// Physical contexts are immutable render derivatives, not canonical storage.
export function createPhysicalContextCache({byteBudget=128*1024*1024,entryLimit=3}={}){
 if(!Number.isSafeInteger(byteBudget)||byteBudget<1||!Number.isSafeInteger(entryLimit)||entryLimit<1)
  throw new RangeError('Invalid physical context cache budget');
 const entries=new Map(),sizes=new WeakMap();
 let evictions=0;
 // Conservative heap estimate: coordinate arrays, child references and
 // numeric components. Memoize shared immutable coordinate subtrees.
 function sizeOf(value){
  if(!Array.isArray(value))return 8;
  if(sizes.has(value))return sizes.get(value);
  let bytes=32+value.length*8;
  for(const child of value)if(Array.isArray(child))bytes+=sizeOf(child);
  sizes.set(value,bytes);return bytes;
 }
 const geometryBytes=geometry=>geometry?sizeOf(geometry.coordinates):0;
 function measure(entry){
  const geometries=new Set();
  if(entry.value){geometries.add(entry.value.geometry);for(const row of entry.value.waters)geometries.add(row.water);}
  if(entry.presentation){geometries.add(entry.presentation.geometry);for(const row of entry.presentation.waterFeatures||[])geometries.add(row.geometry);geometries.add(entry.presentation.water);}
  entry.bytes=0;for(const geometry of geometries)entry.bytes+=geometryBytes(geometry);
  return entry.bytes;
 }
 function trim(protectedKeys=[]){
  const pins=new Set(protectedKeys);let bytes=0;
  for(const entry of entries.values())bytes+=entry.bytes||0;
  for(const [key,entry]of entries){
   if(entries.size<=entryLimit&&bytes<=byteBudget)break;
   if(pins.has(key)||entry.status==='loading')continue;
   bytes-=entry.bytes||0;entry.activation=null;entries.delete(key);evictions++;
  }
 }
 function touch(key){const entry=entries.get(key);if(entry){entries.delete(key);entries.set(key,entry);}return entry;}
 function clear(){for(const entry of entries.values()){entry.activation=null;entry.controller?.abort();}entries.clear();}
 return {get:key=>entries.get(key),has:key=>entries.has(key),set:(key,entry)=>entries.set(key,entry),
  delete:key=>entries.delete(key),values:()=>entries.values(),touch,measure,trim,clear,
  stats:()=>({entries:entries.size,estimatedBytes:[...entries.values()].reduce((sum,entry)=>sum+(entry.bytes||0),0),
   byteBudget,entryLimit,evictions})};
}
