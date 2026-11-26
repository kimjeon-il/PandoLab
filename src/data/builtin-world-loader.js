import { trackPending } from '../runtime/async-request.js';
import { createStoredAssetLoader } from './stored-asset-loader.js';
import { createBuiltinProjectSetup } from '../document/project-setup.js';
import { normalizeTemporalInterval } from '../document/temporal.js';
import { builtinGeometryKey as geometryKey, queryMonthEnd, resolveBuiltinWorldGeometry,
  selectBuiltinCountries, assembleBuiltinWorld } from './builtin-world-catalog.js';
import { builtinCountryAssets, validateBuiltinReadIndex } from './builtin-country-files.js';
import { PROJECT_SCHEMA_VERSION } from '../runtime/version-contract.js';
import { resolveBuiltinGeometryPacks } from './builtin-geometry-pack-receipt.js';

export { selectBuiltinCountries, assembleBuiltinWorld, resolveBuiltinWorldGeometry };

// The verified country catalog provides source coverage. The project retains
// every original temporal interval; C++ owns month-end selection.
export function createBuiltinWorldLoader({manifestUrl, manifestSpec, dataRevision, startupGeometryPacks = null, assetRoot, fetchFn = globalThis.fetch, cacheStorage = globalThis.caches}) {
  if (!manifestUrl||!manifestSpec?.sha256||!dataRevision)throw new Error('Builtin country catalog integrity metadata is required');
  const base = new URL(manifestUrl, globalThis.location?.href), parse = bytes => JSON.parse(new TextDecoder().decode(bytes));
  const assetOptions = {dataRevision, fetchFn, cacheStorage, resolveUrl:spec => new URL(spec.url, base).href};
  // The mutable catalog belongs to a revision. Content-hashed countries do not:
  // unchanged files must survive a newer catalog/data revision without refetching.
  const catalogs = createStoredAssetLoader(assetOptions);
  const assets = createStoredAssetLoader({...assetOptions, cachePolicy:'immutable'});
  let indexPromise, readMetadata, geometryAssetsByRef;
  const geometries = new Map(), pending = new Map(), geometryStates = new Map();
  let activeReads = 0;
  const readQueue = [];
  async function limitedRead(operation) {
    if (activeReads===6)await new Promise(resolve => readQueue.push(resolve)); else activeReads++;
    try {return await operation();}finally {if (readQueue.length)readQueue.shift()(); else activeReads--;}
  }
  function parseIndex(bytes) {
    const value = parse(bytes); builtinCountryAssets(value);
    if (value.template?.schemaVersion!==PROJECT_SCHEMA_VERSION||value.template?.format!=='pandolab-project-state'
        ||Object.hasOwn(value.template,'projectSetup'))throw new Error('Invalid builtin world index');
    const read = validateBuiltinReadIndex(value);
    const freeze = value => {if (value&&typeof value==='object'&&!Object.isFrozen(value)) {for (const child of Object.values(value))freeze(child); Object.freeze(value);}return value;};
    freeze(read); freeze(value.template);
    readMetadata = {...value.template, territorialEntities:read.identities, timelineRecords:read.records,
        geometryResources:freeze(value.geometryAssets.map(({id, version, type, contentSha256, decodedBytes}) => ({id, version, type, contentSha256, decodedBytes})))};
    for (const row of value.entities) {
      if (!Array.isArray(row.coverage))throw new Error('Invalid builtin country coverage descriptor');
      for (const interval of row.coverage) {
        if (!interval||!['validFrom','validTo'].every(key => interval[key]===null||typeof interval[key]==='string'&&interval[key].trim()))throw new Error('Invalid builtin country coverage descriptor');
        normalizeTemporalInterval(interval.validFrom, interval.validTo);
      }
    }
    geometryAssetsByRef = new Map(value.geometryAssets.map(asset => [geometryKey(asset), asset]));
    return value;
  }
  async function loadIndex() {
    if (!indexPromise)indexPromise = catalogs.loadAsset({...manifestSpec, url:base.href},'builtin-world','index','국가 자료 목록', parseIndex)
      .then(({value}) => value).catch (error => {indexPromise = null; throw error;});
    return indexPromise;
  }
  async function loadGeometry(asset) {
    const key = asset.file;
    if (geometries.has(key))return geometries.get(key);
    const existing = pending.get(key);
    if (existing)return (await existing)??loadGeometry(asset);
    geometryStates.set(key,'loading');
    const reading = limitedRead(() => assets.loadAsset({...asset, url:asset.file},
      'builtin-world', asset.id,'국가 형상', buffer => decodeGeometryContent(buffer, asset)))
      .then(({value}) => {geometries.set(key, value); geometryStates.set(key,'ready'); return value;})
      .catch (error => {geometryStates.set(key,'error'); throw error;});
    return trackPending(pending, key, reading);
  }
  async function decodeGeometryContent(buffer, asset) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
    const actual = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2,'0')).join('');
    if (actual!==asset.contentSha256)throw Error('Builtin geometry content hash mismatch: '+asset.id);
    return new TextDecoder('utf-8', {fatal:true}).decode(buffer);
  }
  function loadPack({spec, members}) {
    const missing = members.filter(({asset}) => !geometries.has(asset.file)&&!pending.has(asset.file));
    if (!missing.length)return;
    const done = limitedRead(() => assets.loadStoredAsset({...spec, url:new URL(spec.url, assetRoot).href},
      'builtin-world', spec.sha256,'국가 형상 묶음', async buffer => {
        const rows = [];
        for (const {asset, start, end} of missing) {
          const {value} = await assets.decodeStoredAsset(buffer.slice(start, end), {...asset, maxDecodedBytes:asset.decodedBytes},
            'builtin-world', asset.id,'국가 형상', decoded => decodeGeometryContent(decoded, asset));
          rows.push({asset, value});
        }
        return rows;
      })).then(({value}) => {
        for (const {asset, value:source} of value) {geometries.set(asset.file, source); geometryStates.set(asset.file,'ready');}
      }).catch (() => {
        // The individual catalog assets remain the recovery path for this group.
        for (const {asset} of missing)geometryStates.delete(asset.file);
      });
    for (const {asset} of missing) {
      trackPending(pending, asset.file, done.then(() => geometries.get(asset.file)));
      geometryStates.set(asset.file,'loading');
    }
    return done;
  }
  async function loadGeometryResources(requirements, {isCurrent = () => true} = {}) {
    await loadIndex();
    const rows = await Promise.all(requirements.map(async requirement => {
      if (!isCurrent())throw Object.assign(Error('Builtin geometry request superseded'), {name:'AbortError', cancelled:true});
      const asset = geometryAssetsByRef.get(geometryKey(requirement));
      if (!asset||['type','contentSha256','decodedBytes'].some(key => asset[key]!==requirement[key]))throw Error('Builtin geometry requirement does not match pinned catalog');
      return {id:asset.id, version:asset.version, source:await loadGeometry(asset)};
    }));
    if (!isCurrent())throw Object.assign(Error('Builtin geometry request superseded'), {name:'AbortError', cancelled:true});
    return rows;
  }
  async function geometryState(ref) {
    await loadIndex();
    const asset = geometryAssetsByRef.get(geometryKey(ref));
    if (!asset)throw Error('Unknown builtin geometry reference');
    return geometryStates.get(asset.file)||'unloaded';
  }
  async function loadProject(month, {isCurrent = () => true, concurrency = 6, waitForIdle = null} = {}) {
    if (!Number.isInteger(concurrency)||concurrency<1||concurrency>6)throw new RangeError('Builtin country read concurrency must be 1-6.');
    const assertCurrent = () => {if (!isCurrent())throw Object.assign(new Error('Builtin query superseded'), {name:'AbortError', cancelled:true});};
    assertCurrent();
    const index = await loadIndex(); assertCurrent();
    async function loadAll(selected, read) {
    let next = 0, failed = false;
    const workers = Array.from({length:Math.min(concurrency, selected.length)}, async() => {
      try {
        while (!failed&&next<selected.length) {
          assertCurrent();
          if (waitForIdle) {await waitForIdle(); assertCurrent();}
          if (failed||next>=selected.length)break;
          const i = next++; await read(selected[i]); assertCurrent();
        }
      }catch (error) {failed = true; throw error;}
    });
    try {await Promise.all(workers);}
    catch (error) {
      // An immediate retry must not join another worker's still-pending failure.
      // Superseded queries do not wait: their shared reads may serve the next query.
      if (error?.name!=='AbortError')await Promise.allSettled(workers);
      throw error;
    }
    }
    // Published metadata is immutable. Only active geometry is loaded; no
    // country-document reconstruction or parallel runtime model is retained.
    queryMonthEnd(month);
    const project = {...readMetadata, projectSetup:createBuiltinProjectSetup(month), geometries:[]};
    const required = new Map(resolveBuiltinWorldGeometry(index, index.readIndex, month).map(({asset}) => [geometryKey(asset), asset]));
    let packs = [];
    if (startupGeometryPacks&&startupGeometryPacks.catalogSha256===manifestSpec.sha256) {
      try {packs = resolveBuiltinGeometryPacks(startupGeometryPacks, manifestSpec.sha256, index.geometryAssets);}
      catch{ /* An invalid acceleration receipt leaves individual assets available. */ }
    }
    const files = new Map([...required.values()].map(asset => [asset.file, asset]));
    const eligible = packs.filter(pack => pack.members.every(({asset}) => files.has(asset.file)));
    const packed = new Set(eligible.flatMap(pack => pack.members.map(({asset}) => asset.file)));
    const reads = eligible.filter(pack => pack.members.some(({asset}) => !geometries.has(asset.file))).map(pack => () => loadPack(pack));
    for (const asset of files.values())if (!packed.has(asset.file)&&!geometries.has(asset.file))reads.push(() => loadGeometry(asset));
    await loadAll(reads, read => read());
    // A failed pack or a concurrent pack reader may leave individual members outstanding.
    const outstanding = [...files.values()].filter(asset => !geometries.has(asset.file));
    await loadAll(outstanding, loadGeometry);
    project.geometries = Array.from(required.values(), asset => ({id:asset.id, version:asset.version, source:geometries.get(asset.file)}));
    if (waitForIdle)await waitForIdle();
    assertCurrent();
    return {project, fingerprint:`${manifestSpec.sha256}:complete-timeline`};
  }
  return Object.freeze({loadIndex, loadProject, loadGeometryResources, geometryState});
}
