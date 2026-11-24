import {createGeometryByteEstimator} from './geometry-residency.js';
// Physical contexts are immutable render derivatives, not canonical storage.
export function createPhysicalContextCache({byteBudget=128*1024*1024,entryLimit=3}={}){
 if(!Number.isSafeInteger(byteBudget)||byteBudget<1||!Number.isSafeInteger(entryLimit)||entryLimit<1)
  throw new RangeError('Invalid physical context cache budget');
 const entries=new Map(),geometryBytes=createGeometryByteEstimator();
 let evictions=0;
 function measure(entry){
  const geometries=new Set();
  if(entry.value){geometries.add(entry.value.geometry);for(const row of entry.value.waters)geometries.add(row.water);}
  if(entry.presentation){geometries.add(entry.presentation.geometry);for(const row of entry.presentation.waterFeatures||[])geometries.add(row.geometry);geometries.add(entry.presentation.water);}
  entry.geometries=geometries;
  entry.bytes=0;for(const geometry of geometries)entry.bytes+=geometryBytes(geometry);
  return entry.bytes;
 }
 function estimate(){
  const seen=new Set();let bytes=0;
  for(const entry of entries.values())for(const geometry of entry.geometries||[]){
   if(seen.has(geometry))continue;seen.add(geometry);bytes+=geometryBytes(geometry);
  }
  return bytes;
 }
 function trim(protectedKeys=[]){
  const pins=new Set(protectedKeys);let bytes=estimate();
  for(const [key,entry]of entries){
   if(entries.size<=entryLimit&&bytes<=byteBudget)break;
   if(pins.has(key)||entry.status==='loading')continue;
   entry.activation=null;entries.delete(key);evictions++;bytes=estimate();
  }
 }
 function cancelUnpinnedLoads(protectedKeys=[]){
  const pins=new Set(protectedKeys);
  for(const [key,entry]of entries)if(entry.status==='loading'&&!pins.has(key)){
   entries.delete(key);entry.activation=null;entry.controller?.abort();evictions++;
  }
 }
 function touch(key){const entry=entries.get(key);if(entry){entries.delete(key);entries.set(key,entry);}return entry;}
 function clear(){for(const entry of entries.values()){entry.activation=null;entry.controller?.abort();}entries.clear();}
 return {get:key=>entries.get(key),has:key=>entries.has(key),set:(key,entry)=>entries.set(key,entry),
  delete:key=>entries.delete(key),values:()=>entries.values(),touch,measure,trim,cancelUnpinnedLoads,clear,
  stats:()=>({entries:entries.size,estimatedBytes:estimate(),
   byteBudget,entryLimit,evictions})};
}
