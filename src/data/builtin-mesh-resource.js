import { preparedCountrySceneKey } from '../rendering/country-mesh-codec.js';

/** A different dated country set cannot match the single pinned prepared scene. */
export function preparedCountrySlotsMatch(features, countryIds) {
  if (!Array.isArray(countryIds)) return true; // Unknown catalog: do not guess.
  if (!Array.isArray(features) || features.length !== countryIds.length) return false;
  // The prepared-scene identity sorts rows by country ID. Feature order is
  // deliberately NOT part of that identity; only missing or additional
  // country slots justify a fast rejection before content verification.
  const remaining = new Set(countryIds.map(String));
  return remaining.size === countryIds.length
    && features.every(feature => remaining.delete(String(feature?.id ?? '')))
    && remaining.size === 0;
}

/** The existing resource owner delivers one immutable prepared scene, not a document. */
export function createBuiltinMeshResourceLoader({runtimeAssetUrl,WorkerClass=Worker}={}) {
  if(typeof runtimeAssetUrl!=='function')throw new TypeError('runtimeAssetUrl is required for the built-in mesh loader.');
  const pending=new Map(), retained=new Map();let lastMiss=null,disposed=false;
  // A validated pinned bundle exposes exactly one prepared scene identity.
  // undefined = not yet learned, null = no such asset. This only rejects
  // mismatches; a positive match still goes through full SHA verification.
  let catalogSceneKey=undefined,catalogCountryIds=undefined;
  const metrics={skippedUnmatchedCatalog:0,skippedUnmatchedSlots:0,workerStarts:0};
  // Retain the last two verified CPU scenes across A -> B -> A date moves.
  // Keep the original loader as sole owner; no second decoded mesh cache.
  const maxRetainedMeshBytes=96*1024*1024;
  let retainedMeshBytes=0;
  function remember(key,value) {
    const prior=retained.get(key);
    if(prior)retainedMeshBytes-=prior.meshBuffer.byteLength;
    retained.delete(key);retained.set(key,value);
    retainedMeshBytes+=value.meshBuffer.byteLength;
    while(retained.size>2||(retainedMeshBytes>maxRetainedMeshBytes&&retained.size>1)){
      const oldest=retained.keys().next().value,evicted=retained.get(oldest);
      retainedMeshBytes-=evicted.meshBuffer.byteLength;
      retained.delete(oldest);
    }
  }
  const cancellation=()=>Object.assign(new Error('Built-in mesh loader disposed'),{name:'AbortError'});
  function load(sceneIdentity) {
    if(disposed)return Promise.reject(cancellation());
    let key;
    try {key=preparedCountrySceneKey(sceneIdentity);}catch(error){return Promise.reject(error);}
    const cached=retained.get(key);
    if(cached){
      if(cached.meshBuffer.byteLength){
        retained.delete(key);retained.set(key,cached);
        return Promise.resolve(cached);
      }
      retainedMeshBytes-=cached.meshBuffer.byteLength;retained.delete(key);
    }
    if(catalogSceneKey!==undefined && key!==catalogSceneKey) {
      metrics.skippedUnmatchedCatalog++;
      return Promise.resolve(null);
    }
    if(lastMiss===key)return Promise.resolve(null);
    if(pending.has(key))return pending.get(key).promise;
    let resolve,reject;
    const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const entry={promise,worker:null,live:true,cancel:()=>finish(cancellation())};
    function finish(error,value=null) {
      if(!entry.live)return;
      entry.live=false;entry.worker?.terminate();pending.delete(key);
      if(error)reject(error);else resolve(value);
    }
    pending.set(key,entry);
    try {
      const worker=entry.worker=new WorkerClass(runtimeAssetUrl('workers/data-loader-worker.js'),
        {type:'module',name:'pandolab-builtin-mesh-resource'});
      metrics.workerStarts++;
      worker.onmessage=({data:message})=>{
        if(!entry.live||disposed)return;
        if(message?.type==='builtin-mesh-loader-ready'){
          if(message.preparedSceneKey===null||typeof message.preparedSceneKey==='string') {
            catalogSceneKey=message.preparedSceneKey;
            catalogCountryIds=Array.isArray(message.preparedSceneCountryIds)
              ? message.preparedSceneCountryIds.map(String) : undefined;
          }
          if(catalogSceneKey!==undefined&&catalogSceneKey!==key){
            metrics.skippedUnmatchedCatalog++;
            finish(null);
          }else worker.postMessage({type:'load-builtin-mesh',sceneIdentity});
        }
        else if(message?.type==='builtin-mesh-miss'){lastMiss=key;finish(null);}
        else if(message?.type==='builtin-mesh-ready'){
          if(message.identity?.sceneKey!==key||!/^[a-f0-9]{64}$/.test(message.identity?.hash||'')){
            finish(new Error('Prepared country scene identity mismatch'));return;
          }
          const value=Object.freeze({meshBuffer:message.meshBuffer,preparedStroke:message.preparedStroke,
            spatialBlocks:message.spatialBlocks,boundaryPacket:message.boundaryPacket,identity:message.identity,
            timings:message.timings||null});
          remember(key,value);finish(null,value);
        }else if(message?.type==='builtin-mesh-error')finish(new Error(message.message||'내장 기본 메시를 준비하지 못했습니다.'));
      };
      worker.onerror=event=>finish(new Error(event.message||'내장 기본 메시 Worker 오류'));
    }catch(error){finish(error);}
    return promise;
  }
  return Object.freeze({
    load,
    canMatchCountrySlots(features) {
      if (catalogSceneKey===null) {
        metrics.skippedUnmatchedSlots++;
        return false;
      }
      const matches=preparedCountrySlotsMatch(features,catalogCountryIds);
      if(!matches) metrics.skippedUnmatchedSlots++;
      return matches;
    },
    stats:()=>Object.freeze({...metrics,knownCatalog:catalogSceneKey!==undefined,
      hasPreparedCatalog:catalogSceneKey!=null&&catalogSceneKey!==undefined,
      cachedCount:retained.size,retainedMeshBytes}),
    dispose(){
    if(disposed)return;disposed=true;
    for(const entry of [...pending.values()])entry.cancel();
    retained.clear();retainedMeshBytes=0;lastMiss=null;
    catalogSceneKey=undefined;catalogCountryIds=undefined;
  }});
}
// @worker-transport dedicated: builtin mesh cache delivery owns its streaming resource protocol
