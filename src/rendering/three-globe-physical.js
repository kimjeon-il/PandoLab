import {globeMeshResourceKey} from './globe-mesh.js';
import {createRenderPacketCache,renderCacheBudget,touchRenderCache} from './render-cache-budget.js';

/** The physical owner selects only the packets needed at the current zoom.
 * Water polygons remain required, while lake tiers and rivers are optional.
 * Contexts share immutable decoded packets, not another copy of their arrays.
 */
export function createGlobePhysicalAssets(descriptors,{loadMesh,loadStroke,byteBudget=renderCacheBudget().physicalCpuBytes,residency=null}){
 const catalog=new Map(descriptors.map(row=>[row.identity,row]));
 const contexts=new Map(),pending=new Map();
 let retained=[],disposed=false;
 const meshKey=spec=>`mesh:${globeMeshResourceKey(spec)}`;
 const lineKey=spec=>`line:${spec.sha256}`;
 function plan(identity,{zoom=Infinity,lakesVisible=true,riversVisible=true}={}){
  const spec=catalog.get(identity);
  if(!spec)throw Error('Three.js physical context is missing');
  const lakes=lakesVisible?spec.lakes.filter(row=>zoom>=row.minZoom):[];
  const rivers=riversVisible&&zoom>=spec.riverMinZoom;
  const key=JSON.stringify([identity,rivers,lakes.map(row=>[row.spec.sha256,row.minZoom])]);
  const keys=[...spec.waters.map(row=>meshKey(row.spec)),...lakes.map(row=>meshKey(row.spec)),...(rivers?[lineKey(spec.rivers)]:[])];
  return {key,spec,lakes,rivers,keys};
 }
 const files=createRenderPacketCache({byteBudget,residency,onEvict:key=>{
  for(const [identity,entry] of contexts)if(entry.plan.keys.includes(key))contexts.delete(identity);
 }});
 function refresh(){
  if(disposed)return;
  const active=[...retained,...[...pending.values()].map(row=>row.plan)];
  const keys=new Set(active.flatMap(row=>row.keys));
  files.retain(keys);
  const protectedIds=new Set(active.map(row=>row.key));
  const inactive=[...contexts.keys()].filter(identity=>!protectedIds.has(identity));
  for(const identity of inactive.slice(0,Math.max(0,inactive.length-4)))contexts.delete(identity);
 }
 async function prepare(target,{signal=null}={}){
  if(disposed)throw new DOMException('Physical cache disposed','AbortError');
  signal?.throwIfAborted();
  const existing=touchRenderCache(contexts,target.key);
  if(existing)return existing;
  const {spec}=target;
  const pendingEntry=pending.get(target.key)??{plan:target,users:0};
  pendingEntry.users++;pending.set(target.key,pendingEntry);refresh();
  const mesh=spec=>files.read(meshKey(spec),readSignal=>loadMesh(spec,readSignal),signal);
  const strokes=spec=>files.read(lineKey(spec),readSignal=>loadStroke(spec,readSignal),signal);
  try{
   const [rivers,waters,lakes]=await Promise.all([
    target.rivers?strokes(spec.rivers):null,
    Promise.all(spec.waters.map(async row=>({...row,mesh:await mesh(row.spec)}))),
    Promise.all(target.lakes.map(async row=>({...row,mesh:await mesh(row.spec)}))),
   ]);
   signal?.throwIfAborted();
   if(disposed)throw new DOMException('Physical cache disposed','AbortError');
   const concurrent=touchRenderCache(contexts,target.key);
   if(concurrent)return concurrent;
   const result=Object.freeze({spec,plan:target,rivers,waters,lakes});
   contexts.set(target.key,result);return result;
  }finally{
   if(--pendingEntry.users===0&&pending.get(target.key)===pendingEntry)pending.delete(target.key);
   refresh();
  }
 }
 function retain(plans){retained=plans.filter(Boolean);refresh();}
 function dispose(){disposed=true;contexts.clear();pending.clear();retained=[];files.dispose();}
 return Object.freeze({has:identity=>catalog.has(identity),plan,prepare,retain,memoryEntries:files.memoryEntries,stats:()=>({...files.stats(),contexts:contexts.size}),dispose});
}
