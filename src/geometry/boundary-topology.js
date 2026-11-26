import { computeCountrySharedContacts } from './country-contact-core.js';
import { boundarySourceSegments, createPreparedBoundaryStore } from './boundary-source-store.js';
import { boundarySegmentKey, buildBoundaryTopologyFromSegments } from './boundary-topology-core.js';

export { boundarySourceSegments, boundaryEdgeBoxesInBatches, prepareBoundaryFeature,
  createPreparedBoundaryStore, attachBoundarySegmentReferences } from './boundary-source-store.js';
export { topologyNodeKey, buildBoundaryTopologyFromSegments } from './boundary-topology-core.js';
export { boundaryInteriorComparison, hasOpposingBoundaryInteriors,
  buildTerritorialInternalBoundarySegments } from './territorial-internal-boundaries.js';

export function buildBoundaryTopology(features = [], options = {}) {
  return buildBoundaryTopologyFromSegments(features.flatMap(boundarySourceSegments), options);
}

// The existing source-ref objects and Worker cache remain JS-owned.
// C++ now produces source-contact candidates, shared segments and seam pieces.
export function buildCountrySharedBoundaryContact(left, right) {
  return computeCountrySharedContacts([[left, right]])[0];
}

// Worker source identities remain JS-owned after C++ contact discovery.
// Both static cache assembly and incremental patches must merge the same refs
// without duplicating owner/reference union logic or mutating input rows.
export function mergeSharedBoundaryContributions(segments) {
  if (!segments.length) return null;
  if (segments.length === 1) return segments[0];
  const refs = [];
  for (const segment of segments) for (const ref of segment.refs) {
    if (!refs.some(other => other.featureId === ref.featureId
      && other.polygonIndex === ref.polygonIndex
      && other.ringIndex === ref.ringIndex && other.segmentIndex === ref.segmentIndex)) refs.push(ref);
  }
  return { ...segments[0], ownerIds: [...new Set(segments.flatMap(segment => segment.ownerIds))].sort(), refs };
}

export function buildCountrySharedBoundarySegments(features = [], { preparedStore } = {}) {
  const store = preparedStore || createPreparedBoundaryStore();
  if (!preparedStore) store.replace(features);
  const rows = features.map(feature => store.get(feature.id));
  const order = new Map(rows.map((row, index) => [row.id, index]));
  const pairs = [];
  for (let leftIndex = 0; leftIndex < rows.length; leftIndex++) {
    const left = rows[leftIndex];
    if (!left.segments.length) continue;
    const nearby = store.nearby(left.bounds).filter(right => order.get(right.id) > leftIndex)
      .sort((a, b) => order.get(a.id) - order.get(b.id));
    for (const right of nearby) pairs.push([left, right]);
  }
  const shared = new Map();
  for (const segments of computeCountrySharedContacts(pairs))
    for (const segment of segments) {
      const key = boundarySegmentKey(segment.start, segment.end, 7);
      const previous = shared.get(key);
      shared.set(key, previous ? mergeSharedBoundaryContributions([previous, segment]) : segment);
    }
  return [...shared.values()];
}

// Static cache and rendering packets store coordinates/owners; live source refs
// are attached once by the Worker and never cloned into every render packet.
export function serializeCountrySharedBoundarySegments(segments) {
  return segments.map(({ start, end, ownerIds }) => ({ start, end, ownerIds }));
}
