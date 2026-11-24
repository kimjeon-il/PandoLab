import {unpackHydroFeatures} from '../rendering/hydro-transfer-codec.js';
const packIdsFromKey=key=>new Set((key||'').split(',').filter(Boolean).map(Number));
const tileKey=({stage,x,y})=>`${stage}/${x}/${y}`;
const windowKey=tiles=>[...new Set(tiles.map(tileKey))].sort().join(',');
const wrappedDistance=(a,b)=>Math.abs((((a-b)+180)%360+360)%360-180);
const windowLimit=16;

export async function createHydroBrowserLoader({
 manifest,baseUrl,createWorker,tilesForView,dataRevision,packLimit=96,viewTimeoutMs=30000,signal,
}){
 if(!Number.isInteger(packLimit)||packLimit<1)throw new TypeError('A positive hydro pack limit is required');
 signal?.throwIfAborted();
 const worker=createWorker(),packs=new Map(),pending=new Map(),completeWindows=new Map();
 const stages=new Map((manifest?.stages||[]).map((stage,index)=>[stage.id,{...stage,index}]));
 let viewRequests=0,windowHits=0;
 let workerStats={};
 let revision=0,disposed=false,protectedPacks=new Set();
 let readyResolve,readyReject;
 const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 const timeout=setTimeout(()=>readyReject(Error('Hydro worker startup timed out')),30000);
 const cancelInit=()=>readyReject(signal.reason);
 signal?.addEventListener('abort',cancelInit,{once:true});
 function settleRequests(error){
  for(const request of pending.values()){clearTimeout(request.timeout);request.reject(error);}
  pending.clear();
 }
 function stop(error){
  if(disposed)return;
  disposed=true;clearTimeout(timeout);worker.terminate();packs.clear();completeWindows.clear();
  readyReject(error);settleRequests(error);
 }
 function trim(){
  const released=[];
  for(const id of packs.keys()){
   if(packs.size<=packLimit)break;
   if(!protectedPacks.has(id)){packs.delete(id);released.push(id);}
  }
  if(released.length)worker.postMessage({type:'release',packIds:released});
 }
 function priorityTiles(tiles,center){
  if(!center?.every(Number.isFinite))return tiles;
  return tiles.map((tile,index)=>{
   const stage=stages.get(tile.stage);
   if(!stage?.columns||!stage?.rows)return {tile,index,stage:stage?.index??Infinity,distance:0};
   const longitude=-180+(tile.x+.5)*360/stage.columns,latitude=90-(tile.y+.5)*180/stage.rows;
   return {tile,index,stage:stage.index,distance:Math.hypot(wrappedDistance(longitude,center[0])
    *Math.cos(latitude*Math.PI/180),latitude-center[1])};
  }).sort((a,b)=>a.stage-b.stage||a.distance-b.distance||a.index-b.index).map(row=>row.tile);
 }
 function resolvePacks(ids,old,failedPacks,onProgress){
  const current=new Set([...ids,...failedPacks.map(({id})=>Number(id)).filter(id=>old.has(id))]);
  const addPacks=[];
  for(const id of ids){
   if(!packs.has(id))throw Error('Hydro worker did not deliver pack '+id);
   const features=packs.get(id);packs.delete(id);packs.set(id,features);
   if(!old.has(id))addPacks.push({id,features});
  }
  // Keep already drawn offscreen packs in the source and the decoded cache.
  // Current coverage is protected first, even when it fills the whole budget.
  if(current.size<packLimit)for(const id of [...packs.keys()].reverse()){
   if(old.has(id))current.add(id);
   if(current.size>=packLimit)break;
  }
  protectedPacks=current;
  const packIds=[...current].sort((a,b)=>a-b);
  return {key:packIds.join(','),addPacks,removePacks:[...old].filter(id=>!current.has(id)),failedPacks,
   ...(onProgress&&{packIds,packs:packIds.filter(id=>packs.has(id)).map(id=>({id,features:packs.get(id)}))})};
 }
 function reportProgress(request,ids){
  if(!request?.onProgress||!Array.isArray(ids))return;
  const available=ids.map(Number).filter(id=>!request.old.has(id)&&packs.has(id)&&!request.progressed.has(id));
  if(!available.length)return;
  for(const id of available)request.progressed.add(id);
  try{request.onProgress({packs:available.map(id=>({id,features:packs.get(id)}))});}
  catch(error){
   settleRequests(error);
   worker.postMessage({type:'cancel-view',revision:++revision});
   trim();
  }
 }
 worker.onmessage=event=>{
  if(disposed)return;
  const message=event.data||{};
  if(message.type==='ready'){readyResolve();return;}
  if(message.type==='init-error'){readyReject(Error(message.message));return;}
  if(message.type==='pack'){
   const id=Number(message.packId);
   let features;
   try{
    if(!Number.isSafeInteger(id)||id<0)throw new TypeError('Invalid hydro pack ID');
    features=unpackHydroFeatures(message.packed);
   }catch(error){stop(error);return;}
   packs.delete(id);packs.set(id,features);
   reportProgress(pending.get(message.revision),[id]);
   if(!pending.size)trim();
   return;
  }
  const request=pending.get(message.revision);
  if(message.type==='view-progress'){reportProgress(request,message.packIds);return;}
  if(!request||!['view-ready','view-error'].includes(message.type))return;
  pending.delete(message.revision);clearTimeout(request.timeout);
  try{
   if(message.type==='view-error')throw Object.assign(Error(message.message),{diagnostic:message.diagnostic});
   const ids=message.packIds.map(Number),failedPacks=message.failedPacks||[];
   const result=resolvePacks(ids,request.old,failedPacks,request.onProgress);
   if(message.stats)workerStats=message.stats;
   if(!failedPacks.length){
    completeWindows.delete(request.window);
    completeWindows.set(request.window,ids);
    if(completeWindows.size>windowLimit)completeWindows.delete(completeWindows.keys().next().value);
   }
   request.resolve(result);
  }catch(error){request.reject(error);}
  finally{trim();}
 };
 worker.onerror=event=>stop(event.error||Error(event.message||'Hydro worker failed'));
 worker.onmessageerror=()=>stop(Error('Hydro worker reply could not be decoded'));
 try{
  worker.postMessage({type:'init',manifest,baseUrl,dataRevision});
  await ready;
  signal?.throwIfAborted();
 }catch(error){stop(error);throw error;}
 finally{clearTimeout(timeout);signal?.removeEventListener('abort',cancelInit);}
 return {
  view(view,{onProgress}={}){
   if(disposed)return Promise.reject(Error('Hydro worker is disposed'));
   const id=++revision,tiles=tilesForView(view),old=packIdsFromKey(view.knownKey);
   const window=windowKey(tiles),complete=completeWindows.get(window);
   const superseded=pending.size>0;
   if(superseded)settleRequests(new DOMException('Hydro view superseded','AbortError'));
   protectedPacks=old;
   if(complete?.every(packId=>packs.has(packId))){
    completeWindows.delete(window);completeWindows.set(window,complete);
    if(superseded)worker.postMessage({type:'cancel-view',revision:id});
    windowHits++;
    const result=resolvePacks(complete,old,[],onProgress);
    trim();
    return Promise.resolve(result);
   }
   if(complete)completeWindows.delete(window);
   return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>stop(new DOMException('Hydro viewport timed out','TimeoutError')),viewTimeoutMs);
    pending.set(id,{resolve,reject,old,timeout,window,onProgress,progressed:new Set()});
    try{worker.postMessage({type:'view',revision:id,tiles:priorityTiles(tiles,view.center)});viewRequests++;}catch(error){stop(error);}
   });
  },
  cancel(){
   if(disposed)return;
   settleRequests(new DOMException('Hydro view superseded','AbortError'));
   worker.postMessage({type:'cancel-view',revision:++revision});
   trim();
  },
  get disposed(){return disposed;},
  stats:()=>({...workerStats,cached:packs.size,viewRequests,windowHits}),
  dispose(){stop(new DOMException('Hydro worker disposed','AbortError'));},
 };
}
