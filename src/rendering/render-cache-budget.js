// These are standby-cache ceilings, not limits on the visible world.
// Unknown device hints keep the original defaults. Do not infer available
// heap from total device RAM or change the canonical geometry quality.
const MiB=1024*1024;
export function renderCacheBudget(deviceMemory=globalThis.navigator?.deviceMemory){
 const ram = Number(deviceMemory);
 const hasMemoryHint = Number.isFinite(ram) && ram > 0;
 const isLowMemory = hasMemoryHint && ram <= 2;
 const isMediumMemory = hasMemoryHint && ram <= 4;
 const factor = isLowMemory ? 0.375 : isMediumMemory ? 0.625 : 1;
 return Object.freeze({
  hydroBytes:Math.round(64*MiB*factor),
  historicalCpuBytes:Math.round(96*MiB*factor),
  physicalCpuBytes:Math.round(64*MiB*factor),
  residentMeshBytes:Math.round(128*MiB*factor),
  outlineBytes:Math.round(32*MiB*factor),
  labelAtlasBytes:Math.round(48*MiB*factor),
 });
}

// Account for distinct backing buffers, not each view of the same packet.
export function renderPacketBytes(value){
 const packet=value?.packet??value;
 if(!packet)return 0;
 const buffers=new Set();
 for(const array of Object.values(packet)){
  if(ArrayBuffer.isView(array))buffers.add(array.buffer);
  else if(array instanceof ArrayBuffer)buffers.add(array);
 }
 return [...buffers].reduce((total,buffer)=>total+buffer.byteLength,0);
}

// Maps remain owned by their resource owners. Insertion order is LRU order;
// current/in-flight resources are exempt even when larger than the budget.
export function trimRenderCache(entries,protectedKeys,byteBudget,bytesOf,discard,{entryLimit=Infinity}={}){
 let bytes=0;
 for(const entry of entries.values())bytes+=bytesOf(entry);
 for(const [key,entry] of entries){
  if(bytes<=byteBudget&&entries.size<=entryLimit)break;
  if(protectedKeys.has(key))continue;
  bytes-=bytesOf(entry);entries.delete(key);discard?.(key,entry);
 }
 return bytes;
}

export function touchRenderCache(entries,key){
 const entry=entries.get(key);
 if(entry!==undefined){entries.delete(key);entries.set(key,entry);}
 return entry;
}

// Decoded packet LRU. Pending promises are shared and never evicted mid-read.
export function createRenderPacketCache({byteBudget,entryLimit=256,onEvict}){
 const entries=new Map();
 let retained=new Set(),disposed=false;
 const trim=()=>{
  const protectedKeys=new Set(retained);
  for(const [key,entry] of entries)if(entry.pending)protectedKeys.add(key);
  return trimRenderCache(entries,protectedKeys,byteBudget,entry=>entry.bytes,onEvict,{entryLimit});
 };
 function read(key,load){
  if(disposed)return Promise.reject(new DOMException('Render packet cache disposed','AbortError'));
  const existing=touchRenderCache(entries,key);
  if(existing)return existing.promise;
  const entry={pending:true,bytes:0,promise:null};
  entries.set(key,entry);
  entry.promise=Promise.resolve().then(load).then(value=>{
   if(entries.get(key)===entry){entry.pending=false;entry.bytes=renderPacketBytes(value);trim();}
   return value;
  },error=>{if(entries.get(key)===entry)entries.delete(key);throw error;});
  return entry.promise;
 }
 function retain(keys){retained=new Set(keys);for(const key of retained)touchRenderCache(entries,key);trim();}
 function stats(){return {entries:entries.size,residentBytes:[...entries.values()].reduce((sum,entry)=>sum+entry.bytes,0)};}
 function dispose(){disposed=true;entries.clear();retained.clear();}
 return Object.freeze({read,retain,has:key=>entries.has(key),stats,dispose});
}
