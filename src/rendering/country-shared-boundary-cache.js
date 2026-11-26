import { geometryCoordinateFingerprint } from '../geometry/geometry-versions.js';

// Keep the published boundary seed fingerprint format unchanged.
export const countryGeometrySignature = feature => geometryCoordinateFingerprint(feature?.geometry);

export function changedCountryGeometryIds(features, signatures = {}) {
  const current = new Map((features || []).map(feature => [String(feature.id), feature]));
  const changed = new Set(Object.keys(signatures).filter(id => !current.has(id)));
  for (const [id, feature] of current) {
    if (countryGeometrySignature(feature) !== signatures[id]) changed.add(id);
  }
  return changed;
}
