import {createGlobeRangeCuller} from './globe-spatial-partition.js';
import {createRenderPacketCache,renderCacheBudget} from './render-cache-budget.js';

// A chunk descriptor is exact and conservative in Cartesian chord space.
// Older build metadata has no bounds and is intentionally always admitted.
export function globeViewChunkCuller(camera,viewport,padding=0){
 return camera&&viewport?createGlobeRangeCuller(camera.frame,viewport.width,viewport.height,padding):()=>true;
}
export function selectGlobeMeshChunks(chunks,cull,slots=null){
 return chunks.filter(row=>(!row.bounds||cull(row.bounds))&&(!slots||!row.slots?.length||row.slots.some(slot=>slots.has(slot))));
}
export function globeChunkSetContains(have,needed){
 if(have===needed)return true;
 const keys=new Set(have.map(row=>row.key));
 return needed.every(row=>keys.has(row.key));
}

export function createGlobeBaseAssets(descriptors,{loadMesh,residency,byteBudget=renderCacheBudget().historicalCpuBytes}){
 const rows=descriptors.map((row,index)=>({...row,key:index+':'+row.spec.sha256,order:index}));
 const packets=createRenderPacketCache({byteBudget,residency});
 let retained=[],disposed=false;
 const keyOf=row=>row.spec.sha256;
 function plan(cull,slots=null){return selectGlobeMeshChunks(rows,cull,slots);}
 function retain(plans){
  retained=plans.filter(Boolean);
  packets.retain(new Set(retained.flatMap(plan=>plan.map(keyOf))));
 }
 async function prepare(plan,{signal,priority=20}={}){
  signal?.throwIfAborted();
  if(disposed)throw new DOMException('Base meshes disposed','AbortError');
  return Promise.all(plan.map(async row=>({...row,mesh:await packets.read(keyOf(row),
   readSignal=>loadMesh(row.spec,readSignal,priority),signal)})));
 }
 async function warm(plan,{signal,priority=-20,claim}){
  for(const row of plan){
   signal?.throwIfAborted();
   if(packets.has(keyOf(row))||!claim(row.spec))continue;
   await packets.read(keyOf(row),readSignal=>loadMesh(row.spec,readSignal,priority),signal);
  }
 }
 function dispose(){disposed=true;retained=[];packets.dispose();}
 return Object.freeze({plan,retain,prepare,warm,stats:packets.stats,dispose});
}
