import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { decodeHydroIndex, decodeHydroMetadata, decodeHydroPack } from '../../src/data/hydro-pack.js';
import { encodeHydroRepairPlan } from './hydro-encoding-native.mjs';
import { buildHydroPack } from './hydro-pack-layout.mjs';
import { GRWL_DATASET, GRWL_SOURCE, prepareGrwlFeatures, prepareReviewedGrwlMainstems } from './grwl-hydro.mjs';
import { readGrwlRiverArchive } from './hydro-source-reader.mjs';

export const GRWL_HYDRO_VERSION = '0.14.0';
export const GRWL_HYDRONYM_VERSION = '0.14.1';
export const GRWL_MAINSTEM_VERSION = '0.14.2';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function applyGrwlHydronyms({ manifest, binary, bindings }) {
  if (manifest.version !== GRWL_HYDRO_VERSION || manifest.sources.grwl?.sha256 !== GRWL_SOURCE.sha256 ||
      binary.length !== manifest.container.bytes || digest(binary) !== manifest.container.sha256) {
    throw Error('GRWL hydronyms require the original GRWL Viewer edition');
  }
  const next = structuredClone(manifest);
  const specs = [next.index, next.metadata.core, next.metadata.detail, ...next.shards];
  const chunks = specs.map(spec => {
    const bytes = binary.subarray(spec.offset, spec.offset + spec.bytes);
    if (bytes.length !== spec.bytes || digest(bytes) !== spec.sha256) throw Error('Hydro section hash differs');
    return bytes;
  });
  const core = JSON.parse(gunzipSync(chunks[1]));
  const detail = JSON.parse(gunzipSync(chunks[2]));
  const coreByFid = new Map(core.features.map(row => [row.fid, row]));
  const byObjectId = new Map(detail.features.filter(row => row.source === GRWL_DATASET)
    .map(row => [Number(row.sourceId), row]));
  const used = new Set();
  for (const { objectId, name, aliases, sourceUrls } of bindings) {
    if (!Number.isSafeInteger(objectId) || objectId <= 0 || used.has(objectId) ||
        typeof name !== 'string' || !name.trim() ||
        !Array.isArray(aliases) || !aliases.length || !aliases.every(alias => typeof alias === 'string' && alias.trim()) ||
        !Array.isArray(sourceUrls) || !sourceUrls.length ||
        !sourceUrls.every(url => typeof url === 'string' && /^https:\/\//.test(url) && !/openstreetmap|overpass/i.test(url))) {
      throw Error('Invalid independently sourced GRWL hydronym');
    }
    used.add(objectId);
    const info = byObjectId.get(objectId);
    const row = coreByFid.get(info?.fid);
    if (row?.category !== 'river' || row.awId !== `hydro-grwl:V01.02:${objectId}` || row.name || row.mainstemNameKo) {
      throw Error('GRWL reach is no longer unnamed: ' + objectId);
    }
    row.name = name;
    row.mainstemNameKo = name;
    info.aliases = aliases;
    info.independentSourceUrls = sourceUrls;
  }
  if (!used.size) throw Error('No reviewed GRWL hydronyms');
  chunks[1] = gzipSync(JSON.stringify(core), { level: 9 });
  chunks[2] = gzipSync(JSON.stringify(detail), { level: 9 });
  let offset = 0;
  for (const [index, spec] of specs.entries()) {
    const bytes = chunks[index];
    Object.assign(spec, { offset, bytes: bytes.length, sha256: digest(bytes) });
    offset += bytes.length;
  }
  const packed = Buffer.concat(chunks);
  Object.assign(next.container, { bytes: packed.length, sha256: digest(packed) });
  next.version = GRWL_HYDRONYM_VERSION;
  next.cache.name = 'pandolab-water-v' + next.version + '-' + next.container.sha256.slice(0, 16);
  next.stats.compressedBytes = packed.length;
  next.sources.reviewedGrwlHydronyms = {
    packageVersion: manifest.version,
    packageSha256: manifest.container.sha256,
    bindings,
  };
  return { manifest: next, binary: packed };
}

async function readPreviousEdition(path) {
  const manifest = JSON.parse(await readFile(path,'utf8'));
  return readHydroEdition(manifest, await readFile(resolve(dirname(path),manifest.container.url)));
}

function readHydroEdition(manifest, stored, onEncodedFeature) {
  if (manifest.schema !== 'pandolab-water-shards-v5' || manifest.container?.url !== 'hydro.bin') {
    throw Error('An explicit current Hydro container is required');
  }
  if (stored.length !== manifest.container.bytes || digest(stored) !== manifest.container.sha256) {
    throw Error('Hydro baseline container hash differs');
  }
  const section = spec => {
    const bytes = stored.subarray(spec.offset,spec.offset + spec.bytes);
    if (bytes.length !== spec.bytes || digest(bytes) !== spec.sha256) throw Error('Hydro section hash differs');
    return bytes;
  };
  const metadata = decodeHydroMetadata(gunzipSync(section(manifest.metadata.core)));
  for (const detail of decodeHydroMetadata(gunzipSync(section(manifest.metadata.detail))).values()) {
    Object.assign(metadata.get(detail.fid),detail);
  }
  const { packSpecs } = decodeHydroIndex(gunzipSync(section(manifest.index)));
  const shards = new Map(manifest.shards.map(spec => [spec.id,section(spec)]));
  const existing = [];
  for (const spec of packSpecs.values()) {
    const bytes = shards.get(spec.shard).subarray(spec.offset,spec.offset + spec.length);
    for (const feature of decodeHydroPack(gunzipSync(bytes),spec.id,{ featureMetadata:metadata,stages:manifest.stages,onEncodedFeature })) {
      const meta = metadata.get(feature.properties.__fid);
      existing.push({ metadata:meta,geometry:feature.geometry,widths:feature.properties.stroke_widths.length
        ? feature.properties.stroke_widths : undefined });
    }
  }
  return { manifest, existing };
}

function packContainer(pack) {
  const layout = structuredClone(pack.layout);
  const parts = [layout.index,layout.metadata.core,layout.metadata.detail,...layout.shards];
  let offset = 0;
  const binary = Buffer.concat(parts.map(part => {
    const bytes = pack.files.get(part.url);
    Object.assign(part,{ url:'hydro.bin',offset });
    offset += bytes.length;
    return bytes;
  }));
  const hash = digest(binary);
  const container = { url:'hydro.bin',bytes:binary.length,sha256:hash,
    format:'byte-concatenated-subresources-v1',
    roles:['index','metadata-core','metadata-detail',...layout.shards.map(shard => 'shard-'+shard.id)] };
  return { layout, binary, container };
}

function makeContainer(pack,baseline,sourceClasses) {
  const { layout, binary, container } = packContainer(pack);
  const lakeReference = {
    ...baseline.sources.naturalEarthLakes,
    packageVersion:baseline.version,
    packageSha256:baseline.container.sha256,
  };
  const manifest = {
    version:GRWL_HYDRO_VERSION, schema:baseline.schema, crs:baseline.crs,
    dataset:GRWL_DATASET + ' · Natural Earth 5.0.0 1:10m lakes',
    coordinatePolicy:'GRWL source vertices quantized to 1e-6 degree; reviewed Nakdong bifurcation shares its junction; baseline lake geometry retained',
    selection:{
      rivers:'GRWL centerline records except class 1 (lake or reservoir)',
      riverStages:'Width-ranked within baseline river coordinate budgets; remaining reaches at detail stage',
      riverWidth:'clamp(0.55 + 0.48 * log2(max(1, width_m / 90)), 0.55, 2.6)',
      identity:'Reviewed lower Nakdong reaches or at least 80% of sampled coordinates matching one named mainstem',
      lakes:'Baseline lake records and display thresholds',
    },
    stages:baseline.stages, format:baseline.format,
    index:layout.index, metadata:layout.metadata, shards:layout.shards,
    cache:{ ...baseline.cache,name:'pandolab-water-v'+GRWL_HYDRO_VERSION+'-'+container.sha256.slice(0,16) },
    layers:baseline.layers, stats:pack.stats,
    sources:{ grwl:{ ...GRWL_SOURCE,classes:sourceClasses,reviewedJunctions:[{upstream:13029,branches:[13030,13032]}] },naturalEarthLakes:lakeReference,
      inheritedNames:{ packageVersion:baseline.version,packageSha256:baseline.container.sha256 } },
    container,
    lakeDisplayMinZoom:baseline.lakeDisplayMinZoom,
  };
  return { manifest, binary };
}

export async function buildGrwlMainstemEdition({ manifest, binary, archive, bindings, review }, options={}) {
  if (manifest.version !== GRWL_HYDRONYM_VERSION || manifest.sources.grwl?.sha256 !== GRWL_SOURCE.sha256) {
    throw Error('GRWL mainstem review requires the preceding hydronym edition');
  }
  const encodedByFid = new Map();
  const { existing } = readHydroEdition(manifest, binary, (fid, logicalFid, feature) => {
    encodedByFid.set(fid, { fid, logicalFid, feature });
  });
  const rivers = await readGrwlRiverArchive(archive, { ...GRWL_SOURCE, signal:options.signal });
  const { features, changedFeatureIds } = prepareReviewedGrwlMainstems({ existing, rivers, bindings });
  options.onProgress?.('selection', changedFeatureIds.length);
  const changed = new Set(changedFeatureIds);
  const changedFeatures = features.filter(row => changed.has(row.metadata.fid));
  const updated = await encodeHydroRepairPlan({
    features:changedFeatures, changedFeatureIds, boundsPendingFor:changedFeatureIds,
  }, options);
  for (const feature of updated) encodedByFid.set(feature.fid,feature);
  const encoded = features.map(row => encodedByFid.get(row.metadata.fid));
  const pack = await buildHydroPack({ features, encoded, changedFeatureIds }, { ...options, metadataFloatFields:true });
  const { layout, binary:packed, container } = packContainer(pack);
  const version = GRWL_MAINSTEM_VERSION;
  const next = {
    ...manifest, version, index:layout.index, metadata:layout.metadata, shards:layout.shards, stats:pack.stats, container,
    cache:{ ...manifest.cache, name:'pandolab-water-v'+version+'-'+container.sha256.slice(0,16) },
    selection:{ ...manifest.selection, reviewedMainstems:'Named reaches use the confirmed GRWL vertex ranges' },
    sources:{ ...manifest.sources, reviewedGrwlMainstems:{
      packageVersion:manifest.version, packageSha256:manifest.container.sha256, bindings, review,
    }},
  };
  return { manifest:next, binary:packed };
}

export async function generateGrwlHydro({ archive, baseline },options={}) {
  const { manifest, existing } = await readPreviousEdition(baseline);
  options.onProgress?.('baseline',existing.length);
  const rivers = await readGrwlRiverArchive(archive,{ ...GRWL_SOURCE,signal:options.signal });
  const { features, sourceClasses } = prepareGrwlFeatures({ rivers,existing });
  options.onProgress?.('selection',features.length);
  // The baseline lake coordinates and integer bounds are already quantized.
  const changedFeatureIds = features.filter(feature => feature.metadata.category === 'river').map(feature => feature.metadata.fid);
  const encoded = await encodeHydroRepairPlan({ features,changedFeatureIds,boundsPendingFor:changedFeatureIds },options);
  options.onProgress?.('encoding',encoded.length);
  const pack = await buildHydroPack({ features,encoded,changedFeatureIds },{ ...options,metadataFloatFields:true });
  return makeContainer(pack,manifest,sourceClasses);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options:{
      archive:{ type:'string' },baseline:{ type:'string' },output:{ type:'string' },
    } });
    if (!values.archive || !values.baseline || !values.output) {
      throw Error('Expected --archive, --baseline and --output');
    }
    const { manifest,binary } = await generateGrwlHydro(values,{
      onProgress:(stage,count) => console.error(stage,count),
      directory:process.env.PANDO_HYDRO_ENCODING_DIRECTORY,
    });
    await mkdir(values.output);
    await writeFile(resolve(values.output,'hydro.bin'),binary,{ flag:'wx' });
    await writeFile(resolve(values.output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{ flag:'wx' });
    console.log(JSON.stringify({ version:manifest.version,stats:manifest.stats,sha256:manifest.container.sha256 }));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
