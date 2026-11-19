import { buildRefinedBoundarySegments } from '../geometry/geographic-boundary.js';

// Worker-safe path for geographic LineString/MultiLineString stroke topology.
// This remains an active GPU-mesh Worker dependency for geographic strokes;
// it does not own a separate map scene.
export function buildLineStrokeGeometryPacket(geometry) {
  const startsEnds = [];
  for (const segment of buildRefinedBoundarySegments(geometry)) {
    const [start, end] = segment || [];
    if (!Array.isArray(start) || !Array.isArray(end)
      || !Number.isFinite(Number(start[0])) || !Number.isFinite(Number(start[1]))
      || !Number.isFinite(Number(end[0])) || !Number.isFinite(Number(end[1]))) continue;
    const values = [Number(start[0]), Number(start[1]), Number(end[0]), Number(end[1])];
    if (Math.hypot(values[2] - values[0], values[3] - values[1]) <= 1e-12) continue;
    startsEnds.push(...values);
  }
  return Object.freeze({
    startsEnds: new Float32Array(startsEnds),
    segmentCount: startsEnds.length / 4,
  });
}
