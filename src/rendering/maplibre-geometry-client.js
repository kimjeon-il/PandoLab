import {createVerifiedCoreWorker} from '../runtime/core-wasm-loader.js';
import {createWorkerRpcClient} from '../runtime/worker-rpc.js';
import {decodeStrokeGeometry} from './geometry-transfer-codec.js';
export function createMapGeometryRequester({getWorker,restartWorker,isCurrentWorker=worker=>worker===getWorker(),isDisposed=()=>false,
 track=(_operation,submit)=>submit(),waitBeforeRetry=()=>new Promise(resolve=>setTimeout(resolve,100))}){
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
    const response=await track(operation,()=>worker.request(operation,payload,{projectRevision:revision,signal}));
    requireLive();
    return response.result;
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
 let geometryRpc=null,geometryAbort=new AbortController(),countryAbort=null,closed=false;
 const unavailable=()=>closed||isDisposed();
 function requireOpen(){if(unavailable())throw new DOMException('Geometry client disposed','AbortError');}
 function cancelCountryRequest(){countryAbort?.abort();countryAbort=null;}
 function startCountryRequest(){
  requireOpen();cancelCountryRequest();
  countryAbort=new AbortController();return countryAbort.signal;
 }
 const physicalDisplayCache=new Map();
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
  track:(operation,submit)=>{getStats().geometryWorkerRequests++;return metrics.track(operation,submit);},
 });
 function preparePhysicalDisplay(key,geometry){
  requireOpen();
  const cached=physicalDisplayCache.get(key);
  if(cached){physicalDisplayCache.delete(key);physicalDisplayCache.set(key,cached);return cached.task;}
  if(physicalDisplayCache.size===2){
   const oldest=physicalDisplayCache.keys().next().value;
   physicalDisplayCache.get(oldest).controller.abort();
   physicalDisplayCache.delete(oldest);
  }
  const entry={controller:new AbortController(),geometry:null,task:null};physicalDisplayCache.set(key,entry);
  entry.task=requestMapGeometry('geometry.physical-land',{sourceKey:'physical-display-union-v1:'+key,geometry},getGeneration(),entry.controller.signal)
   .then(result=>{entry.geometry=result.geometry;getStats().physicalLandPreparations++;getStats().physicalLandPreparationMs+=result.durationMs;return result.geometry;},cause=>{if(physicalDisplayCache.get(key)===entry)physicalDisplayCache.delete(key);throw cause;});
  return entry.task;
 }
 async function prepareRenderGeometry(items,revision,boundary,signal=geometryAbort.signal){
  requireOpen();signal.throwIfAborted();
  if(!items.length&&!boundary)return {packets:[]};
  const sentAt=performance.timeOrigin+performance.now();
  const result=await requestMapGeometry('geometry.prepare',{items,boundary},revision,signal);
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
 reset(){if(closed)return;cancelCountryRequest();geometryAbort.abort();geometryAbort=new AbortController();},
 dispose(){
  if(closed)return;closed=true;cancelCountryRequest();geometryAbort.abort();
  for(const entry of physicalDisplayCache.values())entry.controller.abort();
  physicalDisplayCache.clear();const worker=geometryRpc;geometryRpc=null;worker?.stop('maplibre-dispose');
 }});
}
