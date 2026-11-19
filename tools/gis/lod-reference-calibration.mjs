/** Compare intrinsic line detail, never the displacement between map editions.
 * Inputs are explicit, bounded chains in a verified local metre projection.
 * This is a display-detail diagnostic, not a positional or legal accuracy test.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { detailMetrics } from './measure-border-detail.mjs';

export const DETAIL_WINDOWS_METERS = Object.freeze([250, 500, 1000, 2000]);
export const DETAIL_CANDIDATES_METERS = Object.freeze(Array.from({ length: 81 }, (_v, i) => i * 25));

function checkedChain(points) {
  assert(Array.isArray(points) && points.length >= 2, 'Explicit open metric chain required');
  assert(points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)), 'Finite metre coordinates required');
  return points;
}

/** Metric Douglas–Peucker diagnostic; runtime remains the shared-arc owner. */
export function simplifyMetricChain(points, toleranceMeters) {
  checkedChain(points);
  assert(Number.isFinite(toleranceMeters) && toleranceMeters >= 0);
  const keep = new Set([0, points.length - 1]);
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop(), a = points[first], b = points[last];
    const dx = b[0] - a[0], dy = b[1] - a[1], lengthSquared = dx * dx + dy * dy;
    let maximum = toleranceMeters ** 2, furthest = -1;
    for (let i = first + 1; i < last; i++) {
      const p = points[i];
      const t = lengthSquared ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared)) : 0;
      const error = (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
      if (error > maximum) { maximum = error; furthest = i; }
    }
    if (furthest >= 0) { keep.add(furthest); stack.push([first, furthest], [furthest, last]); }
  }
  return points.filter((_p, i) => keep.has(i)).map(p => [...p]);
}

/** Match the runtime's max(flat-degree,spherical-chord) DP importance metric.
 * Closed-ring topology guards may retain extra points at runtime. These open
 * sample chains only measure the intrinsic detail target, not topology safety.
 */
export function simplifyRuntimeMetricChain(points, geographic, toleranceMeters) {
  checkedChain(points); checkedChain(geographic);
  assert.equal(points.length, geographic.length, 'Matching metric/geographic vertices required');
  assert(Number.isFinite(toleranceMeters) && toleranceMeters >= 0);
  const radians = Math.PI / 180, radius = 6371008.8;
  const unit = geographic.map(([lng, lat]) => [Math.cos(lat * radians) * Math.cos(lng * radians), Math.cos(lat * radians) * Math.sin(lng * radians), Math.sin(lat * radians)]);
  const squared = (p, a, b) => {
    const delta = a.map((v, k) => b[k] - v), length = delta.reduce((s, v) => s + v * v, 0);
    const t = length ? Math.max(0, Math.min(1, delta.reduce((s, v, k) => s + (p[k] - a[k]) * v, 0) / length)) : 0;
    return delta.reduce((s, v, k) => s + (p[k] - a[k] - t * v) ** 2, 0);
  };
  const keep = new Set([0, points.length - 1]), stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maximum = (toleranceMeters / radius) ** 2, furthest = -1;
    for (let i = first + 1; i < last; i++) {
      const error = Math.max(squared(geographic[i], geographic[first], geographic[last]) * radians ** 2, squared(unit[i], unit[first], unit[last]));
      if (error > maximum) { maximum = error; furthest = i; }
    }
    if (furthest >= 0) { keep.add(furthest); stack.push([first, furthest], [furthest, last]); }
  }
  return points.filter((_p, i) => keep.has(i)).map(p => [...p]);
}

/** Arc-length sampled midpoint sag relative to a local chord, in metres.
 * Translation and rotation invariant. No cross-source registration is needed.
 */
export function chordResidualRms(points, windowMeters) {
  checkedChain(points);
  assert(Number.isFinite(windowMeters) && windowMeters > 0);
  const distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances.at(-1) + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  if (distances.at(-1) < windowMeters) return null;
  const at = along => {
    let i = 1;
    while (i < distances.length - 1 && distances[i] < along) i++;
    const span = distances[i] - distances[i - 1], t = span ? (along - distances[i - 1]) / span : 0;
    return points[i].map((v, k) => points[i - 1][k] + t * (v - points[i - 1][k]));
  };
  let squares = 0, count = 0;
  for (let along = windowMeters / 2; along <= distances.at(-1) - windowMeters / 2; along += windowMeters / 8) {
    const a = at(along - windowMeters / 2), b = at(along), c = at(along + windowMeters / 2);
    const dx = c[0] - a[0], dy = c[1] - a[1], chord = Math.hypot(dx, dy);
    const residual = chord ? ((b[0] - a[0]) * dy - (b[1] - a[1]) * dx) / chord : Math.hypot(b[0] - a[0], b[1] - a[1]);
    squares += residual ** 2; count++;
  }
  return Math.sqrt(squares / count);
}

export function intrinsicDetailSpectrum(points, windows = DETAIL_WINDOWS_METERS) {
  return windows.map(windowMeters => ({ windowMeters,
    chordResidualRmsMeters: chordResidualRms(points, windowMeters),
    turnDegreesPer100Km: detailMetrics(points, { turnWindowMeters: windowMeters }).turnDegreesPer100Km,
  }));
}

export function calibrateReferenceDetail(samples, { candidates = DETAIL_CANDIDATES_METERS, windows = DETAIL_WINDOWS_METERS } = {}) {
  assert(samples.length > 0);
  const comparisons = samples.map(sample => {
    assert(typeof sample.metricCrs === 'string' && sample.metricCrs.includes('+units=m'), 'Verified local metre projection metadata required');
    const reference = intrinsicDetailSpectrum(sample.public, windows);
    const measured = candidates.map(toleranceMeters => {
      const simplified = sample.geographic?.reference
        ? simplifyRuntimeMetricChain(sample.reference, sample.geographic.reference, toleranceMeters)
        : simplifyMetricChain(sample.reference, toleranceMeters);
      const spectrum = intrinsicDetailSpectrum(simplified, windows);
      // Floors suppress sub-metre straight-line numerical noise; both residual
      // magnitude and accumulated curvature matter, equally at each scale.
      const terms = spectrum.flatMap((value, i) => reference[i].chordResidualRmsMeters === null || value.chordResidualRmsMeters === null ? [] : [
        Math.log((value.chordResidualRmsMeters + 1) / (reference[i].chordResidualRmsMeters + 1)) ** 2,
        Math.log((value.turnDegreesPer100Km + 1) / (reference[i].turnDegreesPer100Km + 1)) ** 2,
      ]);
      assert(terms.length, 'Sample must span a detail window');
      return { toleranceMeters, spectrum, loss: terms.reduce((a, b) => a + b, 0) / terms.length };
    });
    return { id: sample.id, simplificationMetric: sample.geographic?.reference ? 'runtime-flat-and-spherical' : 'local-metres', reference, candidates: measured, best: measured.reduce((a, b) => b.loss < a.loss ? b : a) };
  });
  const ranked = candidates.map((toleranceMeters, i) => ({ toleranceMeters, loss: comparisons.reduce((sum, s) => sum + s.candidates[i].loss, 0) / comparisons.length }))
    .sort((a, b) => a.loss - b.loss || a.toleranceMeters - b.toleranceMeters);
  return { schema: 'pando-lod-reference-calibration-v1', comparisons, ranked,
    meaning: 'Equal-weight multiscale intrinsic shape comparison. Ranking is diagnostic, not proof of a universal tolerance or visual equivalence. Review per-region curvature and residuals before adopting a policy.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const ids = process.argv.slice(3);
  assert(ids.length > 0, 'Supply explicit sample IDs; no whole-catalog calibration');
  const samples = ids.map(id => { const sample = input.samples.find(s => s.id === id); assert(sample, `Unknown sample ${id}`); return sample; });
  console.log(JSON.stringify(calibrateReferenceDetail(samples)));
}
