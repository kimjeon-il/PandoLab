import {createPolarLayer,polarGeometry,polarLinePacket,polarGridPacket,POLAR_LATITUDE} from './maplibre-polar-layer.js';
import {admittedGeometryKey as geometryKey} from '../geometry/geometry-version-store.js';
import {normalizeObjectRef} from '../document/object-ref-identity.js';
import {isWithinDisplayZoom} from '../map/map-display-zoom.js';
// Own polar clipping/mesh state and the line overlays which extend beyond
// MapLibre's supported Mercator latitude. Canonical coordinates are unchanged.
export function createMapLibrePolarDisplay({getMap,isStyleReady,prepareRenderGeometry,getGeneration,
 dirty,invalidate,failMapPreparation,getMapStyle,physicalResources,countryDisplay,state,
 isColorsEnabled,isInitialMapLoading,getPalette,hydro,getSceneKey,getSceneVectors,
 getPickBounds,resolveObjectKey,isHydroFeatureVisible,rgba,createLayer=createPolarLayer,
 readPolarPresentation=()=>({graticule:state.backgroundSettings?.graticule,graticuleAvailable:state.resourceCapabilities?.graticule,
  rivers:state.layerVisibility.rivers,hydroEdits:state.hydroEdits})}){
 let polarLayer=null,polarInputs=[],publishedInputs=null,staticToken=null,polarLineInputs=[],polarVisibleLines=[],countryWarm=null;
 const physicalReady=()=>physicalResources.physicalContextState.ready&&physicalResources.physicalLand;
 function awaitingPublishedInputs(){
  const context=physicalReady();
  return !!context&&(!publishedInputs||publishedInputs!==polarInputs
   ||publishedInputs[0]!==getGeneration()||publishedInputs[1]!==countryDisplay.key
   ||publishedInputs[3]!==context.geometry||publishedInputs[4]!==context.water||publishedInputs[5]!==context.revision);
 }
 function invalidateStaticInputs(){polarInputs=[];publishedInputs=null;staticToken=null;}
 function cancelCountryPrewarm(){countryWarm?.cancel();}
 function cancelPending(){
  cancelCountryPrewarm();polarLayer?.cancelStatic();invalidateStaticInputs();
 }
 const polarGrid=polarGridPacket();
 const overlayLinePackets=new WeakMap();
 function positionPolarLayer(){
  if(!polarLayer||!getMap().getLayer(polarLayer.id))return;
  const before=!isInitialMapLoading()&&getMap().getLayer('viewer-label-dot')?'viewer-label-dot':undefined;
  const layers=getMap().getLayersOrder(),index=layers.indexOf(polarLayer.id);
  if(before?layers[index+1]!==before:index!==layers.length-1)getMap().moveLayer(polarLayer.id,before);
 }
 function ensurePolar(){
  polarLayer ||=createLayer({map:getMap(),prepare:async (geometry,signal)=>(await prepareRenderGeometry([
   {kind:'fill',cacheKey:'polar:'+geometryKey(geometry),geometry,polarCapOnly:true},
  ],getGeneration(),undefined,signal)).packets[0].packet,onChange:token=>{
   if(token!==staticToken)return;
   publishedInputs=polarInputs;dirty();invalidate('polar-ready');
  },onError:cause=>{if(cause.name==='AbortError'){invalidateStaticInputs();invalidate('polar-cancelled');}else failMapPreparation(cause);}});
  polarLayer.ensure();
  return polarLayer;
 }
 function prewarmCountryMeshes(rows,key,signal){
  cancelCountryPrewarm();
  if(!isStyleReady()||signal.aborted)return;
  const style=getMapStyle(),colored=isColorsEnabled(),land=style.paint['physical-land-fill']['fill-color'],shapes=new Set();
  for(const row of rows){
   if(!(colored?row.properties.color&&row.properties.displayAlpha>0:land))continue;
   const shape=polarGeometry(row.geometry);
   if(shape)shapes.add(shape);
  }
  if(!shapes.size)return;
  const controller=new AbortController();
  const request={key,generation:getGeneration(),cancel:null};
  const detach=()=>{
   signal.removeEventListener('abort',request.cancel);
   if(countryWarm===request)countryWarm=null;
  };
  request.cancel=()=>{detach();controller.abort();};
  countryWarm=request;
  signal.addEventListener('abort',request.cancel,{once:true});
  // Warm CPU packets only. The static batch independently subscribes to
  // these same jobs after native country acknowledgement.
  ensurePolar().prewarmMeshes([...shapes].map(geometry=>({geometry})),controller.signal)
   .catch(()=>{}).finally(detach);
  return request.cancel;
 }
 function syncPolar(){
  if(!isStyleReady())return;
  ensurePolar();
  const style=getMapStyle(),items=[],{graticule,graticuleAvailable}=readPolarPresentation();
  const add=(geometry,color,alpha=1,multiply=false,loadingRole)=>{
   if(!color||!(alpha>0))return;
   const shape=polarGeometry(geometry);
   if(!shape)return;
   items.push({geometry:shape,color:rgba(color,alpha),multiply,loadingRole});
  };
  const context=physicalResources.physicalLand;
  if(!context||!physicalResources.physicalContextState.ready)return;
  const colored=isColorsEnabled(),land=style.paint['physical-land-fill']['fill-color'];
  const inputs=[getGeneration(),countryDisplay.key,colored,context.geometry,context.water,context.revision,
   land,style.paint.ocean['background-color'],graticule,graticuleAvailable];
  if(inputs.length===polarInputs.length&&inputs.every((value,index)=>value===polarInputs[index]))return;
  polarInputs=inputs;
  add(context.geometry,style.paint['physical-land-fill']['fill-color'],1,false,'land');
  for(const f of countryDisplay.rows.values())add(f.geometry,colored?f.properties.color:land,colored?f.properties.displayAlpha:1,colored&&f.properties.blendMode==='multiply');
  if(context.water)add(context.water,style.paint.ocean['background-color']);
  if(countryDisplay.key)for(const {paths,feature:{properties}} of countryDisplay.borders.values()){
   if(!paths.polar.indices.length)continue;
   const {borderColor,borderAlpha,borderWidth}=properties;
   items.push({packet:paths.polar,color:rgba(borderColor,borderAlpha),width:borderWidth});
  }
  if(graticule!==false&&graticuleAvailable!==false){
   items.push({packet:polarGrid,color:rgba('#777777',.15),width:.5,loadingRole:'grid'});
  }
  staticToken=Symbol('polar display revision');
  polarLayer.update(staticToken,items,rgba(style.paint.ocean['background-color']));
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
  const {rivers,hydroEdits}=readPolarPresentation();
  if(rivers!==false){
   const paint={color:ocean,alpha:1,width:riverWidth};
   const visibleStageZooms=new Map(visibleStages);
   for(const feature of hydro.features){
    const {category,stage,logicalId,featureId,layerId}=feature.properties;
    if(category!=='river'||!visibleStageZooms.has(stage))continue;
    if(!isHydroFeatureVisible({...feature,id:logicalId,properties:{...feature.properties,pandolab_id:logicalId,layer_id:layerId}}))continue;
    add(feature.geometry,paint,normalizeObjectRef({domain:'hydro',type:'river',id:String(logicalId)}),featureId??feature.id,visibleStageZooms.get(stage));
   }
   for(const feature of hydroEdits||emptyHydroEdits){
    if(feature.properties.category!=='river'||!isHydroFeatureVisible(feature))continue;
    add(feature.geometry,{...paint,width:1},normalizeObjectRef({domain:'hydro',type:'river',id:String(feature.id)}));
   }
  }
  polarVisibleLines=rows;
  polarLayer.setOverlayLines(rows);dirty();
 }

 return Object.freeze({ensurePolar,positionPolarLayer,syncPolar,syncPolarLines,prewarmCountryMeshes,cancelCountryPrewarm,cancelPending,
  get layer(){return polarLayer;},get pending(){return !!polarLayer?.pending||awaitingPublishedInputs();},
  get visibleLines(){return polarVisibleLines;},
  invalidateInputs(){invalidateStaticInputs();polarLineInputs=[];},
  setLoadingSurface(value){polarLayer?.setLoadingSurface(value);},
  resetContext(){cancelCountryPrewarm();polarLayer?.resetContext();invalidateStaticInputs();polarLineInputs=[];},
  retry(){cancelCountryPrewarm();invalidateStaticInputs();polarLineInputs=[];polarLayer?.retry();},
  resetProject(){cancelPending();polarLineInputs=[];},
  stats:()=>polarLayer?.stats(),
  dispose(){cancelCountryPrewarm();polarLayer?.dispose();polarLayer=null;invalidateStaticInputs();polarLineInputs=[];polarVisibleLines=[];}
 });
}
