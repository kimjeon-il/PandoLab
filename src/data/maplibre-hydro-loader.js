export async function createHydroBrowserLoader({manifest,baseUrl,createWorker,tilesForView,dataRevision,packLimit=32}){
 if(!Number.isInteger(packLimit)||packLimit<1)throw new TypeError('A positive hydro pack limit is required');
 const worker=createWorker(),packs=new Map(),pending=new Map();let revision=0,disposed=false;
 let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 const timeout=setTimeout(()=>readyReject(Error('Hydro worker startup timed out')),30000);
 worker.onmessage=event=>{const message=event.data||{};
  if(message.type==='ready'){clearTimeout(timeout);readyResolve();return;}
  if(message.type==='init-error'){clearTimeout(timeout);readyReject(Error(message.message));return;}
  if(message.type==='pack'){const id=Number(message.packId);packs.delete(id);packs.set(id,message.features);return;}
  const request=pending.get(message.revision);if(!request)return;
  if(message.type==='view-error'){pending.delete(message.revision);request.reject(Object.assign(Error(message.message),{diagnostic:message.diagnostic}));return;}
  if(message.type==='view-ready'){
   pending.delete(message.revision);try{const ids=message.packIds.map(Number).sort((a,b)=>a-b),key=ids.join(','),old=new Set((request.knownKey||'').split(',').filter(Boolean).map(Number)),current=new Set(ids);
    const addPacks=ids.filter(id=>!old.has(id)).map(id=>{if(!packs.has(id))throw Error('Hydro worker did not deliver pack '+id);return {id,features:packs.get(id)};});
    for(const id of ids){if(!packs.has(id))throw Error('Hydro worker cache lost active pack '+id);const value=packs.get(id);packs.delete(id);packs.set(id,value);}
    const released=[];for(const id of packs.keys()){if(packs.size<=packLimit)break;if(!current.has(id)){packs.delete(id);released.push(id);}}
    if(released.length)worker.postMessage({type:'release',packIds:released});
    request.resolve({key,addPacks,removePacks:[...old].filter(id=>!current.has(id))});
   }catch(error){request.reject(error);}
  }
 };
 worker.onerror=event=>{const error=event.error||Error(event.message||'Hydro worker failed');disposed=true;worker.terminate();clearTimeout(timeout);readyReject(error);for(const request of pending.values())request.reject(error);pending.clear();};
 worker.postMessage({type:'init',manifest,baseUrl,dataRevision,delivery:'geojson'});try{await ready;}catch(error){disposed=true;clearTimeout(timeout);worker.terminate();throw error;}
 return {
  view(view){if(disposed)return Promise.reject(Error('Hydro worker is disposed'));const id=++revision,tiles=tilesForView(view);
   return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject,knownKey:view.knownKey});worker.postMessage({type:'view',revision:id,tiles});});},
  cancel(){if(disposed)return;const id=++revision;for(const request of pending.values())request.reject(new DOMException('Hydro view superseded','AbortError'));pending.clear();worker.postMessage({type:'cancel-view',revision:id});},
  stats:()=>({cached:packs.size}),
  dispose(){disposed=true;clearTimeout(timeout);for(const request of pending.values())request.reject(new DOMException('Hydro worker disposed','AbortError'));pending.clear();worker.terminate();packs.clear();},
 };
}
