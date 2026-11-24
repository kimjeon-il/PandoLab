import {admittedGeometryKey as geometryKey} from '../geometry/geometry-version-store.js';
const collection=features=>({type:'FeatureCollection',features});
// The native source writer stays with MapLibre, while its land/water
// preparation, current-source identity and admission state live here.
export function createMapLibrePhysicalBase({getMap,getGeneration,isDisposed,isContextReady,isTemporalPending,
 physicalResources,datedSources,sourceWrites,setData,preparePhysicalDisplay,orderSceneLayers,
 dirty,invalidate,failMapPreparation,getStats}){
 let landRevision=null,physicalLandKey='',physicalWaterKey='',physicalLandSource=null,physicalWaterSource=null;
 const physicalPending=new Map();
 function preparePhysicalSource(kind,key,data,displayPrepared=false){
  const previous=physicalPending.get(kind);
  if(previous?.key===key&&previous.source===getMap().getSource(previous.id))return;
  const publish=(id,source)=>{
   datedSources.activate(kind,id);
   if(kind==='physical-land'){physicalLandKey=key;physicalLandSource=source;}
   else{physicalWaterKey=key;physicalWaterSource=source;}
   orderSceneLayers();
  };
  const cached=datedSources.reuse(kind,key);
  if(cached){
   physicalPending.delete(kind);
   publish(cached[0],cached[1].source);
   getStats().retainedSourceHits++;
   return;
  }
  const active=datedSources.active(kind);
  const activeReady=datedSources.get(active)?.key;
  const writePending=sourceWrites.hasPendingWrite(getMap().getSource(active));
  const useStandby=(isTemporalPending()&&activeReady)||previous?.id===active||writePending;
  const id=useStandby?datedSources.reserve(kind,sourceWrites.hasPendingWrite):active;
  const source=getMap().getSource(id),entry={key,source,id,generation:getGeneration()};
  physicalPending.set(kind,entry);
  datedSources.set(id,{kind,source});
  const current=()=>!isDisposed()&&physicalPending.get(kind)===entry&&getMap().getSource(id)===source;
  if(kind==='physical-land'&&displayPrepared)getStats().physicalLandAssetHits++;
  const prepared=kind==='physical-land'&&!displayPrepared?preparePhysicalDisplay(key,data.features[0].geometry).then(geometry=>collection([{...data.features[0],geometry}])):Promise.resolve(data);
  prepared.then(value=>current()?setData(id,value,current,{shareAcrossGenerations:true}):false,cause=>{if(current()){physicalPending.delete(kind);failMapPreparation(cause);}return false;})
   .then(applied=>{if(!current())return;physicalPending.delete(kind);if(applied){datedSources.set(id,{kind,source,key});publish(id,source);invalidate('physical-source-ready');}},cause=>{if(!current())return;physicalPending.delete(kind);if(entry.generation===getGeneration())failMapPreparation(cause);else invalidate('physical-source-retry');});
 }

 function syncPhysicalContext(){
  const context=physicalResources.physicalLand;
  if(!isContextReady()||!context||!physicalResources.physicalContextState.ready)return false;
  const key=context.revision+'|'+(context.waterRevision||'');
  if(key!==landRevision){
   landRevision=key;
  }
  // The derived land revision includes any actual change to the land mask.
  // A water-only change must keep the existing land tiles and their coverage.
  if(getMap().getSource(datedSources.active('physical-land'))&&(physicalLandKey!==context.revision||physicalLandSource!==getMap().getSource(datedSources.active('physical-land'))))
   preparePhysicalSource('physical-land',context.revision,collection([{type:'Feature',properties:{},geometry:context.geometry}]),context.displayPrepared);
  // The physical owner resolves the drawn water and its identities together.
  // Admission into the searchable hydro catalog can complete independently.
  const waterFeatures=context.waterFeatures??(context.water?[{type:'Feature',properties:{},geometry:context.water}]:[]);
  const waterKey=context.waterRevision||JSON.stringify(waterFeatures.map(feature=>geometryKey(feature.geometry)));
  if(waterKey!==physicalWaterKey||physicalWaterSource!==getMap().getSource(datedSources.active('physical-water')))
   preparePhysicalSource('physical-water',waterKey,collection(waterFeatures));
  return true;
 }

 return Object.freeze({syncPhysicalContext,preparePhysicalSource,isPending:kind=>physicalPending.has(kind),
  get revision(){return landRevision;},
  resetContext(){physicalPending.clear();physicalLandKey='';physicalWaterKey='';physicalLandSource=null;physicalWaterSource=null;},
  resetProject(){physicalPending.clear();landRevision=null;physicalLandKey='';physicalWaterKey='';physicalLandSource=null;physicalWaterSource=null;},
  dispose(){physicalPending.clear();}});
}
