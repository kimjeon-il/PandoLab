import { sharedCalculationCore } from '../document/temporal.js';
import { geometryCoordinateFingerprint, geometryRevisionKey } from './geometry-versions.js';
// Persistent geometry IDs/versions are not renderer revisions or snapshot-pool keys.
const fail = (code, detail) => { throw Object.assign(new Error(`${code}: ${detail}`), { code }); };
const invalid = detail => fail('INVALID_GEOMETRY', detail);
function fields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || names.some(name => !Object.hasOwn(value, name))
    || Object.keys(value).some(name => !names.includes(name))) invalid('Unexpected or missing fields.');
}
function reference(ref) {
  fields(ref, ['id', 'version']);
  if (typeof ref.id !== 'string' || !ref.id.length || !Number.isInteger(ref.version)
    || ref.version < 1 || ref.version > 4294967295) invalid('A nonempty ID and uint32 version are required.');
  return JSON.stringify([ref.id, ref.version]);
}
function point(value) {
  if (!Array.isArray(value) || value.length !== 2 || !Number.isFinite(value[0])
    || !Number.isFinite(value[1]) || Math.abs(value[0]) > 180 || Math.abs(value[1]) > 90) invalid('Coordinate.');
}
function list(value, minimum) {
  if (!Array.isArray(value) || value.length < minimum) invalid('Empty or short geometry.');
}
function line(value) {
  list(value, 2);
  for (const position of value) point(position);
}
function ring(value) {
  list(value, 4);
  const first = value[0], last = value.at(-1);
  for (const position of value) point(position);
  if (first[0] !== last[0] || first[1] !== last[1]) invalid('Open ring.');
  let area = 0;
  for (let i = 0; i < value.length; i += 1) {
    const a = value[i], b = value[(i + 1) % value.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (Math.abs(area) < 1e-14) invalid('Degenerate ring.');
}
function canonicalRing(value) {
  list(value, 4);
  for (const position of value) point(position);
  const validate = sharedCalculationCore.validateClippedTerritorialRing;
  if (typeof validate !== 'function') fail('PL-CORE-WASM-CAPABILITY', 'Exact canonical ring validation is unavailable.');
  const issues = validate(value);
  if (!Array.isArray(issues) || issues.length) invalid('Invalid canonical ring.');
}
function polygon(value, validateRing) {
  list(value, 1);
  for (const boundary of value) validateRing(boundary);
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Array.isArray(value) ? value : Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
// Values branded here have passed structural validation and recursive freezing.
// Their validity cannot change; separate registries may safely retain them.
// Certificates are admission-contract-specific: canonical storage never grants
// source admission, even when a caller reuses an already frozen geometry.
const immutableGeometries = new WeakSet();
const immutableCanonicalGeometries = new WeakSet();
const geometryReferences = new WeakMap();
export const geometryReferenceFor = value => geometryReferences.get(value) || null;
const contentByGeometry = new WeakMap();
const contentBuckets = new Map();
const verifiedContent = new Map();
let nextContentId = 0;
const removeCollectedContent = new FinalizationRegistry(({key,entry})=>{
  const bucket=contentBuckets.get(key);
  bucket?.delete(entry);
  if(bucket?.size===0)contentBuckets.delete(key);
});
const removeCollectedAsset = new FinalizationRegistry(({hash,entry})=>{
  if(verifiedContent.get(hash)===entry)verifiedContent.delete(hash);
});
const sameCoordinates=(left,right)=>Object.is(left,right)
  ||Array.isArray(left)&&Array.isArray(right)&&left.length===right.length
    &&left.every((value,index)=>sameCoordinates(value,right[index]));

// A fingerprint selects a bucket only. Exact canonical coordinates admit
// sharing, even across unrelated documents and different local references.
function registerGeometryContent(value,hash){
  const hasVerifiedHash=typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash);
  const content=hasVerifiedHash&&verifiedContent.get(hash)?.deref();
  if(content){
    contentByGeometry.set(value,content);return;
  }
  const key=value.type+':'+geometryCoordinateFingerprint(value);
  let bucket=contentBuckets.get(key);
  if(!bucket){bucket=new Set();contentBuckets.set(key,bucket);}
  let accepted;
  for(const ref of bucket){
    const sibling=ref.deref();
    if(sibling&&sameCoordinates(sibling.geometry.coordinates,value.coordinates)){accepted=sibling;break;}
  }
  if(!accepted){
    accepted={id:++nextContentId,geometry:value};
    const entry=new WeakRef(accepted);
    bucket.add(entry);removeCollectedContent.register(accepted,{key,entry});
  }
  contentByGeometry.set(value,accepted);
  if(hasVerifiedHash){
    const entry=new WeakRef(accepted);
    verifiedContent.set(hash,entry);removeCollectedAsset.register(accepted,{hash,entry});
  }
}
// A verified content identity is not a fallback fingerprint.
export function immutableGeometryContentKey(value){
 const content=contentByGeometry.get(value);
 return content?'canonical:'+content.id:null;
}
export function admittedGeometryKey(value){
  const content=contentByGeometry.get(value);
  return content?'canonical:'+content.id:geometryRevisionKey(value);
}
function geometry(value, validateRing, admitted,verifiedHash) {
  if (admitted.has(value)) return value;
  fields(value, ['type', 'coordinates']);
  const copy = structuredClone(value), c = copy.coordinates;
  switch (copy.type) {
    case 'Point': point(c); break;
    case 'MultiPoint': list(c, 1); for (const p of c) point(p); break;
    case 'LineString': line(c); break;
    case 'MultiLineString': list(c, 1); for (const path of c) line(path); break;
    case 'Polygon': polygon(c, validateRing); break;
    case 'MultiPolygon': list(c, 1); for (const p of c) polygon(p, validateRing); break;
    default: invalid('Unsupported geometry type.');
  }
  // Structural validation matches GeometryStore::insert in the native core.
  // Topology/partition checks remain the editing owner's responsibility.
  freeze(copy);
  registerGeometryContent(copy,verifiedHash);
  admitted.add(copy);
  return copy;
}
const encoder = new TextEncoder();
function compareIds(a, b) {
  const left = encoder.encode(a), right = encoder.encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

/** Append-only geometry registry. Restoration constructs an isolated candidate. */
function createStore(entries, { reuse = null, verifiedContentHashes = null }, validateRing, admitted) {
  if (!Array.isArray(entries)) invalid('Geometry versions must be an array.');
  const versions = new Map();
  function insert(ref, value) {
    const key = reference(ref);
    if (versions.has(key)) fail('DUPLICATE_ID', 'Geometry version already exists.');
    const validated = geometry(value, validateRing, admitted,verifiedContentHashes?.get(key));
    const previous = reuse?.get(ref);
    const geojson = previous && admitted.has(previous) && contentByGeometry.get(previous)===contentByGeometry.get(validated) ? previous : validated;
    if (!geometryReferences.has(geojson)) geometryReferences.set(geojson, Object.freeze({ id: ref.id, version: ref.version }));
    // No registry changes are made until validation and copying have succeeded.
    versions.set(key, Object.freeze({ id: ref.id, version: ref.version, geojson }));
  }
  for (const entry of entries) {
    fields(entry, ['id', 'version', 'geojson']);
    insert({ id: entry.id, version: entry.version }, entry.geojson);
  }
  return Object.freeze({
    insert,
    get: ref => versions.get(reference(ref))?.geojson ?? null,
    snapshot: () => Object.freeze([...versions.values()].sort((a, b) => compareIds(a.id, b.id) || a.version - b.version)),
  });
}

// Source ingress retains the historical admission contract, including its area gate.
export function createGeometryVersionStore(entries = [], options = {}) {
  return createStore(entries, options, ring, immutableGeometries);
}
// Persisted/generated data is revalidated by the same exact Core owner as clipped
// output. This is an explicit entrypoint, not a caller-controlled trust flag.
export function createCanonicalGeometryVersionStore(entries = [], options = {}) {
  return createStore(entries, options, canonicalRing, immutableCanonicalGeometries);
}
