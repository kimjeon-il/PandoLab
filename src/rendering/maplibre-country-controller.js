import {createTerritorialEntityRepository} from '../document/territorial-entity-repository.js';
import {admittedGeometryKey as geometryKey} from '../geometry/geometry-version-store.js';
import {sameRenderIdentity} from './render-identity.js';
import {countryContentIdentity,immutableCountryRows} from './country-content-identity.js';
import {countryDefaultColor} from '../ui/color-adapter.js';
import {prepareCountryPresentation,countryPaintOnly,countryTileDiff} from './maplibre-country-presentation.js';
const collection=features=>({type:'FeatureCollection',features});

// Own the country presentation request queue and its published generation.
// The worker transport owns cancellation; the display cache owns tile rows.
export function createMapLibreCountryController({getMap,getGeneration,isDisposed,styleReady,isFrameBlocked,getBasemapRecovery,waitForStyle,
 isTemporalPending,initialize,getEntityRepository,state,layerPresentation,currentMapStyle,geometryClient,countryDisplay,datedSources,
 sourceLayer,sourceLayers,countryTileSource,scene,sourceWrites,setData,metrics,stats,dirty,prepareCountryBorders}){
 let countryGeneration=-1,countryContentKey='',territories=[],acceptedCountryInputs=null;
 let countrySequence=0,countryTail=Promise.resolve();
 const activeCountryTasks=new Set();
 const immutableRepositories=new WeakMap();
 const fillInputs=new WeakMap();
 function fillIdentity(row){
  let key=fillInputs.get(row);
  if(!key){key=[row.id,row.geometry,row.properties.parentId,row.properties.entityKind,row.properties.style?.color,countryDefaultColor(row)];fillInputs.set(row,key);}
  return key;
 }
 const equivalent=(before,after)=>before===after||before.length===after.length&&before.every((row,index)=>{
  const next=after[index];
  return row===next||fillIdentity(row).every((value,i)=>value===fillIdentity(next)[i]);
 });
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
 function setTerritorialFeatures(features){
  if(isDisposed())return Promise.resolve(false);
  const entities=getEntityRepository().list?.()??features;
  const countryStyle=currentMapStyle();
  const inputs={entities,features,generation:getGeneration(),source:getMap()?.getSource(datedSources.active('territories')),
   presentation:state.layerPresentation,visibility:state.itemVisibility?.objects,
   visible:state.layerVisibility.objects,stroke:JSON.stringify([countryStyle.countryStroke,countryStyle.borderAlpha])};
  const accepted=acceptedCountryInputs;
  if(accepted&&styleReady()&&!isFrameBlocked()&&countryGeneration===getGeneration()&&!activeCountryTasks.size&&!countryDisplay.needsSwap
    &&accepted.generation===inputs.generation&&accepted.source===inputs.source&&accepted.stroke===inputs.stroke
    &&accepted.presentation===inputs.presentation&&accepted.visibility===inputs.visibility&&accepted.visible===inputs.visible
    &&immutableCountryRows(accepted.entities)&&immutableCountryRows(entities)&&immutableCountryRows(accepted.features)&&immutableCountryRows(features)
    &&equivalent(accepted.entities,entities)&&equivalent(accepted.features,features)){
   territories=features;acceptedCountryInputs=inputs;countryContentKey=countryContentIdentity(features);return Promise.resolve(true);
  }
  if(activeCountryTasks.size){countryDisplay.markSourceStale();countryTail=Promise.resolve();}
  const signal=geometryClient.startCountryRequest();
  territories=features;const sequence=++countrySequence,requestedGeneration=getGeneration();countryGeneration=-1;
  const task=countryTail.then(async()=>{
   if(sequence!==countrySequence||requestedGeneration!==getGeneration()||isDisposed())return false;
   const entityRepository=metrics.run('territorial.payload',()=>repositoryFor(entities,features));
   activeCountryTasks.add(sequence);
   try{
    const applied=await applyTerritorialFeatures(features,sequence,requestedGeneration,entityRepository,signal);
    if(applied&&sequence===countrySequence&&requestedGeneration===getGeneration())
     acceptedCountryInputs={...inputs,source:getMap().getSource(datedSources.active('territories'))};
    return applied;
   }
   finally{activeCountryTasks.delete(sequence);}
  }).catch(cause=>{if(isDisposed()||sequence!==countrySequence||requestedGeneration!==getGeneration())return false;throw cause;});
  countryTail=task.catch(()=>{});return task;
 }
 async function applyTerritorialFeatures(features,sequence,requestedGeneration,entityRepository,signal){
  const recovery=getBasemapRecovery();if(recovery)await recovery;
  await initialize();
  await waitForStyle(signal);
  if(isDisposed())return false;
  if(requestedGeneration!==getGeneration()||sequence!==countrySequence)return false;
  const map=getMap();
  const {presented,nextBatches,key}=prepareCountryPresentation(features,{state,entityRepository,style:currentMapStyle(),layerPresentation});
  const cached=datedSources.reuse('territories',key,sameRenderIdentity);
  const current=()=>!isDisposed()&&!signal.aborted&&requestedGeneration===getGeneration()&&sequence===countrySequence&&getMap()===map;
  const publish=(id,record)=>{
   const sourceChanged=datedSources.active('territories')!==id;
   datedSources.activate('territories',id);
   countryDisplay.publish(record,record.key);
   scene.syncCountryPaint(id,record.rows);
   if(sourceChanged)scene.syncVectorGroups();
   scene.orderSceneLayers();
  };
  const active=datedSources.get(datedSources.active('territories'));
  // A paint-only transition shares the already tiled source. Keep the actual
  // tile rows for the next native diff and update its paint through feature state.
  const paintOnly=!cached&&!countryDisplay.needsSwap&&active?.source===map.getSource(datedSources.active('territories'))
   &&countryPaintOnly(active,presented);
  if(paintOnly){
   const record={...active,key,rows:new Map(presented.map(row=>[row.id,row]))};
   datedSources.set(datedSources.active('territories'),record);publish(datedSources.active('territories'),record);dirty();
  }else if(cached){
   if(cached[0]!==datedSources.active('territories'))stats.retainedSourceHits++;
   countryDisplay.clearSwap();
   publish(...cached);
  }else{
   const preserve=isTemporalPending()&&datedSources.get(datedSources.active('territories'))?.key!=null;
   if(!preserve)countryDisplay.replaceObsoleteCountrySource({map,datedSources,sourceLayer,sourceLayers,countryTileSource,onCountrySourceRemoved:id=>scene.removeCountryFillSource(id),onStyleInvalidated:()=>{scene.invalidateLayerIndex();},dirty});
   else countryDisplay.clearSwap();
   const requestedSource=preserve?datedSources.reserve('territories'):datedSources.active('territories');
   const source=map.getSource(requestedSource);
   const previousTileRows=datedSources.get(requestedSource)?.tiles
    ??(requestedSource===datedSources.active('territories')?countryDisplay.tiles:new Map());
   const borders=await prepareCountryBorders(presented,requestedGeneration,signal);
   const ownsSource=()=>current()&&map.getSource(requestedSource)===source;
   if(!ownsSource())return false;
   const tileFeatures=[...presented,...borders.map(row=>row.feature).filter(feature=>feature.geometry.coordinates.length)];
   const {next,remove,add,update}=countryTileDiff(previousTileRows,tileFeatures);
   const dirtyEntry={kind:'territories',source};datedSources.set(requestedSource,dirtyEntry);
   try{
    let applied=true;
    if(!previousTileRows.size)applied=await setData(requestedSource,collection(tileFeatures),ownsSource);
    else if(remove.length||add.length||update.length)applied=await sourceWrites.update(source=>source.updateData({remove,add,update}),requestedSource,ownsSource);
    if(!applied)return false;
   }catch(cause){if(current()){countryDisplay.clearTiles();}throw cause;}
   if(!ownsSource())return false;
   scene.syncTerritorialFills(requestedSource,nextBatches);
   const record={kind:'territories',source,key,rows:new Map(presented.map(feature=>[feature.id,feature])),
    tiles:next,borders:new Map(borders.map(row=>[row.key,row]))};
   datedSources.set(requestedSource,record);
   publish(requestedSource,record);
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
