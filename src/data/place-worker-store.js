import { touchLruEntry, trimLruEntries } from '../runtime/lru-cache.js';
import { trackPending } from '../runtime/async-request.js';
import { createHydroTileWindow, hydroTileSpecsForWindow } from './hydro-tile-window.js';
import { decodePlaceTile } from './place-codec.js';
import { comparePlaces, normalizePlace, normalizePlaceQuery, selectedPlaceNames, PLACE_LIMITS } from '../document/place-contract.js';
import { resolvePlaceLabelRows, placeLabelRowsAtMonth } from '../ui/place-name-display.js';
import { coordinateInGeographicBounds } from '../rendering/label-layout.js';
import { isWithinDisplayZoom, placeDisplayMinZoom } from '../map/map-display-zoom.js';
const noCancellation = Object.freeze({ throwIfCancelled() {} });
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

async function sha256Hex(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
}

// Cull within the conservative tile window before spending the candidate budget.
function viewportPredicate(view) {
  const bounds = view.bounds;
  if (!Array.isArray(bounds)||bounds.length!==4||!bounds.every(Number.isFinite)||bounds[1]>bounds[3])throw new TypeError('Place viewport requires actual camera geographic bounds');
  return record => {
    if (!coordinateInGeographicBounds(record.coordinates, bounds))return false;
    const rows = view.presentation ? placeLabelRowsAtMonth(record, view.presentation.month, { ko: true, en: true, native: true })
      : resolvePlaceLabelRows(record, { ko: true, en: true, native: true }, view.mapDate || null);
    // Bound loading by the native camera; exact perspective, horizon and label
    // collisions are resolved once by the main layout with its actual projector.
    return rows.length>0;
  };
}

export async function readPlaceResponse(response, limit) {
  if (Number(response.headers.get('Content-Length')) > limit) throw new RangeError('Place response byte budget exceeded');
  if (!response.body?.getReader) { const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.length > limit) throw new RangeError('Place response byte budget exceeded'); return bytes; }
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    for (; ;) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > limit) throw new RangeError('Place response byte budget exceeded'); chunks.push(value); }
  } catch (error) { await reader.cancel().catch (() => {}); throw error; }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
export function validatePlaceManifest(raw) {
  if (raw?.version !== 1 || typeof raw.revision !== 'string' || !raw.revision.trim() || !Array.isArray(raw.stages) || raw.stages.length > 8 || !raw.tiles || !raw.shards || !raw.search) throw new TypeError('Invalid place manifest');
  const stageIds = new Set();
  for (const stage of raw.stages) {
    if (!Number.isInteger(stage.id) || stageIds.has(stage.id) || !Number.isFinite(stage.minZoom) || stage.minZoom < 0 || !Number.isInteger(stage.columns) || stage.columns < 1 || stage.columns > 512 || !Number.isInteger(stage.rows) || stage.rows < 1 || stage.rows > 256) throw new TypeError('Invalid place stage');
    stageIds.add(stage.id);
  }
  for (const spec of Object.values(raw.shards)) {
    if (!spec.url || !Number.isInteger(spec.bytes) || spec.bytes < 1 || spec.bytes > PLACE_LIMITS.shardBytes) throw new RangeError('Invalid place shard byte budget');
  }
  const checkTile = row => {
    const shard = raw.shards[row?.shard];
    if (!shard || !Number.isInteger(row.offset) || row.offset < 0 || !Number.isInteger(row.length) || row.length < 32 || row.offset + row.length > shard.bytes) throw new RangeError('Invalid place tile range');
    if (!SHA256_PATTERN.test(String(row.sha256 || ''))) throw new TypeError('Invalid place tile hash');
  };
  const tileEntries=Object.entries(raw.tiles),tileRowsByStage=new Map();
  for (const [key,value] of tileEntries) {
    const match = /^(\d+)\/(\d+)-(\d+)$/u.exec(key), stage = match && raw.stages.find(s => s.id === Number(match[1]));
    if (!stage || Number(match[2]) >= stage.columns || Number(match[3]) >= stage.rows) throw new TypeError('Invalid place tile key');
    const rows=Array.isArray(value)?value:[value];
    if(!rows.length||rows.length>4096)throw new RangeError('Invalid place spatial page group');
    for(const row of rows) {
      checkTile(row);
      if(raw.spatialPartition&&(!Number.isInteger(row.recordCount)||row.recordCount<1||row.recordCount>PLACE_LIMITS.tileRecords||
        !Number.isFinite(row.priority)||!Number.isFinite(row.population)||row.length>PLACE_LIMITS.shardBytes))
        throw new TypeError('Invalid place spatial page metadata');
    }
    let pages=tileRowsByStage.get(stage.id);if(!pages){pages=[];tileRowsByStage.set(stage.id,pages);}pages.push({key,rows});
  }
  if(raw.spatialPartition!==undefined) {
    const partition=raw.spatialPartition;
    if(partition?.schema!=='pando-place-spatial-partition-v1'||partition.algorithm!=='equirectangular-grid-bounded-overflow-v1'||
      partition.maxTileRecords!==PLACE_LIMITS.tileRecords||partition.maxTileBytes!==PLACE_LIMITS.shardBytes||
      partition.maxQueryPages!==PLACE_LIMITS.queryTiles||!Number.isInteger(partition.sourceRecordCount)||partition.sourceRecordCount<0||
      !Array.isArray(partition.stages)||partition.stages.length!==raw.stages.length||partition.shards!==Object.keys(raw.shards).length)
      throw new TypeError('Invalid place spatial partition contract');
    let totalCells=0,totalPages=0;
    for(let index=0;index<raw.stages.length;index++) {
      const stage=raw.stages[index],stats=partition.stages[index],entries=tileRowsByStage.get(stage.id)??[];
      const pages=entries.flatMap(row=>row.rows);
      const maxRecords=pages.reduce((max,row)=>Math.max(max,row.recordCount),0);
      const maxBytes=pages.reduce((max,row)=>Math.max(max,row.length),0);
      if(stats?.id!==stage.id||stats.minZoom!==stage.minZoom||stats.columns!==stage.columns||stats.rows!==stage.rows||
        stats.tileCount!==entries.length||stats.pageCount!==pages.length||stats.maxRecords!==maxRecords||stats.maxBytes!==maxBytes)
        throw new TypeError('Place spatial stage statistics mismatch: '+stage.id);
      totalCells+=entries.length;totalPages+=pages.length;
    }
    if(partition.totalCells!==totalCells||partition.totalPages!==totalPages)throw new TypeError('Place spatial partition totals mismatch');
  }
  for (const pages of Object.values(raw.search)) {
    if (!Array.isArray(pages)) throw new TypeError('Invalid place search pages');
    for (const row of pages) { checkTile(row); if (typeof row.first !== 'string' || typeof row.last !== 'string' || row.first > row.last) throw new TypeError('Invalid place search range'); }
  }
  const ranking = raw.displayRanking;
  if (ranking !== undefined) {
    if (ranking?.schema !== 'pando-place-population-spatial-display-v1' ||
      !Number.isInteger(ranking.approvedCount) || !Number.isInteger(ranking.neighbourhoodCandidateCount) ||
      !/^[a-f0-9]{64}$/.test(String(ranking.sourceSha256 || '')) ||
      !ranking.entries || typeof ranking.entries !== 'object' || Array.isArray(ranking.entries) ||
      Object.keys(ranking.entries).length !== ranking.approvedCount) throw new TypeError('Invalid place display rankings');
    for (const [id, row] of Object.entries(ranking.entries)) {
      if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(row.population) || row.population < 0 ||
        !Number.isInteger(row.tier) || row.tier < 1 || row.tier > 5 ||
        !Number.isInteger(row.priority) || row.priority < 1 || row.priority > 99 ||
        ![1, 1.4, 2, 3, 5].includes(row.minZoom) || !Number.isFinite(row.score))
        throw new TypeError('Invalid place display ranking entry: ' + id);
    }
  }
  return raw;
}

/** Worker-only owner of loaded tile data. No project objects or DOM here. */
export function createPlaceWorkerStore({ manifest: raw, baseUrl = 'http://localhost/', fetchBytes = null, cacheBytes = PLACE_LIMITS.cacheBytes } = {}) {
  const manifest = validatePlaceManifest(raw), cache = new Map(), inflight = new Map();
  const inflightShards = new Map();
  const budget = Math.max(0, Math.min(PLACE_LIMITS.cacheBytes, Number(cacheBytes) || 0));
  let used = 0; const metrics = { queryCount: 0, networkCount: 0, evictions: 0, lastTileCount: 0, lastCandidateCount: 0, peakWorkingRecords: 0 };
  function get(key) {return touchLruEntry(cache, key)?.value??null;}
  function put(key, value, bytes) {
    if (bytes > budget) return value;
    const existing = cache.get(key); if (existing) { used-=existing.bytes; cache.delete(key); }
    used = trimLruEntries(cache, null, budget-bytes, entry => entry.bytes, () => {metrics.evictions++;}, {residentBytes:used});
    cache.set(key, {value, bytes}); used+=bytes; return value;
  }
  function startWholeShard(row, context, readBytes) {
    const spec = manifest.shards[row.shard];
    const task = (async () => {
      const full = await readBytes();
      if (full.byteLength !== spec.bytes) throw new RangeError('Invalid place shard response');
      if (spec.sha256 && await sha256Hex(full) !== spec.sha256) throw new Error('Invalid place shard hash');
      context.throwIfCancelled();
      return { full: put('shard:' + row.shard, full, full.byteLength) };
    })();
    return trackPending(inflightShards, row.shard, task);
  }
  async function awaitWholeShard(row, context, pending) {
    try {
      const result = await pending;
      context.throwIfCancelled();
      return result;
    } catch (error) {
      context.throwIfCancelled();
      if (error.cancelled || error.name === 'AbortError') return loadTileBytes(row, context);
      throw error;
    }
  }
  async function loadTileBytes(row, context) {
    context.throwIfCancelled();
    const key = 'shard:' + row.shard, spec = manifest.shards[row.shard];
    const hit = get(key);
    if (hit) return { full: hit };
    const pending = inflightShards.get(row.shard);
    if (pending) return awaitWholeShard(row, context, pending);

    metrics.networkCount++;
    if (fetchBytes) return startWholeShard(row, context, () => fetchBytes(spec, { signal: context.signal }));

    const url = new URL(spec.url, baseUrl);
    url.searchParams.set('v', manifest.revision);
    const wholeShard = row.offset === 0 && row.length === spec.bytes;
    const range = `${row.offset}-${row.offset + row.length - 1}`;
    const headers = wholeShard ? {} : { Range: `bytes=${range}` };
    const response = await fetch(url, { headers, signal: context.signal });
    if (!response.ok) throw new Error('Place HTTP ' + response.status + ': ' + row.shard);
    if (response.status === 206) {
      const payload = await readPlaceResponse(response, spec.bytes);
      const expected = `bytes ${range}/${spec.bytes}`;
      const actual = response.headers.get('Content-Range');
      if (actual !== expected || payload.length !== row.length)
        throw new RangeError('Invalid place range response: expected ' + expected + ' (' + row.length +
          ' bytes), received ' + actual + ' (' + payload.length + ' bytes)');
      return { bytes: payload };
    }
    if (response.status !== 200) throw new RangeError('Invalid place shard response');

    // Publish a shared body only after headers confirm this response covers the entire shard.
    const received = get(key), active = inflightShards.get(row.shard);
    if (received || active) {
      response.body?.cancel().catch(() => {});
      return received ? { full: received } : awaitWholeShard(row, context, active);
    }
    return startWholeShard(row, context, () => readPlaceResponse(response, spec.bytes));
  }
  async function loadTile(row, context) {
    context.throwIfCancelled();
    const key = `${row.shard}:${row.offset}:${row.length}:${row.sha256}`;
    const hit = get('tile:' + key);
    if (hit) return hit;
    const pending = inflight.get(key);
    if (pending) {
      try {
        const records = await pending;
        context.throwIfCancelled();
        return records;
      } catch (error) {
        context.throwIfCancelled();
        if (!error.cancelled && error.name !== "AbortError") throw error;
        return loadTile(row, context);
      }
    }
    const task=(async () => {
      const { bytes: rangeBytes, full } = await loadTileBytes(row, context);
      context.throwIfCancelled();
      const bytes = rangeBytes ?? full.subarray(row.offset, row.offset + row.length);
      if (await sha256Hex(bytes) !== row.sha256) throw new Error('Invalid place tile hash');
      context.throwIfCancelled();
      const decoded=decodePlaceTile(bytes);
      if(row.recordCount!==undefined&&decoded.length!==row.recordCount)throw new RangeError('Place spatial page record count mismatch');
      const records=decoded.map(record => {
        const rank=record.source==='geonames' && record.kind==='city'
          ? manifest.displayRanking?.entries?.[record.sourceId] : null;
        return rank ? normalizePlace({ ...record, population:rank.population,
          priority:rank.priority, minZoom:rank.minZoom }) : record;
      });
      const decodedBytes=records.reduce((total,record) => total+512+Object.values(record).reduce((sum,value)=>sum+(typeof value === 'string' ? value.length*2 : 0),0)+record.nameNativeExtras.reduce((sum,name)=>sum+name.length*2,0)+JSON.stringify(record.nameTimeline).length*2+JSON.stringify(record.capitalPeriods).length*2,0);
      context.throwIfCancelled(); return put(`tile:${key}`,records,decodedBytes);
    })();
    return trackPending(inflight, key, task);
  }
  async function loadRows(rows, context, accepts, limit) {
    let records=[]; let truncated=false;
    for (let i=0; i<rows.length; i+=4) {
      context.throwIfCancelled();
      const batch=await Promise.all(rows.slice(i,i+4).map(row => loadTile(row,context)));
      metrics.peakWorkingRecords=Math.max(metrics.peakWorkingRecords,records.length+batch.reduce((sum,tile)=>sum+tile.length,0));
      const unique=new Map(records.map(record=>[record.id,record]));
      for (const tile of batch) for (const record of tile) if (accepts(record)) unique.set(record.id,record);
      truncated ||= unique.size > limit;
      records=[...unique.values()].sort(comparePlaces).slice(0,limit);
    }
    return {records,truncated};
  }
  async function queryViewport(view, context=noCancellation) {
    metrics.queryCount++; context.throwIfCancelled();
    const zoom=Number(view.threshold || 0);
    const stages=manifest.stages.filter(stage => isWithinDisplayZoom(zoom,stage.minZoom)).sort((a,b) => b.minZoom-a.minZoom);
    let tileWindow=null,rows=[],spatialPagesOmitted=false;
    const compareTilePages=(a,b)=>(Number(b.priority)||0)-(Number(a.priority)||0)||
      (Number(b.population)||0)-(Number(a.population)||0)||String(a.shard).localeCompare(String(b.shard))||a.offset-b.offset;
    for(const stage of stages) {
      const candidateWindow=createHydroTileWindow({...view,manifest:{stages:[stage]}}),specs=hydroTileSpecsForWindow(candidateWindow);
      const candidateRows=specs.flatMap(spec=>{
        const value=manifest.tiles[`${spec.stage}/${spec.x}-${spec.y}`];
        return value===undefined?[]:Array.isArray(value)?value:[value];
      }).sort(compareTilePages);
      tileWindow=candidateWindow;rows=candidateRows;
      if(rows.length<=PLACE_LIMITS.queryTiles)break;
    }
    if(rows.length>PLACE_LIMITS.queryTiles){rows=rows.slice(0,PLACE_LIMITS.queryTiles);spatialPagesOmitted=true;}
    const inViewport=viewportPredicate(view);
    const loaded=await loadRows(rows,context,record =>
      isWithinDisplayZoom(zoom,placeDisplayMinZoom(record.minZoom))&&inViewport(record),PLACE_LIMITS.candidates);
    metrics.lastTileCount=rows.length; metrics.lastCandidateCount=loaded.records.length;
    return {signature:`${manifest.revision}:${tileWindow?.signature||'empty'}`,records:loaded.records,
      tileCount:rows.length,stageId:tileWindow?.windows?.[0]?.stage??null,
      truncated:spatialPagesOmitted||loaded.truncated,spatialPagesOmitted,
      cacheBytes:used,peakWorkingRecords:metrics.peakWorkingRecords};
  }
  async function search(value, context=noCancellation, presentation=null) {
    const query=normalizePlaceQuery(value); if ([...query].length < 2) return { records: [], truncated: false };
    const prefix=[...query].slice(0,2).join(''), pages=(manifest.search[prefix] || []).filter(row => row.last >= query && row.first <= `${query}\uffff`);
    const selected = pages.slice(0, PLACE_LIMITS.queryTiles);
    const names = record => presentation ? placeLabelRowsAtMonth(record, presentation.month, presentation.languages).map(row => row.text.replace(/^\(현\)/,'')) : selectedPlaceNames(record);
    const {records, truncated} = await loadRows(selected, context, record => names(record).some(name => normalizePlaceQuery(name).startsWith(query)), PLACE_LIMITS.searchResults);
    const displayNames = Object.fromEntries(records.map(record => [record.id,
      placeLabelRowsAtMonth(record, presentation?.month, presentation?.languages)[0]?.text || record.name]));
    return { records, displayNames, truncated: pages.length > selected.length || truncated };
  }
  return Object.freeze({ queryViewport, search, stats: () => ({ ...metrics, cacheBytes: used, cacheBudget: budget, cachedTiles: [...cache.keys()].filter(key => key.startsWith('tile:')).length, inflight: inflight.size }) });
}
