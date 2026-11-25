import {admittedGeometryKey as geometryKey} from '../geometry/geometry-version-store.js';
import {createGeometryByteEstimator,estimateFeatureRows} from './geometry-residency.js';
import {createLatestRenderRequests,createRenderLifetime} from './render-lifetime.js';
const collection=features=>({type:'FeatureCollection',features});
// The native source writer stays with MapLibre, while its land/water
// preparation, current-source identity and admission state live here.
export function createMapLibrePhysicalBase({getMap,getGeneration,isDisposed,isContextReady,isTemporalPending,
 physicalResources,datedSources,sourceWrites,setData,preparePhysicalDisplay,orderSceneLayers,
 dirty,invalidate,failMapPreparation,getStats,lifetime=createRenderLifetime({getMap,getGeneration,isDisposed})}){
 let landRevision=null,physicalLandKey='',physicalWaterKey='',physicalLandSource=null,physicalWaterSource=null;
 const physicalPending=createLatestRenderRequests(),geometryBytes=createGeometryByteEstimator();
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
   physicalPending.cancel(kind);
   publish(cached[0],cached[1].source);
   getStats().retainedSourceHits++;
   return;
  }
  const active=datedSources.active(kind);
  const activeReady=datedSources.get(active)?.key;
  const writePending=sourceWrites.hasNativeWrite(getMap().getSource(active));
  const useStandby=(isTemporalPending()&&activeReady)||previous?.id===active||writePending;
  const id=useStandby?datedSources.reserve(kind):active;
  const scope=lifetime.capture(),source=scope.map.getSource(id),entry=physicalPending.begin(kind,{key,source,id,generation:scope.generation});
  datedSources.set(id,{kind,source});
  const current=()=>physicalPending.current(kind,entry)&&scope.sourceCurrent(id,source);
  if(kind==='physical-land'&&displayPrepared)getStats().physicalLandAssetHits++;
  // Tag only the display derivative; source-owned geometry and selection
  // identities are left intact.
  const tagged=collection(data.features.map(feature=>({...feature,properties:{...feature.properties,displayRole:kind}})));
  const prepared=kind==='physical-land'&&!displayPrepared?preparePhysicalDisplay(key,tagged.features[0].geometry).then(geometry=>collection([{...tagged.features[0],geometry}])):Promise.resolve(tagged);
  let estimatedBytes=0;
  prepared.then(value=>{
   if(!current())return false;
   estimatedBytes=estimateFeatureRows(value.features,geometryBytes);
   return setData(id,value,current,{shareAcrossGenerations:true});
  },cause=>{if(current()){physicalPending.finish(kind,entry);failMapPreparation(cause);}return false;})
   .then(applied=>{if(!current())return;physicalPending.finish(kind,entry);if(applied){datedSources.set(id,{kind,source,key,estimatedBytes});publish(id,source);invalidate('physical-source-ready');}},cause=>{if(!current())return;physicalPending.finish(kind,entry);if(entry.generation===getGeneration())failMapPreparation(cause);else invalidate('physical-source-retry');});
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
  dispose(){physicalPending.dispose();}});
}
