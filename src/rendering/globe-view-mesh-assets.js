import { createGlobeRangeCuller } from './globe-spatial-partition.js';
import { createRenderPacketCache, renderCacheBudget } from './render-cache-budget.js';
import { createGlobePacketIndex } from './globe-picking.js';

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
  const index = createGlobePacketIndex(rows, row => row.bounds);
  function select(cull = all, accept = all) {
    return index.query(cull).filter(accept);
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
  function plan(cull, accept = all) {return catalog.select(cull, accept);}
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
  const outlineBySlot = new Map();
  function combineBorderRows(rows, baseBorder) {
    const groups = new Map(), result = [];
    for (const row of rows) {
      if (row.role!=='border'||Boolean(row.baseBorder)!==baseBorder) {result.push(row); continue;}
      const cell = row.cell??row.key;
      let group = groups.get(cell); if (!group) {group = []; groups.set(cell, group);}
      group.push(row);
    }
    const maxBatchBytes = baseBorder?Math.floor(cacheBudget.borderBatchBytes/2):cacheBudget.borderBatchBytes;
    for (const [cell, group] of groups) {
      let sources = [], decodedBytes = 0;
      const flush = () => {
        if (sources.length===1)result.push(sources[0]);
        else if (sources.length) {
          const key = (baseBorder?'base-border-batch:':'border-batch:')+sources.map(row => row.key).join(',');
          const compressedBytes = sources.reduce((sum, row) => sum+(Number(row.spec.compressedBytes)||0), 0);
          const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
          for (const row of sources)for (let axis = 0; axis<3; axis++) {
            bounds[axis] = Math.min(bounds[axis], row.bounds[axis]);
            bounds[axis+3] = Math.max(bounds[axis+3], row.bounds[axis+3]);
          }
          const slots = [...new Set(sources.flatMap(row => row.slots??[]))].sort((a,b) => a-b);
          result.push({role:'border',kind:'stroke',key,sources,bounds,slots,cell,baseBorder,
            spec:{sha256:key,decodedBytes,compressedBytes,estimatedBytes:compressedBytes*3+decodedBytes*7+64*1024}});
        }
        sources = []; decodedBytes = 0;
      };
      for (const row of group) {
        const bytes = Number(row.spec.decodedBytes)||0;
        if (sources.length&&(sources.length>=32||decodedBytes+bytes>maxBatchBytes))flush();
        sources.push(row); decodedBytes+=bytes;
      }
      flush();
    }
    return result;
  }
  function descriptorsFor(catalog = null) {
    if (!catalog) return [
      ...spec.countryChunks.map((row, i) => ({...row, role:'country', key:'base-country:'+i+':'+row.spec.sha256})),
      ...combineBorderRows(spec.borderChunks.map((row, i) => ({...row, role:'border', kind:'stroke', baseBorder:true, key:'base-border:'+i+':'+row.spec.sha256})),true),
    ];
    return [
      ...catalog.historicalCountries.flatMap((country, i) => country.countryChunks.map((row, j) => ({
        ...row, role:'country', historySlot:baseSlots.length+i, key:'history-country:'+i+':'+j+':'+row.spec.sha256,
      }))),
      ...catalog.historicalBorders.flatMap((border, i) => border.chunks.map((row, j) => ({
        ...row, role:'border', kind:'stroke', historyBorder:i, key:'history-border:'+i+':'+j+':'+row.spec.sha256,
      }))),
    ];
  }
  const assets = createGlobeChunkAssets(descriptorsFor(), {
    loadMesh, loadStroke, residency, byteBudget:cacheBudget.historicalCpuBytes,
  });
  const borderPlansByView = new WeakMap();

  function addOutlineDescriptors(row, slot) {
    for (let order = 0; order<row.outlineChunks.length; order++) {
      const chunk = row.outlineChunks[order];
      const descriptor = {...chunk, key:'outline:'+(slot??'base')+':'+order+':'+chunk.spec.sha256, slot, order, count:row.outlineChunks.length};
      for (const owner of chunk.ownerSlots) {
        let rows = outlineBySlot.get(owner);
        if (!rows) {rows = []; outlineBySlot.set(owner, rows);}
        rows.push(descriptor);
      }
    }
  }
  function addHistoryCatalog(catalog) {
    assets.addDescriptors(descriptorsFor(catalog));
    catalog.historicalCountries.forEach((row, index) => addOutlineDescriptors(row, baseSlots.length+index));
  }
  function planHistoryBorders(view, cull) {
    if (!view) return [];
    let index = borderPlansByView.get(view);
    if (!index) {
      const groups = new Set(view.borders);
      const allRows = assets.plan(() => true,
        row => row.role==='border'&&!row.baseBorder&&groups.has(row.historyBorder));
      index = createGlobeChunkCatalog(combineBorderRows(allRows,false));
      borderPlansByView.set(view, index);
    }
    return index.select(cull);
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
  addOutlineDescriptors(spec, null);
  function dispose() {
    outlineBySlot.clear();
    assets.dispose();
  }
  return Object.freeze({...assets, addHistoryCatalog,
    outlineDescriptors:slot => outlineBySlot.get(slot)??[], planHistoryBorders, loadOutlines, dispose});
}
