import {createRenderPacketCache,renderCacheBudget,touchRenderCache} from './render-cache-budget.js';
import {createGlobeChunkCatalog,globeChunkSetContains} from './globe-view-mesh-assets.js';
import {selectGlobeRiverChunks} from './three-globe-rivers.js';

// The same immutable Cartesian descriptor index is used for land, water,
// lakes and all river tiers. Legacy descriptors remain conservatively
// admitted; old detailed river cells retain their geographic selector.
export function createGlobePhysicalAssets(descriptors,{loadMesh,loadStroke,byteBudget=renderCacheBudget().physicalCpuBytes,residency=null}){
 const catalog=new Map(),contexts=new Map(),pending=new Map();
 let retained=[],disposed=false;
 function chunks(list,role){
  return list.flatMap((row,i)=>(row.chunks??[{spec:row.spec}]).map((chunk,j)=>({
   ...row,...chunk,chunks:undefined,role,kind:role==='river'?'stroke':'mesh',
   key:role+':'+(row.id??i)+':'+j+':'+chunk.spec.sha256,
  })));
 }
 function addDescriptors(rows){
  for(const spec of rows){
   if(catalog.has(spec.identity))continue;
   const waters=chunks(spec.waters,'water'),lakes=chunks(spec.lakes,'lake');
   const rivers=(spec.riverChunks??(spec.rivers?[{spec:spec.rivers}]:[])).map((row,i)=>({...row,role:'river',kind:'stroke',
    minZoom:spec.riverMinZoom,key:'river:'+i+':'+row.spec.sha256}));
   const details=(spec.riverDetail??[]).map(row=>({...row,role:'detail',kind:'stroke',
    key:'detail:'+row.id,legacy:!row.bounds||row.bounds.length!==6}));
   catalog.set(spec.identity,{spec,meshes:createGlobeChunkCatalog([...waters,...lakes]),
    strokes:createGlobeChunkCatalog(rivers),detail:createGlobeChunkCatalog(details.filter(row=>!row.legacy)),
    legacyDetails:details.filter(row=>row.legacy)});
  }
 }
 addDescriptors(descriptors);
 const keyOf=row=>row.kind+':'+row.spec.sha256;
 const files=createRenderPacketCache({byteBudget,residency,onEvict:key=>{
  for(const [identity,entry] of contexts)if(entry.plan.keys.includes(key))contexts.delete(identity);
 }});
 function read(row,signal,priority){
  return files.read(keyOf(row),(readSignal,readPriority)=>row.kind==='stroke'?
   loadStroke(row.spec,readSignal,readPriority):loadMesh(row.spec,readSignal,readPriority),signal,{priority});
 }
 function plan(identity,{zoom=Infinity,lakesVisible=true,riversVisible=true,cull=()=>true,strokeCull=cull}={}){
  const source=catalog.get(identity);
  if(!source)throw Error('Three.js physical context is missing');
  const {spec}=source,meshes=source.meshes.select(cull,row=>row.role==='water'||lakesVisible&&zoom>=row.minZoom);
  const waters=meshes.filter(row=>row.role==='water'),lakes=meshes.filter(row=>row.role==='lake');
  const rivers=riversVisible&&zoom>=spec.riverMinZoom;
  const riverChunks=rivers?source.strokes.select(strokeCull):[];
  const rows=[...waters,...lakes,...riverChunks],key=JSON.stringify([identity,rivers,rows.map(row=>row.key)]);
  return {key,spec,waters,lakes,rivers,riverChunks,rows,keys:rows.map(keyOf)};
 }
 function refresh(){
  if(disposed)return;
  const active=[...retained,...[...pending.values()].map(row=>row.plan)];
  files.retain(new Set(active.flatMap(row=>row.keys)));
  const protectedIds=new Set(active.map(row=>row.key)),inactive=[...contexts.keys()].filter(key=>!protectedIds.has(key));
  for(const key of inactive.slice(0,Math.max(0,inactive.length-4)))contexts.delete(key);
 }
 async function prepare(target,{signal=null,priority=20}={}){
  if(disposed)throw new DOMException('Physical cache disposed','AbortError');
  signal?.throwIfAborted();
  const existing=touchRenderCache(contexts,target.key);if(existing)return existing;
  const pendingEntry=pending.get(target.key)??{plan:target,users:0};
  pendingEntry.users++;pending.set(target.key,pendingEntry);refresh();
  try{
   const [waters,lakes,riverChunks]=await Promise.all([
    Promise.all(target.waters.map(async row=>({...row,mesh:await read(row,signal,priority)}))),
    Promise.all(target.lakes.map(async row=>({...row,mesh:await read(row,signal,priority)}))),
    Promise.all(target.riverChunks.map(async row=>({...row,packet:await read(row,signal,priority)}))),
   ]);
   signal?.throwIfAborted();if(disposed)throw new DOMException('Physical cache disposed','AbortError');
   const concurrent=touchRenderCache(contexts,target.key);if(concurrent)return concurrent;
   // Keep the legacy single-river accessor for existing consumers/fixtures.
   const result=Object.freeze({spec:target.spec,plan:target,waters,lakes,riverChunks,
    rivers:target.spec.riverChunks?null:riverChunks[0]?.packet??null});
   contexts.set(target.key,result);return result;
  }finally{
   if(--pendingEntry.users===0&&pending.get(target.key)===pendingEntry)pending.delete(target.key);
   refresh();
  }
 }
 function coversWaters(have,needed){return !!have&&have.spec.identity===needed.spec.identity&&globeChunkSetContains(have.waters,needed.waters);}
 function covers(have,needed){return coversWaters(have,needed)&&have.rivers===needed.rivers&&
  globeChunkSetContains(have.lakes,needed.lakes)&&globeChunkSetContains(have.riverChunks,needed.riverChunks);}
 async function warm(target,{signal,priority=-20,claim,holdBytes=0}){
  for(const row of target.rows){signal?.throwIfAborted();if(files.has(keyOf(row))){if(holdBytes)files.holdWarm(keyOf(row),holdBytes);continue;}if(!claim(row.spec,row.kind))continue;await read(row,signal,priority);if(holdBytes)files.holdWarm(keyOf(row),holdBytes);}
 }
 function detailPlan(identity,{zoom,strokeCull=()=>true,geographicBounds}){
  const source=catalog.get(identity);if(!source)return [];
  return [...source.detail.select(strokeCull,row=>zoom>=row.minZoom),
   ...(geographicBounds?selectGlobeRiverChunks(source.legacyDetails,geographicBounds,zoom):[])];
 }
 function retain(plans){retained=plans.filter(Boolean);refresh();}
 function dispose(){disposed=true;contexts.clear();pending.clear();catalog.clear();retained=[];files.dispose();}
 return Object.freeze({has:identity=>catalog.has(identity),addDescriptors,plan,prepare,coversWaters,covers,warm,releaseWarm:()=>files.releaseWarm(),detailPlan,
  readDetail:(row,signal)=>read(row,signal,5),retain,memoryEntries:files.memoryEntries,stats:()=>({...files.stats(),contexts:contexts.size}),dispose});
}
