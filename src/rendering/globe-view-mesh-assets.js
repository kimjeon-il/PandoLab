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
/** Optional errors cannot block a later required request. Back off only
  * repeated optional attempts; never silently defer required coverage. */
export function createGlobePlanFailures() {
  const optional = new Map();
  return {allow:(key, required) => required||!optional.has(key),
    fail:(key, required) => {if (!required) {optional.clear(); optional.set(key, true);}},
    clear:() => optional.clear()};
}


/** Owns base/history territorial descriptors, border batching, and outline lookup. */
export function createGlobeTerritorialAssets(spec, {
  baseSlots, cacheBudget, residency, loadMesh, loadStroke, load, slotCount = () => baseSlots.length,
}) {
  const outlineBySlot = new Map();
  function descriptorsFor(catalog = null) {
    if (!catalog) return [
      ...spec.countryChunks.map((row, i) => ({...row, role:'country', key:'base-country:'+i+':'+row.spec.sha256})),
      ...spec.borderChunks.map((row, i) => ({...row, role:'border', kind:'stroke', baseBorder:true, key:'base-border:'+i+':'+row.spec.sha256})),
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
  function combineHistoryBorders(rows) {
    const groups = new Map(), result = [];
    for (const row of rows) {
      if (row.role!=='border'||row.baseBorder) {result.push(row); continue;}
      const cell = row.cell;
      let group = groups.get(cell);
      if (!group) {group = []; groups.set(cell, group);}
      group.push(row);
    }
    for (const group of groups.values()) {
      let sources = [], decodedBytes = 0;
      const flush = () => {
        if (sources.length===1)result.push(sources[0]);
        else if (sources.length) {
          const key = 'border-batch:'+sources.map(row => row.key).join(',');
          const compressedBytes = sources.reduce((sum, row) => sum+(Number(row.spec.compressedBytes)||0), 0);
          const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
          for (const row of sources)for (let axis = 0; axis<3; axis++) {
            bounds[axis] = Math.min(bounds[axis], row.bounds[axis]);
            bounds[axis+3] = Math.max(bounds[axis+3], row.bounds[axis+3]);
          }
          result.push({role:'border', kind:'stroke', key, sources, bounds,
            spec:{sha256:key, decodedBytes, compressedBytes, estimatedBytes:compressedBytes*3+decodedBytes*7+64*1024}});
        }
        sources = [];
        decodedBytes = 0;
      };
      for (const row of group) {
        const bytes = Number(row.spec.decodedBytes)||0;
        if (sources.length&&(sources.length>=32||decodedBytes+bytes>cacheBudget.borderBatchBytes))flush();
        sources.push(row);
        decodedBytes += bytes;
      }
      flush();
    }
    return result;
  }
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
      index = createGlobeChunkCatalog(combineHistoryBorders(allRows));
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
