// Owns native source writes and the two dated source slots. Rendering owns
// frame admission; no document state or camera policy is stored here.
export function createMapLibreSourceWrites({getMap,getGeneration,getContextRevision,isDisposed,requiredSource,dirty,track,onError}) {
 const pending=new Set(),queues=new WeakMap(),handledErrors=new WeakSet();
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
  if(!entry){if(queues.get(source)===lane)queues.delete(source);return;}
  lane.running=true;
  const {map,generation,context,id,isCurrent,shareAcrossGenerations,start}=entry;
  const live=()=>!isDisposed()&&getMap()===map&&context===getContextRevision()&&map.getSource(id)===source;
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
  const map=getMap(),generation=getGeneration(),context=getContextRevision(),source=map.getSource(id);
  if(requiredSource(id))dirty();
  if(!source)return Promise.resolve(false);
  let lane=queues.get(source);
  if(!lane){lane={running:false,waiting:[]};queues.set(source,lane);}
  const entry={map,id,source,generation,context,start,isCurrent,shareAcrossGenerations,coalesce};
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
 return Object.freeze({update,pendingCount,hasPendingWrite:source=>queues.has(source),reset:()=>pending.clear(),handlesError:error=>handledErrors.has(error)});
}

const slotOpacity=type=>type==='line'?'line-layer-opacity':'fill-layer-opacity';
export function createMapLibreDatedSources({getMap,sourceLayers,sourceLayer,mapSourceLayers,createCountrySource,createEmptySource,
 invalidateLayerIndex,dirty,canRetire,temporalPending,graceMs=5000}){
 const activeIds=new Map(Object.keys(sourceLayers).map(kind=>[kind,kind]));
 const retained=new Map(),retiring=new Set();
 let timer=null;
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
 function show(id){
  const map=getMap();retiring.delete(id);
  for(const layer of mapSourceLayers()){
   if(layer.source===id&&!layer.visible){map.setLayoutProperty(layer.id,'visibility','visible');invalidateLayerIndex();}
  }
 }
 function reserve(kind,hasPendingWrite=()=>false){
  const map=getMap(),current=active(kind);
  const standby=slots(kind).find(([id])=>id!==current);
  if(standby){
   const [id,record]=standby;
   if(hasPendingWrite(record.source)){
    // The obsolete write belongs to the old native source instance. Rebuild
    // only the standby slot, preserving the active layer and the draw order.
    const layers=map.getStyle().layers;
    const owned=layers.filter(layer=>layer.source===id);
    for(const layer of owned)map.removeLayer(layer.id);
    map.removeSource(id);map.addSource(id,createEmptySource(kind));
    for(const layer of owned.reverse()){
     const before=layers.slice(layers.indexOf(layer)+1).find(next=>map.getLayer(next.id));
     map.addLayer(layer,before?.id);
    }
    retained.set(id,{kind,source:map.getSource(id)});invalidateLayerIndex();
   }
   show(id);return id;
  }
  const id=current===kind?kind+'-retained':kind;
  if(!map.getSource(id))map.addSource(id,kind==='territories'?createCountrySource():createEmptySource(kind));
  const layers=map.getStyle().layers;
  for(const base of sourceLayers[kind]){
   const spec=layers.find(layer=>layer.id===sourceLayer(base,current));
   const layerId=sourceLayer(base,id);
   if(!map.getLayer(layerId))map.addLayer({...spec,id:layerId,source:id,layout:{...spec.layout,visibility:'visible'},
    paint:{...spec.paint,[slotOpacity(spec.type)]:0,[slotOpacity(spec.type)+'-transition']:{duration:0}}},spec.id);
  }
  retained.set(id,{kind,source:map.getSource(id)});invalidateLayerIndex();
  return id;
 }
 function cancelRetirement(){clearTimeout(timer);timer=null;}
 function retire(){
  cancelRetirement();
  if(!retiring.size||!canRetire())return;
  const map=getMap();
  for(const layer of mapSourceLayers()){
   if(retiring.has(layer.source)&&layer.visible&&!layer.id.startsWith('initial-map-')&&map.getLayer(layer.id)){
    map.setLayoutProperty(layer.id,'visibility','none');invalidateLayerIndex();
   }
  }
  retiring.clear();
 }
 function scheduleRetirement(){
  if(timer===null&&retiring.size&&!temporalPending())timer=setTimeout(retire,graceMs);
 }
 function activate(kind,id){
  const previous=active(kind);
  if(previous===id)return;
  const map=getMap();show(id);
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
  get:id=>retained.get(id),set:(id,record)=>retained.set(id,record),has:id=>retained.has(id),
  dispose(){cancelRetirement();retained.clear();retiring.clear();activeIds.clear();}});
}
