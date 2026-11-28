import { describeGlobeOutlineChunks } from './globe-spatial-catalog.js';
import { createGlobeRangeCuller } from './globe-spatial-partition.js';
import { createRenderPacketCache, renderCacheBudget } from './render-cache-budget.js';
import { createGlobePacketIndex } from './globe-picking.js';
import { GLOBE_FINE_LOD, globeChunkLod, validateGlobeLodChunks } from './globe-lod.js';
import { batchGlobeStrokeDescriptors } from './globe-spatial-aggregate.js';

const all = () => true;
export function globeViewChunkCuller(camera, viewport, padding = 0) {
  return camera&&viewport?createGlobeRangeCuller(camera.frame, viewport.width, viewport.height, padding):all;
}
const chunkKeys = new WeakMap();
export function globeChunkSetContains(have, needed) {
  if (have===needed)return true;
  let keys = chunkKeys.get(have); if (!keys) {keys = new Set(have.map(row => row.key)); chunkKeys.set(have, keys);}
  return needed.every(row => keys.has(row.key));
}
export const globeChunkPlanKey = rows => rows.map(row => row.key).join('|');

// Reuse an already admitted plan even if it retains a padded margin.
// Matching a date or a chunk count alone never proves coverage or identity.
export function reuseGlobeTerritorialCoverage(context, required, ...candidates) {
  return candidates.find(row => row?.context===context&&globeChunkSetContains(row.plan, required))??null;
}
export function reuseGlobePhysicalCoverage(required, covers, ...candidates) {
  return candidates.find(row => row&&covers(row.plan, required))??null;
}

// Build the descriptor hierarchy once, not on every camera change. All
// published chunks have Cartesian bounds; preserve descriptor order.
export function createGlobeChunkCatalog(descriptors) {
  const rows = descriptors.map((row, index) => ({...row, key:row.key??index+':'+row.spec.sha256, order:row.order??index, catalogOrder:index}));
  if (rows.some(row => !Array.isArray(row.bounds)||row.bounds.length!==6||!row.bounds.every(Number.isFinite)
      ||row.bounds.slice(0,3).some((value, axis) => value>row.bounds[axis+3])))
    throw Error('Invalid Cartesian globe chunk bounds');
  const byLod = new Map(), indexes = new Map();
  for (const row of rows) {
    const lod=globeChunkLod(row);
    if (!byLod.has(lod))byLod.set(lod,[]);
    byLod.get(lod).push(row);
  }
  // Only the requested precision's descriptor tree is built. A coarse
  // camera never traverses every exact/detail descriptor.
  function select(cull = all, accept = all, lod = GLOBE_FINE_LOD) {
    if (!indexes.has(lod))indexes.set(lod,createGlobePacketIndex(byLod.get(lod)??[], row => row.bounds));
    return indexes.get(lod).query(cull).filter(accept);
  }
  return {rows, select};
}

/** Shared CPU packet owner for exact mesh and stroke chunks. Callers lease
  * each required plan while pending/published. Attach replacement consumers
  * before aborting obsolete plans, so common packets keep their flight. */
export function createGlobeChunkAssets(descriptors, {loadMesh, loadStroke, residency, byteBudget = renderCacheBudget().historicalCpuBytes}) {
  let catalog = createGlobeChunkCatalog(descriptors);
  const packets = createRenderPacketCache({byteBudget, residency});
  const keyOf = row => (row.kind??'mesh')+':'+row.spec.sha256;
  function plan(cull, accept = all, lod = GLOBE_FINE_LOD) {return catalog.select(cull, accept, lod);}
  function addDescriptors(rows) {const merged = new Map(catalog.rows.map(row => [row.key, row])); for (const row of rows)merged.set(row.key, row); catalog = createGlobeChunkCatalog([...merged.values()]);}
  function retain(plans) {packets.retain(new Set(plans.filter(Boolean).flatMap(plan => plan.map(keyOf))));}
  function read(row, signal, priority) {
    return packets.read(keyOf(row), (readSignal, readPriority) => row.kind==='stroke'?loadStroke(row.spec, readSignal, readPriority, row):loadMesh(row.spec, readSignal, readPriority), signal, {priority});
  }
  async function prepare(plan, {signal, priority = 20} = {}) {
    signal?.throwIfAborted();
    return Promise.all(plan.map(async row => ({...row, [row.kind==='stroke'?'packet':'mesh']:await read(row, signal, priority)})));
  }
  async function warm(plan, {signal, priority = -20, claim, holdBytes = 0}) {
    for (const row of plan) {
      signal?.throwIfAborted();
      if (packets.has(keyOf(row))) {if (holdBytes)packets.holdWarm(keyOf(row), holdBytes); continue;}
      if (!claim(row.spec, row.kind??'mesh'))continue;
      await read(row, signal, priority);
      if (holdBytes)packets.holdWarm(keyOf(row), holdBytes);
    }
  }
  return Object.freeze({plan, retain, prepare, warm, releaseWarm:() => packets.releaseWarm(), read, stats:packets.stats, dispose:packets.dispose, addDescriptors});
}
/** Required coverage always bypasses optional failures. Retry a declined
  * memory reservation only after actual headroom recovers. If a retry still
  * fails, require more headroom than at that attempt to avoid self-induced
  * release/reload loops; ordinary failures remain blocked for the same plan. */
export function createGlobePlanFailures({residency, onRetry}) {
  let failure = null, lastRetry = null, unsubscribe = null;
  const headroom = () => {const {byteBudget, totalBytes} = residency.pressure(); return byteBudget-totalBytes;};
  function forgetFailure() {
    unsubscribe?.(); unsubscribe = null; failure = null;
  }
  function clear() {forgetFailure(); lastRetry = null;}
  function canRetry(row) {
    const available = headroom();
    return row.temporary&&available>=row.bytes&&
      (lastRetry?.key!==row.key||available>lastRetry.headroom);
  }
  function wake() {
    const row = failure;
    if (!row||row.notified||row.scheduled||!canRetry(row))return;
    row.scheduled = true;
    queueMicrotask(() => {
      row.scheduled = false;
      if (failure!==row||row.notified||!canRetry(row))return;
      row.notified = true; onRetry();
    });
  }
  function allow(key, required) {
    if (required) {clear(); return true;}
    if (lastRetry?.key!==key)lastRetry = null;
    if (failure?.key!==key) {forgetFailure(); return true;}
    if (!canRetry(failure)) {failure.notified = false; return false;}
    lastRetry = {key, headroom:headroom()}; forgetFailure(); return true;
  }
  function fail(key, required, cause) {
    if (required) {clear(); return 'required';}
    forgetFailure();
    if (lastRetry?.key!==key)lastRetry = null;
    const bytes = Number(cause?.requestedBytes);
    const temporary = !!cause?.memoryPressure&&Number.isFinite(bytes)&&bytes>0&&bytes<=residency.pressure().byteBudget;
    failure = {key, bytes, temporary, notified:false, scheduled:false};
    if (temporary) {unsubscribe = residency.onChange(wake); wake(); return 'temporary';}
    return cause?.memoryPressure?'over-budget':'permanent';
  }
  return Object.freeze({allow, fail, clear});
}


/** Owns base/history territorial descriptors, border batching, and outline lookup. */
export function createGlobeTerritorialAssets(spec, {
  baseSlots, cacheBudget, residency, loadMesh, loadStroke, load, slotCount = () => baseSlots.length,
}) {
  function combineBorderRows(rows,baseBorder,aggregationLevel=0) {
    const other=rows.filter(row=>row.role!=='border'||Boolean(row.baseBorder)!==baseBorder);
    const borders=rows.filter(row=>row.role==='border'&&Boolean(row.baseBorder)===baseBorder);
    return [...other,...batchGlobeStrokeDescriptors(borders,{
      prefix:(baseBorder?'base-border-batch':'border-batch')+'-'+aggregationLevel,
      byteBudget:aggregationLevel===0?(baseBorder?Math.floor(cacheBudget.borderBatchBytes/2):cacheBudget.borderBatchBytes):
        Math.max(256*1024,Math.floor(cacheBudget.borderBatchBytes/(baseBorder?4:2))),
      maxSources:aggregationLevel===0?32:128,groupKey:row=>String(globeChunkLod(row))+(!baseBorder?':'+String(row.historyBorder??''):''),
      aggregate:sources=>{
        const row=sources[0];if(aggregationLevel===0||row.lod!==0)return {};
        const gridDivisions=aggregationLevel===1?128:aggregationLevel===2?64:20;
        const aggregateReductionEstimate=aggregationLevel===1?2:aggregationLevel===2?8:32;
        return {force:true,aggregateErrorScale:aggregationLevel===1?32:64,aggregateReductionEstimate,
          aggregateMaxRun:512,aggregateBounds:null,aggregateGridDivisions:gridDivisions,aggregatePreserveOwners:true};
      },
    })];
  }
  const version=spec.lodVersion;
  const chunks=rows=>validateGlobeLodChunks(rows,version);
  function historyDescriptors(catalog) {
    if (!catalog)return [];
    if (catalog.lodVersion!==version)throw Error('Historical globe LOD version mismatch');
    return [
      ...catalog.historicalCountries.flatMap((country,i)=>chunks(country.countryChunks).map((row,j)=>({
        ...row,role:'country',kind:'mesh',historySlot:baseSlots.length+i,catalogPage:country.catalogPage,key:'history-country:'+globeChunkLod(row)+':'+i+':'+j+':'+row.spec.sha256,
      }))),
      ...catalog.historicalBorders.flatMap((border,i)=>chunks(border.chunks).map((row,j)=>({
        ...row,role:'border',kind:'stroke',historyBorder:i,catalogPage:border.catalogPage,key:'history-border:'+globeChunkLod(row)+':'+i+':'+j+':'+row.spec.sha256,
      }))),
    ];
  }
  const assets=createGlobeChunkAssets([],{loadMesh,loadStroke,residency,byteBudget:cacheBudget.historicalCpuBytes});
  function createSelection(baseRows,catalog=null) {
    const historicalRows=historyDescriptors(catalog),indexes=new Map(),outlines=new Map();
    const indexFor=level=>{
      if(!indexes.has(level))indexes.set(level,createGlobeChunkCatalog([
        ...combineBorderRows(baseRows.filter(row=>row.role!=='outline'),true,level),...historicalRows,
      ]));
      return indexes.get(level);
    };
    const index=indexFor(0);
    const add=descriptor=>{
      for (const owner of descriptor.ownerSlots) {
        const key=globeChunkLod(descriptor)+':'+owner;let rows=outlines.get(key);
        if (!rows){rows=[];outlines.set(key,rows);}rows.push(descriptor);
      }
    };
    for (const row of baseRows)if (row.role==='outline')add(row);
    catalog?.historicalCountries.forEach((row,i)=>{
      for (const descriptor of describeGlobeOutlineChunks(row.outlineChunks,version,baseSlots.length+i))add(descriptor);
    });
    return {index,indexFor,outlines,borderPlansByView:new WeakMap()};
  }
  function plan(cull,accept=all,lod=GLOBE_FINE_LOD,selection,aggregationLevel=0) {
    if (!selection)throw Error('Missing territorial catalog selection');
    return selection.indexFor(aggregationLevel).select(cull,accept,lod);
  }
  function planHistoryBorders(view,cull,lod=GLOBE_FINE_LOD,selection,aggregationLevel=0) {
    if (!view||!selection)return [];
    let levels=selection.borderPlansByView.get(view);
    if (!levels){levels=new Map();selection.borderPlansByView.set(view,levels);}
    const cacheKey=lod+':'+aggregationLevel;let index=levels.get(cacheKey);
    if (!index) {
      const groups=new Set(view.borders),rows=selection.indexFor(aggregationLevel).select(all,row=>row.role==='border'&&!row.baseBorder&&groups.has(row.historyBorder),lod);
      index=createGlobeChunkCatalog(combineBorderRows(rows,false,aggregationLevel));levels.set(cacheKey,index);
    }
    return index.select(cull,all,lod);
  }
  async function loadOutlines(row, signal) {
    const owners = row.owners;
    if (!owners?.length||owners.some(group => !group.length
      ||group.some(slot => !Number.isInteger(slot)||slot<0||slot>=slotCount())))
      throw Error('Invalid globe outline owners');
    const packet = await load(row.spec, 'stroke', {
      phase:'background', priority:6, label:'선택 윤곽선', signal,
      ownerCount:owners.length, outlineOwners:owners,
    });
    return {packet, owners, preparedIndex:packet.outlineIndex};
  }
  return Object.freeze({...assets,plan,createSelection,
    outlineDescriptors:(slot,lod=GLOBE_FINE_LOD,selection)=>selection?.outlines.get(lod+':'+slot)??[],
    planHistoryBorders,loadOutlines,dispose:assets.dispose});
}
