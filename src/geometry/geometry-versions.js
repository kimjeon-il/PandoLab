const revisions = new WeakMap();
const identities = new WeakMap();
let nextIdentity = 0;
export function geometryIdentity(geometry) {
  if (!geometry || typeof geometry !== 'object') return 0;
  if (!identities.has(geometry)) identities.set(geometry, ++nextIdentity);
  return identities.get(geometry);
}
export const geometryRevisionKey = geometry => `${geometryIdentity(geometry)}:${geometryRevision(geometry)}`;
export const geometryRevision = geometry => geometry && revisions.get(geometry) || 0;
export function geometryCoordinateFingerprint(geometry) {
  let first = 2166136261;
  let second = 0x9e3779b9;
  const bytes = new DataView(new ArrayBuffer(8));
  const mix = value => {
    first = Math.imul(first ^ value, 16777619) >>> 0;
    second = (Math.imul(second ^ value, 2246822519) + 3266489917) >>> 0;
  };
  const visit = value => {
    if (!Array.isArray(value)) return;
    mix(value.length);
    if (typeof value[0] === 'number') {
      for (const coordinate of value) {
        bytes.setFloat64(0, Number(coordinate), true);
        mix(bytes.getUint32(0, true));
        mix(bytes.getUint32(4, true));
      }
      return;
    }
    for (const item of value) visit(item);
  };
  mix(geometry?.type === 'MultiPolygon' ? 2 : 1);
  visit(geometry?.coordinates);
  return `${first.toString(16)}:${second.toString(16)}`;
}
