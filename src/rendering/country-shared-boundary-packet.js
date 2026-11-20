import { buildGpuStrokeInstances } from "./gpu-stroke-geometry.js";
import { prepareGpuStrokeVisibilityBlocks } from "./gpu-stroke-visibility.js";
import { boundaryInteriorComparison, buildTerritorialInternalBoundarySegments, createPreparedBoundaryStore } from "../geometry/boundary-topology.js";
import { createBoundarySpatialIndex, segmentBounds } from "../geometry/boundary-spatial-index.js";
import { MAX_BOUNDARY_EDGE_DEGREES, forEachRenderableBoundarySegment } from "../geometry/geographic-boundary.js";
import { sharedCalculationCore } from "../document/temporal.js";
import { assembleStrokeWithGroupReuse } from "./country-stroke-group-reuse.js";

// Keep each owner set contiguous so the GPU can apply the same per-country
// visibility rule as Canvas without rebuilding geometry when visibility flips.
const boundaryGeometryCache = new WeakMap();
// One previous per-owner compiled stroke set per live prepared-store; all group
// fragments together obey an independent 24MiB budget (see helper).
const compiledStrokeGroupCaches = new WeakMap();
// Keep each WASM transfer below its source/candidate limits. Each subtraction
// row is independent, so chunking preserves the source order and exact pieces.
const OUTLINE_BATCH_EDGES = 16_384;
const OUTLINE_BATCH_CANDIDATES = 1_000_000;
export function prepareCountrySharedBoundaryPacket(segments = [], features = [], { preparedStore, maxEdgeDegrees = MAX_BOUNDARY_EDGE_DEGREES, includeOutlines = true, profile } = {}) {
  // Optional, non-mutating diagnostic spans. The ordinary viewer does not
  // allocate timing entries or call performance.now() for each source edge.
  const measure = (name, operation, details) => {
    if (typeof profile !== 'function') return operation();
    const started = performance.now();
    try { return operation(); }
    finally { profile(name, performance.now() - started, details); }
  };
  const store = preparedStore || createPreparedBoundaryStore();
  if (!preparedStore) store.replace(features);
  const byId = new Map(features.map(feature => [String(feature.id), feature]));
  const rootOf = id => String(byId.get(String(id))?.boundaryRootId || id);
  const childIds = ids => ids.filter(id => rootOf(id) !== String(id));
  const sameHierarchy = segment => new Set(segment.ownerIds.map(rootOf)).size === 1;
  const key = JSON.stringify(features.map(feature => [String(feature.id), rootOf(feature.id), store.get(feature.id).geometryKey]));
  let cached = boundaryGeometryCache.get(store);
  if (cached?.key !== key) {
    const previous = cached;
    const roots = features.filter(feature => rootOf(feature.id) === String(feature.id))
      .map(feature => ({ ...feature, properties: { ...feature.properties, entityKind: 'general', parentId: '' } }));
    const children = features.filter(feature => rootOf(feature.id) !== String(feature.id));
    const internal = [], rootCache = new Map();
    // A changed sovereign must not force unrelated countries to repeat their
    // C++ union/topology work. Each cache key includes the exact root and
    // ordered child geometry revisions; structural edits invalidate only that
    // root. Retain *one* previous set per Worker, not unbounded time history.
    const membersByRoot = new Map(roots.map(root => [String(root.id), []]));
    for (const child of children) membersByRoot.get(rootOf(child.id))?.push(child);
    const hierarchyStats = {roots: roots.length, children: children.length,
      reusedRoots: 0, recomputedRoots: 0};
    measure('hierarchy-internal', () => {
      for (const root of roots) {
        const id = String(root.id), rawMembers = membersByRoot.get(id) || [];
        const groupKey = JSON.stringify([[id, store.get(id).geometryKey],
          ...rawMembers.map(child => [String(child.id), store.get(child.id).geometryKey])]);
        let group = previous?.rootCache?.get(id);
        if (group?.key === groupKey) hierarchyStats.reusedRoots++;
        else {
          hierarchyStats.recomputedRoots++;
          const groupStarted = typeof profile === 'function' && rawMembers.length ? performance.now() : 0;
          const members = rawMembers.map(feature => ({ ...feature,
            properties: { ...feature.properties, entityKind: 'general', parentId: id } }));
          const segments = buildTerritorialInternalBoundarySegments([root], members).map(segment => ({
            start: segment.a, end: segment.b,
            ownerIds: [...new Set([id, ...segment.unitOwners.map(owner => owner.id)])].sort(),
          }));
          group = {key: groupKey, segments};
          if (groupStarted) profile('hierarchy-root', performance.now() - groupStarted,
            {rootId: id, children: members.length, segments: segments.length});
        }
        rootCache.set(id, group);
        internal.push(...group.segments);
      }
    }, hierarchyStats);
    // Coast classification is useful only for the explicit legacy/diagnostic
    // outline path. The ordinary viewer never pays for it.
    cached = { key, internal, coasts: null, outlines: null, rootCache };
    boundaryGeometryCache.set(store, cached);
  }
  const internalOwners = {};
  const contacts = segments.filter(segment => !sameHierarchy(segment));
  const visible = [...contacts, ...cached.internal];
  for (const segment of visible) {
    const children = childIds(segment.ownerIds);
    if (children.length && sameHierarchy(segment)) internalOwners[segment.ownerIds.join('|')] = children;
  }
  if (includeOutlines && !cached.outlines) {
    if (cached.coasts === null) {
      cached.coasts = measure('hierarchy-classification', () => {
        const hierarchyContacts = segments.filter(segment => sameHierarchy(segment) && childIds(segment.ownerIds).length);
        const opposing = hierarchyContacts.length ? sharedCalculationCore.boundaryOpposingInteriorsBatch(hierarchyContacts.map(segment => boundaryInteriorComparison(segment, segment.ownerIds))) : [];
        if (!Array.isArray(opposing) || opposing.length !== hierarchyContacts.length || opposing.some(value => typeof value !== 'boolean'))
          throw Object.assign(new Error('Incomplete compiled country boundary interior classifications.'), { code: 'PL-BOUNDARY-INTERIOR' });
        return hierarchyContacts.filter((_, index) => !opposing[index]);
      });
    }
    const excluded = createBoundarySpatialIndex();
    measure('outline-index', () => {
      [...segments, ...cached.internal].forEach((segment, index) => {
        const row = { a: segment.start, b: segment.end, ownerIds: segment.ownerIds };
        excluded.insert(index, row, segmentBounds(row));
      });
    }, {segments: segments.length + cached.internal.length});
    const pending = [], outlines = [];
    let candidateCount = 0;
    function flushOutlines() {
      if (!pending.length) return;
      const clipped = measure('outline-wasm-subtract', () =>
        sharedCalculationCore.boundarySubtractOverlapsBatch(pending.map(({ start, end, blocked }) => [[start, end], blocked])),
      {sourceEdges: pending.length, candidates: candidateCount});
      if (!Array.isArray(clipped) || clipped.length !== pending.length || clipped.some(pieces => !Array.isArray(pieces)))
        throw Object.assign(new Error('Incomplete compiled outline overlap subtraction.'), { code: 'PL-BOUNDARY-OVERLAP' });
      pending.forEach(({ id }, index) => {
        for (const [start, end] of clipped[index]) outlines.push({ start, end, ownerIds: [id] });
      });
      pending.length = 0;
      candidateCount = 0;
    }
    measure('outline-scan-including-wasm', () => {
      for (const feature of features) {
        const id = String(feature.id);
        forEachRenderableBoundarySegment(store.get(id).geometry, ([start, end]) => {
          const bounds = segmentBounds({ a: start, b: end }).map((value, index) => value + (index < 2 ? -1e-7 : 1e-7));
          const blocked = excluded.query(bounds).filter(edge => edge.ownerIds.includes(id)).map(edge => [edge.a, edge.b]);
          if (pending.length >= OUTLINE_BATCH_EDGES
            || (pending.length && candidateCount + blocked.length > OUTLINE_BATCH_CANDIDATES)) flushOutlines();
          pending.push({ id, start, end, blocked });
          candidateCount += blocked.length;
        });
      }
      flushOutlines();
    }, {features: features.length});
    cached.outlines = [...outlines, ...cached.coasts];
  }
  const groupCaches = preparedStore
    ? compiledStrokeGroupCaches.get(store) || {} : null;
  const packet = prepareStrokePacket(visible, maxEdgeDegrees, measure, 'contact-stroke',groupCaches,profile);
  // Do not run even an empty WASM outline assembler when the active map
  // suppresses coasts. Keep a zero-cost packet shape for existing consumers.
  const emptyStartsEnds = new Float32Array(0);
  const outlineOverrides = includeOutlines
    ? prepareStrokePacket(cached.outlines, maxEdgeDegrees, measure, 'outline-stroke', groupCaches, profile)
    : { segments: [], startsEnds: emptyStartsEnds, chainPhase: new Float32Array(0),
      ownerRanges: {}, ownerIds: [], preparedGeometry: buildGpuStrokeInstances(emptyStartsEnds) };
  if (groupCaches) compiledStrokeGroupCaches.set(store,groupCaches);
  outlineOverrides.internalOwners = includeOutlines ? Object.fromEntries([
    ...features.filter(feature => rootOf(feature.id) !== String(feature.id)).map(feature => [String(feature.id), [String(feature.id)]]),
    ...(cached.coasts || []).map(segment => [segment.ownerIds.join('|'), childIds(segment.ownerIds)]),
  ]) : {};
  return { ...packet, ownerIds: [...new Set([...packet.ownerIds, ...byId.keys()])], internalOwners, outlineOverrides,
    outlineOwnerIds: [...byId.keys()].sort() };
}

function prepareStrokePacket(segments, maxEdgeDegrees, measure = (_, operation) => operation(),
  label = 'stroke', groupCaches = null, profile = null) {
  // The browser owns only locale-sensitive input ordering and GPU allocation.
  // Country grouping, junction walks, seam splitting, subdivision, phases and
  // owner ranges are calculated in the same native C++ source used by Qt.
  const ordered = measure(label + '-sort', () => [...segments].sort((left, right) =>
    left.ownerIds.join('|').localeCompare(right.ownerIds.join('|'))),
  {segments:segments.length});
  if (typeof sharedCalculationCore.boundaryAssembleStrokePacket !== 'function') {
    throw Object.assign(new Error('Compiled shared-border packet builder unavailable.'),
      { code: 'PL-CORE-WASM-CAPABILITY' });
  }
  // The production C++ kernel remains authoritative. When a prepared-store
  // survives into the next date, only changed owner groups cross the WASM
  // bridge; unchanged output is validated against exact numeric source bytes.
  // Unprepared standalone calls retain the original single native crossing.
  let packet;
  if (groupCaches) {
    const result = assembleStrokeWithGroupReuse(ordered, maxEdgeDegrees,
      (source,quality) => sharedCalculationCore.boundaryAssembleStrokePacket(source,quality),
      groupCaches[label], typeof profile === 'function'
        ? (name,ms,details) => profile(label+'-'+name,ms,details) : null);
    packet = result.packet;
    groupCaches[label] = result.cache;
  } else {
    const source=ordered.map(segment=>[segment.start,segment.end,segment.ownerIds]);
    packet=measure(label+'-wasm-bridge',()=>
      sharedCalculationCore.boundaryAssembleStrokePacket(source,maxEdgeDegrees),
    {segments:source.length});
  }
  if (!packet || !Array.isArray(packet.segments) || !Array.isArray(packet.ownerIds)
    || !(packet.startsEnds instanceof Float32Array)
    || !(packet.chainPhase instanceof Float32Array)
    || packet.startsEnds.length !== packet.segments.length * 4
    || packet.chainPhase.length !== packet.segments.length
    || !packet.ownerRanges || typeof packet.ownerRanges !== 'object') {
    throw Object.assign(new Error('Incomplete compiled shared-border render packet.'),
      { code: 'PL-BOUNDARY-PACKET' });
  }
  const prepared = measure(label + '-gpu-instances', () =>
    buildGpuStrokeInstances(packet.startsEnds, packet.chainPhase, packet.ownerRanges),
  {segments: packet.segments.length});
  // Build conservative country-border culling metadata once in this Worker.
  // Other strokes and canonical editing geometry remain unchanged.
  const spatial = label === 'contact-stroke' ? measure(label + '-visible-blocks', () =>
    prepareGpuStrokeVisibilityBlocks(prepared), { segments: packet.segments.length }) : null;
  return { ...packet, preparedGeometry: spatial
    ? Object.freeze({ ...prepared, visibilityBlocks: spatial }) : prepared };
}
