import { packHydroFeatures, unpackHydroFeatures, geometryTransferBuffers, canPackExactGeometry } from './geometry-transfer-codec.js';
import { createGeometryByteEstimator } from './geometry-residency.js';

// Stable content keys are supplied only by the admitted immutable geometry
// owner. Unbranded shapes use request-local identity, never a lossy hash.
export function createGeometryInputTransport({stableKey = () => null} = {}) {
  const knownByWorker = new WeakMap(); let sequence = 0;
  function encode(operation, payload, worker, force = false) {
    let known = knownByWorker.get(worker); if (!known) {known = new Set(); knownByWorker.set(worker, known);}
    const rows = [], refs = new Map(), sent = new Set(), persistent = [], request = ++sequence; let refHits = 0;
    const encodeRow = row => {
      if (!row?.geometry)return row;
      const geometry = row.geometry, stable = stableKey(geometry), existing = refs.get(geometry);
      const key = existing??stable??'request:'+request+':'+rows.length;
      if (!existing) {
        if (!force&&stable&&known.has(key))refHits++;
        else if (!sent.has(key)) {
          if (!canPackExactGeometry(geometry))return row;
          sent.add(key); rows.push({type:'Feature', id:key, properties:{}, geometry});
          if (stable)persistent.push(key);
        }
        refs.set(geometry, key);
      }
      const {geometry:unused, ...rest} = row;
      return {...rest, geometryInputRef:key};
    };
    let output;
    if (operation==='geometry.physical-land')output = encodeRow(payload);
    else if (operation==='geometry.prepare') {
      output = {...payload, items:payload.items.map(encodeRow)};
      if (payload.boundary)output.boundary = {...payload.boundary, upserts:payload.boundary.upserts.map(encodeRow)};
    }else return {payload, transfer:[], bytes:0, refHits:0};
    if (!refs.size)return {payload, transfer:[], bytes:0, refHits:0};
    const packet = rows.length?packHydroFeatures(rows):null, transfer = packet?geometryTransferBuffers(packet):[];
    return {payload:{...output, geometryInputs:{packet, persistent}}, transfer,
      bytes:transfer.reduce((sum, buffer) => sum+buffer.byteLength, 0), refHits};
  }
  function accept(worker, result) {
    if (!Array.isArray(result?.retainedGeometryInputs))return;
    knownByWorker.set(worker, new Set(result.retainedGeometryInputs));
  }
  return {encode, accept, forget:worker => knownByWorker.delete(worker)};
}

// The receiver first admits all exact bytes and checks every reference,
// before changing country topology or starting any geometry computation.
export function createGeometryInputStore({byteBudget = 48*1024*1024, entryLimit = 256} = {}) {
  const entries = new Map(), estimate = createGeometryByteEstimator(); let bytes = 0, hits = 0, evictions = 0;
  function remember(key, geometry) {
    const cost = estimate(geometry);
    if (entries.has(key)) {bytes-=entries.get(key).cost; entries.delete(key);}
    if (cost>byteBudget)return;
    entries.set(key, {geometry, cost}); bytes+=cost;
    while (bytes>byteBudget||entries.size>entryLimit) {
      const id = entries.keys().next().value; bytes-=entries.get(id).cost; entries.delete(id); evictions++;
    }
  }
  function get(key) {
    const row = entries.get(key);
    if (!row)return null;
    hits++; entries.delete(key); entries.set(key, row); return row.geometry;
  }
  function hydrate(operation, payload) {
    if (!payload.geometryInputs)return {payload};
    const {packet, persistent} = payload.geometryInputs;
    if (!Array.isArray(persistent)||new Set(persistent).size!==persistent.length)throw new TypeError('Invalid geometry input receipt');
    const local = new Map();
    if (packet)for (const feature of unpackHydroFeatures(packet)) {
      if (typeof feature.id!=='string'||local.has(feature.id))throw new TypeError('Duplicate geometry input');
      local.set(feature.id, feature.geometry);
    }
    const pins = new Set(persistent);
    for (const key of pins)if (typeof key!=='string'||!local.has(key))throw new TypeError('Invalid persistent geometry input');
    const miss = new Set();
    const hydrateRow = row => {
      if (!Object.hasOwn(row,'geometryInputRef'))return row;
      const {geometryInputRef:key, ...rest} = row;
      if (typeof key!=='string'||Object.hasOwn(row,'geometry'))throw new TypeError('Invalid geometry reference');
      const geometry = local.get(key)||get(key);
      if (!geometry) {miss.add(key); return rest;}
      return {...rest, geometry};
    };
    const {geometryInputs:ignored, ...base} = payload;
    let result;
    if (operation==='geometry.physical-land')result = hydrateRow(base);
    else {
      result = {...base, items:base.items.map(hydrateRow)};
      if (base.boundary)result.boundary = {...base.boundary, upserts:base.boundary.upserts.map(hydrateRow)};
    }
    if (miss.size)return {missing:[...miss]};
    for (const key of pins)remember(key, local.get(key));
    return {payload:result};
  }
  return {hydrate, retained:() => [...entries.keys()], stats:() => ({geometryInputBytes:bytes, geometryInputBudget:byteBudget, geometryInputHits:hits, geometryInputEvictions:evictions})};
}
