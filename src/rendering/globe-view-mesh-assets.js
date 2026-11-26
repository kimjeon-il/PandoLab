import { createGlobeRangeCuller } from './globe-spatial-partition.js';
import { createRenderPacketCache, renderCacheBudget } from './render-cache-budget.js';
import { createGlobePacketIndex } from './globe-picking.js';

const all = () => true;
export function globeViewChunkCuller(camera, viewport, padding = 0) {
  return camera&&viewport?createGlobeRangeCuller(camera.frame, viewport.width, viewport.height, padding):all;
}
export function selectGlobeMeshChunks(chunks, cull, slots = null) {
  return chunks.filter(row => (!row.bounds||cull(row.bounds))&&(!slots||!row.slots?.length||row.slots.some(slot => slots.has(slot))));
}
const chunkKeys = new WeakMap();
export function globeChunkSetContains(have, needed) {
  if (have===needed)return true;
  let keys = chunkKeys.get(have); if (!keys) {keys = new Set(have.map(row => row.key)); chunkKeys.set(have, keys);}
  return needed.every(row => keys.has(row.key));
}
export const globeChunkPlanKey = rows => rows.map(row => row.key).join('|');

// Build the descriptor hierarchy once, not on every camera change. Unbounded
// legacy packets are admitted conservatively. Preserve descriptor order.
export function createGlobeChunkCatalog(descriptors) {
  const rows = descriptors.map((row, index) => ({...row, key:row.key??index+':'+row.spec.sha256, order:row.order??index, catalogOrder:index}));
  const fallback = rows.filter(row => !row.bounds);
  const index = createGlobePacketIndex(rows.filter(row => row.bounds), row => row.bounds);
  function select(cull = all, accept = all) {
    return [...index.query(cull), ...fallback].filter(accept).sort((a, b) => a.catalogOrder-b.catalogOrder);
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
export function createGlobeBaseAssets(descriptors, options) {
  const owner = createGlobeChunkAssets(descriptors, options);
  return {...owner, plan:(cull, slots = null) => owner.plan(cull, row => !slots||!row.slots?.length||row.slots.some(slot => slots.has(slot)))};
}

/** Optional errors cannot block a later required request. Back off only
  * repeated optional attempts; never silently defer required coverage. */
export function createGlobePlanFailures() {
  const optional = new Map();
  return {allow:(key, required) => required||!optional.has(key),
    fail:(key, required) => {if (!required) {optional.clear(); optional.set(key, true);}},
    clear:() => optional.clear()};
}
