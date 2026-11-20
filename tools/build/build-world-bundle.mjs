import { canonicalSharedBoundaryPath, validateScopedRetirementDerivation, WORLD_BUNDLE_ROLES as ROLES, contentAddress } from '../../src/data/world-bundle-manifest.js';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { resolve, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProjectGenerationContext, readProjectWorldGenerationContext } from './project-generation-context.mjs';
import { gunzipSync } from 'node:zlib';

export const WORLD_BUNDLE_SCHEMA = 'pandolab-world-bundle';
export const WORLD_BUNDLE_FORMAT = 1;
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertDataPath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\')
    || value.includes('?') || value.includes('#') || value.includes('\0')
    || posix.normalize(value) !== value || value.split('/').some(part => part === '.' || part === '..' || !part)) {
    throw new Error(`Unsafe world asset path: ${value}`);
  }
  return value;
}

export function bundleDescriptor({ seed, legacy, assets, sourceBytes, sourceSha256 = null }) {
  if (seed?.schema !== 'pandolab-world-build-input' || seed?.schemaVersion !== 1) throw new Error('Invalid world build input');
  if (!Number.isSafeInteger(legacy?.countries) || legacy.countries <= 0 || legacy?.source !== seed.canonicalSource || !legacy.defaultClassification) throw new Error('Incompatible legacy world manifest');
  const sourceDigest = sourceSha256 || sha256(sourceBytes);
  if (sourceDigest !== legacy.sourceSha256 || sourceDigest !== legacy.canonicalSourceSha256) throw new Error('Stale canonical world source');
  const outAssets = {};
  for (const role of Object.keys(ROLES)) {
    const old = legacy.assets?.[role];
    const bytes = assets?.[role];
    if (!old || !bytes || !old.url || !['gzip', 'identity'].includes(old.encoding)) throw new Error(`Missing world asset: ${role}`);
    assertDataPath(old.url);
    const currentDigest = sha256(bytes);
    if (old.sha256 !== currentDigest || old.compressedBytes !== bytes.length) throw new Error(`World asset digest/size mismatch: ${role}`);
    const decoded = old.encoding === 'gzip' ? gunzipSync(bytes) : bytes;
    if (old.decodedBytes !== decoded.length) throw new Error(`World decoded size mismatch: ${role}`);
    if (old.header) {
      if (!Array.isArray(old.header) || decoded.length < old.header.length * 4) throw new Error(`World packet header truncated: ${role}`);
      const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
      if (old.header.some((n, i) => n !== view.getUint32(i * 4, true))) throw new Error(`World packet header mismatch: ${role}`);
    }
    outAssets[role] = {
      url: contentAddress(role, currentDigest), encoding: old.encoding,
      compressedBytes: bytes.length, decodedBytes: decoded.length, sha256: currentDigest,
      ...(old.header ? { header: old.header } : {}),
    };
  }
  const canonicalBoundary = canonicalSharedBoundaryPath(seed.sharedBoundaries);
  return {
    schema: WORLD_BUNDLE_SCHEMA, schemaVersion: WORLD_BUNDLE_FORMAT,
    source: { url: seed.canonicalSource, sha256: sourceDigest, countryCount: legacy.countries },
    derivation: { coordinateCount: legacy.coordinateCount,
      meshAlgorithmRevision: legacy.meshAlgorithmRevision },
    defaultClassification: legacy.defaultClassification,
    assets: outAssets,
    compatibility: { sharedBoundaries: canonicalBoundary ? { canonical: canonicalBoundary } : {} },
  };
}


/** Published Viewer verification never loads the private GIS generation recipe.
 * This verifies only the exact signed runtime byte closure, not source derivation. */
export function verifyPublishedWorldBundle({root,catalogPath='assets/data/world/current.json'}={}) {
  if(!root)throw new TypeError('Repository root required');
  const data=resolve(root,'assets/data');
  const catalogue=JSON.parse(readFileSync(resolve(root,catalogPath),'utf8'));
  if(catalogue?.schema!==WORLD_BUNDLE_SCHEMA||catalogue.schemaVersion!==WORLD_BUNDLE_FORMAT
    ||!/^[a-f0-9]{64}$/.test(catalogue.source?.sha256||'')
    ||!Number.isSafeInteger(catalogue.source?.countryCount)||catalogue.source.countryCount<=0
    ||!catalogue.defaultClassification?.countries)
    throw new TypeError('Invalid published world catalogue');
  assertDataPath(catalogue.source.url);
  function verified(asset,role) {
    const retiredScene = role === 'preparedCountryScene';
    if(!asset||!/^[a-f0-9]{64}$/.test(asset.sha256||'')
      ||!['gzip','identity'].includes(asset.encoding)
      ||(retiredScene&&asset.encoding!=='gzip')
      ||!Number.isSafeInteger(asset.compressedBytes)||asset.compressedBytes<=0
      ||!Number.isSafeInteger(asset.decodedBytes)||asset.decodedBytes<=0)
      throw new TypeError('Invalid published world resource: '+role);
    assertDataPath(asset.url);
    const expectedUrl = retiredScene ? `world/objects/country-scene-sha256-${asset.sha256}.bin.gz` : contentAddress(role,asset.sha256);
    if(asset.url!==expectedUrl)
      throw new Error('Published world content address mismatch: '+role);
    const stored=readFileSync(resolve(data,asset.url));
    if(stored.byteLength!==asset.compressedBytes||sha256(stored)!==asset.sha256)
      throw new Error('Published world asset integrity mismatch: '+role);
    const decoded=asset.encoding==='gzip'?gunzipSync(stored):stored;
    if(decoded.length!==asset.decodedBytes)
      throw new Error('Published world decoded length mismatch: '+role);
    if(asset.header) {
      if(!Array.isArray(asset.header)||decoded.byteLength<asset.header.length*4)
        throw new Error('Published world packet header truncated: '+role);
      const view=new DataView(decoded.buffer,decoded.byteOffset,decoded.byteLength);
      if(asset.header.some((word,index)=>word!==view.getUint32(index*4,true)))
        throw new Error('Published world packet header mismatch: '+role);
    }
  }
  for(const role of Object.keys(ROLES))verified(catalogue.assets?.[role],role);
  const scopedRetirement=validateScopedRetirementDerivation(catalogue.derivation);
  const retiredScene=catalogue.assets?.preparedCountryScene;
  if(scopedRetirement&&(retiredScene!==undefined||Object.keys(catalogue.compatibility?.sharedBoundaries||{}).length))throw Error('Scoped retirement caches must be detached');
  if(retiredScene!==undefined)verified(retiredScene,'preparedCountryScene');
  const reference=canonicalSharedBoundaryPath(catalogue.compatibility?.sharedBoundaries);
  if(reference&&!statSync(resolve(data,reference),{throwIfNoEntry:false})?.isFile())
    throw new Error('Missing published shared boundary: canonical');
  return {bundle:catalogue,validatedAssets:Object.keys(ROLES).length+Number(retiredScene!==undefined),
    check:true,sourceFree:true};
}

export async function publishWorldBundle({ root, check = false, manifestOverride = null, projectId = null } = {}) {
  if (!root) throw new Error('Repository root required');
  const data = resolve(root, 'assets/data');
  const readData = name => readFileSync(resolve(data, assertDataPath(name)));
  const project=projectId?readProjectGenerationContext({root,projectId}):null;
  const recipePath=project?project.source('worldBuildRecipe'):'assets/data/world/build-input.json';
  if(check&&!manifestOverride&&!existsSync(resolve(root,recipePath)))
    return verifyPublishedWorldBundle({root,
      catalogPath:project?.catalogs.world||'assets/data/world/current.json'});
  const { loadBoundedCurrentWorld, hashFileInChunks } = await import('../data/current-world-bounded-loader.mjs');
  const selected=projectId?readProjectWorldGenerationContext({root,projectId}):null;
  const seedPath=selected?resolve(root,selected.worldRecipePath):resolve(data,'world/build-input.json');
  const seed=selected?structuredClone(selected.worldRecipe):JSON.parse(readFileSync(seedPath,'utf8'));
  if (manifestOverride && check) throw new Error('Cannot override build input in --check mode');
  if (manifestOverride) {
    if(selected?.projectId!=='default-world' && selected
      && !manifestOverride.startsWith(selected.projectId+'/'))
      throw new TypeError('Nondefault project cannot publish a shared world source descriptor');
    seed.legacyPreviewManifest = assertDataPath(manifestOverride);
  }
  const legacy = JSON.parse(readData(seed.legacyPreviewManifest));
  const sourcePath=resolve(data,assertDataPath(seed.canonicalSource));
  const source=loadBoundedCurrentWorld(sourcePath);
  const {sha256:sourceSha256}=hashFileInChunks(sourcePath);
  if (source?.type !== 'FeatureCollection' || source.features?.length !== legacy.countries
      || new Set(source.features.map(feature => String(feature.id))).size !== legacy.countries) throw new Error('Invalid world canonical source');
  const original = {};
  for (const role of Object.keys(ROLES)) original[role] = readData(legacy.assets?.[role]?.url);
  const bundle = bundleDescriptor({ seed, legacy, assets: original, sourceSha256 });
  const currentPath = selected ? resolve(root,selected.catalogs.world) : resolve(data,'world/current.json');
  const expected = `${JSON.stringify(bundle, null, 2)}\n`;
  if (check) {
    if (!existsSync(currentPath) || readFileSync(currentPath, 'utf8') !== expected) throw new Error('Stale world/current.json');
  }
  const publish = () => { for (const role of Object.keys(ROLES)) {
    const target = resolve(data, bundle.assets[role].url);
    const bytes = original[role];
    if (existsSync(target)) {
      if (sha256(readFileSync(target)) !== sha256(bytes)) throw new Error(`Immutable world asset corrupted: ${role}`);
    } else if (check) throw new Error(`Missing immutable world asset: ${role}`);
    else {
      mkdirSync(dirname(target), { recursive: true });
      const temp = `${target}.tmp-${process.pid}`;
      try { writeFileSync(temp, bytes, { flag: 'wx' }); renameSync(temp, target); }
      finally { if (existsSync(temp)) unlinkSync(temp); }
    }
  }
  if (!check) {
    mkdirSync(dirname(currentPath), { recursive: true });
    const temp = `${currentPath}.tmp-${process.pid}`;
    try { writeFileSync(temp, expected, { flag: 'wx' }); renameSync(temp, currentPath); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
    if (manifestOverride) writeFileSync(seedPath, `${JSON.stringify(seed, null, 2)}\n`);
  }
  };
  if (check) publish();
  else {
    const { withLibraryOutputs } = await import('../data/library-runtime.mjs');
    withLibraryOutputs({ root, paths: [currentPath, ...(manifestOverride ? [seedPath] : []), ...Object.values(bundle.assets).map(asset => resolve(data, asset.url)).filter(path => !existsSync(path))] }, publish);
  }
  return { bundle, validatedAssets: Object.keys(ROLES).length, check };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const check = process.argv.includes('--check');
  const arg = process.argv.find(value => value.startsWith('--source-manifest='));
  try {
    const projectId=process.argv.find(value=>value.startsWith('--project='))?.slice('--project='.length)||'default-world';
    const result = await publishWorldBundle({ root, projectId, check, manifestOverride: arg?.slice('--source-manifest='.length) || null });
    console.log(JSON.stringify({ mode: result.sourceFree ? 'check-published' : check ? 'check' : 'build', worldDataVersion: result.bundle.source.sha256,
      assets: result.validatedAssets, programVersionDependency: false }));
  } catch (error) {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  }
}
