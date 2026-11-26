import {createStoredAssetLoader} from '../data/stored-asset-loader.js';
import {estimateGlobeWorkingBytes} from './globe-work-scheduler.js';

// Verified packet I/O and deferred-write accounting share a single owner.
export function createGlobeAssetReader({dataRevision,cacheBudget,residency,loadGate,packetTasks,metrics,lifetime,resolveUrl}){
 let persistenceBytes=0,persistencePeakBytes=0,persistenceSkipped=0;
 function reserveDeferredWrite(bytes){
  // Cache writes may retain the verified source and a Response copy.
  const size=bytes*2;
  if(persistenceBytes+size>cacheBudget.persistenceBytes){persistenceSkipped++;return null;}
  const release=residency.reserve(size,{kind:'disk-cache-write',optional:true,trimFirst:false});
  if(!release){persistenceSkipped++;return null;}
  persistenceBytes+=size;persistencePeakBytes=Math.max(persistencePeakBytes,persistenceBytes);
  let ended=false;return ()=>{if(ended)return;ended=true;persistenceBytes-=size;release();};
 }
 const loader=createStoredAssetLoader({dataRevision,cachePolicy:'immutable',deferCacheWrite:true,reserveDeferredWrite,resolveUrl});
 async function load(row,kind,{phase='startup',label='Three.js 지도 자산',signal=lifetime.signal,priority=phase==='startup'?10:0,...parameters}={}){
  const estimate=estimateGlobeWorkingBytes(row,kind);
  return loadGate.run({bytes:estimate,priority,signal,kind:'load-'+kind},async()=>{
   const result=await loader.loadStoredAsset(row,phase,row.sha256,label,bytes=>
    metrics.track('three.decode-packet',()=>packetTasks.decode(kind,bytes,row,{signal,priority,...parameters})),signal);
   return result.value;
  });
 }
 async function loadTerritorialStroke(row,signal,priority,descriptor){
  if(!descriptor.sources)return load(row,'stroke',{signal,priority});
  return loadGate.run({bytes:estimateGlobeWorkingBytes(descriptor.spec,'stroke'),priority,signal,kind:'border-batch'},async()=>{
   const inputs=[];
   for(const item of descriptor.sources){
    signal.throwIfAborted();
    const result=await loader.loadStoredAsset(item.spec,'startup',item.spec.sha256,'역사 국경선',bytes=>bytes,signal);
    inputs.push({bytes:result.value,spec:item.spec});
   }
   return metrics.track('three.combine-borders',()=>packetTasks.combineStoredStrokes(inputs,{signal,priority}));
  });
 }
 return Object.freeze({load,loadTerritorialStroke,stats:()=>({
  bytes:persistenceBytes,peakBytes:persistencePeakBytes,skipped:persistenceSkipped,
 })});
}
