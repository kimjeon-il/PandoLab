import { createRenderPacketCache, renderCacheBudget, touchRenderCache } from './render-cache-budget.js';
import { createGlobeChunkCatalog, globeChunkSetContains } from './globe-view-mesh-assets.js';
import { GLOBE_FINE_LOD, globeChunkLod } from './globe-lod.js';
import { batchGlobeStrokeDescriptors,globeStrokePacketDecodedBytes } from './globe-spatial-aggregate.js';

// The same immutable Cartesian descriptor index is used for water, lakes
// and all river tiers.
export function createGlobePhysicalAssets({loadMesh,loadStroke,byteBudget=renderCacheBudget().physicalCpuBytes,
  strokeBatchBytes=renderCacheBudget().borderBatchBytes,residency=null}) {
  const contexts=new Map(),pending=new Map();
  function batchRiverChunks(rows) {
    return batchGlobeStrokeDescriptors(rows,{
      prefix:'river-batch',byteBudget:strokeBatchBytes,maxSources:32,
      groupKey:row=>{
        const cell=String(row.cell??'').split(':').map(Number);
        if(row.lod===0&&cell.length===3&&cell.every(Number.isInteger))
          return 'lod0:'+String(row.minZoom)+':'+cell.map(value=>Math.floor(value/2)).join(':');
        return 'lod:'+globeChunkLod(row)+':'+String(row.minZoom??'');
      },
      aggregate:sources=>{
        const row=sources[0],cell=String(row.cell??'').split(':').map(Number);
        if(row.lod!==0||cell.length!==3||!cell.every(Number.isInteger))return {};
        const supercell=cell.map(value=>Math.floor(value/2)),min=supercell.map(value=>value-1),max=supercell;
        return {aggregateErrorScale:16,aggregateReductionEstimate:4,aggregateMaxRun:512,aggregateBounds:[...min,...max]};
      },
    });
  }
  let retained = [], disposed = false;
  function createDescriptor(spec,rows) {
    const features=new Map(spec.waters.map(row=>[row.id,row.feature]));
    const meshes=rows.filter(row=>row.kind==='mesh').map(row=>row.role==='water'?{...row,feature:features.get(row.id)}:row);
    const rivers=batchRiverChunks(rows.filter(row=>row.role==='river'));
    return {spec,meshes:createGlobeChunkCatalog(meshes),strokes:createGlobeChunkCatalog(rivers)};
  }
  function createDetailDescriptor(rows) {return createGlobeChunkCatalog(rows.filter(row=>row.role==='detail'));}
  const keyOf = row => row.kind+':'+row.spec.sha256;
  const files = createRenderPacketCache({byteBudget, residency, onEvict:key => {
    for (const [identity, entry] of contexts)if (entry.plan.keys.includes(key))contexts.delete(identity);
  }});
  function read(row, signal, priority) {
    return files.read(keyOf(row), (readSignal, readPriority) => row.kind==='stroke'?
      loadStroke(row.spec, readSignal, readPriority, row):loadMesh(row.spec, readSignal, readPriority), signal, {priority});
  }
  function plan(source,{zoom=Infinity,lod=GLOBE_FINE_LOD,lakesVisible=true,riversVisible=true,cull=()=>true,strokeCull=cull}={}) {
    if (!source)throw Error('Three.js physical context is missing');
    const {spec}=source,identity=spec.identity,meshes=source.meshes.select(cull,row=>row.role==='water'||lakesVisible&&zoom>=row.minZoom,lod);
    const waters = meshes.filter(row => row.role==='water'), lakes = meshes.filter(row => row.role==='lake');
    const rivers = riversVisible&&zoom>=spec.riverMinZoom;
    const riverChunks = rivers?source.strokes.select(strokeCull,()=>true,lod):[];
    const rows = [...waters, ...lakes, ...riverChunks], key = JSON.stringify([identity,lod,rivers,rows.map(row => row.key)]);
    return {key,spec,lod,waters,lakes,rivers,riverChunks,rows,keys:rows.map(keyOf)};
  }
  function refresh() {
    if (disposed)return;
    const active = [...retained, ...[...pending.values()].map(row => row.plan)];
    files.retain(new Set(active.flatMap(row => row.keys)));
    const protectedIds = new Set(active.map(row => row.key)), inactive = [...contexts.keys()].filter(key => !protectedIds.has(key));
    for (const key of inactive.slice(0, Math.max(0, inactive.length-4)))contexts.delete(key);
  }
  async function prepare(target, {signal = null, priority = 20} = {}) {
    if (disposed)throw new DOMException('Physical cache disposed','AbortError');
    signal?.throwIfAborted();
    const existing = touchRenderCache(contexts, target.key); if (existing)return existing;
    const pendingEntry = pending.get(target.key)??{plan:target, users:0};
    pendingEntry.users++; pending.set(target.key, pendingEntry); refresh();
    try {
      const [waters, lakes, riverChunks] = await Promise.all([
        Promise.all(target.waters.map(async row => ({...row, mesh:await read(row, signal, priority)}))),
        Promise.all(target.lakes.map(async row => ({...row, mesh:await read(row, signal, priority)}))),
        Promise.all(target.riverChunks.map(async row=>{
          const packet=await read(row,signal,priority);
          if(!row.aggregateErrorScale)return {...row,packet};
          const {sources,aggregateErrorScale,aggregateReductionEstimate,aggregateMaxRun,aggregateBounds,...descriptor}=row;
          const decodedBytes=globeStrokePacketDecodedBytes(packet);
          return {...descriptor,first:0,end:packet.count,
            spec:{...row.spec,decodedBytes,estimatedBytes:decodedBytes*4+packet.count*24+4096},packet};
        })),
      ]);
      signal?.throwIfAborted(); if (disposed)throw new DOMException('Physical cache disposed','AbortError');
      const concurrent = touchRenderCache(contexts, target.key); if (concurrent)return concurrent;
      const result = Object.freeze({spec:target.spec, plan:target, waters, lakes, riverChunks});
      contexts.set(target.key, result); return result;
    }finally {
      if (--pendingEntry.users===0&&pending.get(target.key)===pendingEntry)pending.delete(target.key);
      refresh();
    }
  }
  function coversWaters(have, needed) {return !!have&&have.spec.identity===needed.spec.identity&&have.lod===needed.lod&&globeChunkSetContains(have.waters, needed.waters);}
  function covers(have, needed) {return coversWaters(have, needed)&&(!needed.rivers||have.rivers)&&
    globeChunkSetContains(have.lakes, needed.lakes)&&globeChunkSetContains(have.riverChunks, needed.riverChunks);}
  async function warm(target, {signal, priority = -20, claim, holdBytes = 0}) {
    for (const row of target.rows) {signal?.throwIfAborted(); if (files.has(keyOf(row))) {if (holdBytes)files.holdWarm(keyOf(row), holdBytes); continue;}if (!claim(row.spec, row.kind))continue; await read(row, signal, priority); if (holdBytes)files.holdWarm(keyOf(row), holdBytes);}
  }
  function detailPlan(source,{zoom,lod=GLOBE_FINE_LOD,strokeCull=()=>true}) {
    return source?source.select(strokeCull,row=>zoom>=row.minZoom,lod):[];
  }
  function retain(plans) {retained = plans.filter(Boolean); refresh();}
  function dispose() {disposed = true; contexts.clear(); pending.clear(); retained = []; files.dispose();}
  return Object.freeze({createDescriptor,createDetailDescriptor,plan, prepare, coversWaters, covers, warm, releaseWarm:() => files.releaseWarm(), detailPlan,
    readDetail:(row, signal) => read(row, signal, 5), retain, memoryEntries:files.memoryEntries, stats:() => ({...files.stats(), contexts:contexts.size}), dispose});
}
