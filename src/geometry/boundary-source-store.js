import { createBoundarySpatialIndex, segmentBounds, padBoundaryBounds } from './boundary-spatial-index.js';
import { countryGeometrySignature } from '../rendering/country-shared-boundary-cache.js';
import { sharedCalculationCore } from '../document/temporal.js';
import './polygon-geometry.js';

const { sphericalSignedAreas } = globalThis.PandoLabPolygonGeometry;

/** Owns source-edge extraction, prepared feature revisions, and edge-reference lookup. */
function polygonRings(feature) {
  if (feature?.geometry?.type === 'Polygon') return [{ polygonIndex: 0, rings: feature.geometry.coordinates || [] }];
  if (feature?.geometry?.type === 'MultiPolygon') return (feature.geometry.coordinates || []).map((rings, polygonIndex) => ({ polygonIndex, rings }));
  return [];
}

export function boundaryFeatureId(feature, index = 0) {
  return String(feature?.id || index);
}

export function boundarySourceSegments(feature, fallbackId = 0, { compactPrepared = false } = {}) {
  const rows = [];
  const id = boundaryFeatureId(feature, fallbackId);
  for (const polygon of polygonRings(feature)) {
    const rings = polygon.rings || [];
    // Preserve the historical skip for empty/one-point rings, while using
    // one crossing into the shared C++ integral for all remaining rings.
    const calculable = rings.filter(ring => ring.length > 1);
    const areas = calculable.length ? sphericalSignedAreas(calculable) : [];
    let areaIndex = 0;
    rings.forEach((ring, ringIndex) => {
      const limit = Math.max(0, ring.length - 1);
      if (!limit) return;
      let area = areas[areaIndex++];
      // The common spherical integral may include a full turn around a pole.
      // Use its signed smaller region, without offsetting ordinary tiny areas.
      if (area > 2 * Math.PI) area -= 4 * Math.PI;
      else if (area < -2 * Math.PI) area += 4 * Math.PI;
      // Spherical winding has the opposite sign to the former planar area.
      const interiorSide = -Math.sign(area) * (ringIndex ? -1 : 1);
      // Long-lived Worker caches only need one copy of the feature/ring/winding
      // metadata. Keep immutable per-edge identities and original coordinate
      // arrays in ordinary JS objects.
      // Keep inherited fields visible through property reads; consumers that
      // persist a contact ref must snapshot those fields into own properties.
      const shared = compactPrepared
        ? { featureId: id, polygonIndex: polygon.polygonIndex, ringIndex, interiorSide } : null;
      for (let index = 0; index < limit; index++) {
        if (!shared) {
          rows.push({ featureId: id, polygonIndex: polygon.polygonIndex, ringIndex,
            segmentIndex: index, endVertexIndex: (index + 1) % limit,
            a: ring[index], b: ring[index + 1], interiorSide });
          continue;
        }
        const row = Object.create(shared);
        row.segmentIndex = index;
        row.endVertexIndex = (index + 1) % limit;
        row.a = ring[index];
        row.b = ring[index + 1];
        rows.push(row);
      }
    });
  }
  return rows;
}

// The native boundaryEdgeBoxesBatch binding rejects >1,000,000 edges per
// call. A detailed LSIB country can exceed this limit without invalid source
// geometry. Bound the transfer, not the polygon, and retain exact edge order.
export function boundaryEdgeBoxesInBatches(segments,{
  batchSize=100_000,
  calculate=edges=>sharedCalculationCore.boundaryEdgeBoxesBatch(edges),
}={}) {
  if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>1_000_000)
    throw new RangeError('Invalid native boundary edge batch size');
  const boxes=new Array(segments.length);
  for(let start=0;start<segments.length;start+=batchSize){
    const batch=segments.slice(start,start+batchSize).map(({a,b})=>[a,b]);
    const computed=calculate(batch);
    if(!Array.isArray(computed)||computed.length!==batch.length)
      throw new Error('Native boundary edge box count mismatch');
    for(let index=0;index<computed.length;index++)boxes[start+index]=computed[index];
  }
  return boxes;
}

export function prepareBoundaryFeature(feature) {
  const segments = boundarySourceSegments(feature, 0, { compactPrepared: true });
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const spatialIndex = createBoundarySpatialIndex();
  const boxes=boundaryEdgeBoxesInBatches(segments);
  for (const rowBoxes of boxes) for (const box of rowBoxes) for (let axis = 0; axis < 2; axis++) {
    bounds[axis] = Math.min(bounds[axis], box[axis]);
    bounds[axis + 2] = Math.max(bounds[axis + 2], box[axis + 2]);
  }
  // Source segments belong to this immutable geometry revision. Bulk-loading
  // removes per-edge JS Map/Set/key retention while preserving ordered source refs.
  spatialIndex.loadPacked(segments, boxes);
  return { id: String(feature.id), feature, geometry: feature.geometry, segments, bounds, spatialIndex };
}

/** The Worker owns this derived index; only a changed geometry is prepared. */
export function createPreparedBoundaryStore() {
  const byId = new Map(), spatialIndex = createBoundarySpatialIndex();
  let preparationCount = 0;
  function put(feature) {
    const id = String(feature.id), previous = byId.get(id);
    // Caller keys include geometry identity and revision. A bare revision such
    // as 0 is insufficient when a timeline replaces one geometry with another.
    if (feature.boundaryGeometryRevision !== undefined && typeof feature.boundaryGeometryRevision !== 'string')
      throw new Error('Boundary geometry revision must include geometry identity and mutable revision');
    const key = feature.boundaryGeometryRevision !== undefined
      ? `identity:${feature.boundaryGeometryRevision}` : `digest:${countryGeometrySignature(feature)}`;
    if (previous?.geometryKey === key) {
      previous.feature = feature;
      return false;
    }
    const prepared = { ...prepareBoundaryFeature(feature), geometryKey: key };
    byId.set(id, prepared);
    spatialIndex.remove(id);
    if (prepared.segments.length) spatialIndex.insert(id, prepared, prepared.bounds);
    preparationCount++;
    return true;
  }
  function patch(features = [], removedIds = []) {
    const changed = new Set();
    for (const value of removedIds) {
      const id = String(value);
      if (byId.delete(id)) changed.add(id);
      spatialIndex.remove(id);
    }
    for (const feature of features) if (put(feature)) changed.add(String(feature.id));
    return changed;
  }
  function replace(features = []) {
    const ids = new Set(features.map(feature => String(feature.id)));
    return patch(features, [...byId.keys()].filter(id => !ids.has(id)));
  }
  return { patch, replace, get: id => byId.get(String(id)), values: () => [...byId.values()],
    nearby: bounds => spatialIndex.query(padBoundaryBounds(bounds)), stats: () => ({ preparationCount }) };
}

export function attachBoundarySegmentReferences(segment, preparedStore) {
  if (segment.refs) return segment;
  const refs = [];
  for (const id of segment.ownerIds) {
    const prepared = preparedStore.get(id);
    if (!prepared) throw new Error(`공유 경계의 원본 객체가 없습니다: ${id}`);
    const candidates = prepared.spatialIndex.query(padBoundaryBounds(segmentBounds({ a: segment.start, b: segment.end })));
    const splits = candidates.length ? sharedCalculationCore.boundarySplitCandidatesBatch(
      candidates.map(({ a, b }) => [a, b]), [segment.start, segment.end], 1e-7) : [];
    const edge = candidates.find((_, index) => splits[index].some(([node]) => node === 0)
      && splits[index].some(([node]) => node === 1));
    if (!edge) throw new Error(`공유 경계의 원본 구간이 없습니다: ${id}`);
    refs.push(edge);
  }
  return { ...segment, refs };
}

