import {createWorkerRpcClient} from '../runtime/worker-rpc.js';
import {workerAssetUrl} from '../runtime/worker-asset-url.js';
import {createLatestWorkerJobScheduler,createWorkerCancellationError} from '../runtime/worker-job-scheduler.js';

/** A bounded pool of stateless packet Workers. Cancel only the worker
 * owned by the obsolete job. Network/input reservations remain global. */
export function globePacketWorkerCount({deviceMemory=globalThis.navigator?.deviceMemory,hardwareConcurrency=globalThis.navigator?.hardwareConcurrency}={}){
 const cores=Number(hardwareConcurrency)||4,ram=Number(deviceMemory)||4;
 return ram<=2||cores<=2?1:ram>=8&&cores>=8?3:2;
}
export function createGlobePacketTasks({
 createWorker=()=>new Worker(workerAssetUrl(new URL('./workers/globe-packet-worker.js',import.meta.url)),{type:'module'}),
 maxWorkers=globePacketWorkerCount(),
}={}){
 const count=Math.max(1,Math.min(3,Math.floor(maxWorkers)||1));
 const lanes=Array.from({length:count},()=>({rpc:null,entry:null})),running=new Map();
 let sequence=0,peakRunning=0;
 const scheduler=createLatestWorkerJobScheduler({
  maxConcurrent:count,
  execute:async entry=>{
   if(entry.obsolete)throw createWorkerCancellationError();
   const lane=lanes.find(row=>!row.entry);
   if(!lane)throw Error('Globe packet Worker lane unavailable');
   const owner=lane.rpc??=createWorkerRpcClient({createWorker,defaultTimeoutMs:120_000});
   lane.entry=entry;running.set(entry,lane);peakRunning=Math.max(peakRunning,running.size);
   try{
    const {result}=await owner.request(entry.payload.operation,entry.payload.body,{transfer:entry.payload.transfer,priority:entry.priority});
    return result;
   }finally{
    running.delete(entry);
    if(lane.entry===entry)lane.entry=null;
   }
  },
  cancelRunning:entry=>{
   const lane=running.get(entry);
   if(!lane||lane.entry!==entry)return;
   const owner=lane.rpc;lane.rpc=null;
   owner?.stop('globe-packet-superseded');
  },
 });
 function decode(kind,bytes,spec,{signal,priority=0,...parameters}={}){
  signal?.throwIfAborted();
  return scheduler.enqueue({jobKey:'packet-'+(++sequence),priority,signal,
   payload:{operation:'globe.decode-packet',transfer:[bytes],body:{kind,bytes,spec:{encoding:spec.encoding,decodedBytes:spec.decodedBytes,maxDecodedBytes:spec.maxDecodedBytes},...parameters}}}).promise;
 }
 function combineStoredStrokes(inputs,{signal,priority=10}={}){
  signal?.throwIfAborted();
  // Inputs are private verified stored-byte copies, not cached decoded
  // packets. Transfer their backing stores exactly once.
  const transfer=[...new Set(inputs.map(row=>row.bytes))];
  const packets=inputs.map(({bytes,spec})=>({bytes,spec:{encoding:spec.encoding,decodedBytes:spec.decodedBytes,maxDecodedBytes:spec.maxDecodedBytes}}));
  return scheduler.enqueue({jobKey:'stroke-batch-'+(++sequence),priority,signal,
   payload:{operation:'globe.combine-stored-strokes',body:{packets},transfer}}).promise;
 }
 function dispose(){scheduler.close('globe-packet-disposed');for(const lane of lanes){lane.rpc?.stop('globe-packet-disposed');lane.rpc=null;}}
 return Object.freeze({decode,combineStoredStrokes,dispose,stats:()=>({...scheduler.stats(),workerLimit:count,workers:lanes.filter(row=>row.rpc).length,running:running.size,peakRunning})});
}
