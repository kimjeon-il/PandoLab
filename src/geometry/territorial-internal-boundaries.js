import { buildRefinedBoundarySegments } from './geographic-boundary.js';
import { sharedCalculationCore } from '../document/temporal.js';
import { territorialRootId } from '../document/territorial-units.js';
import { multiCoordinates } from './polygon-geometry-utils.js';
import { boundarySourceSegments, boundaryFeatureId } from './boundary-source-store.js';
import { buildBoundaryTopologyFromSegments } from './boundary-topology-core.js';

/** Owns territorial hierarchy filtering and internal-boundary display classification. */
function topologyFeature(feature, prefix, index) {
  const id = boundaryFeatureId(feature, index);
  return {
    ...feature,
    id: `${prefix}:${id}`,
  };
}

function pointSegmentDistance(point, a, b) {
  const dx = Number(b[0]) - Number(a[0]);
  const dy = Number(b[1]) - Number(a[1]);
  const length2 = dx * dx + dy * dy;
  if (!length2) return Math.hypot(Number(point[0]) - Number(a[0]), Number(point[1]) - Number(a[1]));
  const t = Math.max(0, Math.min(1, ((Number(point[0]) - Number(a[0])) * dx + (Number(point[1]) - Number(a[1])) * dy) / length2));
  return Math.hypot(Number(point[0]) - (Number(a[0]) + dx * t), Number(point[1]) - (Number(a[1]) + dy * t));
}

// Keep source-reference selection in JavaScript; shared C++ alone owns the
// signed interior/direction calculation. Inputs are untouched source edges,
// not seam-split or refined display strokes.
export function boundaryInteriorComparison(segment, ownerIds = segment.ownerIds) {
  const refs = ownerIds.map(id => {
    const edge = segment.refs?.find(ref => String(ref.featureId) === String(id));
    if (!edge) throw new Error('공유 경계의 원본 구간이 없습니다: ' + id);
    return [edge.a, edge.b, edge.interiorSide];
  });
  return [[segment.start, segment.end], refs];
}

export function hasOpposingBoundaryInteriors(segment, ownerIds = segment.ownerIds) {
  return sharedCalculationCore.boundaryOpposingInteriors(...boundaryInteriorComparison(segment, ownerIds));
}

export function buildTerritorialInternalBoundarySegments(countries = [], units = [], {
  precision = 7, epsilon = 1e-7, sourceSegments = boundarySourceSegments,
} = {}) {
  // No unit can own an internal boundary: do not even inspect country geometry.
  if (!(units || []).some(feature => ['Polygon', 'MultiPolygon'].includes(feature?.geometry?.type))) return [];
  const rootIds = new Set((countries || [])
    .filter(feature => feature?.geometry?.type === 'Polygon' || feature?.geometry?.type === 'MultiPolygon')
    .map((feature, index) => boundaryFeatureId(feature, index)));
  const unitFeatures = (units || [])
    .filter(feature => feature?.geometry?.type === 'Polygon' || feature?.geometry?.type === 'MultiPolygon')
    .map((feature, index) => topologyFeature(feature, 'unit', index));
  const entities = new Map([...countries, ...units].map(feature => [String(feature.id), feature]));
  const unitMeta = new Map(unitFeatures.map(feature => [feature.id, {
    id: boundaryFeatureId(feature).replace(/^unit:/, ''),
    entityKind: feature.properties?.entityKind || '',
    rootId: territorialRootId(entities.get(boundaryFeatureId(feature).replace(/^unit:/, '')), id => entities.get(id)),
  }]));
  // A root's editable polygon may exclude its children (including islands).
  // Only the exterior of the complete general hierarchy is a coast; using the
  // root polygon alone hid land contacts and painted child coastlines dashed.
  // Derive the exclusion geometry with the shared polygon kernel, without
  // replacing canonical entity geometry or including independent regions.
  const countryFeatures = (countries || [])
    .filter(feature => rootIds.has(String(feature.id)))
    .map((feature, index) => {
      const members = unitFeatures.filter(unit => {
        const meta = unitMeta.get(unit.id);
        return meta.entityKind === 'general' && meta.rootId === String(feature.id);
      });
      const geometry = members.length ? { type: 'MultiPolygon', coordinates: sharedCalculationCore.polygonOperation('union',
        [feature, ...members].map(item => multiCoordinates(item.geometry)), false) } : feature.geometry;
      return topologyFeature({ ...feature, geometry }, 'country', index);
    });
  const topology = buildBoundaryTopologyFromSegments(
    [...countryFeatures, ...unitFeatures].flatMap((feature, index) => sourceSegments(feature, index)), { precision, epsilon },
  );
  const countryEdges = [...topology.segments.values()].filter(segment => [...segment.ownerIds].some(ownerId => ownerId.startsWith('country:')));
  const boundaryTolerance = Math.max(1e-4, epsilon * 1000);
  const bucketSize = 1;
  const countryBuckets = new Map();
  const bucketKey = (x, y) => `${x}:${y}`;
  for (const edge of countryEdges) {
    const minX = Math.floor(Math.min(edge.a[0], edge.b[0]) / bucketSize);
    const maxX = Math.floor(Math.max(edge.a[0], edge.b[0]) / bucketSize);
    const minY = Math.floor(Math.min(edge.a[1], edge.b[1]) / bucketSize);
    const maxY = Math.floor(Math.max(edge.a[1], edge.b[1]) / bucketSize);
    if ((maxX - minX + 1) * (maxY - minY + 1) > 4096) continue;
    for (let x = minX; x <= maxX; x += 1) for (let y = minY; y <= maxY; y += 1) {
      const key = bucketKey(x, y);
      if (!countryBuckets.has(key)) countryBuckets.set(key, []);
      countryBuckets.get(key).push(edge);
    }
  }
  const nearCountryExterior = segment => {
    const minX = Math.floor((Math.min(segment.a[0], segment.b[0]) - boundaryTolerance) / bucketSize);
    const maxX = Math.floor((Math.max(segment.a[0], segment.b[0]) + boundaryTolerance) / bucketSize);
    const minY = Math.floor((Math.min(segment.a[1], segment.b[1]) - boundaryTolerance) / bucketSize);
    const maxY = Math.floor((Math.max(segment.a[1], segment.b[1]) + boundaryTolerance) / bucketSize);
    const candidates = [];
    const seen = new Set();
    for (let x = minX; x <= maxX; x += 1) for (let y = minY; y <= maxY; y += 1) {
      for (const edge of countryBuckets.get(bucketKey(x, y)) || []) {
        if (seen.has(edge.key)) continue;
        seen.add(edge.key);
        candidates.push(edge);
      }
    }
    return candidates.some(edge => pointSegmentDistance(segment.a, edge.a, edge.b) <= boundaryTolerance
      && pointSegmentDistance(segment.b, edge.a, edge.b) <= boundaryTolerance);
  };
  const output = [];
  for (const segment of topology.segments.values()) {
    const unitOwners = [...segment.ownerIds].filter(ownerId => ownerId.startsWith('unit:'));
    if (!unitOwners.length || [...segment.ownerIds].some(ownerId => ownerId.startsWith('country:')) || nearCountryExterior(segment)) continue;
    const metadata = unitOwners.map(ownerId => unitMeta.get(ownerId)).filter(Boolean);
    if (!metadata.length) continue;
    const validRootIds = new Set(metadata
      .map(item => item.rootId)
      .filter(rootId => rootId && rootIds.has(rootId)));
    if (validRootIds.size > 1) continue;
    const allRootsValid = metadata.every(item => item.rootId && rootIds.has(item.rootId));
    const sameRootChildren = metadata.every(item => item.entityKind === 'general')
      && allRootsValid
      && validRootIds.size === 1;
    const styleType = metadata.some(item => item.entityKind === 'regional')
      ? 'region'
      : sameRootChildren ? 'subunit-internal' : 'subunit';
    // Preserve editable source segments for classification. Only the
    // accepted, visible edges become refined display geometry.
    const pieces = buildRefinedBoundarySegments({ type: 'LineString', coordinates: [segment.a, segment.b] });
    const displayOwners = metadata.map(item => ({ id: item.id, entityKind: item.entityKind, rootId: item.rootId }));
    pieces.forEach(([a, b], index) => output.push({
      key: `${segment.key}:${index}`,
      a, b, unitOwners: displayOwners, styleType,
    }));
  }
  return output;
}
