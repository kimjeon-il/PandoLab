import {createVerifiedCoreWorker} from '../runtime/core-wasm-loader.js';
import {createWorkerRpcClient} from '../runtime/worker-rpc.js';
import {decodeStrokeGeometry} from './geometry-transfer-codec.js';
import {immutableGeometryContentKey} from '../geometry/geometry-version-store.js';
import {createGeometryInputTransport} from './geometry-input-transport.js';
import {renderCacheBudget} from './render-cache-budget.js';
import {createGeometryByteEstimator} from './geometry-residency.js';
import {createLatestRenderRequests} from './render-lifetime.js';
function geometryRequestPriority(operation,payload){
 if(payload.boundary)return 100;
 if(operation==='geometry.physical-land')return 80;
 return payload.items?.some(item=>item.polarCapOnly!==true)?60:70;
}

export function createMapGeometryRequester({getWorker,restartWorker,isCurrentWorker=worker=>worker===getWorker(),isDisposed=()=>false,
 track=(_operation,submit)=>submit(),waitBeforeRetry=()=>new Promise(resolve=>setTimeout(resolve,100)),
 inputTransport=null,onInput=()=>{}}){
 return async (operation,payload,revision,signal)=>{
  let worker;
  const requireLive=()=>{
   signal?.throwIfAborted();
   if(isDisposed())throw new DOMException('Geometry client disposed','AbortError');
  };
  const request=async()=>{
   requireLive();
   worker=getWorker();
   try{
    const priority=geometryRequestPriority(operation,payload);
    const send=async force=>{
     requireLive();
     const encoded=inputTransport?.encode(operation,payload,worker,force)??{payload,transfer:[],bytes:0,refHits:0};
     onInput(encoded);
     const response=await track(operation,()=>worker.request(operation,encoded.payload,{projectRevision:revision,signal,priority,transfer:encoded.transfer}));
     requireLive();inputTransport?.accept(worker,response.result);
     return response.result;
    };
    let result=await send(false);
    // A worker cache can be evicted or restarted after its acknowledgement.
    // A miss is preflight-only: no topology mutation has occurred.
    if(result?.geometryInputMiss){
     inputTransport?.forget(worker);result=await send(true);
     if(result?.geometryInputMiss)throw Error('Geometry input recovery failed');
    }
    return result;
   }catch(cause){
    if(!isDisposed()&&cause.code==='PL-MAP-GEOMETRY-INITIALIZATION')restartWorker(worker);
    throw cause;
   }
  };
  try{return await request();}
  catch(cause){
   // Retiring a failed transport also rejects the other requests it owns.
   // Their caller signals still determine whether the work is needed.
   if(signal?.aborted||isDisposed()||(cause.name==='AbortError'&&isCurrentWorker(worker)))throw cause;
   await waitBeforeRetry();
   if(isDisposed())throw cause;
   return request();
  }
 };
}
export function createMapLibreGeometryClient({runtimeAssetUrl,isDisposed=()=>false,getGeneration,onRestart=()=>{},getStats,metrics,
 createRpc=createWorkerRpcClient,createWorker=createVerifiedCoreWorker}){
 let geometryRpc=null,geometryAbort=new AbortController(),closed=false;
 const latest=createLatestRenderRequests();
 const unavailable=()=>closed||isDisposed();
 function requireOpen(){if(unavailable())throw new DOMException('Geometry client disposed','AbortError');}
 function cancelCountryRequest(){latest.cancel('country');}
 function startCountryRequest(){requireOpen();return latest.begin('country').signal;}
 const physicalDisplayCache=new Map(),physicalEstimate=createGeometryByteEstimator(),budget=renderCacheBudget();
 const inputTransport=createGeometryInputTransport({stableKey:immutableGeometryContentKey});
 function trimPhysical(pinned){
  let bytes=0;
  for(const row of physicalDisplayCache.values())bytes+=row.bytes||0;
  for(const [key,row]of physicalDisplayCache){
   if(bytes<=budget.physicalDisplayBytes&&physicalDisplayCache.size<=2)break;
   if(key===pinned)continue;
   row.controller.abort();physicalDisplayCache.delete(key);bytes-=row.bytes||0;
  }
 }
 function geometryWorker(){
  requireOpen();
  return geometryRpc ||=createRpc({createWorker:()=>createWorker(runtimeAssetUrl('workers/map-geometry-worker.js')),
   isCurrent:({entry,message})=>entry.projectRevision===message.projectRevision,
   onCrash:()=>{if(!unavailable())onRestart();}});
 }
 const requestMapGeometry=createMapGeometryRequester({getWorker:geometryWorker,isCurrentWorker:worker=>geometryRpc===worker,isDisposed:unavailable,
  restartWorker:worker=>{
   if(geometryRpc!==worker)return;
   geometryRpc=null;onRestart();worker.stop('geometry-initialization-retry');
  },
  inputTransport,onInput:encoded=>{
   const stats=getStats();
   stats.geometryWorkerInputBytes=(stats.geometryWorkerInputBytes||0)+encoded.bytes;
   stats.geometryWorkerReferenceHits=(stats.geometryWorkerReferenceHits||0)+encoded.refHits;
  },
  track:(operation,submit)=>{getStats().geometryWorkerRequests++;return metrics.track(operation,submit);},
 });
 function recordGeometryQueue(snapshot){
  if(!snapshot||!Number.isFinite(snapshot.sampledAt))return;
  const stats=getStats();
  if(!stats.geometryQueue||snapshot.sampledAt>=stats.geometryQueue.sampledAt)stats.geometryQueue=snapshot;
 }
 function preparePhysicalDisplay(key,geometry){
  requireOpen();
  const cached=physicalDisplayCache.get(key);
  if(cached){physicalDisplayCache.delete(key);physicalDisplayCache.set(key,cached);return cached.task;}
  if(physicalDisplayCache.size===2){
   const oldest=physicalDisplayCache.keys().next().value;
   physicalDisplayCache.get(oldest).controller.abort();
   physicalDisplayCache.delete(oldest);
  }
  const entry={controller:new AbortController(),geometry:null,task:null,bytes:0};physicalDisplayCache.set(key,entry);
  entry.task=requestMapGeometry('geometry.physical-land',{sourceKey:'physical-display-union-v1:'+key,geometry},getGeneration(),entry.controller.signal)
   .then(result=>{recordGeometryQueue(result.geometryQueue);entry.geometry=result.geometry;entry.bytes=physicalEstimate(result.geometry);
    if(physicalDisplayCache.get(key)===entry)trimPhysical(key);
    getStats().physicalLandPreparations++;getStats().physicalLandPreparationMs+=result.durationMs;return result.geometry;},cause=>{if(physicalDisplayCache.get(key)===entry)physicalDisplayCache.delete(key);throw cause;});
  return entry.task;
 }
 async function prepareRenderGeometry(items,revision,boundary,signal=geometryAbort.signal){
  requireOpen();signal.throwIfAborted();
  if(!items.length&&!boundary)return {packets:[]};
  const sentAt=performance.timeOrigin+performance.now();
  const result=await requestMapGeometry('geometry.prepare',{items,boundary},revision,signal);
  recordGeometryQueue(result.geometryQueue);
  getStats().geometryWorkerTransferBytes+=result.stats?.transferBytes||0;
  const receivedAt=performance.timeOrigin+performance.now();
  if(result.boundaryMiss)return result;
  for(const prepared of result.packets||[])if(prepared.stroke){
   prepared.geometry=decodeStrokeGeometry(prepared.stroke);
   delete prepared.stroke;
  }
  if(result.stats){
   const {workerMs,startedAt,finishedAt}=result.stats;
   metrics.record('geometry.worker',workerMs);
   metrics.record('geometry.dispatch',Math.max(0,startedAt-sentAt));
   metrics.record('geometry.reply',Math.max(0,receivedAt-finishedAt));
  }
  if(result.stats)getStats().geometryPreparation={boundarySeedFailure:result.stats.boundarySeedFailure,boundarySeeded:result.stats.boundarySeeded,boundaryChangedCount:result.stats.boundaryChangedCount,packets:result.stats.slowestPackets?.map(row=>({kind:row.kind,durationMs:row.durationMs,packetBytes:row.packetBytes,assetHits:(row.assetHitsAfter??0)-(row.assetHitsBefore??0)}))};
  return result;
 }

 return Object.freeze({preparePhysicalDisplay,prepareRenderGeometry,startCountryRequest,cancelCountryRequest,
 physicalGeometry:key=>physicalDisplayCache.get(key)?.geometry,
 cacheStats:()=>({physicalDisplayBytes:[...physicalDisplayCache.values()].reduce((sum,row)=>sum+(row.bytes||0),0),
  physicalDisplayBudget:budget.physicalDisplayBytes}),
 reset({retainPhysical=false}={}){if(closed)return;cancelCountryRequest();geometryAbort.abort();geometryAbort=new AbortController();
  if(!retainPhysical){for(const entry of physicalDisplayCache.values())entry.controller.abort();physicalDisplayCache.clear();}
 },
 dispose(){
  if(closed)return;closed=true;latest.dispose();geometryAbort.abort();
  for(const entry of physicalDisplayCache.values())entry.controller.abort();
  physicalDisplayCache.clear();const worker=geometryRpc;geometryRpc=null;worker?.stop('maplibre-dispose');
 }});
}
