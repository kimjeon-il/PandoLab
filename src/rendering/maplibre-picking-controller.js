import {createMapObjectSpatialIndex} from '../map/map-object-spatial-index.js';
import {coordinateBounds} from '../geometry/coordinate-bounds.js';
import {projectedLineDistance} from '../geometry/geometry-screen-hit.js';
import {normalizeObjectRef} from '../document/object-ref-identity.js';
import {POLAR_LATITUDE} from './maplibre-polar-layer.js';
import {isWithinDisplayZoom} from '../map/map-display-zoom.js';
const layerVisibleAtZoom=(layer,zoom)=>layer.visible&&isWithinDisplayZoom(zoom,layer.minzoom,layer.maxzoom);
export function createMapLibrePicking({getMap,getProjection,getTerritories,getHydroFeatures,getPolarLines,getVectorRole,ownsHighlight,canPick,canPickHydro,objectRefVisible,containsGeometry,isHydroFeatureVisible,mapSourceLayers,sourceLayer,datedSources,requiredSource,objectKeyRef}){
 const polarPicking=createMapObjectSpatialIndex(),polarFeatureBounds=new WeakMap();
 let indexedTerritories=null,pickLayerCache=null;
 const polarTerritories=new Map();
 function pickBounds(geometry){
  if(polarFeatureBounds.has(geometry))return polarFeatureBounds.get(geometry);
  const [west,south,east,north]=coordinateBounds(geometry.coordinates);
  const wide=east-west>=180||south<=-89.999||north>=89.999;
  const bounds=[west,south,east,north].every(Number.isFinite)?[
   wide?-180:Math.max(-180,west-1e-3),Math.max(-90,south-1e-3),
   wide?180:Math.min(180,east+1e-3),Math.min(90,north+1e-3),
  ]:[-180,-90,180,90];
  polarFeatureBounds.set(geometry,bounds);
  return bounds;
 }
 function territorialPolarCandidates(coordinate){
  const territories=getTerritories();
  if(indexedTerritories!==territories){
   indexedTerritories=territories;polarTerritories.clear();polarPicking.clearDomain('territorial');
   for(const feature of territories){
    if(!feature.geometry)continue;
    const bounds=pickBounds(feature.geometry);
    if(bounds[1]>-POLAR_LATITUDE&&bounds[3]<POLAR_LATITUDE)continue;
    const id=String(feature.id);polarTerritories.set(id,feature);
    polarPicking.upsert({key:id,id,domain:'territorial',bounds});
   }
  }
  const [lon,lat]=coordinate;
  return polarPicking.query([lon,lat,lon,lat]).map(record=>polarTerritories.get(record.id));
 }
 function pickingLayers(zoom,includeHydro,includeLabels){
  const sources=mapSourceLayers();
  if(!pickLayerCache||zoom<pickLayerCache.min||zoom>=pickLayerCache.max){
   const groups={map:[],hydro:[],labels:[]};
   const border=sourceLayer('borders',datedSources.active('territories'));
   let min=-Infinity,max=Infinity;
   for(const layer of sources){
    if(!layer.visible)continue;
    for(const cutoff of [layer.minzoom,layer.maxzoom]){
     if(cutoff<=zoom)min=Math.max(min,cutoff);else max=Math.min(max,cutoff);
    }
    if(!layerVisibleAtZoom(layer,zoom))continue;
    const {id,source}=layer;
    if(source==='viewer-labels')groups.labels.push(id);
    else if(['hydro','hydro-edits',datedSources.active('physical-water')].includes(source)||getVectorRole(source)==='project-hydro')groups.hydro.push(id);
    else if(source!==datedSources.active('physical-land')&&!ownsHighlight(source)&&id!=='map-graticule'&&id!==border&&requiredSource(source))groups.map.push(id);
   }
   pickLayerCache={min,max,groups};
  }
  const groups=pickLayerCache.groups;
  return includeHydro||includeLabels?[...groups.map,...(includeHydro?groups.hydro:[]),...(includeLabels?groups.labels:[])]:groups.map;
 }
 function queryObjectRefs(point,{includeHydro=true,includeLabels=true}={}){
  if(!canPick())return [];
  const coordinate=getProjection().screenToGeo(point);
  if(!coordinate)return [];
  const zoom=getMap().getZoom();
  if(Math.abs(coordinate[1])>=POLAR_LATITUDE){
   const refs=[];
   for(const feature of territorialPolarCandidates(coordinate)){
    const ref=normalizeObjectRef({domain:'territorial',type:'entity',id:String(feature.id)});
    if(objectRefVisible(ref)&&containsGeometry(coordinate,feature.geometry))refs.push(ref);
   }
   if(includeHydro)for(const feature of getHydroFeatures()){
    if(!feature.properties.physical_water||!feature.geometry||!isHydroFeatureVisible(feature))continue;
    const [west,south,east,north]=pickBounds(feature.geometry),[lon,lat]=coordinate;
    if(lon>=west&&lon<=east&&lat>=south&&lat<=north&&containsGeometry(coordinate,feature.geometry))
     refs.push(normalizeObjectRef({domain:'hydro',type:feature.properties.category,id:String(feature.id)}));
   }
   for(const row of getPolarLines()){
    if(!row.ref||!isWithinDisplayZoom(zoom,row.displayMinZoom)||!objectRefVisible(row.ref)||row.ref.domain==='hydro'&&(!includeHydro
     ||row.packFeatureId!==null&&!canPickHydro(row.packFeatureId,row.ref.id)))continue;
    if(projectedLineDistance(row.geometry,point,vertex=>getProjection().projectVisibleCoordinate(vertex,{allowOutsideViewport:true}))<=Math.max(4,row.width/2))
     refs.push(row.ref);
   }
   return refs;
  }
  const refs=new Map();
  const layers=pickingLayers(zoom,includeHydro,includeLabels);
  if(!layers.length)return [];
  for(const feature of getMap().queryRenderedFeatures(point,{layers})){
   const p=feature.properties||{};if(p.displayRole==='country-border')continue;
   if(feature.source==='hydro'&&(!isWithinDisplayZoom(zoom,p.viewerMinZoom)||!canPickHydro(p.featureId,p.logicalId)))continue;
   if(feature.source==='viewer-labels'&&p.kind==='label'&&!isWithinDisplayZoom(zoom,p.viewerMinZoom))continue;
   let ref;
   if(p.objectKey)ref=objectKeyRef(p.objectKey);
   else if(p.logicalId&&p.category)ref=normalizeObjectRef({domain:'hydro',type:p.category,id:String(p.logicalId)});
   if(ref&&(includeHydro||ref.domain!=='hydro')&&(includeLabels||ref.domain!=='label'))refs.set(ref.key,ref);
  }
  return [...refs.values()];
 }

 return Object.freeze({queryObjectRefs,pickBounds,invalidateLayers(){pickLayerCache=null;},
  reset(){pickLayerCache=null;indexedTerritories=null;polarTerritories.clear();polarPicking.clearDomain('territorial');}});
}
