import { createCanonicalGeometryVersionStore as createGeometryVersionStore } from '../geometry/geometry-version-store.js';
import { fields, refKey, invalid, freeze } from './core-read-contract.js';

const headerFields = new Set(['format','schemaVersion','version','savedAt','baseDataset','landObjectModel','territorialModel',
  'distributionModel','projectSetup','documentId','physicalSourceInfo','sourceInfo']);
const sameCoordinates = (left, right) => Array.isArray(left) && Array.isArray(right)
  ? left.length===right.length && left.every((value, index) => sameCoordinates(value, right[index]))
  : Object.is(left, right);

export function loadAcceptedStorage(value, reuse) {
  if (!value || !Array.isArray(value.geometries)) invalid('A complete accepted C++ storage snapshot is required after document load.');
  for (const field of Object.values(fields)) if (!Array.isArray(value[field]))
    invalid(`Required accepted C++ loaded domain is missing: ${field}`);
  const {geometries:geometryRows, ...properties} = value;
  const candidate = structuredClone(properties);
  const geometries = createGeometryVersionStore(geometryRows, {reuse});
  return {project:freeze({...candidate, geometries:geometries.snapshot()}), geometries};
}

export function candidateForGeometryAdmission(project, geometries, delta, verified) {
  if(!Array.isArray(delta.admitted)||!Array.isArray(delta.removed))
    invalid('A Core geometry resource receipt is required.');
  if(!delta.admitted.length&&!delta.removed.length)return null;
  const incoming=new Map((verified?.resources||[]).map(row=>[refKey(row),row]));
  const hashes=new Map((verified?.descriptors||[]).map(row=>[refKey(row),row.contentSha256]));
  const removed=new Set(delta.removed.map(refKey)),admitted=new Set();
  const rows=delta.admitted.map(ref=>{
    const key=refKey(ref),payload=incoming.get(key);
    if(!payload||admitted.has(key)||removed.has(key)||geometries.get(ref))
      invalid('Core geometry receipt does not match the submitted immutable resource.');
    admitted.add(key);
    return {id:ref.id,version:ref.version,geojson:JSON.parse(payload.source)};
  });
  for(const ref of delta.removed)if(!geometries.get(ref))invalid('Unknown evicted geometry resource.');
  const entries=project.geometries.filter(row=>!removed.has(refKey(row))).concat(rows);
  const next=createGeometryVersionStore(entries,{reuse:geometries,verifiedContentHashes:hashes});
  return {project:freeze({...project,geometries:next.snapshot()}), geometries:next};
}

export function candidateForDelta(project, geometries, provenance, delta, verifiedResources) {
  for (const field of ['objects','geometries','removedGeometryRefs'])
    if (!Array.isArray(delta[field])) invalid(`Required C++ delta collection is missing: ${field}`);
  for (const field of ['timelineRecords','presentation','provenance','header'])
    if (!Object.hasOwn(delta, field)) invalid(`Required C++ delta field is missing: ${field}`);
  if (!delta.orders || typeof delta.orders !== 'object') invalid('Authoritative C++ domain orders are required.');
  const candidate = { ...project };
  const grouped = new Map();
  for (const row of delta.objects) {
    const field = fields[row.ref.domain];
    if (!field || typeof row.ref.id !== 'string') invalid('Unsupported C++ object delta identity.');
    if (!grouped.has(field)) grouped.set(field, []);
    grouped.get(field).push(row);
  }
  for (const [field, rows] of grouped) {
    const changed = new Set(rows.map(row => row.ref.id));
    if (changed.size !== rows.length) invalid('Duplicate C++ object delta identity.');
    const values = project[field].filter(value => !changed.has(value.id));
    for (const row of rows.filter(row => row.value !== null).sort((a, b) => a.index - b.index)) {
      if (!Number.isInteger(row.index) || row.index < 0 || row.index > values.length || row.value.id !== row.ref.id)
        invalid('Authoritative C++ object delta vector index/value is required.');
      values.splice(row.index, 0, freeze(structuredClone(row.value)));
    }
    candidate[field] = Object.freeze(values);
  }
  for (const [domain, field] of Object.entries(fields)) {
    const order = delta.orders[domain], values = candidate[field];
    if (!Array.isArray(order) || order.length !== values.length || new Set(order).size !== order.length)
      invalid(`Invalid authoritative C++ domain order: ${domain}`);
    const byId = new Map(values.map(value => [value.id, value]));
    if (order.some(id => typeof id !== 'string' || !byId.has(id))) invalid(`Unknown C++ domain order identity: ${domain}`);
    if (order.some((id, index) => values[index].id !== id)) candidate[field] = Object.freeze(order.map(id => byId.get(id)));
  }
  let nextGeometries = geometries;
  if (delta.geometries.length || delta.removedGeometryRefs.length) {
    const removed = new Set(delta.removedGeometryRefs.map(refKey));
    const admitted = new Set();
    for (const entry of delta.geometries) {
      const key = refKey(entry);
      if (admitted.has(key)) invalid('Duplicate C++ geometry delta version.');
      admitted.add(key);
      const existing = geometries.get({ id: entry.id, version: entry.version });
      if (existing && (existing.type!==entry.geojson?.type
        || !sameCoordinates(existing.coordinates, entry.geojson.coordinates)))
        invalid('A C++ geometry delta cannot replace the coordinates of an existing immutable version.');
    }
    // Canonical archive admission can expose an already-stored reference.
    // Upsert its identical version while retaining the geometry allocation.
    const entries = project.geometries.filter(row => !removed.has(refKey(row)) && !admitted.has(refKey(row))).concat(delta.geometries);
    const verifiedContentHashes = verifiedResources&&new Map(verifiedResources.map(row => [refKey(row), row.contentSha256]));
    nextGeometries = createGeometryVersionStore(entries, { reuse: geometries, verifiedContentHashes });
    candidate.geometries = nextGeometries.snapshot();
  }
  if (delta.timelineRecords !== null) candidate.timelineRecords = freeze(structuredClone(delta.timelineRecords));
  if (delta.presentation !== null) Object.assign(candidate, freeze(structuredClone(delta.presentation)));
  if (delta.header!==null) {
    const { set, removedKeys } = delta.header;
    if (!set || typeof set!=='object' || Array.isArray(set) || !Array.isArray(removedKeys)
      || new Set(removedKeys).size!==removedKeys.length || [...Object.keys(set), ...removedKeys].some(key => !headerFields.has(key))
      || removedKeys.some(key => Object.hasOwn(set, key))) invalid('A disjoint authoritative C++ root-field patch is required.');
    for (const key of removedKeys) delete candidate[key];
    Object.assign(candidate, freeze(structuredClone(set)));
  }
  const nextProvenance = delta.provenance === null ? provenance : freeze(structuredClone(delta.provenance));
  return { project: freeze(candidate), geometries: nextGeometries, provenance: nextProvenance };
}
