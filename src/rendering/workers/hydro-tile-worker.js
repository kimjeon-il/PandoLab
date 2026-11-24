/* Hydro GeoJSON viewport worker. */
'use strict';

importScripts('../vendor/fflate/fflate.min.js', 'hydro-shard-store.js');

let packHydroFeatures,geometryTransferBuffers;

const textDecoder = new TextDecoder('utf-8');
let manifest = null;
let baseUrl = '';
let dataRevision = '';
let latestRevision = 0;
const tilePacks = new Map();
const packSpecs = new Map();
const shardSpecs = new Map();
const postedPacks = new Set();
const activeRanges = new Set();
let shardStore;
let rangeSupportPromise = null;
const featureMetadata = new Map();
let wholeHydroBundle = null;
let foregroundController = null;
let packParseMs = 0, parsedPacks = 0, fetchAttempts = 0;
const now = () => globalThis.performance?.now() ?? Date.now();

function resolveUrl(path) {
  const url = new URL(path, baseUrl);
  if (dataRevision) url.searchParams.set('v', dataRevision);
  return url.href;
}

const retryableStatus = status => [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
function responseError(label, response) {
  const error = new Error(`${label} HTTP ${response.status}`);
  error.httpStatus = Number(response.status);
  error.retryable = retryableStatus(response.status);
  return error;
}
const sleep = (ms, signal = null) => new Promise((resolve, reject) => {
  let settled = false;
  const onAbort = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(signal.reason || new DOMException('Aborted', 'AbortError'));
  };
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, Math.max(0, Number(ms || 0)));
  signal?.addEventListener('abort', onAbort, { once: true });
});

async function fetchWithRetry(input, init = {}, {
  attempts = 3,
  baseDelay = 400,
  signal = init.signal || null,
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    try {
      fetchAttempts++;
      const response = await fetch(input, { ...init, signal });
      if (!response.ok && retryableStatus(response.status)) {
        const error = new Error(`HTTP ${response.status}`);
        error.httpStatus = response.status;
        throw error;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (error?.name === 'AbortError' || attempt >= attempts) throw error;
      if (Number.isFinite(Number(error?.httpStatus)) && !retryableStatus(error.httpStatus)) throw error;
      if (!(error instanceof TypeError) && !retryableStatus(error?.httpStatus)) throw error;
      await sleep(Math.min(2400, baseDelay * (2 ** (attempt - 1))), signal);
    }
  }
  throw lastError;
}

async function hydroDigest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    byte => byte.toString(16).padStart(2, '0')).join('');
}

async function saveWholeHydroBundle(bytes) {
  if (!manifest?.container) return;
  const spec = manifest.container;
  if (bytes.length !== spec.bytes || await hydroDigest(bytes) !== spec.sha256)
    throw new Error('통합 수계 파일의 길이 또는 SHA-256이 일치하지 않습니다.');
  wholeHydroBundle = bytes;
}

async function fetchGzip(asset) {
  const signal = globalThis.AbortSignal.timeout(15000);
  if (typeof asset === 'string') {
    const response = await fetchWithRetry(resolveUrl(asset), {signal});
    if (!response.ok) throw responseError(asset, response);
    return self.fflate.gunzipSync(new Uint8Array(await response.arrayBuffer()));
  }
  const { url, offset, bytes: length, sha256 } = asset || {};
  if (!manifest?.container || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(length) || length <= 0 ||
      offset + length > manifest.container.bytes || url !== manifest.container.url)
    throw new Error('통합 수계 구성요소 범위가 올바르지 않습니다.');
  let content;
  if (wholeHydroBundle) {
    content = wholeHydroBundle.subarray(offset, offset + length);
  } else {
    const response = await fetchWithRetry(resolveUrl(url),
      { signal, headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (!response.ok) throw responseError(url, response);
    const raw = new Uint8Array(await response.arrayBuffer());
    if (response.status === 206) {
      if (response.headers.get('Content-Range') !==
          `bytes ${offset}-${offset + length - 1}/${manifest.container.bytes}` ||
          raw.length !== length)
        throw new Error('통합 수계 부분 응답의 범위가 다릅니다.');
      content = raw;
    } else if (response.status === 200) {
      await saveWholeHydroBundle(raw);
      content = raw.subarray(offset, offset + length);
    } else throw new Error('통합 수계 다운로드 응답이 올바르지 않습니다.');
  }
  if (await hydroDigest(content) !== sha256)
    throw new Error('통합 수계 구성요소의 SHA-256이 일치하지 않습니다.');
  return self.fflate.gunzipSync(content);
}

function readGlobalIndex(bytes, logicalPacks = null) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x34495741 || view.getUint16(4, true) !== 4) {
    throw new Error('수계 공간 인덱스 버전이 올바르지 않습니다.');
  }
  const tileCount = view.getUint32(8, true);
  const logicalCount = view.getUint32(12, true);
  const packCount = view.getUint32(16, true);
  let offset = 20;
  for (let index = 0; index < tileCount; index += 1) {
    const stage = view.getUint8(offset);
    const x = view.getUint16(offset + 1, true);
    const y = view.getUint16(offset + 3, true);
    const count = view.getUint16(offset + 5, true);
    offset += 7;
    const packs = new Array(count);
    for (let item = 0; item < count; item += 1, offset += 4) packs[item] = view.getUint32(offset, true);
    tilePacks.set(`${stage}/${x}-${y}`, packs);
  }
  for (let index = 0; index < logicalCount; index += 1) {
    const logicalFid = view.getUint32(offset, true);
    const count = view.getUint16(offset + 4, true);
    offset += 6;
    if (logicalPacks) {
      const packs = Array.from({ length: count }, (_, item) => view.getUint32(offset + item * 4, true));
      logicalPacks.set(logicalFid, packs);
    }
    offset += count * 4;
  }
  for (let index = 0; index < packCount; index += 1) {
    const id = view.getUint32(offset, true);
    const shard = view.getUint16(offset + 4, true);
    const packOffset = view.getUint32(offset + 6, true);
    const length = view.getUint32(offset + 10, true);
    const stage = view.getUint8(offset + 14);
    packSpecs.set(id, { id, shard, offset: packOffset, length, stage });
    offset += 15;
  }
  if (offset !== bytes.length) throw new Error('수계 공간 인덱스에 불필요한 데이터가 있습니다.');
}

function readFeatureMetadata(bytes) {
  const payload = JSON.parse(textDecoder.decode(bytes));
  if (Number(payload?.version) !== 5 || !Array.isArray(payload?.features)) {
    throw new Error('수계 메타데이터 버전이 올바르지 않습니다.');
  }
  for (const row of payload.features) featureMetadata.set(Number(row.fid), row);
}

async function openHydroCache() {
  if (!('caches' in self)) return null;
  try { return await caches.open(manifest.cache?.name || `pandolab-hydro-v${manifest.version}`); }
  catch (_) { return null; }
}

async function fetchPackBytes(packId, signal = null) {
  const pack = packSpecs.get(Number(packId));
  if (!pack) throw new Error('Unknown hydro pack ' + packId);
  const shard = shardSpecs.get(Number(pack.shard));
  const rows = await shardStore.read(shard, [{ ...pack, id: packId }], pack.offset, pack.offset + pack.length, signal);
  return rows[0][1];
}

async function detectRangeSupport() {
  const first = [...shardSpecs.values()][0];
  if (!first) return false;
  try {
    const response = await fetchWithRetry(resolveUrl(first.url), {
      signal:globalThis.AbortSignal.timeout(15000), headers: { Range: 'bytes=0-0' },
    }, { attempts: 2 });
    if (response.status !== 206) { await response.body?.cancel(); return false; }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return response.status === 206 && bytes.length === 1 && response.headers.get('Content-Range') === 'bytes 0-0/' + (first.fileBytes || first.bytes);
  } catch (_) { return false; }
}

function readUVarint(bytes, cursor) {
  let value = 0;
  let shift = 0;
  while (cursor.offset < bytes.length) {
    const byte = bytes[cursor.offset++];
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return value >>> 0;
    shift += 7;
    if (shift > 35) throw new Error('수계 varint가 손상되었습니다.');
  }
  throw new Error('수계 varint가 중간에서 끝났습니다.');
}

function readSVarint(bytes, cursor) {
  const value = readUVarint(bytes, cursor);
  return (value >>> 1) ^ -(value & 1);
}

function readLine(bytes, cursor) {
  const count = readUVarint(bytes, cursor);
  const points = new Array(count);
  let x = 0;
  let y = 0;
  for (let index = 0; index < count; index += 1) {
    if (index === 0) {
      x = readSVarint(bytes, cursor);
      y = readSVarint(bytes, cursor);
    } else {
      x += readSVarint(bytes, cursor);
      y += readSVarint(bytes, cursor);
    }
    points[index] = [x / 1e6, y / 1e6];
  }
  return points;
}

function readGeometry(bytes, geometryKind) {
  const cursor = { offset: 0 };
  if (geometryKind === 1 || geometryKind === 2) {
    const partCount = readUVarint(bytes, cursor);
    const parts = new Array(partCount);
    for (let part = 0; part < partCount; part += 1) parts[part] = readLine(bytes, cursor);
    return geometryKind === 1 ? { type: 'LineString', coordinates: parts[0] || [] } : { type: 'MultiLineString', coordinates: parts };
  }
  const polygonCount = readUVarint(bytes, cursor);
  const polygons = new Array(polygonCount);
  for (let polygon = 0; polygon < polygonCount; polygon += 1) {
    const ringCount = readUVarint(bytes, cursor);
    const rings = new Array(ringCount);
    for (let ring = 0; ring < ringCount; ring += 1) rings[ring] = readLine(bytes, cursor);
    polygons[polygon] = rings;
  }
  return geometryKind === 3 ? { type: 'Polygon', coordinates: polygons[0] || [] } : { type: 'MultiPolygon', coordinates: polygons };
}

function lineParts(geometry) {
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

function readWidthProfile(bytes, geometry) {
  if (!bytes.length) return [];
  const cursor = { offset: 0 };
  const geometryParts = lineParts(geometry);
  const partCount = readUVarint(bytes, cursor);
  if (partCount !== geometryParts.length) throw new Error('강 너비 part 수가 지오메트리와 다릅니다.');
  return geometryParts.map(points => {
    const count = readUVarint(bytes, cursor);
    if (count !== points.length) throw new Error('강 너비 꼭짓점 수가 지오메트리와 다릅니다.');
    let width = count ? readUVarint(bytes, cursor) : 0;
    const widths = new Array(count);
    for (let index = 0; index < count; index += 1) {
      if (index) width += readSVarint(bytes, cursor);
      widths[index] = width / 1000;
    }
    return widths;
  });
}

function decodePack(bytes, packId) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46485741 || view.getUint16(4, true) !== 4) throw new Error('수계 feature pack 버전이 올바르지 않습니다.');
  const count = view.getUint32(8, true);
  const features = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const fid = view.getUint32(offset, true);
    const logicalFid = view.getUint32(offset + 4, true);
    const kind = view.getUint8(offset + 8);
    const stage = view.getUint8(offset + 9);
    const geometryKind = view.getUint8(offset + 10);
    const flags = view.getUint8(offset + 11);
    const fragmentIndex = view.getUint16(offset + 12, true);
    const fragmentCount = view.getUint16(offset + 14, true);
    const width = view.getFloat32(offset + 16, true);
    const bounds = [0, 1, 2, 3].map(item => view.getInt32(offset + 20 + item * 4, true) / 1e6);
    const geometryLength = view.getUint32(offset + 36, true);
    const widthLength = view.getUint32(offset + 40, true);
    offset += 44;
    const geometry = readGeometry(bytes.subarray(offset, offset + geometryLength), geometryKind); offset += geometryLength;
    const widthProfile = kind === 1 ? readWidthProfile(bytes.subarray(offset, offset + widthLength), geometry) : []; offset += widthLength;
    const metadata = featureMetadata.get(fid);
    if (!metadata || Number(metadata.logicalFid) !== logicalFid) throw new Error(`수계 feature ${fid} 메타데이터가 없습니다.`);
    const feature = {
      type: 'Feature', id: metadata.awId,
      properties: {
        __fid: fid, __logicalFid: logicalFid, __flags: flags, border_aligned: (flags & 1) !== 0,
        fragment_index: fragmentIndex, fragment_count: fragmentCount,
        pandolab_id: metadata.awId, layer_id: metadata.layerId, category: kind === 1 ? 'river' : 'lake', name: metadata.name || '', name_ko: metadata.name || '',
        source_id: metadata.sourceId || '', source: metadata.source || '',
        system_id: metadata.systemId || '', mainstem_name_ko: metadata.mainstemNameKo || metadata.name || '',
        role: metadata.role || '', aliases: metadata.aliases || [], tributary_names: metadata.tributaryNames || [],
        osm_relation_ids: metadata.osmRelationIds || [],
        independent_source_urls: metadata.independentSourceUrls || [],
        min_zoom: manifest.stages[stage].minZoom, stage, stroke_width: width, stroke_widths: widthProfile, pack_id: packId,
      },
      geometry, __awBounds: bounds,
    };
    features.push(feature);
  }
  if (offset !== bytes.length) throw new Error(`수계 pack ${packId}에 불필요한 데이터가 있습니다.`);
  return features;
}

function readPack(bytes, packId) {
  const started = now();
  try {
    const features = decodePack(bytes, packId);
    parsedPacks++;
    return features;
  } finally {
    packParseMs += now() - started;
  }
}

async function loadPack(packId, signal) {
  return readPack(await fetchPackBytes(packId, signal), packId);
}

function coalescePackRanges(packIds) {
  const priority = new Map(packIds.map((id,index)=>[id,index]));
  const byShard = new Map();
  for (const packId of packIds) {
    const spec = packSpecs.get(Number(packId));
    if (!spec) continue;
    if (!byShard.has(spec.shard)) byShard.set(spec.shard, []);
    byShard.get(spec.shard).push(spec);
  }
  const groups = [];
  for (const [shard, rows] of byShard) {
    rows.sort((left, right) => left.offset - right.offset);
    let group = null;
    for (const row of rows) {
      const rowEnd = row.offset + row.length;
      if (!group || row.offset - group.end > 32 * 1024 || rowEnd - group.start > 1024 * 1024) {
        group = { shard, start: row.offset, end: rowEnd, rows: [row], priority: priority.get(row.id) };
        groups.push(group);
      } else {
        group.end = Math.max(group.end, rowEnd);
        group.rows.push(row);
        group.priority = Math.min(group.priority, priority.get(row.id));
      }
    }
  }
  return groups.sort((left, right) => left.priority - right.priority);
}

function rangesForView(packIds) {
  const remaining = new Set(packIds), reused = [];
  for (const {shard,start,end,coverage,signal} of activeRanges) {
    if (signal.aborted) continue;
    const rows = coverage.filter(row => remaining.delete(row.id));
    if (rows.length) reused.push({shard,start,end,coverage,rows});
  }
  // The predecessor is about to be cancelled. Subscribe to its existing
  // transfers before scheduling additional ranges for uncovered packs.
  return reused.concat(coalescePackRanges([...remaining]));
}

async function loadPackRangeGroup(group, signal = null) {
  const shard = shardSpecs.get(Number(group.shard));
  if (!shard) throw new Error('Unknown hydro shard ' + group.shard);
  // A later viewport can still request a pack covered by the original
  // byte interval even when an intermediate viewport only decodes a subset.
  const active = {shard:group.shard,start:group.start,end:group.end,coverage:group.coverage||group.rows,signal};
  activeRanges.add(active);
  try {
    const rows = await shardStore.read(shard, group.rows, group.start, group.end, signal);
    return rows.map(([id, bytes]) => {
      try { return { id, features: readPack(bytes, id) }; }
      catch(error){ return {id,error}; }
    });
  } finally {
    activeRanges.delete(active);
  }
}

function postPack(packId, decodedFeatures, revision) {
  const features = decodedFeatures.map(feature => {
    const featureId = packId + ':' + feature.properties.__fid;
    return {
      type: 'Feature',
      id: featureId,
      geometry: feature.geometry,
      properties: {
        ...feature.properties, featureId, logicalId: String(feature.id),
        layerId: feature.properties.layer_id, sourceId: feature.properties.source_id,
      },
    };
  });
  const packed=packHydroFeatures(features);
  postMessage({type:'pack',revision,packId,packed},geometryTransferBuffers(packed));
  postedPacks.add(packId);
}

async function processView(message) {
  const controller = new AbortController();foregroundController=controller;
  latestRevision = Math.max(latestRevision, Number(message.revision || 0));
  const packIds = [...new Set((message.tiles || []).flatMap(spec => tilePacks.get(`${spec.stage}/${spec.x}-${spec.y}`) || []))];
  const needed = packIds.filter(packId => !postedPacks.has(packId));
  const failedPacks=[];
  const isCurrent=()=>message.revision>=latestRevision&&!controller.signal.aborted;
  const recordFailure=(id,error)=>failedPacks.push({id,message:error.message,diagnostic:error.diagnostic});
  const supportsRange = await rangeSupportPromise;
  const concurrency = 4;
  try {
    if (!isCurrent()) return;
    const reusable = packIds.filter(id => postedPacks.has(id));
    if (needed.length && reusable.length) postMessage({type:'view-progress',revision:message.revision,packIds:reusable});
    if (supportsRange) {
      const groups = rangesForView(needed);
      const activeShards = new Map();
      await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, async () => {
        while (isCurrent()) {
          const next = groups.findIndex(group => (activeShards.get(group.shard) || 0) < 2);
          if (next === -1) return;
          const [group] = groups.splice(next, 1);
          activeShards.set(group.shard, (activeShards.get(group.shard) || 0) + 1);
          let rows;
          try{
            try{rows=await loadPackRangeGroup(group,controller.signal);}
            catch(error){
              if(!isCurrent())return;
              if(error.corrupt&&group.rows.length>1){
                rows=[];
                for(const spec of group.rows){
                  if(!isCurrent())return;
                  try{rows.push({id:spec.id,features:await loadPack(spec.id,controller.signal)});}
                  catch(cause){rows.push({id:spec.id,error:cause});}
                }
              }else rows=group.rows.map(spec=>({id:spec.id,error}));
            }
            if(!isCurrent())return;
            for(const {id,features,error} of rows){
              if(error)recordFailure(id,error);else postPack(id,features,message.revision);
            }
          } finally {
            const count = activeShards.get(group.shard) - 1;
            if (count) activeShards.set(group.shard, count);
            else activeShards.delete(group.shard);
          }
        }
      }));
    } else {
      const groups = new Map();
      for (const packId of needed) {
        const shardId = packSpecs.get(packId)?.shard;
        if (!groups.has(shardId)) groups.set(shardId, []);
        groups.get(shardId).push(packId);
      }
      const shardGroups = [...groups.values()];
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, shardGroups.length) }, async () => {
        while (cursor < shardGroups.length) {
          const packIdsForShard = shardGroups[cursor++];
          for (const packId of packIdsForShard) {
            if (message.revision < latestRevision) return;
            let features;
            try{features=await loadPack(packId,controller.signal);}
            catch(error){if(!isCurrent())return;recordFailure(packId,error);continue;}
            if(!isCurrent())return;
            postPack(packId, features, message.revision);
          }
        }
      }));
    }
  } finally {
    if(foregroundController===controller)foregroundController=null;
  }
  if (!isCurrent()) return;
  const workerStats = shardStore.stats?.();
  postMessage({ type: 'view-ready', revision: message.revision,
    packIds:packIds.filter(id=>postedPacks.has(id)),failedPacks,
    stats:{...workerStats,parseMs:packParseMs+(workerStats?.gunzipMs||0),parsedPacks,fetchAttempts} });
}

function startView(message) {
  if (message.revision < latestRevision) return;
  const previous = foregroundController;
  const task = processView(message).catch(error => {
    if (message.revision < latestRevision) return;
    postMessage({
      type: 'view-error',
      message: error?.message || String(error),
      diagnostic: error?.diagnostic || { stage: 'pack-processing' },
      revision: Number(message.revision || 0),
      retryable: error?.name !== 'AbortError' && error?.retryable !== false,
    });
  });
  // Let the new request subscribe to matching in-flight bytes in the same
  // turn. Its revision already prevents the predecessor from publishing.
  if (previous) queueMicrotask(() => previous.abort());
  return task;
}

onmessage = async event => {
  const message = event.data || {};
  if (message.type === 'init') {
    try {
      ({packHydroFeatures,geometryTransferBuffers}=await import('../geometry-transfer-codec.js'));
      manifest = message.manifest;
      if (manifest.container) {
        const isSourceIndependentHydro = manifest.version === '0.13.4'
          && manifest.stats?.osmWaterwayMatchCount === 0
          && manifest.sources?.osmWaterways?.matchedSystems === 0
          && manifest.sources?.independentHydronymReplacements?.replacedSystems === 42
          && manifest.sources?.independentHydronymFollowup?.replacedSystems === 2
          && manifest.sources?.independentHydronymBulk?.replacedSystems === 29;
        if (!isSourceIndependentHydro ||
            manifest.container.url !== 'hydro.bin' ||
            manifest.container.format !== 'byte-concatenated-subresources-v1')
          throw new Error('통합 수계 형식 또는 버전이 올바르지 않습니다.');
      }
      wholeHydroBundle = null;
      packParseMs = parsedPacks = fetchAttempts = 0;
      baseUrl = message.baseUrl;
      dataRevision = message.dataRevision || manifest.version || '';
      tilePacks.clear();
      packSpecs.clear();
      shardSpecs.clear();
      featureMetadata.clear();
      postedPacks.clear();
      activeRanges.clear();
      shardStore = self.createHydroShardStore({
        fetchResponse: fetchWithRetry,
        openCache: openHydroCache,
        resolveUrl,
        gunzip: bytes => self.fflate.gunzipSync(bytes),
        digest: hydroDigest,
        sharedBundle: async () => wholeHydroBundle,
        onWholeBundle: saveWholeHydroBundle,
      });
      for (const shard of manifest.shards || [])
        shardSpecs.set(Number(shard.id), manifest.container
          ? { ...shard, fileBytes: manifest.container.bytes } : shard);
      readGlobalIndex(await fetchGzip(manifest.container ? manifest.index : manifest.index.url));
      readFeatureMetadata(await fetchGzip(manifest.container
        ? manifest.metadata.core : manifest.metadata?.core?.url || manifest.metadata?.url));
      // The container reads already proved whether the host served ranges.
      rangeSupportPromise = manifest.container ? Promise.resolve(!wholeHydroBundle) : detectRangeSupport();
      postMessage({ type: 'ready' });
    } catch (error) {
      postMessage({ type: 'init-error', message: error?.message || String(error) });
    }
    return;
  }
  if (message.type === 'view') startView(message);
  else if (message.type === 'cancel-view') {
    latestRevision = Math.max(latestRevision, Number(message.revision || 0));
    foregroundController?.abort();
  }
  else if (message.type === 'release') {
    for (const packId of message.packIds || []) postedPacks.delete(packId);
  }
};
