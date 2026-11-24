import {createGeometryByteEstimator,estimateFeatureRows} from './geometry-residency.js';
import {createRenderLifetime} from './render-lifetime.js';
// Owns native source writes and the two dated source slots. Rendering owns
// frame admission; no document state or camera policy is stored here.
export function createMapLibreSourceWrites({getMap,getGeneration,getContextRevision,isDisposed,requiredSource,dirty,track,onError,
 lifetime=createRenderLifetime({getMap,getGeneration,getContextRevision,isDisposed})}) {
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
  if(!entry){if(queues.get(source)===lane)queues.delete(source);liveLanes.delete(lane);return;}
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
   try{
    await track('source:'+id.replace(/-generation-\d+$/,''),()=>start(source));
    if(sourceError)throw sourceError;
    return true;
   }finally{source.off('error',onSourceError);}
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
  if(!lane){lane={running:false,waiting:[]};queues.set(source,lane);liveLanes.add(lane);}
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
 return Object.freeze({update,pendingCount,hasPendingWrite:source=>queues.has(source),reset,handlesError:error=>handledErrors.has(error)});
}

const slotOpacity=type=>type==='line'?'line-layer-opacity':'fill-layer-opacity';
export function createMapLibreDatedSources({getMap,sourceLayers,sourceLayer,mapSourceLayers,createCountrySource,createEmptySource,
 invalidateLayerIndex,dirty,canRetire,temporalPending,graceMs=5000,
 standbyBudget=Infinity,hasPendingWrite:sourcePending=()=>false,onEvict=()=>{}}){
 const activeIds=new Map(Object.keys(sourceLayers).map(kind=>[kind,kind]));
 const retained=new Map(),retiring=new Set(),geometryBytes=createGeometryByteEstimator();
 let timer=null,evictions=0;
 function set(id,record){
  if(record.estimatedBytes===undefined&&record.tiles)
   record={...record,estimatedBytes:estimateFeatureRows(record.tiles.values(),geometryBytes)};
  retained.delete(id);retained.set(id,record);
 }
 function residency(){
  const current=new Set(activeIds.values());let activeBytes=0,standbyBytes=0;
  for(const [id,record]of retained){if(current.has(id))activeBytes+=record.estimatedBytes||0;else standbyBytes+=record.estimatedBytes||0;}
  return {activeBytes,standbyBytes,standbyBudget,evictions};
 }
 function trimStandby(){
  const map=getMap(),current=new Set(activeIds.values());let bytes=residency().standbyBytes;
  for(const [id,record]of retained){
   if(bytes<=standbyBudget)break;
   if(current.has(id)||sourcePending(record.source)||map.getSource(id)!==record.source)continue;
   for(const layer of map.getStyle().layers.filter(layer=>layer.source===id))if(map.getLayer(layer.id))map.removeLayer(layer.id);
   map.removeSource(id);retained.delete(id);retiring.delete(id);onEvict(record.kind,id);invalidateLayerIndex();
   bytes-=record.estimatedBytes||0;evictions++;
  }
 }
 const active=kind=>activeIds.get(kind);
 function slots(kind){
  const map=getMap();
  const matches=[];
  for(const [id,record]of retained){
   if(map.getSource(id)!==record.source){retained.delete(id);retiring.delete(id);continue;}
   if(record.kind===kind)matches.push([id,record]);
  }
  return matches;
 }
 function reuse(kind,key,equals=(a,b)=>a===b){return slots(kind).find(([,record])=>equals(record.key,key));}
 function setVisibility(id,visible){
  const map=getMap();let changed=false;
  for(const layer of mapSourceLayers()){
   if(layer.source===id&&layer.visible!==visible&&!layer.id.startsWith('initial-map-')&&map.getLayer(layer.id)){
    map.setLayoutProperty(layer.id,'visibility',visible?'visible':'none');changed=true;
   }
  }
  if(changed)invalidateLayerIndex();
 }
 const standbySlot=kind=>slots(kind).find(([id])=>id!==active(kind));
 const sourceSpec=kind=>kind==='territories'?createCountrySource():createEmptySource(kind);
 function ensureStandby(kind){
  const existing=standbySlot(kind);
  if(existing)return existing;
  const map=getMap(),id=active(kind)===kind?kind+'-retained':kind;
  if(!map.getSource(id))map.addSource(id,sourceSpec(kind));
  const record={kind,source:map.getSource(id)};
  set(id,record);return [id,record];
 }
 function needsCountryStandby(){
  const kind='territories',id=active(kind),record=retained.get(id);
  return standbyBudget>0&&record?.key!=null&&record.source===getMap().getSource(id)&&!standbySlot(kind);
 }
 function reserve(kind,hasPendingWrite=sourcePending){
  const map=getMap(),current=active(kind);
  const [id,record]=ensureStandby(kind);
  retiring.delete(id);
  // An opacity-zero visible layer still requests tiles. Keep the standby
  // unused while native data is written, and activate only its new content.
  setVisibility(id,false);
  if(hasPendingWrite(record.source)){
   const layers=map.getStyle().layers,owned=layers.filter(layer=>layer.source===id);
   for(const layer of owned)map.removeLayer(layer.id);
   map.removeSource(id);map.addSource(id,sourceSpec(kind));
   for(const layer of owned.reverse()){
    const before=layers.slice(layers.indexOf(layer)+1).find(next=>map.getLayer(next.id));
    map.addLayer({...layer,layout:{...layer.layout,visibility:'none'}},before?.id);
   }
   set(id,{kind,source:map.getSource(id)});invalidateLayerIndex();
  }
  const layers=map.getStyle().layers;let changed=false;
  for(const base of sourceLayers[kind]){
   const spec=layers.find(layer=>layer.id===sourceLayer(base,current));
   const layerId=sourceLayer(base,id);
   if(!map.getLayer(layerId)){
    map.addLayer({...spec,id:layerId,source:id,layout:{...spec.layout,visibility:'none'},
     paint:{...spec.paint,[slotOpacity(spec.type)]:0,[slotOpacity(spec.type)+'-transition']:{duration:0}}},spec.id);changed=true;
   }
  }
  if(changed)invalidateLayerIndex();
  return id;
 }
 function cancelRetirement(){clearTimeout(timer);timer=null;}
 function retire(){
  cancelRetirement();
  if(!canRetire())return;
  retiring.clear();trimStandby();
  // Initialize only the empty country worker source, without visible layers
  // or a duplicate world geometry upload, after a canonical frame.
  if(needsCountryStandby())ensureStandby('territories');
 }
 function scheduleRetirement(){
  if(timer!==null||temporalPending()||!canRetire())return;
  if(needsCountryStandby())timer=setTimeout(retire,0);
  else if(retiring.size)timer=setTimeout(retire,graceMs);
 }
 function activate(kind,id){
  const previous=active(kind);
  if(previous===id)return;
  const map=getMap();
  // The acknowledged source becomes the only visible slot for this kind.
  // Retain the old data for revisit, not a second active tile workload.
  setVisibility(previous,false);retiring.delete(id);setVisibility(id,true);
  for(const layer of map.getStyle().layers){
   if(layer.source!==previous&&layer.source!==id)continue;
   if(layer.id.startsWith('initial-map-')||!['fill','line'].includes(layer.type))continue;
   map.setPaintProperty(layer.id,slotOpacity(layer.type),layer.source===id?1:0);
  }
  retiring.add(previous);activeIds.set(kind,id);invalidateLayerIndex();dirty();
 }
 function replaceActive(kind,id){
  const old=active(kind);retiring.delete(old);retained.delete(old);activeIds.set(kind,id);
 }
 return Object.freeze({active,reuse,reserve,activate,replaceActive,cancelRetirement,scheduleRetirement,
  get:id=>retained.get(id),set,has:id=>retained.has(id),stats:residency,
  dispose(){cancelRetirement();retained.clear();retiring.clear();activeIds.clear();}});
}
