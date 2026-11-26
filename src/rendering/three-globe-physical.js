import {globeMeshResourceKey} from './globe-mesh.js';
import {createRenderPacketCache,renderCacheBudget,touchRenderCache} from './render-cache-budget.js';

/** Immutable packets can be shared by several dated physical scenes. */
export function createGlobePhysicalAssets(descriptors,{loadMesh,loadStroke,byteBudget=renderCacheBudget().physicalCpuBytes}){
 const catalog=new Map(descriptors.map(row=>[row.identity,row]));
 const contexts=new Map(),pending=new Set();
 let retained=new Set(),disposed=false;
 const meshKey=spec=>`mesh:${globeMeshResourceKey(spec)}`;
 const lineKey=spec=>`line:${spec.sha256}`;
 const keysFor=spec=>[lineKey(spec.rivers),...spec.waters.map(row=>meshKey(row.spec)),...spec.lakes.map(row=>meshKey(row.spec))];
 const files=createRenderPacketCache({byteBudget,onEvict:key=>{
  // Contexts may not keep evicted packet buffers alive.
  for(const [identity,entry] of contexts)if(!pending.has(identity)&&entry.keys.includes(key))contexts.delete(identity);
 }});
 function refresh(){
  const protectedIds=new Set([...retained,...pending]),keys=new Set();
  for(const identity of protectedIds){
   const spec=catalog.get(identity);
   if(spec)for(const key of keysFor(spec))keys.add(key);
  }
  files.retain(keys);
  // Context metadata is inexpensive, but its packet references must not grow
  // with the full timeline. Keep only a few recent inactive contexts.
  const inactive=[...contexts.keys()].filter(identity=>!protectedIds.has(identity));
  for(const identity of inactive.slice(0,Math.max(0,inactive.length-4)))contexts.delete(identity);
 }
 const mesh=spec=>files.read(meshKey(spec),()=>loadMesh(spec));
 const strokes=spec=>files.read(lineKey(spec),()=>loadStroke(spec));
 function prepare(identity){
  if(disposed)return Promise.reject(new DOMException('Physical cache disposed','AbortError'));
  const spec=catalog.get(identity);
  if(!spec)throw Error('Three.js physical context is missing');
  const existing=touchRenderCache(contexts,identity);
  if(existing)return existing.promise;
  const entry={keys:keysFor(spec),promise:null};
  pending.add(identity);contexts.set(identity,entry);refresh();
  entry.promise=(async()=>{
   try{
    const [rivers,waters,lakes]=await Promise.all([
     strokes(spec.rivers),
     Promise.all(spec.waters.map(async row=>({...row,mesh:await mesh(row.spec)}))),
     Promise.all(spec.lakes.map(async row=>({...row,mesh:await mesh(row.spec)}))),
    ]);
    return Object.freeze({spec,rivers,waters,lakes});
   }catch(error){
    if(contexts.get(identity)===entry)contexts.delete(identity);
    throw error;
   }finally{pending.delete(identity);if(!disposed)refresh();}
  })();
  return entry.promise;
 }
 function retain(identities){retained=new Set(identities);refresh();}
 function dispose(){disposed=true;contexts.clear();pending.clear();retained.clear();files.dispose();}
 return Object.freeze({has:identity=>catalog.has(identity),prepare,retain,stats:()=>({...files.stats(),contexts:contexts.size}),dispose});
}
