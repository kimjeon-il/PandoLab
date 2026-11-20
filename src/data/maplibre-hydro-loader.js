const packIdsFromKey=key=>new Set((key||'').split(',').filter(Boolean).map(Number));

export async function createHydroBrowserLoader({
 manifest,baseUrl,createWorker,tilesForView,dataRevision,packLimit=32,viewTimeoutMs=30000,signal,
}){
 if(!Number.isInteger(packLimit)||packLimit<1)throw new TypeError('A positive hydro pack limit is required');
 signal?.throwIfAborted();
 const worker=createWorker(),packs=new Map(),pending=new Map();
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
  disposed=true;clearTimeout(timeout);worker.terminate();packs.clear();
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
 worker.onmessage=event=>{
  if(disposed)return;
  const message=event.data||{};
  if(message.type==='ready'){readyResolve();return;}
  if(message.type==='init-error'){readyReject(Error(message.message));return;}
  if(message.type==='pack'){
   const id=Number(message.packId);packs.delete(id);packs.set(id,message.features);
   if(!pending.size)trim();
   return;
  }
  const request=pending.get(message.revision);
  if(!request||!['view-ready','view-error'].includes(message.type))return;
  pending.delete(message.revision);clearTimeout(request.timeout);
  try{
   if(message.type==='view-error')throw Object.assign(Error(message.message),{diagnostic:message.diagnostic});
   const ids=message.packIds.map(Number),failedPacks=message.failedPacks||[];
   const current=new Set([...ids,...failedPacks.map(({id})=>Number(id)).filter(id=>request.old.has(id))]);
   const addPacks=[];
   for(const id of ids){
    if(!packs.has(id))throw Error('Hydro worker did not deliver pack '+id);
    const features=packs.get(id);packs.delete(id);packs.set(id,features);
    if(!request.old.has(id))addPacks.push({id,features});
   }
   protectedPacks=current;
   request.resolve({key:[...current].sort((a,b)=>a-b).join(','),addPacks,
    removePacks:[...request.old].filter(id=>!current.has(id)),failedPacks});
  }catch(error){request.reject(error);}
  finally{trim();}
 };
 worker.onerror=event=>stop(event.error||Error(event.message||'Hydro worker failed'));
 worker.onmessageerror=()=>stop(Error('Hydro worker reply could not be decoded'));
 try{
  worker.postMessage({type:'init',manifest,baseUrl,dataRevision,delivery:'geojson'});
  await ready;
  signal?.throwIfAborted();
 }catch(error){stop(error);throw error;}
 finally{clearTimeout(timeout);signal?.removeEventListener('abort',cancelInit);}
 return {
  view(view){
   if(disposed)return Promise.reject(Error('Hydro worker is disposed'));
   const id=++revision,tiles=tilesForView(view),old=packIdsFromKey(view.knownKey);
   protectedPacks=old;
   return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>stop(new DOMException('Hydro viewport timed out','TimeoutError')),viewTimeoutMs);
    pending.set(id,{resolve,reject,old,timeout});
    try{worker.postMessage({type:'view',revision:id,tiles});}catch(error){stop(error);}
   });
  },
  cancel(){
   if(disposed)return;
   settleRequests(new DOMException('Hydro view superseded','AbortError'));
   worker.postMessage({type:'cancel-view',revision:++revision});
   trim();
  },
  get disposed(){return disposed;},
  stats:()=>({cached:packs.size}),
  dispose(){stop(new DOMException('Hydro worker disposed','AbortError'));},
 };
}
