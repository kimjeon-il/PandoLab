import {createMapLibrePolarDisplay} from './maplibre-polar-display.js';
import {createMapLibreSceneController} from './maplibre-scene-controller.js';
import {createMapLibreProjection} from './maplibre-projection.js';
import {installManagedMapLibreFeature} from './maplibre-feature-lifecycle.js';
import {createExternalBasemap} from './maplibre-external-style.js';
import {createMapLibreFrameController} from './maplibre-frame-controller.js';
import {normalizeObjectRef} from '../document/object-ref-identity.js';
import {createMapLibreGeometryClient} from './maplibre-geometry-client.js';
import {createMapLibreCountryBorders} from './maplibre-country-borders.js';
import {createMapLibreCountryController} from './maplibre-country-controller.js';
import {createMapLibreCountryDisplay} from './maplibre-country-display.js';
import {createMapLibrePhysicalBase} from './maplibre-physical-base.js';
import {createMapLibreHydroDisplay} from './maplibre-hydro-display.js';
import {createMapLibreSelection} from './maplibre-selection-controller.js';
import {createRenderingMetrics} from './rendering-metrics.js';
import {createMapLibreSourceWrites,createMapLibreDatedSources} from './maplibre-source-lifecycle.js';

const collection=features=>({type:'FeatureCollection',features});
const empty=()=>collection([]);
// Display-only simplification is performed by MapLibre per tile/zoom; canonical geometry stays intact.
const countryTileSource=()=>({type:'geojson',data:empty(),promoteId:'objectKey',tolerance:0.5});
const countryFillFilter=batch=>['all',['==',['get','displayRole'],'country-fill'],['==',['get','paintBatch'],batch],['==',['get','blendMode'],'normal']];
const SOURCE_LAYERS={'territories':['territories','borders'],'physical-land':['physical-land-fill'],'physical-water':['physical-water']};
import {createMapLibreCamera,WORLD_VIEW_BOUNDS} from './maplibre-camera-controller.js';

export {createMapGeometryRequester} from './maplibre-geometry-client.js';

/** MapLibre owns map pixels and picking. Core and the physical owner retain all data. */
export function createMapLibreViewerRenderer(deps,{presentMapPreparation,onMapPreparationStatus,initialCamera,readSafeInsets=()=>({}),onWorldFitChange}={}) {
 if(typeof deps.objectRefVisible!=='function')throw new TypeError('MapLibre requires the canonical object visibility query.');
 const state=deps.projectState.state;
 const metrics=createRenderingMetrics();
 const camera=createMapLibreCamera({getMap:()=>map,isLoaded:()=>loaded,getProjection:()=>projection,getView:()=>state.view,readSafeInsets,onWorldFitChange,
  onFarJump:()=>frame.onFarCameraJump(),onMove:event=>frame.onCameraMove(event),
  onMoveStart:()=>{frame.resetCadence();selection.onCameraChange();deps.domains.renderingDomain?.beginInteraction('maplibre-move');},
  onMoveEnd:()=>{frame.resetCadence();selection.onCameraChange();deps.domains.renderingDomain?.endInteraction('maplibre-move-end');datedSources.scheduleRetirement();}});
 const {fitMapBounds,refreshWorldFit,applyCameraFit,isAtWorldView,labelZoomVisibility,syncCameraFromState}=camera;
 let map,api,projection,container,stylesheet,initialization,loadedStyle=null,disposed=false,loaded=false;

  let quality=null;
 const countryDisplay=createMapLibreCountryDisplay();
 const geometryClient=createMapLibreGeometryClient({runtimeAssetUrl:path=>deps.platform.runtimeAssetUrl(path),isDisposed:()=>disposed,getGeneration:()=>frame.generation,onRestart:()=>{borders.reset();},getStats:()=>stats,metrics});
 const {preparePhysicalDisplay,prepareRenderGeometry}=geometryClient;
 const borders=createMapLibreCountryBorders({getBoundaryGeometry:()=>countryDisplay.borders,prepareRenderGeometry,metrics,getStats:()=>stats});
 const {prepareCountryBorders}=borders;

 const mapFeatures=new Map();
 let externalBasemap=null,externalAttribution=null;
 let pendingStyleRefresh=false,pendingCountryPaint=false;
 const styleReady=()=>loaded&&!frame.contextLost&&!frame.basemapRecovery&&!!map&&loadedStyle===map.style;
 function flushStyleChanges(){
  if(!styleReady())return;
  frame.styleAvailable();scene.flushPendingInteractionStyle();
  if(pendingStyleRefresh){pendingStyleRefresh=false;invalidateStyle();}
  if(pendingCountryPaint){pendingCountryPaint=false;invalidateCountryColors();}
  scene.flushPendingDomains();
  selection.flushPending();
  invalidate('map-paint-ready');
 }
 async function previewExternalBasemap(style){
  if(disposed||!loaded||frame.temporalPending()||frame.hasOverlay)throw new Error('The map is not available for a basemap change.');
  for(const layer of style?.layers||[])if(map.getLayer(layer.id))throw new Error('Basemap layer collision: '+layer.id);
  externalBasemap ||=createExternalBasemap(map,{getRevision:frame.externalRevisionKey,onChange:()=>{syncVectorGroups();dirty();invalidate('external-basemap-change');},onRemoveStart:preserveTemporalFrame,onRemoveEnd:()=>{if(!frame.temporalPending())releaseTemporalFrame();},onCancelled:()=>{if(externalAttribution){map.removeControl(externalAttribution);externalAttribution=null;}},onFailure:(cause,{removed})=>{
   if(removed&&externalAttribution){map.removeControl(externalAttribution);externalAttribution=null;}
   deps.feedback.reportOperationError(cause,'외부 배경 지도를 불러오지 못했습니다.','PL-BASEMAP-001');
  }});
  let remove;preserveTemporalFrame();
  try{remove=await externalBasemap.install(style);}catch(cause){if(cause.name!=='AbortError')deps.feedback.reportOperationError(cause,'외부 배경 지도를 불러오지 못했습니다.','PL-BASEMAP-001');throw cause;}finally{if(!frame.temporalPending())releaseTemporalFrame();}
  if(disposed){await remove();throw new Error('The map was disposed during basemap installation.');}
  const attribution=new api.AttributionControl({compact:true});externalAttribution=attribution;map.addControl(attribution);
  return async()=>{if(externalAttribution!==attribution)return;await remove();if(externalAttribution===attribution){map.removeControl(attribution);externalAttribution=null;}};
 }
 function registerFeature(id,install){
  if(disposed||!loaded||typeof id!=='string'||!id||typeof install!=='function'||mapFeatures.has(id))throw new Error('Invalid or duplicate MapLibre feature: '+id);
  const owner=installManagedMapLibreFeature(map,install),record={install,owner,layers:owner.layers};
  mapFeatures.set(id,record);
  try{frame.suspendOptionalLayersIfHeld();}
  catch(error){mapFeatures.delete(id);try{owner.dispose();}catch(cleanupError){error.rollbackError=cleanupError;}throw error;}
  return ()=>{if(mapFeatures.get(id)!==record)return;mapFeatures.delete(id);record.owner.dispose();};
 }
 function restoreFeatures(){
  for(const [id,record]of mapFeatures){
   if(!record.layers.some(layer=>!map.getLayer(layer)))continue;
   try{record.owner.dispose();record.owner=installManagedMapLibreFeature(map,record.install);record.layers=record.owner.layers;}
   catch(error){mapFeatures.delete(id);deps.feedback.reportOperationError(error,'추가 지도 기능을 복원하지 못했습니다.','PL-MAPLIBRE-OPTIONAL-001');}
  }
 }
 const rgba=(color,alpha=1)=>{const rgb=deps.platform.d3.rgb(color);return [rgb.r/255,rgb.g/255,rgb.b/255,alpha];};
 function objectKeyRef(objectKey){
  if(!objectKey)return null;
  const [domain,type,...id]=objectKey.split(':');
  return normalizeObjectRef({domain,type,id:decodeURIComponent(id.join(':'))});
 }
 function mapSourceLayers(){return scene.mapSourceLayers();}
 function requiredSource(id){return scene.requiredSource(id);}
 function syncVectorGroups(){return scene.syncVectorGroups();}
 function orderSceneLayers(){return scene.orderSceneLayers();}
 function syncCountryPaint(id,rows){return scene.syncCountryPaint(id,rows);}
 function syncBaseLayer(){return scene.syncBaseLayer();}
 function strokeDomain(...args){return scene.strokeDomain(...args);}
 function setSceneDomains(domains){return scene.setSceneDomains(domains);}
 function setInteractionStyle(value){return scene.setInteractionStyle(value);}
 const currentMapStyle=()=>scene.getStyle();
 const colorsEnabled=()=>scene.colorsEnabled();
 const stats={renderedFrames:0,preservedFrameCopies:0,sourceUpdates:0,sourceWrites:0,hydroVisibilityScans:0,geometryWorkerRequests:0,geometryWorkerTransferBytes:0,retainedSourceHits:0,boundaryRequests:0,boundaryGeometryRows:0,boundaryCacheMisses:0,approvalAttempts:0,renderer:'maplibre',firstCanonicalFrameMs:null,physicalLandPreparations:0,physicalLandPreparationMs:0,physicalLandAssetHits:0,strokePreparedPackets:0};
 const invalidate=reason=>deps.domains.renderingDomain?.invalidateView(reason);
 const datedSources=createMapLibreDatedSources({getMap:()=>map,sourceLayers:SOURCE_LAYERS,sourceLayer,mapSourceLayers,
  createCountrySource:countryTileSource,createEmptySource:()=>({type:'geojson',data:empty()}),
  invalidateLayerIndex:()=>scene.invalidateLayerIndex(),dirty,
  canRetire:()=>styleReady()&&!frame.temporalPending()&&!frame.zoomPending&&!map.isMoving(),
  temporalPending:()=>frame.temporalPending()});
 const sourceWrites=createMapLibreSourceWrites({getMap:()=>map,getGeneration:()=>frame.generation,getContextRevision:()=>frame.contextRevision,
  isDisposed:()=>disposed,requiredSource:id=>requiredSource(id),dirty,onError:failMapPreparation,
  track:(name,submit)=>metrics.track(name,()=>{stats.sourceWrites++;return submit();})});
 const scene=createMapLibreSceneController({getMap:()=>map,isLoaded:()=>loaded,isStyleReady:styleReady,isDisposed:()=>disposed,
 isTemporalOverlay:()=>frame.hasOverlay,isInitialMapLoading:()=>frame.initialMapLoading,getPolarLayer:()=>polarDisplay.layer,getHighlight:()=>selection,
 isPhysicalPending:kind=>physicalBase.isPending(kind),
 getPhysicalGeometry:()=>geometryClient.physicalGeometry(deps.physicalResources.physicalLand?.revision),
 getExternalBasemap:()=>externalBasemap,getSelectionSnapshot:()=>selection.snapshot,setSelection,
 invalidatePickingLayers:()=>selection.invalidateLayers(),preferences:deps.preferences,state,datedSources,sourceWrites,
 sourceLayer,sourceGroups:SOURCE_LAYERS,dirty,invalidate,failMapPreparation,feedback:deps.feedback});
 const physicalBase=createMapLibrePhysicalBase({getMap:()=>map,getGeneration:()=>frame.generation,isDisposed:()=>disposed,
 isContextReady:styleReady,isTemporalPending:()=>frame.temporalPending(),
 physicalResources:deps.physicalResources,datedSources,sourceWrites,setData,preparePhysicalDisplay,orderSceneLayers,
 dirty,invalidate,failMapPreparation,getStats:()=>stats});
 const {syncPhysicalContext}=physicalBase;
 const hydroDisplay=createMapLibreHydroDisplay({state,physicalResources:deps.physicalResources,physicalServices:deps.physicalServices,
 physicalConfig:deps.physicalConfig,preferences:deps.preferences,platform:deps.platform,feedback:deps.feedback,
 getMap:()=>map,getProjection:()=>projection,getPresentation:()=>frame,initialize,styleReady,isDisposed:()=>disposed,
 isZoomFramePending:()=>frame.zoomPending,getBasemapRecovery:()=>frame.basemapRecovery,getSelectionSnapshot:()=>selection.snapshot,setSelection,
 sourceWrites,setData,strokeDomain,metrics,getStats:()=>stats,invalidate});
 const {setHydroManifest,syncHydroState,refreshHydroDetail}=hydroDisplay;
 const polarDisplay=createMapLibrePolarDisplay({getMap:()=>map,isStyleReady:styleReady,prepareRenderGeometry,getGeneration:()=>frame.generation,
 dirty,invalidate,failMapPreparation,getMapStyle:currentMapStyle,physicalResources:deps.physicalResources,countryDisplay,state,
 isColorsEnabled:colorsEnabled,isInitialMapLoading:()=>frame.initialMapLoading,getPalette:()=>deps.preferences.mapPalette(),
 hydro:hydroDisplay,getSceneKey:()=>scene.key,getSceneVectors:()=>scene.vectors,getPickBounds:geometry=>selection.pickBounds(geometry),
 resolveObjectKey:objectKeyRef,isHydroFeatureVisible:feature=>deps.physicalServices.isHydroFeatureVisible(feature),rgba});
 const {ensurePolar}=polarDisplay;

 function sourceLayer(id,source){
  return map.getLayer(id)?.source===source?id:id+'--'+source;
 }
 function dirty(){frame.dirty();}
 function failMapPreparation(cause){frame.failMapPreparation(cause);}
 function retryMapPreparation(){frame.retryMapPreparation();}
 function preserveTemporalFrame(){frame.preserveTemporalFrame();}
 function releaseTemporalFrame(){frame.releaseTemporalFrame();}
 function setData(id,data,isCurrent,options){return sourceWrites.update(source=>source.setData(data),id,isCurrent,options);}
 function attach(mapElement){
  if(container)return;
  container=document.createElement('div');container.className='maplibre-map-surface';
  Object.assign(container.style,{position:'absolute',inset:'0'});
  mapElement.prepend(container);
 }
 async function initialize(){
  if(initialization)return initialization;
  initialization=(async()=>{
   if(!container)throw new Error('MapLibre map surface is missing.');
   frame.notify('loading','지도 불러오는 중');
   const vendor=new URL('assets/vendor/maplibre-gl/',document.baseURI);
   stylesheet=document.createElement('link');stylesheet.rel='stylesheet';stylesheet.href=new URL('maplibre-gl.css',vendor);document.head.append(stylesheet);
   const vendorModuleUrl=new URL('maplibre-gl.mjs',vendor).href;
   api=await import(vendorModuleUrl);
   if(disposed)return false;
   api.setWorkerUrl(new URL('maplibre-gl-worker.mjs',vendor).href);
   const initialStyle=currentMapStyle();
   const hydroStyle=hydroDisplay.initialStyle({antiAlias:scene.interactionStyle?.antiAlias!==false,stylePaint:initialStyle.paint});
   // MapLibre can draw a default-camera frame before its load event.
   if(initialCamera)container.style.visibility='hidden';
   // Draw native symbol placement with the tile's first frame so a published
   // camera frame and its visible labels share the same approval.
   map=new api.Map({container,trackResize:false,attributionControl:false,interactive:true,fadeDuration:0,canvasContextAttributes:{preserveDrawingBuffer:true},dragRotate:false,pitchWithRotate:false,
    center:[-state.view.globeRotation[0],-state.view.globeRotation[1]],...(Number.isFinite(state.view.zoom)?{zoom:state.view.zoom}:{}),
    style:{version:8,projection:{type:'globe'},sources:{
     'physical-land':{type:'geojson',data:empty()},'physical-water':{type:'geojson',data:empty()},
     territories:countryTileSource(),...hydroStyle.sources,
    },layers:[{id:'ocean',type:'background',paint:initialStyle.paint.ocean},
     {id:'physical-land-fill',type:'fill',source:'physical-land',paint:initialStyle.paint['physical-land-fill']},
     {id:'territories',type:'fill',source:'territories',filter:countryFillFilter(0),layout:{'fill-sort-key':['get','paintOrder']},paint:initialStyle.paint.territories},
     {id:'physical-water',type:'fill',source:'physical-water',paint:initialStyle.paint['physical-water']},
     ...hydroStyle.layers,
     {id:'borders',type:'line',source:'territories',filter:['==',['get','displayRole'],'country-border'],
      layout:{'line-cap':'round','line-join':'round'},paint:initialStyle.paint.borders},
    ]}});
   camera.captureNativeMinZoom();
   scene.attachMap();
   projection=createMapLibreProjection(map);
   map.on('styledata',()=>{scene.invalidateLayerIndex();});
   map.on('style.load',()=>{
    hydroDisplay.resetStyle();
    if(loadedStyle!==map.style)selection.onStyleChanged();
    loadedStyle=map.style;
    if(loaded&&!disposed){restoreFeatures();flushStyleChanges();refreshHydroDetail();}
   });
   frame.attachMap();
   await new Promise((resolve,reject)=>{map.once('load',resolve);map.once('error',event=>reject(event.error));});
   const startupView=await initialCamera;
   if(disposed)return false;
   const initialView=state.view;
   loaded=true;
   frame.styleAvailable();scene.applyStyle(currentMapStyle(),{updateVisibility:false});
   if(initialCamera)map.resize();
   const initialInsets=readSafeInsets('startup-camera');
   refreshWorldFit(initialInsets);
   if(initialCamera){
    if(startupView)syncCameraFromState(startupView);
    else fitMapBounds(WORLD_VIEW_BOUNDS,initialInsets);
    frame.syncInitialMapSkeleton();
    map.once('render',()=>container.style.removeProperty('visibility'));
    map.triggerRepaint();
   }
   camera.attachMovement();
   if(!initialCamera){
    if(camera.hasPendingFit())applyCameraFit();else syncCameraFromState(initialView);
   }
   window.__PANDOLAB_MAPLIBRE__=map;
   return true;
  })();
  initialization.catch(failMapPreparation);return initialization;
 }
 const country=createMapLibreCountryController({getMap:()=>map,getGeneration:()=>frame.generation,isDisposed:()=>disposed,
  styleReady,isFrameBlocked:()=>frame.blocked,getBasemapRecovery:()=>frame.basemapRecovery,waitForStyle:signal=>frame.waitForStyle(signal),
  isTemporalPending:()=>frame.temporalPending(),initialize,getEntityRepository:()=>deps.territorialModel.entityRepository,
  state,layerPresentation:deps.layerPresentation,currentMapStyle,geometryClient,countryDisplay,datedSources,
  sourceLayer,sourceLayers:SOURCE_LAYERS.territories,countryTileSource,scene,sourceWrites,setData,metrics,stats,dirty,prepareCountryBorders});
 function setTerritorialFeatures(features){return country.setTerritorialFeatures(features);}
 const selection=createMapLibreSelection({getMap:()=>map,state,styleReady,ensurePolar,setData,orderSceneLayers,metrics,invalidate,
 feedback:deps.feedback,suppressHover:frameSuppressHover,objectRefVisible:ref=>deps.objectRefVisible(ref),
 getTerritory:id=>deps.territorialModel.entityRepository.get(id),getHydroFeature:id=>deps.hydroModel.hydroFeatureById(id),
 getInteractionStyle:()=>scene.interactionStyle,rgba,pickingPorts:{
 getMap:()=>map,getProjection:()=>projection,getTerritories:()=>country.features,
 getHydroFeatures:()=>state.hydroFeatureCache.values(),getPolarLines:()=>polarDisplay.visibleLines,getVectorRole:source=>scene.vectorRole(source),
 canPick:()=>loaded&&!frame.isFramePreserved(),canPickHydro:(...args)=>hydroDisplay.canPick(...args),
 containsGeometry:(...args)=>deps.containsGeometry(...args),isHydroFeatureVisible:feature=>deps.physicalServices.isHydroFeatureVisible(feature),
 mapSourceLayers,sourceLayer,datedSources,requiredSource,objectKeyRef}});
 const {queryObjectRefs}=selection;
 function setSelection(snapshot){selection.setSelection(snapshot);}
 function frameSuppressHover(){return frame.suppressHover();}
 const frame=createMapLibreFrameController({getMap:()=>map,getContainer:()=>container,isLoaded:()=>loaded,isDisposed:()=>disposed,
  isStyleReady:styleReady,isStyleCurrent:()=>loadedStyle===map.style,state,metrics,stats,invalidate,
  presentMapPreparation,onMapPreparationStatus,camera,scene,selection,physicalBase,polarDisplay,physicalResources:deps.physicalResources,
  sourceWrites,datedSources,getExternalBasemap:()=>externalBasemap,flushStyleChanges,feedback:deps.feedback,renderQuality:deps.renderQuality,rgba,
  getCountryStatus:country.status});
 function invalidateCountryColors(){
  if(!styleReady()){pendingCountryPaint=true;return;}
  syncCountryPaint(datedSources.active('territories'),countryDisplay.rows);
  dirty();invalidate('country-paint');
 }
 function invalidateStyle(){if(loaded&&!styleReady()){pendingStyleRefresh=true;return;}if(loaded){
  setTerritorialFeatures(country.features).catch(failMapPreparation);
  hydroDisplay.invalidateVisibility();syncHydroState();syncBaseLayer();
  if(frame.initialMapLoading)frame.syncInitialMapSkeleton();
  dirty();
 }invalidate('map-paint');}
 return Object.freeze({registerFeature,previewExternalBasemap,cameraSnapshot:camera.cameraSnapshot,setInitialMapLoading:frame.setInitialMapLoading,attach,initialize,setTerritorialFeatures,setSceneDomains,setSelection,queryObjectRefs,getPickingRevision:()=>frame.sourceRevision,syncCameraFromState,syncPhysicalContext,syncHydroState,
 get map(){return map;},get projection(){return projection;},get loaded(){return loaded;},isStyleReady:styleReady,renderFrame:frame.renderFrame,commitVisualFrame:frame.commitVisualFrame,measureWork:metrics.track,measureSyncWork:metrics.run,
  panBy:camera.panBy,fitGeometry:camera.fitGeometry,
  fitMapBounds,fitWorld:camera.fitWorld,isAtWorldView,
  canPresentVisualFrame:frame.canPresentVisualFrame,prepareTemporalCountrySource:frame.prepareTemporalCountrySource,
  beginTemporalViewTransition:frame.beginTemporalViewTransition,admitTemporalViewTransition:frame.admitTemporalViewTransition,
  preserveTemporalFrame,releaseTemporalFrame,isFramePreserved:frame.isFramePreserved,
  finishTemporalViewTransition:frame.finishTemporalViewTransition,
  waitForTemporalPresentation:frame.waitForTemporalPresentation,waitForMapPresentation:frame.waitForMapPresentation,
  getProjectGeneration:()=>frame.generation,
  resetProjectRenderState(options){
   frame.prepareProjectReset(options);
   if(options.presentation!=='temporal')hydroDisplay.resetProject();
   borders.reset();geometryClient.reset();physicalBase.resetProject();polarDisplay.resetProject();selection.reset();
   scene.resetPendingDomains();sourceWrites.reset();
   country.reset();frame.resetForProject(options);
  },
  labelZoomVisibility,
  getRuntimeState:()=>({...stats,...frame.runtimeState(),physicalContextRevision:physicalBase.revision}),
  getStats:()=>({...stats,...frame.stats(),datedSources:{territories:datedSources.active('territories'),land:datedSources.active('physical-land'),water:datedSources.active('physical-water')},
   performance:metrics.snapshot(),polar:polarDisplay.stats(),highlight:selection.stats(),hydro:hydroDisplay.stats,
   projectReplacing:!!state.projectReplacing,hydroFeatureCount:hydroDisplay.features.length,labelLayout:deps.countryLabelModel.labelLayoutMetrics,mapMoving:state.mapMoving}),
  setHydroManifest,
  invalidateCountryColors,invalidateCountryPalette:invalidateStyle,invalidatePhysicalStyle:invalidateStyle,
  invalidateHydroVisibility(){refreshHydroDetail();if(loaded&&!styleReady()){pendingStyleRefresh=true;return;}if(loaded){syncHydroState();dirty();}invalidate('hydro-visibility');},
  setRenderQuality(value){quality=value;if(map&&value?.dprCap&&Math.abs(map.getPixelRatio()-value.dprCap)>1e-9)map.setPixelRatio(value.dprCap);},
  setInteractionStyle,
  getRenderPixelRatio:()=>quality?.dprCap||window.devicePixelRatio||1,
  verifyLayout:()=>camera.verifyLayout(syncBaseLayer),failMapPreparation,retryMapPreparation,
  dispose(){if(disposed)return;disposed=true;frame.dispose();camera.dispose();datedSources.cancelRetirement();country.dispose();geometryClient.dispose();selection.dispose();polarDisplay.dispose();externalBasemap?.dispose();if(externalAttribution)map?.removeControl(externalAttribution);externalAttribution=null;for(const record of mapFeatures.values()){try{record.owner.dispose();}catch(cause){deps.feedback.reportOperationError(cause,'추가 지도 기능을 정리하지 못했습니다.','PL-MAPLIBRE-OPTIONAL-001');}}mapFeatures.clear();hydroDisplay.dispose();physicalBase.dispose();scene.dispose();map?.remove();if(window.__PANDOLAB_MAPLIBRE__===map)delete window.__PANDOLAB_MAPLIBRE__;stylesheet?.remove();container?.remove();},
 });
}
