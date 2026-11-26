import { sharedCalculationCore } from '../document/temporal.js';

const cloneCoordinate = coordinate => [Number(coordinate[0]), Number(coordinate[1])];

function quantized(value, precision) {
  const factor = 10 ** precision;
  return Math.round(Number(value) * factor) / factor;
}

export function topologyNodeKey(coordinate, precision = 7) {
  return `${quantized(coordinate[0], precision)},${quantized(coordinate[1], precision)}`;
}

export function boundarySegmentKey(a, b, precision) {
  const left = topologyNodeKey(a, precision);
  const right = topologyNodeKey(b, precision);
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

// Topology snapshots must include inherited ring metadata, while preserving
// all custom own fields of edit-time source rows (id, bounds, etc.).
function snapshotSourceRow(row) {
  const own = { ...row };
  if (!Object.hasOwn(row, 'featureId')) {
    own.featureId = row.featureId;
    own.polygonIndex = row.polygonIndex;
    own.ringIndex = row.ringIndex;
    own.interiorSide = row.interiorSide;
  }
  return own;
}

export function buildBoundaryTopologyFromSegments(rawSegments, { precision = 7, epsilon = 1e-7 } = {}) {
  const nodes = new Map();
  for (const raw of rawSegments) {
    for (const [coordinate, vertexIndex] of [[raw.a, raw.segmentIndex], [raw.b, raw.endVertexIndex]]) {
      const key = topologyNodeKey(coordinate, precision);
      if (!nodes.has(key)) nodes.set(key, { key, coordinate: cloneCoordinate(coordinate), ownerIds: new Set(), refs: [], virtualRefs: [] });
      const node = nodes.get(key);
      node.ownerIds.add(raw.featureId);
      if (!node.refs.some(ref => ref.featureId === raw.featureId && ref.polygonIndex === raw.polygonIndex
        && ref.ringIndex === raw.ringIndex && ref.vertexIndex === vertexIndex)) node.refs.push({
        featureId: raw.featureId, polygonIndex: raw.polygonIndex, ringIndex: raw.ringIndex, vertexIndex,
      });
    }
  }

  const nodeValues = [...nodes.values()];
  // One compiled C++ crossing owns geographic node buckets, epsilon
  // projections and stable split ordering. JS retains edit references and
  // object-key Map identities, not a second arithmetic implementation.
  const splitRows = rawSegments.length
    ? sharedCalculationCore.boundarySplitCandidatesBatch(
      rawSegments.map(({ a, b }) => [a, b]), nodeValues.map(node => node.coordinate), epsilon) : [];
  if (!Array.isArray(splitRows) || splitRows.length !== rawSegments.length
    || splitRows.some(row => !Array.isArray(row))) {
    throw Object.assign(new Error('Incomplete compiled boundary topology split result.'),
      { code: 'PL-BOUNDARY-SPLIT' });
  }
  const segments = new Map();
  for (const [rawIndex, raw] of rawSegments.entries()) {
    const split = splitRows[rawIndex].map(([nodeIndex, t]) => ({ node: nodeValues[nodeIndex], t }));
    for (const item of split) {
      item.node.ownerIds.add(raw.featureId);
      if (item.t > epsilon && item.t < 1 - epsilon && !item.node.virtualRefs.some(ref => ref.featureId === raw.featureId
        && ref.polygonIndex === raw.polygonIndex && ref.ringIndex === raw.ringIndex && ref.segmentIndex === raw.segmentIndex)) {
        item.node.virtualRefs.push({
          featureId: raw.featureId,
          polygonIndex: raw.polygonIndex,
          ringIndex: raw.ringIndex,
          segmentIndex: raw.segmentIndex,
          t: item.t,
        });
      }
    }
    for (let index = 1; index < split.length; index += 1) {
      const start = split[index - 1];
      const end = split[index];
      if (end.t - start.t <= epsilon) continue;
      const key = boundarySegmentKey(start.node.coordinate, end.node.coordinate, precision);
      if (!segments.has(key)) segments.set(key, {
        key,
        a: cloneCoordinate(start.node.coordinate),
        b: cloneCoordinate(end.node.coordinate),
        ownerIds: new Set(),
        refs: [],
      });
      const segment = segments.get(key);
      segment.ownerIds.add(raw.featureId);
      segment.refs.push({ ...snapshotSourceRow(raw), startT: start.t, endT: end.t });
    }
  }

  for (const node of nodes.values()) node.kind = node.ownerIds.size >= 3 ? 'multi-owner' : node.ownerIds.size === 2 ? 'shared' : 'coast';
  for (const segment of segments.values()) segment.kind = segment.ownerIds.size >= 2 ? 'shared' : 'coast';
  return { precision, epsilon, nodes, segments };
}
