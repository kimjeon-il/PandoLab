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
 function update(start,id,isCurrent=()=>true,{shareAcrossGenerations=false}={}){
  const map=getMap(),generation=getGeneration(),context=getContextRevision();
  if(requiredSource(id))dirty();
  const source=map.getSource(id),previous=queues.get(source)||Promise.resolve(),entry={id,source,generation,context};
  pending.add(entry);
  const live=()=>!isDisposed()&&getMap()===map&&context===getContextRevision()&&map.getSource(id)===source;
  const sameGeneration=()=>generation===getGeneration();
  const outcome=previous.catch(()=>{}).then(async()=>{
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
  });
  queues.set(source,outcome);
  const finish=()=>{pending.delete(entry);if(queues.get(source)===outcome)queues.delete(source);};
  outcome.then(()=>{finish();if(live()&&sameGeneration())map.triggerRepaint();},
   cause=>{finish();if(requiredSource(id)&&live()&&isCurrent()&&sameGeneration())onError(cause);});
  return outcome;
 }
 return Object.freeze({update,pendingCount,reset:()=>pending.clear(),handlesError:error=>handledErrors.has(error)});
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
  return [...retained].filter(([id,record])=>record.kind===kind&&map.getSource(id)===record.source);
 }
 function reuse(kind,key,equals=(a,b)=>a===b){return slots(kind).find(([,record])=>equals(record.key,key));}
 function show(id){
  const map=getMap();retiring.delete(id);
  for(const layer of mapSourceLayers()){
   if(layer.source===id&&!layer.visible){map.setLayoutProperty(layer.id,'visibility','visible');invalidateLayerIndex();}
  }
 }
 function reserve(kind){
  const map=getMap(),current=active(kind);
  const standby=slots(kind).find(([id])=>id!==current);
  if(standby){show(standby[0]);return standby[0];}
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
  get:id=>retained.get(id),set:(id,record)=>retained.set(id,record),has:id=>retained.has(id)});
}
