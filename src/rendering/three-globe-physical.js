import {globeMeshResourceKey} from './globe-mesh.js';

/** Immutable packets can be shared by several dated physical scenes. */
export function createGlobePhysicalAssets(descriptors,{loadMesh,loadStroke}){
 const catalog=new Map(descriptors.map(row=>[row.identity,row]));
 const files=new Map(),contexts=new Map();
 function remember(cache,key,read){
  if(!cache.has(key)){
   const task=Promise.resolve().then(read);
   cache.set(key,task);
   task.catch(()=>{if(cache.get(key)===task)cache.delete(key);});
  }
  return cache.get(key);
 }
 const mesh=spec=>remember(files,`mesh:${globeMeshResourceKey(spec)}`,()=>loadMesh(spec));
 const strokes=spec=>remember(files,`line:${spec.sha256}`,()=>loadStroke(spec));
 function prepare(identity){
  const spec=catalog.get(identity);
  if(!spec)throw Error('Three.js physical context is missing');
  return remember(contexts,identity,async()=>{
   const [land,rivers,waters,lakes]=await Promise.all([
    mesh(spec.land),strokes(spec.rivers),
    Promise.all(spec.waters.map(async row=>({...row,mesh:await mesh(row.spec)}))),
    Promise.all(spec.lakes.map(async row=>({...row,mesh:await mesh(row.spec)}))),
   ]);
   return Object.freeze({spec,land,rivers,waters,lakes});
  });
 }
 return Object.freeze({has:identity=>catalog.has(identity),prepare});
}
