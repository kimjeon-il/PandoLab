import {createTerritorialEntityRepository} from '../document/territorial-entity-repository.js';
import {admittedGeometryKey as geometryKey} from '../geometry/geometry-version-store.js';
import {sameRenderIdentity} from './render-identity.js';
import {countryContentIdentity,immutableCountryRows} from './country-content-identity.js';
import {countryDefaultColor} from '../ui/color-adapter.js';
import {worldViewChange} from '../document/world-view-change.js';
import {prepareCountryPresentation,countryPaintOnly,countryTileDiff,countryDeltaPreferred} from './maplibre-country-presentation.js';
import {createGeometryByteEstimator} from './geometry-residency.js';
const collection=features=>({type:'FeatureCollection',features});

// Own the country presentation request queue and its published generation.
// The worker transport owns cancellation; the display cache owns tile rows.
export function createMapLibreCountryController({getMap,getGeneration,isDisposed,styleReady,isFrameBlocked,getBasemapRecovery,waitForStyle,
 isTemporalPending,isFramePreserved,getTemporalTicket,initialize,getEntityRepository,state,layerPresentation,currentMapStyle,geometryClient,countryDisplay,datedSources,
 sourceLayer,sourceLayers,countryTileSource,scene,sourceWrites,setData,metrics,stats,dirty,prepareCountryBorders,
 prewarmCountryMeshes,readCountryPresentation=()=>state}){
 let countryGeneration=-1,countryContentKey='',territories=[],acceptedCountryInputs=null;
 let countrySequence=0,countryTail=Promise.resolve();
 const activeCountryTasks=new Set(),geometryBytes=createGeometryByteEstimator();
 const trustedTiles=(record,source)=>record?.key!=null&&record.source===source&&record.tiles instanceof Map?record.tiles:null;
 const immutableRepositories=new WeakMap();
 const fillInputs=new WeakMap(),fillCache=new WeakMap();
 function fillIdentity(row){
  let key=fillInputs.get(row);
  if(!key){key=[row.id,row.geometry,row.properties.parentId,row.properties.entityKind,row.properties.style?.color,countryDefaultColor(row)];fillInputs.set(row,key);}
  return key;
 }
 const sameCountryRows=(before,after)=>{
  if(before===after)return true;
  if(before.length!==after.length)return false;
  const indices=worldViewChange(before,after)??before.keys();
  for(const index of indices){
   const row=before[index],next=after[index];
   if(row===next)continue;
   const previous=fillIdentity(row),current=fillIdentity(next);
   if(!previous.every((value,i)=>value===current[i]))return false;
  }
  return true;
 };
 function repositoryFor(entities,features){
  if(immutableCountryRows(entities)&&immutableCountryRows(features)){
   let byFeatures=immutableRepositories.get(entities);
   if(!byFeatures){byFeatures=new WeakMap();immutableRepositories.set(entities,byFeatures);}
   let repository=byFeatures.get(features);
   if(!repository){
    const rows=entities===features?entities:[...new Map([...entities,...features].map(row=>[String(row.id),row])).values()];
    repository=createTerritorialEntityRepository({getEntities:()=>rows});byFeatures.set(features,repository);
   }
   return repository;
  }
  const rows=[...new Map([...entities,...features].map(row=>[String(row.id),row])).values()]
   .map(row=>({...row,properties:structuredClone(row.properties)}));
  return createTerritorialEntityRepository({getEntities:()=>rows});
 }
 function canReuseCountryInputs(inputs){
  const accepted=acceptedCountryInputs;
  if(!accepted||!styleReady()||isFrameBlocked()||countryGeneration!==getGeneration()
    ||activeCountryTasks.size||countryDisplay.needsSwap)return false;
  const samePresentation=accepted.generation===inputs.generation&&accepted.source===inputs.source
    &&accepted.stroke===inputs.stroke&&accepted.presentation===inputs.presentation
    &&accepted.visibility===inputs.visibility&&accepted.visible===inputs.visible;
  if(!samePresentation)return false;
  const immutable=immutableCountryRows(accepted.entities)&&immutableCountryRows(inputs.entities)
    &&immutableCountryRows(accepted.features)&&immutableCountryRows(inputs.features);
  return immutable&&sameCountryRows(accepted.entities,inputs.entities)&&sameCountryRows(accepted.features,inputs.features);
 }
 function setTerritorialFeatures(features){
  if(isDisposed())return Promise.resolve(false);
  const entities=getEntityRepository().list?.()??features;
  const countryStyle=currentMapStyle(),state=readCountryPresentation();
  const inputs={entities,features,generation:getGeneration(),source:getMap()?.getSource(datedSources.active('territories')),
   presentation:state.layerPresentation,visibility:state.itemVisibility?.objects,
   visible:state.layerVisibility.objects,stroke:JSON.stringify([countryStyle.countryStroke,countryStyle.borderAlpha])};
  if(canReuseCountryInputs(inputs)){
   territories=features;acceptedCountryInputs=inputs;countryContentKey=countryContentIdentity(features);return Promise.resolve(true);
  }
  if(activeCountryTasks.size){countryDisplay.markSourceStale();countryTail=Promise.resolve();}
  const signal=geometryClient.startCountryRequest(),ticket=isTemporalPending()?getTemporalTicket():null;
  territories=features;const sequence=++countrySequence,requestedGeneration=getGeneration();countryGeneration=-1;
  const task=countryTail.then(async()=>{
   if(sequence!==countrySequence||requestedGeneration!==getGeneration()||isDisposed())return false;
   const entityRepository=metrics.run('territorial.payload',()=>repositoryFor(entities,features));
   activeCountryTasks.add(sequence);
   try{
    const applied=await applyTerritorialFeatures(features,sequence,requestedGeneration,entityRepository,signal,ticket);
    if(applied&&sequence===countrySequence&&requestedGeneration===getGeneration())
     acceptedCountryInputs={...inputs,source:getMap().getSource(datedSources.active('territories'))};
    return applied;
   }
   finally{activeCountryTasks.delete(sequence);}
  }).catch(cause=>{if(isDisposed()||sequence!==countrySequence||requestedGeneration!==getGeneration())return false;throw cause;});
  countryTail=task.catch(()=>{});return task;
 }
 async function applyTerritorialFeatures(features,sequence,requestedGeneration,entityRepository,signal,ticket){
  const recovery=getBasemapRecovery();if(recovery)await recovery;
  await initialize();
  await waitForStyle(signal);
  if(isDisposed())return false;
  if(requestedGeneration!==getGeneration()||sequence!==countrySequence)return false;
  const map=getMap();
  const sameRequest=()=>!isDisposed()&&!signal.aborted&&requestedGeneration===getGeneration()&&sequence===countrySequence&&getMap()===map;
  const current=()=>sameRequest()&&(!ticket||getTemporalTicket()===ticket&&ticket.isCurrent());
  if(!current())return false;
  const {presented,nextBatches,key}=metrics.run('territorial.presentation',()=>prepareCountryPresentation(features,{
   state:readCountryPresentation(),entityRepository,style:currentMapStyle(),layerPresentation,previousRows:countryDisplay.rows,fillCache}));
  const cached=datedSources.reuse('territories',key,sameRenderIdentity);
  const publish=(id,record,paintChanges)=>{
   const sourceChanged=datedSources.active('territories')!==id;
   datedSources.activate('territories',id);
   countryDisplay.publish(record,record.key);
   scene.syncCountryPaint(id,record.rows,paintChanges);
   if(sourceChanged){scene.syncVectorGroups();scene.orderSceneLayers();}
  };
  const active=datedSources.get(datedSources.active('territories'));
  // A paint-only transition shares the already tiled source. Keep the actual
  // tile rows for the next native diff and update its paint through feature state.
  const paintChanges=[];
  const paintOnly=!cached&&!countryDisplay.needsSwap&&active?.source===map.getSource(datedSources.active('territories'))
   &&countryPaintOnly(active,presented,paintChanges);
  if(paintOnly){
   const record={...active,key,rows:new Map(presented.map(row=>[row.id,row]))};
   datedSources.set(datedSources.active('territories'),record);publish(datedSources.active('territories'),record,{base:active.rows,ids:paintChanges});dirty();
  }else if(cached){
   if(cached[0]!==datedSources.active('territories'))stats.retainedSourceHits++;
   countryDisplay.clearSwap();
   publish(...cached);
  }else{
   const temporal=isTemporalPending();
   const startingId=datedSources.active('territories'),startingSource=map.getSource(startingId);
   const canPreserve=temporal&&!!trustedTiles(datedSources.get(startingId),startingSource);
   // A pending or unacknowledged source must never be a diff baseline.
   if(!canPreserve&&(countryDisplay.needsSwap||sourceWrites.hasPendingWrite(startingSource))){
    countryDisplay.markSourceStale();
    countryDisplay.replaceObsoleteCountrySource({map,datedSources,sourceLayer,sourceLayers,countryTileSource,onCountrySourceRemoved:id=>scene.removeCountryFillSource(id),onStyleInvalidated:()=>{scene.invalidateLayerIndex();},dirty});
   }
   const activeId=datedSources.active('territories'),activeSource=map.getSource(activeId);
   const borders=await metrics.track('territorial.borders',()=>prepareCountryBorders(presented,requestedGeneration,signal));
   if(!current()||datedSources.active('territories')!==activeId||map.getSource(activeId)!==activeSource)return false;
   const tileFeatures=presented.slice();
   for(const {feature} of borders)if(feature.geometry.coordinates.length)tileFeatures.push(feature);
   const diff=tiles=>tiles&&metrics.run('territorial.tile-diff',()=>countryTileDiff(tiles,tileFeatures));
   const activeRecord=datedSources.get(activeId),activeTiles=trustedTiles(activeRecord,activeSource);
   const activeSafe=!!activeTiles&&!countryDisplay.needsSwap&&!sourceWrites.hasPendingWrite(activeSource);
   let delta=activeSafe&&(!temporal||isFramePreserved())?diff(activeTiles):null;
   const useActive=activeSafe&&(!canPreserve||isFramePreserved()&&countryDeltaPreferred(delta,geometryBytes));
   const requestedSource=canPreserve&&!useActive?datedSources.reserve('territories'):activeId;
   const source=map.getSource(requestedSource),previousRecord=datedSources.get(requestedSource);
   const sameSource=()=>sameRequest()&&map.getSource(requestedSource)===source;
   const ownsSource=()=>current()&&map.getSource(requestedSource)===source;
   if(!ownsSource())return false;
   if(requestedSource!==activeId)delta=diff(trustedTiles(previousRecord,source));
   const useDelta=!!delta&&(!temporal||countryDeltaPreferred(delta,geometryBytes));
   const hasChanges=useDelta&&(delta.remove.length||delta.add.length||delta.update.length);
   const willWrite=!useDelta||hasChanges;
   const dirtyEntry={kind:'territories',source};
   if(willWrite)datedSources.set(requestedSource,dirtyEntry);
   countryDisplay.clearSwap();
   prewarmCountryMeshes(presented,key,signal);
   // Restore the last acknowledged native snapshot after an uncertain write.
   // A superseded request cannot write back into a newer source instance.
   const rollback=async()=>{
    if(!willWrite||requestedSource!==activeId||!activeTiles||!sameSource())return;
    const restored=await metrics.track('territorial.rollback-submit',()=>setData(requestedSource,collection([...activeTiles.values()]),sameSource));
    if(restored&&sameSource())datedSources.set(requestedSource,activeRecord);
    else if(sameSource())countryDisplay.markSourceStale();
   };
   let applied=true;
   try{
    if(!useDelta){
     applied=await metrics.track('territorial.full-submit',()=>setData(requestedSource,collection(tileFeatures),ownsSource));
     stats.countryFullSubmissions=(stats.countryFullSubmissions||0)+1;
    }else if(hasChanges){
     const {remove,add,update}=delta;
     applied=await metrics.track('territorial.delta-submit',()=>sourceWrites.update(source=>source.updateData({remove,add,update}),requestedSource,ownsSource));
     stats.countryDeltaSubmissions=(stats.countryDeltaSubmissions||0)+1;
     stats.countryDeltaGeometryRows=(stats.countryDeltaGeometryRows||0)+add.length+update.filter(row=>row.newGeometry).length;
    }
   }catch(cause){
    if(sameSource()){
     try{await rollback();}catch(restoreError){
      if(sameSource()){countryDisplay.markSourceStale();cause.restoreError=restoreError;}
     }
    }
    throw cause;
   }
   if(!applied||!ownsSource()){
    try{await rollback();}catch(cause){if(sameSource())countryDisplay.markSourceStale();throw cause;}
    return false;
   }
   const record={kind:'territories',source,key,rows:new Map(presented.map(feature=>[feature.id,feature])),
    tiles:delta?.next??new Map(tileFeatures.map(feature=>[feature.id,feature])),borders:new Map(borders.map(row=>[row.key,row]))};
   try{
    scene.syncTerritorialFills(requestedSource,nextBatches);
    datedSources.set(requestedSource,record);
    publish(requestedSource,record);scene.orderSceneLayers();
   }catch(cause){
    if(sameSource()){datedSources.set(requestedSource,dirtyEntry);countryDisplay.markSourceStale();}
    throw cause;
   }
  }
  if(sequence!==countrySequence||requestedGeneration!==getGeneration())return false;
  if(requestedGeneration===getGeneration()&&sequence===countrySequence){countryGeneration=getGeneration();countryContentKey=countryContentIdentity(features);}
  map.triggerRepaint();
  return true;
 }

 function reset(){
  geometryClient.cancelCountryRequest();
  if(activeCountryTasks.size)countryDisplay.markSourceStale();
  countryTail=Promise.resolve();countrySequence++;countryGeneration=-1;
  countryContentKey='';acceptedCountryInputs=null;
 }
 return Object.freeze({setTerritorialFeatures,reset,get features(){return territories;},
  status:()=>({generation:countryGeneration,contentKey:countryContentKey}),
  dispose(){reset();activeCountryTasks.clear();territories=[];countryDisplay.clearSource();}
 });
}
