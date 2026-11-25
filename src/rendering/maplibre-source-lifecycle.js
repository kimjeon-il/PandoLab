import {createGeometryByteEstimator,estimateFeatureRows} from './geometry-residency.js';
import {createRenderLifetime} from './render-lifetime.js';
// Owns native source writes and the two dated source slots. Rendering owns
// frame admission; no document state or camera policy is stored here.
export function createMapLibreSourceWrites({getMap,getGeneration,getContextRevision,isDisposed,requiredSource,dirty,track,onError,
 onIdle=()=>{},lifetime=createRenderLifetime({getMap,getGeneration,getContextRevision,isDisposed})}) {
 const pending=new Set(),queues=new WeakMap(),liveLanes=new Set(),handledErrors=new WeakSet();
 function pendingCount(){
  const map=getMap(),generation=getGeneration(),context=getContextRevision();
  let count=0;
  for(const entry of pending){
   if(entry.generation!==generation||entry.context!==context||map.getSource(entry.id)!==entry.source)pending.delete(entry);
   else if(requiredSource(entry.id))count++;
  }
  return count;
 }
 function pump(lane,source){
  if(lane.running)return;
  const entry=lane.waiting.shift();
  if(!entry){if(queues.get(source)===lane)queues.delete(source);liveLanes.delete(lane);onIdle();return;}
  lane.running=true;
  const {map,generation,id,isCurrent,shareAcrossGenerations,start,scope}=entry;
  const live=()=>scope.sourceCurrent(id,source);
  const sameGeneration=()=>generation===getGeneration();
  const execute=async()=>{
   if(!live()||!isCurrent()||(!shareAcrossGenerations&&!sameGeneration()))return false;
   let sourceError=null;
   const onSourceError=event=>{
    sourceError=event.error||new Error('Source update failed: '+id);
    if(typeof sourceError==='object'&&sourceError!==null){
     const handled=sourceError;handledErrors.add(handled);queueMicrotask(()=>handledErrors.delete(handled));
    }
   };
   source.on('error',onSourceError);
   lane.nativePending=true;
   try{
    await track('source:'+id.replace(/-generation-\d+$/,''),()=>start(source));
    if(sourceError)throw sourceError;
    return true;
   }finally{lane.nativePending=false;source.off('error',onSourceError);}
  };
  Promise.resolve().then(execute).then(value=>{
   pending.delete(entry);entry.resolve(value);
   if(live()&&sameGeneration())map.triggerRepaint();
  },cause=>{
   pending.delete(entry);entry.reject(cause);
   if(requiredSource(id)&&live()&&isCurrent()&&sameGeneration())onError(cause);
  }).finally(()=>{
   lane.running=false;
   // The caller's acknowledgement updates its actual source baseline before
   // the next snapshot computes its diff.
   queueMicrotask(()=>pump(lane,source));
  });
 }
 function update(start,id,isCurrent=()=>true,{shareAcrossGenerations=false,coalesce=false}={}){
  const scope=lifetime.capture(),{map,generation,context}=scope,source=map?.getSource(id);
  if(requiredSource(id))dirty();
  if(!source)return Promise.resolve(false);
  let lane=queues.get(source);
  if(!lane){lane={running:false,nativePending:false,waiting:[]};queues.set(source,lane);liveLanes.add(lane);}
  const entry={map,id,source,generation,context,start,isCurrent,shareAcrossGenerations,coalesce,scope};
  if(coalesce){
   const last=lane.waiting.at(-1);
   if(last?.coalesce&&last.id===id&&last.context===context&&last.generation===generation){
    lane.waiting.pop();pending.delete(last);last.resolve(false);
   }
  }
  const outcome=new Promise((resolve,reject)=>{entry.resolve=resolve;entry.reject=reject;});
  pending.add(entry);lane.waiting.push(entry);pump(lane,source);
  return outcome;
 }
 function reset(){
  // Running native writes cannot be interrupted safely. Queued snapshots
  // are not native state; resolve them false and release their payloads.
  for(const lane of liveLanes){
   for(const entry of lane.waiting){pending.delete(entry);entry.resolve(false);}
   lane.waiting.length=0;
  }
  pending.clear();
 }
 return Object.freeze({update,pendingCount,hasPendingWrite:source=>queues.has(source),
  hasNativeWrite:source=>!!queues.get(source)?.nativePending,reset,handlesError:error=>handledErrors.has(error)});
}

const slotOpacity=type=>type==='line'?'line-layer-opacity':'fill-layer-opacity';
export function createMapLibreDatedSources({getMap,sourceLayers,sourceLayer,mapSourceLayers,createCountrySource,createEmptySource,
 invalidateLayerIndex,dirty,canRetire,temporalPending,standbyBudget=Infinity,
 hasPendingWrite:sourcePending=()=>false,hasNativeWrite:sourceBusy=sourcePending,onEvict=()=>{}}){
 const activeIds=new Map(Object.keys(sourceLayers).map(kind=>[kind,kind]));
 const retained=new Map(),warmups=new Map(),geometryBytes=createGeometryByteEstimator();
 let timer=null,closed=false,warmedMap=null,warmedStyle=null,evictions=0,replacements=0,cacheHits=0;
 let warmStarted=0,warmReady=0,warmFailed=0,warmUsedReady=0,warmUsedCold=0;
 const active=kind=>activeIds.get(kind);
 function stopWarm(id){
  const warm=warmups.get(id);
  if(!warm)return null;
  warm.detach();warmups.delete(id);return warm;
 }
 function watchWarm(id,source){
  const warm={source,status:'pending',detach:null};
  const finish=status=>{
   if(closed||warmups.get(id)!==warm||warm.status!=='pending')return;
   if(getMap().getSource(id)!==source){stopWarm(id);return;}
   warm.status=status;warm.detach();
   if(status==='ready')warmReady++;else warmFailed++;
  };
  // Metadata confirms worker acceptance, unlike a hidden source's loaded flag.
  const onData=event=>{if(event.sourceDataType==='metadata')finish('ready');};
  const onError=()=>finish('failed');
  warm.detach=()=>{source.off('data',onData);source.off('error',onError);};
  warmups.set(id,warm);warmStarted++;
  source.on('data',onData);source.on('error',onError);
 }
 function pruneMissing(){
  const map=getMap();let changed=false;
  for(const [id,record]of retained)if(map.getSource(id)!==record.source){
   stopWarm(id);retained.delete(id);onEvict(record.kind,id);changed=true;
  }
  if(changed)invalidateLayerIndex();
 }
 function set(id,record){
  const prior=retained.get(id);
  if(record.estimatedBytes===undefined){
   if(record.tiles)record={...record,estimatedBytes:estimateFeatureRows(record.tiles.values(),geometryBytes)};
   else if(prior?.source===record.source)record={...record,estimatedBytes:prior.estimatedBytes};
  }
  retained.delete(id);retained.set(id,record);
 }
 function residency(){
  const current=new Set(activeIds.values());let activeBytes=0,standbyBytes=0;
  for(const [id,record]of retained){if(current.has(id))activeBytes+=record.estimatedBytes||0;else standbyBytes+=record.estimatedBytes||0;}
  return {activeBytes,standbyBytes,standbyBudget,evictions,replacements,cacheHits,standbyWarmStarted:warmStarted,
   standbyWarmReady:warmReady,standbyWarmFailed:warmFailed,standbyWarmUsedReady:warmUsedReady,standbyWarmUsedCold:warmUsedCold};
 }
 function trimStandby(){
  const map=getMap(),current=new Set(activeIds.values());let bytes=residency().standbyBytes;
  for(const [id,record]of retained){
   if(bytes<=standbyBudget)break;
   if(current.has(id)||sourcePending(record.source)||map.getSource(id)!==record.source)continue;
   stopWarm(id);
   for(const layer of mapSourceLayers())if(layer.source===id&&map.getLayer(layer.id))map.removeLayer(layer.id);
   map.removeSource(id);retained.delete(id);onEvict(record.kind,id);invalidateLayerIndex();
   bytes-=record.estimatedBytes||0;evictions++;
  }
 }
 function slots(kind){pruneMissing();return [...retained].filter(([,record])=>record.kind===kind);}
 function completeLayers(kind,id){
  const map=getMap();
  return sourceLayers[kind].every(base=>map.getLayer(sourceLayer(base,id))?.source===id);
 }
 function reuse(kind,key,equals=(a,b)=>a===b){
  const cached=slots(kind).find(([id,record])=>record.key!=null&&!sourceBusy(record.source)&&completeLayers(kind,id)&&equals(record.key,key));
  if(cached&&cached[0]!==active(kind)){cacheHits++;set(...cached);}
  return cached;
 }
 function setVisibility(id,visible){
  const map=getMap();let changed=false;
  for(const layer of mapSourceLayers()){
   if(layer.source===id&&layer.visible!==visible&&!layer.id.startsWith('initial-map-')&&map.getLayer(layer.id)?.source===id){
    map.setLayoutProperty(layer.id,'visibility',visible?'visible':'none');changed=true;
   }
  }
  if(changed)invalidateLayerIndex();
 }
 const standbySlot=kind=>slots(kind).find(([id])=>id!==active(kind));
 const sourceSpec=kind=>kind==='territories'?createCountrySource():createEmptySource(kind);
 function ensureStandby(kind,prewarm=false){
  const existing=standbySlot(kind);
  if(existing)return existing;
  const map=getMap(),id=active(kind)===kind?kind+'-retained':kind;
  const created=!map.getSource(id);
  if(created)map.addSource(id,sourceSpec(kind));
  const record={kind,source:map.getSource(id)};
  set(id,record);
  if(prewarm&&created)watchWarm(id,record.source);
  return [id,record];
 }
 function needsCountryStandby(){
  const map=getMap(),kind='territories',id=active(kind),record=retained.get(id);
  return standbyBudget>0&&(map!==warmedMap||map.style!==warmedStyle)
   &&record?.key!=null&&record.source===map.getSource(id)&&!standbySlot(kind);
 }
 function reserve(kind){
  const map=getMap(),current=active(kind);
  const [id,record]=ensureStandby(kind);
  const warm=stopWarm(id);
  if(warm){if(warm.status==='ready')warmUsedReady++;else warmUsedCold++;}
  setVisibility(id,false);
  // Only a genuinely executing native write or failed prewarm needs isolation.
  if(sourceBusy(record.source)||warm?.status==='failed'){
   const layers=map.getStyle().layers,owned=layers.filter(layer=>layer.source===id);
   for(const layer of owned)map.removeLayer(layer.id);
   map.removeSource(id);map.addSource(id,sourceSpec(kind));
   for(const layer of owned.reverse()){
    const before=layers.slice(layers.indexOf(layer)+1).find(next=>map.getLayer(next.id));
    map.addLayer({...layer,layout:{...layer.layout,visibility:'none'}},before?.id);
   }
   set(id,{kind,source:map.getSource(id)});invalidateLayerIndex();replacements++;
  }
  let changed=false;
  for(const base of sourceLayers[kind]){
   const layerId=sourceLayer(base,id);
   if(map.getLayer(layerId))continue;
   const spec=map.getStyle().layers.find(layer=>layer.id===sourceLayer(base,current));
   if(!spec)throw new Error('Missing active dated layer: '+base);
   map.addLayer({...spec,id:layerId,source:id,layout:{...spec.layout,visibility:'none'},
    paint:{...spec.paint,[slotOpacity(spec.type)]:0,[slotOpacity(spec.type)+'-transition']:{duration:0}}},spec.id);changed=true;
  }
  if(changed)invalidateLayerIndex();
  return id;
 }
 function cancelRetirement(){clearTimeout(timer);timer=null;}
 function retire(){
  cancelRetirement();
  if(closed||!canRetire()||temporalPending())return;
  pruneMissing();trimStandby();
  // Once per map/style: eviction must not recreate the speculative slot.
  if(needsCountryStandby()){
   const map=getMap();warmedMap=map;warmedStyle=map.style;
   ensureStandby('territories',true);
  }
 }
 function scheduleRetirement(){
  if(closed||timer!==null||temporalPending()||!canRetire())return;
  pruneMissing();
  if(residency().standbyBytes>standbyBudget||needsCountryStandby())timer=setTimeout(retire,0);
 }
 function activate(kind,id){
  const previous=active(kind);
  if(previous===id)return;
  const map=getMap();
  setVisibility(previous,false);setVisibility(id,true);
  for(const row of mapSourceLayers()){
   if(row.source!==previous&&row.source!==id||row.id.startsWith('initial-map-'))continue;
   const layer=map.getLayer(row.id);
   if(!layer||!['fill','line'].includes(layer.type))continue;
   const property=slotOpacity(layer.type),value=row.source===id?1:0;
   if(map.getPaintProperty(row.id,property)!==value)map.setPaintProperty(row.id,property,value);
  }
  activeIds.set(kind,id);invalidateLayerIndex();dirty();
 }
 function replaceActive(kind,id){
  const old=active(kind);stopWarm(old);retained.delete(old);activeIds.set(kind,id);
 }
 return Object.freeze({active,reuse,reserve,activate,replaceActive,cancelRetirement,scheduleRetirement,
  get:id=>retained.get(id),set,has:id=>retained.has(id),stats:residency,
  dispose(){closed=true;cancelRetirement();for(const id of warmups.keys())stopWarm(id);retained.clear();activeIds.clear();warmedMap=warmedStyle=null;}});
}
