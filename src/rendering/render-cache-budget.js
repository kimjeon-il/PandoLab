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
  totalRenderBytes:Math.round(320*MiB*factor),
  pendingBytes:Math.round(64*MiB*factor),
  borderBatchBytes:Math.round(8*MiB*factor),
  concurrentLoads:hasMemoryHint&&ram<=2?2:4,
 });
}

// Account for distinct backing buffers, not each view of the same packet.
export function renderPacketBuffers(value){
 const buffers=new Set(),visited=new Set();
 function visit(row){
  if(!row||typeof row!=='object'||visited.has(row))return;
  visited.add(row);
  if(ArrayBuffer.isView(row))buffers.add(row.buffer);
  else if(row instanceof ArrayBuffer)buffers.add(row);
  else for(const child of Object.values(row))visit(child);
 }
 visit(value);return buffers;
}
export function renderPacketBytes(value){
 return [...renderPacketBuffers(value?.packet??value)].reduce((total,buffer)=>total+buffer.byteLength,0);
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

// Decoded packet LRU with independent consumers of the same in-flight read.
// Last-consumer cancellation propagates through network and Worker restores.
export function createRenderPacketCache({byteBudget,entryLimit=256,onEvict}){
 const entries=new Map();
 let retained=new Set(),disposed=false,cancelled=0;
 const trim=()=>{
  const protectedKeys=new Set(retained);
  for(const [key,entry] of entries)if(entry.pending||entry.users>0)protectedKeys.add(key);
  return trimRenderCache(entries,protectedKeys,byteBudget,entry=>entry.bytes,onEvict,{entryLimit});
 };
 function abortUnused(key,entry){
  // Give synchronous replacement callers an opportunity to attach to the
  // same immutable flight before cancelling its last former consumer.
  queueMicrotask(()=>{
   if(entries.get(key)!==entry||!entry.pending||entry.users||entry.unscoped)return;
   entries.delete(key);cancelled++;entry.controller.abort();
  });
 }
 function consume(key,entry,signal){
  if(!signal){if(entry.pending)entry.unscoped=true;return entry.promise;}
  entry.users++;
  return new Promise((resolve,reject)=>{
   let settled=false;
   const finish=(callback,value)=>{
    if(settled)return;
    settled=true;signal.removeEventListener('abort',abort);entry.users--;
    callback(value);
    if(entry.pending&&!entry.users&&!entry.unscoped)abortUnused(key,entry);
     else if(!entry.pending&&!entry.users)trim();
   };
   const abort=()=>finish(reject,signal.reason??new DOMException('Render packet cancelled','AbortError'));
   signal.addEventListener('abort',abort,{once:true});
   entry.promise.then(value=>finish(resolve,value),error=>finish(reject,error));
   if(signal.aborted)abort();
  });
 }
 function read(key,load,signal=null){
  if(disposed||signal?.aborted)return Promise.reject(signal?.reason??new DOMException('Render packet cache disposed','AbortError'));
  const existing=touchRenderCache(entries,key);
  if(existing){existing.lastUsed=performance.now();return consume(key,existing,signal);}
  const entry={pending:true,bytes:0,promise:null,controller:new AbortController(),users:0,unscoped:false,lastUsed:performance.now(),buffers:null};
  entries.set(key,entry);
  entry.promise=Promise.resolve().then(()=>{
   entry.controller.signal.throwIfAborted();return load(entry.controller.signal);
  }).then(value=>{
   entry.controller.signal.throwIfAborted();
   if(entries.get(key)===entry){entry.pending=false;entry.buffers=renderPacketBuffers(value?.packet??value);entry.bytes=[...entry.buffers].reduce((sum,buffer)=>sum+buffer.byteLength,0);trim();}
   return value;
  }).catch(error=>{if(entries.get(key)===entry)entries.delete(key);entry.controller.abort();throw error;});
  return consume(key,entry,signal);
 }
 function retain(keys){retained=new Set(keys);for(const key of retained){const entry=touchRenderCache(entries,key);if(entry)entry.lastUsed=performance.now();}trim();}
 function memoryEntries(){
  return [...entries].filter(([,entry])=>!entry.pending).map(([key,entry])=>({buffers:entry.buffers,extraBytes:0,lastUsed:entry.lastUsed,
   protected:retained.has(key)||entry.users>0,evict:()=>{if(entries.get(key)===entry){entries.delete(key);onEvict?.(key,entry);}}}));
 }
 function stats(){return {entries:entries.size,residentBytes:[...entries.values()].reduce((sum,entry)=>sum+entry.bytes,0),pending:[...entries.values()].filter(entry=>entry.pending).length,cancelled};}
 function dispose(){disposed=true;for(const entry of entries.values())if(entry.pending)entry.controller.abort();entries.clear();retained.clear();}
 return Object.freeze({read,retain,memoryEntries,has:key=>entries.has(key),stats,dispose});
}

// Count CPU backing stores once across packet caches and GPU owners, while
// device allocations are separate. Pressure is relieved from old standby
// resources only, after publication; visible/preparing resources may exceed.
export function createRenderResidencyBudget(byteBudget){
 const owners=new Set();
 let latest={residentBytes:0,cpuBytes:0,deviceAndOtherBytes:0,evicted:0,byteBudget};
 function register(read){owners.add(read);return ()=>owners.delete(read);}
 function trim(){
  const rows=[...owners].flatMap(read=>read()),refs=new Map();
  let cpu=0,extra=0,evicted=0;
  for(const row of rows){
   extra+=row.extraBytes??0;
   for(const buffer of row.buffers??[]){
    if(!refs.has(buffer))cpu+=buffer.byteLength;
    refs.set(buffer,(refs.get(buffer)??0)+1);
   }
  }
  const standby=rows.filter(row=>!row.protected&&typeof row.evict==='function').sort((a,b)=>a.lastUsed-b.lastUsed);
  for(const row of standby){
   if(cpu+extra<=byteBudget)break;
   row.evict();evicted++;extra-=row.extraBytes??0;
   for(const buffer of row.buffers??[]){
    const count=refs.get(buffer)-1;
    if(count===0){refs.delete(buffer);cpu-=buffer.byteLength;}else refs.set(buffer,count);
   }
  }
  latest={residentBytes:cpu+extra,cpuBytes:cpu,deviceAndOtherBytes:extra,evicted:latest.evicted+evicted,byteBudget};
  return latest;
 }
 return Object.freeze({register,trim,stats:()=>({...latest}),dispose:()=>owners.clear()});
}

// Admit a bounded number of downloads + Worker inputs, not only Worker calls.
// A required oversize packet runs alone. Queued work never acquires bytes.
export function createRenderLoadGate({concurrency,byteBudget}){
 let active=0,bytes=0,sequence=0,closed=false,peakBytes=0,peakActive=0;
 const queue=[];
 function pump(){
  if(closed)return;
  queue.sort((a,b)=>b.priority-a.priority||a.sequence-b.sequence);
  while(queue.length&&active<concurrency){
   const row=queue[0];
   if(active>0&&bytes+row.bytes>byteBudget)break;
   queue.shift();row.signal?.removeEventListener('abort',row.abort);
   if(row.signal?.aborted){row.reject(row.signal.reason);continue;}
   active++;bytes+=row.bytes;peakActive=Math.max(peakActive,active);peakBytes=Math.max(peakBytes,bytes);
   Promise.resolve().then(()=>{row.signal?.throwIfAborted();return row.task();}).then(row.resolve,row.reject).finally(()=>{
    active--;bytes-=row.bytes;pump();
   });
  }
 }
 function run({bytes:estimate=0,priority=0,signal},task){
  if(closed||signal?.aborted)return Promise.reject(signal?.reason??new DOMException('Render load gate closed','AbortError'));
  return new Promise((resolve,reject)=>{
   const row={bytes:Math.max(1,Number(estimate)||1),priority,signal,task,resolve,reject,sequence:++sequence};
   row.abort=()=>{const i=queue.indexOf(row);if(i>=0){queue.splice(i,1);reject(signal.reason);pump();}};
   queue.push(row);signal?.addEventListener('abort',row.abort,{once:true});pump();
  });
 }
 function dispose(){
  closed=true;
  for(const row of queue.splice(0)){row.signal?.removeEventListener('abort',row.abort);row.reject(new DOMException('Render load gate closed','AbortError'));}
 }
 return Object.freeze({run,dispose,stats:()=>({active,queued:queue.length,reservedBytes:bytes,peakBytes,peakActive,byteBudget,concurrency})});
}
