import {createPolarLayer,polarGeometry,polarLinePacket,polarGridPacket,POLAR_LATITUDE} from './maplibre-polar-layer.js';
import {admittedGeometryKey as geometryKey} from '../geometry/geometry-version-store.js';
import {normalizeObjectRef} from '../document/object-ref-identity.js';
import {isWithinDisplayZoom} from '../map/map-display-zoom.js';
// Own polar clipping/mesh state and the line overlays which extend beyond
// MapLibre's supported Mercator latitude. Canonical coordinates are unchanged.
export function createMapLibrePolarDisplay({getMap,isStyleReady,prepareRenderGeometry,getGeneration,
 dirty,invalidate,failMapPreparation,getMapStyle,physicalResources,countryDisplay,state,
 isColorsEnabled,isInitialMapLoading,getPalette,hydro,getSceneKey,getSceneVectors,
 getPickBounds,resolveObjectKey,isHydroFeatureVisible,rgba}){
 let polarLayer=null,polarInputs=[],polarLineInputs=[],polarVisibleLines=[];
 const polarGrid=polarGridPacket();
 const overlayLinePackets=new WeakMap();
 function positionPolarLayer(){
  if(!polarLayer||!getMap().getLayer(polarLayer.id))return;
  const before=!isInitialMapLoading()&&getMap().getLayer('viewer-label-dot')?'viewer-label-dot':undefined;
  const layers=getMap().getLayersOrder(),index=layers.indexOf(polarLayer.id);
  if(before?layers[index+1]!==before:index!==layers.length-1)getMap().moveLayer(polarLayer.id,before);
 }
 function ensurePolar(){
  polarLayer ||=createPolarLayer({map:getMap(),prepare:async geometry=>(await prepareRenderGeometry([
   {kind:'fill',cacheKey:'polar:'+geometryKey(geometry),geometry,polarCapOnly:true},
  ],getGeneration())).packets[0].packet,onChange:()=>{dirty();invalidate('polar-ready');},onError:cause=>{if(cause.name==='AbortError'){polarInputs=[];invalidate('polar-cancelled');}else failMapPreparation(cause);}});
  polarLayer.ensure();
  return polarLayer;
 }
 function syncPolar(){
  if(!isStyleReady())return;
  ensurePolar();
  const style=getMapStyle(),items=[],keys=[];
  const add=(geometry,color,alpha=1,multiply=false,loadingRole)=>{
   if(!color||!(alpha>0))return;
   const shape=polarGeometry(geometry);
   if(!shape)return;
   items.push({geometry:shape,color:rgba(color,alpha),multiply,loadingRole});
   keys.push([geometryKey(geometry),color,alpha,multiply,loadingRole]);
  };
  const context=physicalResources.physicalLand;
  if(!context||!physicalResources.physicalContextState.ready)return;
  const colored=isColorsEnabled(),land=style.paint['physical-land-fill']['fill-color'];
  const inputs=[getGeneration(),countryDisplay.key,colored,context.geometry,context.water,context.revision,
   land,style.paint.ocean['background-color'],state.backgroundSettings?.graticule,state.resourceCapabilities?.graticule];
  if(inputs.length===polarInputs.length&&inputs.every((value,index)=>value===polarInputs[index]))return;
  polarInputs=inputs;
  add(context.geometry,style.paint['physical-land-fill']['fill-color'],1,false,'land');
  for(const f of countryDisplay.rows.values())add(f.geometry,colored?f.properties.color:land,colored?f.properties.displayAlpha:1,colored&&f.properties.blendMode==='multiply');
  if(context.water)add(context.water,style.paint.ocean['background-color']);
  if(countryDisplay.key)for(const {key,paths,feature:{properties}} of countryDisplay.borders.values()){
   if(!paths.polar.indices.length)continue;
   const {borderColor,borderAlpha,borderWidth}=properties;
   items.push({packet:paths.polar,color:rgba(borderColor,borderAlpha),width:borderWidth});
   keys.push([key,borderColor,borderAlpha,borderWidth]);
  }
  if(state.backgroundSettings?.graticule!==false&&state.resourceCapabilities?.graticule!==false){
   items.push({packet:polarGrid,color:rgba('#777777',.15),width:.5,loadingRole:'grid'});
   keys.push('grid');
  }
  polarLayer.update(JSON.stringify([getGeneration(),keys,style.paint.ocean]),items,rgba(style.paint.ocean['background-color']));
  positionPolarLayer();
 }

 const emptyHydroEdits=[];
 function syncPolarLines(){
  if(!polarLayer)return;
  const palette=getPalette();
  const zoom=getMap().getZoom(),ocean=palette.ocean||'#ffffff',riverWidth=palette.strokes?.river?.width??1;
  const visibleStages=[...hydro.stageZooms].filter(([,minZoom])=>isWithinDisplayZoom(zoom,minZoom));
  const inputs=[getSceneKey(),hydro.features,hydro.visibilityKey,hydro.editsKey,hydro.stageZooms,visibleStages.length,ocean,riverWidth];
  if(inputs.every((value,index)=>value===polarLineInputs[index]))return;
  polarLineInputs=inputs;
  const rows=[];
  const add=(geometry,style,ref,packFeatureId=null,displayMinZoom=-Infinity)=>{
   if(!['LineString','MultiLineString'].includes(geometry?.type)||!style.color||!(style.alpha>0)||!(style.width>0))return;
   if(!overlayLinePackets.has(geometry)){
    const bounds=getPickBounds(geometry);
    const lines=geometry.type==='LineString'?[geometry.coordinates]:geometry.coordinates;
    overlayLinePackets.set(geometry,bounds[1]<=-POLAR_LATITUDE||bounds[3]>=POLAR_LATITUDE?polarLinePacket(lines):null);
   }
   const packet=overlayLinePackets.get(geometry);
   if(packet?.indices.length)rows.push({packet,geometry,ref,packFeatureId,displayMinZoom,color:rgba(style.color,style.alpha),width:style.width});
  };
  for(const row of getSceneVectors()){
   if(row.role==='graticule')continue;
   const style=row.style||{};
   add(row.geometry,{color:style.color,width:style.width??1,alpha:style.alpha??1},resolveObjectKey(row.objectKey));
  }
  if(state.layerVisibility.rivers!==false){
   const paint={color:ocean,alpha:1,width:riverWidth};
   const visibleStageZooms=new Map(visibleStages);
   for(const feature of hydro.features){
    const {category,stage,logicalId,featureId,layerId}=feature.properties;
    if(category!=='river'||!visibleStageZooms.has(stage))continue;
    if(!isHydroFeatureVisible({...feature,id:logicalId,properties:{...feature.properties,pandolab_id:logicalId,layer_id:layerId}}))continue;
    add(feature.geometry,paint,normalizeObjectRef({domain:'hydro',type:'river',id:String(logicalId)}),featureId??feature.id,visibleStageZooms.get(stage));
   }
   for(const feature of state.hydroEdits||emptyHydroEdits){
    if(feature.properties.category!=='river'||!isHydroFeatureVisible(feature))continue;
    add(feature.geometry,{...paint,width:1},normalizeObjectRef({domain:'hydro',type:'river',id:String(feature.id)}));
   }
  }
  polarVisibleLines=rows;
  polarLayer.setOverlayLines(rows);
 }

 return Object.freeze({ensurePolar,positionPolarLayer,syncPolar,syncPolarLines,
  get layer(){return polarLayer;},get pending(){return !!polarLayer?.pending;},
  get visibleLines(){return polarVisibleLines;},
  invalidateInputs(){polarInputs=[];polarLineInputs=[];},
  setLoadingSurface(value){polarLayer?.setLoadingSurface(value);},
  resetContext(){polarLayer?.resetContext();polarInputs=[];polarLineInputs=[];},
  retry(){polarInputs=[];polarLineInputs=[];polarLayer?.retry();},
  resetProject(){polarInputs=[];polarLineInputs=[];},
  stats:()=>polarLayer?.stats(),
  dispose(){polarLayer?.dispose();polarLayer=null;polarInputs=[];polarLineInputs=[];polarVisibleLines=[];}
 });
}
