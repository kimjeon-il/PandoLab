import {createWorkerRpcClient} from '../runtime/worker-rpc.js';
import {workerAssetUrl} from '../runtime/worker-asset-url.js';
import {createLatestWorkerJobScheduler,createWorkerCancellationError} from '../runtime/worker-job-scheduler.js';

/** One lazy immutable Worker; only one packet is posted at a time.
 * Terminating a cancelled running job also interrupts synchronous restoration,
 * rather than letting obsolete work block the next visible packet.
 */
export function createGlobePacketTasks({
 createWorker=()=>new Worker(workerAssetUrl(new URL('./workers/globe-packet-worker.js',import.meta.url)),{type:'module'}),
}={}){
 let rpc=null,sequence=0,running=null;
 const scheduler=createLatestWorkerJobScheduler({
  execute:async entry=>{
   if(entry.obsolete)throw createWorkerCancellationError();
   const owner=rpc??=createWorkerRpcClient({createWorker,defaultTimeoutMs:120_000});
   running={entry,owner};
   try{
    const {result}=await owner.request(entry.payload.operation,entry.payload.body,{transfer:entry.payload.transfer});
    return result;
   }finally{if(running?.entry===entry)running=null;}
  },
  cancelRunning:entry=>{
   if(running?.entry!==entry)return;
   const owner=running.owner;running=null;
   if(rpc===owner)rpc=null;
   owner.stop('globe-packet-superseded');
  },
 });
 function decode(kind,bytes,spec,{signal,priority=0,...parameters}={}){
  signal?.throwIfAborted();
  return scheduler.enqueue({jobKey:'packet-'+(++sequence),priority,signal,
   payload:{operation:'globe.decode-packet',transfer:[bytes],body:{kind,bytes,spec:{encoding:spec.encoding,decodedBytes:spec.decodedBytes,maxDecodedBytes:spec.maxDecodedBytes},...parameters}}}).promise;
 }
 function combineStrokes(packets,{signal,priority=10}={}){
  signal?.throwIfAborted();
  // Cached immutable packet buffers remain with their other consumers.
  return scheduler.enqueue({jobKey:'stroke-batch-'+(++sequence),priority,signal,
   payload:{operation:'globe.combine-strokes',body:{packets},transfer:[]}}).promise;
 }
 function dispose(){scheduler.close('globe-packet-disposed');rpc?.stop('globe-packet-disposed');rpc=null;}
 return Object.freeze({decode,combineStrokes,dispose,stats:scheduler.stats});
}
