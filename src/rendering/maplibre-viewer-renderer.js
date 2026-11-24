import {createMapLibrePolarDisplay} from './maplibre-polar-display.js';
import {createMapLibreSceneController} from './maplibre-scene-controller.js';
import {createTerritorialEntityRepository} from '../document/territorial-entity-repository.js';
import {createMapLibreProjection} from './maplibre-projection.js';
import {installManagedMapLibreFeature} from './maplibre-feature-lifecycle.js';
import {createExternalBasemap} from './maplibre-external-style.js';
import {createMapPresentationSession} from './map-presentation-session.js';
import {normalizeObjectRef} from '../document/object-ref-identity.js';
import {admittedGeometryKey as geometryKey,geometryReferenceFor} from '../geometry/geometry-version-store.js';
import {countryDefaultColor} from '../ui/color-adapter.js';
import {createMapLibreGeometryClient} from './maplibre-geometry-client.js';
import {createMapLibreCountryBorders} from './maplibre-country-borders.js';
import {prepareCountryPresentation,countryPaintOnly,countryTileDiff} from './maplibre-country-presentation.js';
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
  onFarJump:()=>{if(camera.hasPresented()&&!state.projectReplacing&&!contextLost){preserveDisplayedFrame();zoomFramePending=true;ready=false;preparedReady=false;}},
  onMove:({userInitiated,largeJump,farFromPresented,applying,hasPresented})=>{
   if(userInitiated&&zoomFramePending&&!initialMapLoading&&!initialFrameStaging){zoomFramePending=false;discardUnusedPreservedFrame();}
   if(largeJump&&!userInitiated&&!zoomFramePending&&(!state.projectReplacing||initialMapLoading)&&farFromPresented){
    if(initialMapLoading){initialZoomHidden=true;map.getCanvas().style.visibility='hidden';}
    else if(hasPresented)preserveDisplayedFrame();
    zoomFramePending=true;
   }
   if(zoomFramePending){ready=false;preparedReady=false;}
   if(!applying&&!state.projectReplacing)invalidate('maplibre-camera');
  },
  onMoveStart:()=>{previousActiveRender=null;selection.onCameraChange();deps.domains.renderingDomain?.beginInteraction('maplibre-move');},
  onMoveEnd:()=>{previousActiveRender=null;selection.onCameraChange();deps.domains.renderingDomain?.endInteraction('maplibre-move-end');datedSources.scheduleRetirement();}});
 const {fitMapBounds,refreshWorldFit,applyCameraFit,isAtWorldView,labelZoomVisibility,jumpCamera,syncCameraFromState}=camera;
 let map,api,projection,container,stylesheet,initialization,loadedStyle=null,disposed=false,loaded=false,generation=0,contextRevision=0,contextLost=false;

 let sourceRevision=0,certifiedRevision=-1,certifiedGeneration=-1,certifiedContext=-1,certifiedCamera='',pendingFrame=null,ready=false,preparedReady=false,error=null,countryGeneration=-1,countryContentKey='';
 let requestedCertificate=null,previousActiveRender=null;
 let endSourceFrame=null;
 let territories=[];
  let quality=null;
 let acceptedCountryInputs=null;
 const countryDisplay=createMapLibreCountryDisplay();
 let countrySequence=0,countryTail=Promise.resolve();
 const activeCountryTasks=new Set();
 let countryGeometryAbort=null;
 const geometryClient=createMapLibreGeometryClient({runtimeAssetUrl:path=>deps.platform.runtimeAssetUrl(path),isDisposed:()=>disposed,getGeneration:()=>generation,onRestart:()=>{borders.reset();},getStats:()=>stats,metrics});
 const {preparePhysicalDisplay,prepareRenderGeometry}=geometryClient;
 const borders=createMapLibreCountryBorders({getBoundaryGeometry:()=>countryDisplay.borders,prepareRenderGeometry,metrics,getStats:()=>stats});
 const {prepareCountryBorders}=borders;

 const mapFeatures=new Map();
 let externalBasemap=null,externalAttribution=null,basemapRecovery=null;
 let pendingStyleRefresh=false,pendingCountryPaint=false;
 const styleReady=()=>loaded&&!contextLost&&!basemapRecovery&&!!map&&loadedStyle===map.style;
 function flushStyleChanges(){
  if(!styleReady())return;
  scene.flushPendingInteractionStyle();
  if(pendingStyleRefresh){pendingStyleRefresh=false;invalidateStyle();}
  if(pendingCountryPaint){pendingCountryPaint=false;invalidateCountryColors();}
  scene.flushPendingDomains();
  selection.flushPending();
  invalidate('map-paint-ready');
 }
 async function previewExternalBasemap(style){
  if(disposed||!loaded||presentation.temporalPending()||temporalOverlay)throw new Error('The map is not available for a basemap change.');
  for(const layer of style?.layers||[])if(map.getLayer(layer.id))throw new Error('Basemap layer collision: '+layer.id);
  externalBasemap ||=createExternalBasemap(map,{getRevision:()=>JSON.stringify([generation,contextRevision,sourceRevision,presentation.temporalPending(),temporalFrameHeld]),onChange:()=>{syncVectorGroups();dirty();invalidate('external-basemap-change');},onRemoveStart:preserveTemporalFrame,onRemoveEnd:()=>{if(!presentation.temporalPending())releaseTemporalFrame();},onCancelled:()=>{if(externalAttribution){map.removeControl(externalAttribution);externalAttribution=null;}},onFailure:(cause,{removed})=>{
   if(removed&&externalAttribution){map.removeControl(externalAttribution);externalAttribution=null;}
   deps.feedback.reportOperationError(cause,'외부 배경 지도를 불러오지 못했습니다.','PL-BASEMAP-001');
  }});
  let remove;preserveTemporalFrame();
  try{remove=await externalBasemap.install(style);}catch(cause){if(cause.name!=='AbortError')deps.feedback.reportOperationError(cause,'외부 배경 지도를 불러오지 못했습니다.','PL-BASEMAP-001');throw cause;}finally{if(!presentation.temporalPending())releaseTemporalFrame();}
  if(disposed){await remove();throw new Error('The map was disposed during basemap installation.');}
  const attribution=new api.AttributionControl({compact:true});externalAttribution=attribution;map.addControl(attribution);
  return async()=>{if(externalAttribution!==attribution)return;await remove();if(externalAttribution===attribution){map.removeControl(attribution);externalAttribution=null;}};
 }
 function registerFeature(id,install){
  if(disposed||!loaded||typeof id!=='string'||!id||typeof install!=='function'||mapFeatures.has(id))throw new Error('Invalid or duplicate MapLibre feature: '+id);
  const owner=installManagedMapLibreFeature(map,install),record={install,owner,layers:owner.layers};
  mapFeatures.set(id,record);
  try{if(temporalFrameHeld)suspendOptionalLayers();}
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
 let initialMapLoading=false,initialFrameStaging=null;
 let temporalOverlay=null,temporalInteractions=[],temporalOptionalLayers=[];
 let temporalFrameHeld=false,projectFrameHeld=false,zoomFramePending=false,initialZoomHidden=false;
 function suspendOptionalLayers(){
  for(const layer of map.getStyle()?.layers||[]){
   if(!layer.source||requiredSource(layer.source)||selection.owns(layer.source)||datedSources.has(layer.source)||layer.source==='hydro'||layer.layout?.visibility==='none'||temporalOptionalLayers.some(item=>item.id===layer.id))continue;
   temporalOptionalLayers.push({id:layer.id,visibility:map.getLayoutProperty(layer.id,'visibility')});
   map.setLayoutProperty(layer.id,'visibility','none');
  }
 }
 function preserveDisplayedFrame(){
  if(temporalOverlay)return;
  const source=map.getCanvas(),stage=container.parentNode;
  const overlay=document.createElement('div');
  overlay.dataset.mapPreservedFrame='';
  Object.assign(overlay.style,{position:'absolute',inset:'0',zIndex:'10',overflow:'hidden',pointerEvents:'none'});
  const snapshot=document.createElement('canvas');snapshot.width=source.width;snapshot.height=source.height;
  Object.assign(snapshot.style,{position:'absolute',inset:'0',width:'100%',height:'100%'});
  const context=snapshot.getContext('2d');
  if(!context)throw new Error('Cannot preserve the displayed map frame.');
  context.drawImage(source,0,0);stats.preservedFrameCopies++;overlay.append(snapshot);
  stage.append(overlay);temporalOverlay=overlay;
 }
 function discardUnusedPreservedFrame(){
  if(!disposed&&(temporalFrameHeld||projectFrameHeld||zoomFramePending||initialFrameStaging))return;
  temporalOverlay?.remove();temporalOverlay=null;
 }
 function preserveTemporalFrame(){
  if(temporalFrameHeld)return;
  preserveDisplayedFrame();temporalFrameHeld=true;
  // Preserve the previous vector frame until the newly dated sources render.
  suspendOptionalLayers();
  temporalInteractions=['dragPan','scrollZoom','boxZoom','doubleClickZoom','touchZoomRotate','keyboard']
   .map(name=>map[name]).filter(handler=>handler?.isEnabled());
  for(const handler of temporalInteractions)handler.disable();
 }
 function releaseTemporalFrame(){temporalFrameHeld=false;discardUnusedPreservedFrame();for(const layer of temporalOptionalLayers)if(map?.getLayer(layer.id)&&map.getLayoutProperty(layer.id,'visibility')==='none')map.setLayoutProperty(layer.id,'visibility',layer.visibility);temporalOptionalLayers=[];for(const handler of temporalInteractions)handler.enable();temporalInteractions=[];}
 function syncInitialMapSkeleton(){
  if(!loaded||!scene.hasStyleController())return;
  const style=currentMapStyle(),{paint}=style;
  positionPolarLayer();
  const before=initialMapLoading&&polarDisplay.layer&&map.getLayer(polarDisplay.layer.id)?polarDisplay.layer.id:undefined;
  scene.syncLoadingSurface(style,initialMapLoading,before);
  polarDisplay.layer?.setLoadingSurface(initialMapLoading?{
   ocean:rgba(paint['initial-map-ocean']['background-color']),
   land:rgba(paint['initial-map-land']['fill-color']),
  }:null);
  syncLabelVisibility();
 }
 function syncLabelVisibility(){
  if(styleReady()&&scene.syncLabelVisibility(initialMapLoading))dirty();
 }

 const rgba=(color,alpha=1)=>{const rgb=deps.platform.d3.rgb(color);return [rgb.r/255,rgb.g/255,rgb.b/255,alpha];};
 function objectKeyRef(objectKey){
  if(!objectKey)return null;
  const [domain,type,...id]=objectKey.split(':');
  return normalizeObjectRef({domain,type,id:decodeURIComponent(id.join(':'))});
 }
 function mapSourceLayers(){return scene.mapSourceLayers();}
 function requiredSource(id){return scene.requiredSource(id);}
 function requiredSourcesReady(){return scene.requiredSourcesReady();}
 function syncVectorGroups(){return scene.syncVectorGroups();}
 function orderSceneLayers(){return scene.orderSceneLayers();}
 function syncTerritorialFills(source,batches){return scene.syncTerritorialFills(source,batches);}
 function syncCountryPaint(id,rows){return scene.syncCountryPaint(id,rows);}
 function syncBaseLayer(){return scene.syncBaseLayer();}
 function strokeDomain(...args){return scene.strokeDomain(...args);}
 function setSceneDomains(domains){return scene.setSceneDomains(domains);}
 function setInteractionStyle(value){return scene.setInteractionStyle(value);}
 const currentMapStyle=()=>scene.getStyle();
 const colorsEnabled=()=>scene.colorsEnabled();
 const stats={renderedFrames:0,preservedFrameCopies:0,sourceUpdates:0,sourceWrites:0,hydroVisibilityScans:0,geometryWorkerRequests:0,geometryWorkerTransferBytes:0,retainedSourceHits:0,boundaryRequests:0,boundaryGeometryRows:0,boundaryCacheMisses:0,approvalAttempts:0,renderer:'maplibre',firstCanonicalFrameMs:null,physicalLandPreparations:0,physicalLandPreparationMs:0,physicalLandAssetHits:0,strokePreparedPackets:0};
 const invalidate=reason=>deps.domains.renderingDomain?.invalidateView(reason);
 const cameraKey=camera.cameraKey;
 const datedSources=createMapLibreDatedSources({getMap:()=>map,sourceLayers:SOURCE_LAYERS,sourceLayer,mapSourceLayers,
  createCountrySource:countryTileSource,createEmptySource:()=>({type:'geojson',data:empty()}),
  invalidateLayerIndex:()=>scene.invalidateLayerIndex(),dirty,
  canRetire:()=>styleReady()&&!presentation.temporalPending()&&!zoomFramePending&&!map.isMoving(),
  temporalPending:()=>presentation.temporalPending()});
 const sourceWrites=createMapLibreSourceWrites({getMap:()=>map,getGeneration:()=>generation,getContextRevision:()=>contextRevision,
  isDisposed:()=>disposed,requiredSource:id=>requiredSource(id),dirty,onError:failMapPreparation,
  track:(name,submit)=>metrics.track(name,()=>{stats.sourceWrites++;return submit();})});
 const scene=createMapLibreSceneController({getMap:()=>map,isLoaded:()=>loaded,isStyleReady:styleReady,isDisposed:()=>disposed,
 isTemporalOverlay:()=>!!temporalOverlay,isInitialMapLoading:()=>initialMapLoading,getPolarLayer:()=>polarDisplay.layer,getHighlight:()=>selection,
 isPhysicalPending:kind=>physicalBase.isPending(kind),
 getPhysicalGeometry:()=>geometryClient.physicalGeometry(deps.physicalResources.physicalLand?.revision),
 getExternalBasemap:()=>externalBasemap,getSelectionSnapshot:()=>selection.snapshot,setSelection,
 invalidatePickingLayers:()=>selection.invalidateLayers(),preferences:deps.preferences,state,datedSources,sourceWrites,
 sourceLayer,sourceGroups:SOURCE_LAYERS,dirty,invalidate,failMapPreparation,feedback:deps.feedback});
 const physicalBase=createMapLibrePhysicalBase({getMap:()=>map,getGeneration:()=>generation,isDisposed:()=>disposed,
 isContextReady:()=>loaded&&!contextLost&&!basemapRecovery&&loadedStyle===map.style,isTemporalPending:()=>presentation.temporalPending(),
 physicalResources:deps.physicalResources,datedSources,sourceWrites,setData,preparePhysicalDisplay,orderSceneLayers,
 dirty,invalidate,failMapPreparation,getStats:()=>stats});
 const {syncPhysicalContext}=physicalBase;
 const hydroDisplay=createMapLibreHydroDisplay({state,physicalResources:deps.physicalResources,physicalServices:deps.physicalServices,
 physicalConfig:deps.physicalConfig,preferences:deps.preferences,platform:deps.platform,feedback:deps.feedback,
 getMap:()=>map,getProjection:()=>projection,getPresentation:()=>presentation,initialize,styleReady,isDisposed:()=>disposed,
 isZoomFramePending:()=>zoomFramePending,getBasemapRecovery:()=>basemapRecovery,getSelectionSnapshot:()=>selection.snapshot,setSelection,
 sourceWrites,setData,strokeDomain,metrics,getStats:()=>stats,invalidate});
 const {setHydroManifest,syncHydroState,refreshHydroDetail,cancelHydroStartup}=hydroDisplay;
 const polarDisplay=createMapLibrePolarDisplay({getMap:()=>map,isStyleReady:styleReady,prepareRenderGeometry,getGeneration:()=>generation,
 dirty,invalidate,failMapPreparation,getMapStyle:currentMapStyle,physicalResources:deps.physicalResources,countryDisplay,state,
 isColorsEnabled:colorsEnabled,isInitialMapLoading:()=>initialMapLoading,getPalette:()=>deps.preferences.mapPalette(),
 hydro:hydroDisplay,getSceneKey:()=>scene.key,getSceneVectors:()=>scene.vectors,getPickBounds:geometry=>selection.pickBounds(geometry),
 resolveObjectKey:objectKeyRef,isHydroFeatureVisible:feature=>deps.physicalServices.isHydroFeatureVisible(feature),rgba});
 const {ensurePolar,positionPolarLayer,syncPolar,syncPolarLines}=polarDisplay;

 function sourceLayer(id,source){
  return map.getLayer(id)?.source===source?id:id+'--'+source;
 }
 const notify=(status,label)=>{
  const value={status,label,retry:status==='error',mapReady:ready};
  presentMapPreparation?.(value,{retry:()=>retryMapPreparation()});
  onMapPreparationStatus?.(value,generation);
 };
 const presentation=createMapPresentationSession({getGeneration:()=>generation,getContextRevision:()=>contextRevision,
  isDisposed:()=>disposed,getReadiness:()=>({mapReady:preparedReady}),invalidateFrame:invalidate,
  prepareContentKey:async features=>features.map(feature=>String(feature.id)+':'+geometryKey(feature.geometry)).join('|'),isProjectBlocked:()=>!!error,
  isRecoveryFrameAdmissible:()=>!error&&loaded&&!contextLost,
  onTemporalRetired:()=>{if(presentation.ticket?.presented)releaseTemporalFrame();},
  waitForCanonicalFrame:()=>presentation.waitForMapPresentation(generation)});
 function dirty(){
  sourceRevision++;ready=false;preparedReady=false;stats.sourceUpdates++;
  endSourceFrame??=metrics.begin('source-to-render');
 }
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
   notify('loading','지도 불러오는 중');
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
   map.on('webglcontextlost',()=>{contextRevision++;sourceWrites.reset();physicalBase.resetContext();contextLost=true;ready=false;preparedReady=false;certifiedRevision=-1;notify('loading','지도 복구 중');});
   map.on('webglcontextrestored',()=>{
    const restore=()=>{if(disposed)return;scene.applyStyle(currentMapStyle(),{updateVisibility:!temporalOverlay});syncVectorGroups();polarDisplay.resetContext();selection.reset({restore:true});contextLost=false;certifiedRevision=-1;dirty();flushStyleChanges();invalidate('map-context-restored');};
    if(loadedStyle===map.style)restore();else map.once('style.load',restore);
   });
   map.on('error',event=>{if(event.error?.name==='AbortError')return;
    if(event.error&&sourceWrites.handlesError(event.error))return;
    if(event.sourceId&&externalBasemap?.ownsSource(event.sourceId))return;if(event.sourceId==='viewer-labels')return;
    if(event.sourceId&&map.getSource(event.sourceId)&&!requiredSource(event.sourceId)){
     deps.feedback.reportOperationError(event.error||new Error('Optional source failed: '+event.sourceId),'추가 지도 자료를 불러오지 못했습니다.','PL-MAPLIBRE-OPTIONAL-001');return;
    }
    failMapPreparation(event.error||new Error('MapLibre render failed.'));
   });
   map.on('render',()=>{
    stats.renderedFrames++;
    requestedCertificate=null;
    if(loaded&&!contextLost)selection.onRender();

    const requiredReady=loaded&&!error&&!contextLost&&!polarDisplay.pending&&!sourceWrites.pendingCount()&&requiredSourcesReady();
    const sampled=requiredReady&&!document.hidden&&map.isMoving()?performance.now():null;
    if(sampled!==null&&previousActiveRender!==null&&deps.renderQuality?.renderQualityController.recordFrame(0,{frameIntervalMs:sampled-previousActiveRender}))
     deps.renderQuality.queueAdaptiveRenderQualityRefresh('maplibre-frame-cadence');
    previousActiveRender=sampled;
    if(!requiredReady)return;
    certifiedRevision=sourceRevision;certifiedGeneration=generation;certifiedContext=contextRevision;certifiedCamera=cameraKey();
    endSourceFrame?.();endSourceFrame=null;
    if(pendingFrame)invalidate('maplibre-presented');
   });
   await new Promise((resolve,reject)=>{map.once('load',resolve);map.once('error',event=>reject(event.error));});
   const startupView=await initialCamera;
   if(disposed)return false;
   const initialView=state.view;
   loaded=true;
   scene.applyStyle(currentMapStyle(),{updateVisibility:false});
   if(initialCamera)map.resize();
   const initialInsets=readSafeInsets('startup-camera');
   refreshWorldFit(initialInsets);
   if(initialCamera){
    if(startupView)syncCameraFromState(startupView);
    else fitMapBounds(WORLD_VIEW_BOUNDS,initialInsets);
    syncInitialMapSkeleton();
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
 function setTerritorialFeatures(features){
  const entities=deps.territorialModel.entityRepository.list?.()??features;
  const countryStyle=currentMapStyle();
  const inputs={entities,features,generation,source:map?.getSource(datedSources.active('territories')),
   presentation:state.layerPresentation,visibility:state.itemVisibility?.objects,
   visible:state.layerVisibility.objects,stroke:JSON.stringify([countryStyle.countryStroke,countryStyle.borderAlpha])};
  const accepted=acceptedCountryInputs;
  const immutable=rows=>rows.every(row=>Object.isFrozen(row)&&Object.isFrozen(row.properties)&&geometryReferenceFor(row.geometry));
  // The country tiles consume geometry, hierarchy and fill inputs. Dated
  // names, flags and other metadata belong to the separate label scene.
  const equivalent=(before,after)=>before===after||before.length===after.length&&before.every((row,index)=>{
   const next=after[index];
   return row===next||row.id===next.id&&row.geometry===next.geometry
    &&row.properties.parentId===next.properties.parentId
    &&row.properties.entityKind===next.properties.entityKind
    &&row.properties.style?.color===next.properties.style?.color
    &&countryDefaultColor(row)===countryDefaultColor(next);
  });
  if(accepted&&styleReady()&&!error&&countryGeneration===generation&&!activeCountryTasks.size&&!countryDisplay.needsSwap
    &&accepted.generation===inputs.generation&&accepted.source===inputs.source&&accepted.stroke===inputs.stroke
    &&accepted.presentation===inputs.presentation&&accepted.visibility===inputs.visibility&&accepted.visible===inputs.visible
    &&immutable(accepted.entities)&&immutable(entities)&&immutable(accepted.features)&&immutable(features)
    &&equivalent(accepted.entities,entities)&&equivalent(accepted.features,features)){
   territories=features;acceptedCountryInputs=inputs;return Promise.resolve(true);
  }
  if(activeCountryTasks.size){countryDisplay.markSourceStale();countryTail=Promise.resolve();}
  countryGeometryAbort?.abort();
  const controller=new AbortController();countryGeometryAbort=controller;
  territories=features;const sequence=++countrySequence,requestedGeneration=generation;countryGeneration=-1;
  const task=countryTail.then(async()=>{
   if(sequence!==countrySequence||requestedGeneration!==generation||disposed)return false;
   const entityRepository=metrics.run('territorial.payload',()=>{
    const rows=[...new Map([...entities,...features].map(feature=>[String(feature.id),feature])).values()]
     .map(feature=>({...feature,properties:structuredClone(feature.properties)}));
    return createTerritorialEntityRepository({getEntities:()=>rows});
   });
   activeCountryTasks.add(sequence);
   try{
    const applied=await applyTerritorialFeatures(features,sequence,requestedGeneration,entityRepository,controller.signal);
    if(applied&&sequence===countrySequence&&requestedGeneration===generation)
     acceptedCountryInputs={...inputs,source:map.getSource(datedSources.active('territories'))};
    return applied;
   }
   finally{activeCountryTasks.delete(sequence);}
  }).catch(cause=>{if(disposed||sequence!==countrySequence||requestedGeneration!==generation)return false;throw cause;});
  countryTail=task.catch(()=>{});return task;
 }
 async function applyTerritorialFeatures(features,sequence,requestedGeneration,entityRepository,signal){
  if(basemapRecovery)await basemapRecovery;
  await initialize();
  if(!styleReady())await new Promise(resolve=>map.once('style.load',resolve));
  if(disposed)return false;
  if(requestedGeneration!==generation||sequence!==countrySequence)return false;
  const {presented,nextBatches,key}=prepareCountryPresentation(features,{state,entityRepository,style:currentMapStyle(),layerPresentation:deps.layerPresentation});
  const cached=datedSources.reuse('territories',key);
  const current=()=>!disposed&&requestedGeneration===generation&&sequence===countrySequence;
  const publish=(id,record)=>{
   datedSources.activate('territories',id);
   countryDisplay.publish(record,key);
   syncCountryPaint(id,record.rows);orderSceneLayers();
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
   const preserve=presentation.temporalPending()&&datedSources.get(datedSources.active('territories'))?.key!=null;
   if(!preserve)countryDisplay.replaceObsoleteCountrySource({map,datedSources,sourceLayer,sourceLayers:SOURCE_LAYERS.territories,countryTileSource,onCountrySourceRemoved:id=>scene.removeCountryFillSource(id),onStyleInvalidated:()=>{scene.invalidateLayerIndex();},dirty});
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
   syncTerritorialFills(requestedSource,nextBatches);
   const record={kind:'territories',source,key,rows:new Map(presented.map(feature=>[feature.id,feature])),
    tiles:next,borders:new Map(borders.map(row=>[row.key,row]))};
   datedSources.set(requestedSource,record);
   publish(requestedSource,record);
  }
  if(sequence!==countrySequence||requestedGeneration!==generation)return false;
  if(requestedGeneration===generation&&sequence===countrySequence){countryGeneration=generation;countryContentKey=features.map(feature=>String(feature.id)+':'+geometryKey(feature.geometry)).join('|');}
  map.triggerRepaint();
  return true;
 }
 const selection=createMapLibreSelection({getMap:()=>map,state,styleReady,ensurePolar,setData,orderSceneLayers,metrics,invalidate,
 feedback:deps.feedback,suppressHover:()=>temporalFrameHeld&&presentation.temporalPending(),objectRefVisible:ref=>deps.objectRefVisible(ref),
 getTerritory:id=>deps.territorialModel.entityRepository.get(id),getHydroFeature:id=>deps.hydroModel.hydroFeatureById(id),
 getInteractionStyle:()=>scene.interactionStyle,rgba,pickingPorts:{
 getMap:()=>map,getProjection:()=>projection,getTerritories:()=>territories,
 getHydroFeatures:()=>state.hydroFeatureCache.values(),getPolarLines:()=>polarDisplay.visibleLines,getVectorRole:source=>scene.vectorRole(source),
 canPick:()=>loaded&&!temporalOverlay&&!initialZoomHidden,canPickHydro:(...args)=>hydroDisplay.canPick(...args),
 containsGeometry:(...args)=>deps.containsGeometry(...args),isHydroFeatureVisible:feature=>deps.physicalServices.isHydroFeatureVisible(feature),
 mapSourceLayers,sourceLayer,datedSources,requiredSource,objectKeyRef}});
 const {queryObjectRefs}=selection;
 function setSelection(snapshot){selection.setSelection(snapshot);}
 function renderFrame(frame){
  stats.approvalAttempts++;
  if(error){pendingFrame=null;return {succeeded:false,presentationReady:false,error};}
  if(!styleReady()){pendingFrame=frame;return {succeeded:false,deferred:true,presentationReady:false};}
  pendingFrame=frame;metrics.run('physical.sync',syncPhysicalContext);metrics.run('polar.sync',()=>{syncPolar();syncPolarLines();});if(initialMapLoading)syncInitialMapSkeleton();else syncLabelVisibility();
  const pending=!!polarDisplay.pending||presentation.temporalPending()&&selection.selectionPending()||!!error||!loaded||contextLost||sourceWrites.pendingCount()||
   scene.requiredVectorPending()||
   countryGeneration!==generation||!presentation.countrySourceAdmitted(countryContentKey)||
   !deps.physicalResources.physicalContextState.ready||!requiredSourcesReady()||zoomFramePending&&map.isMoving();
  const camera=cameraKey(),certified=certifiedRevision===sourceRevision&&certifiedGeneration===generation&&certifiedContext===contextRevision&&certifiedCamera===camera;
  if(pending||!certified){
   ready=false;preparedReady=false;
   // Pending sources and Workers already notify this renderer on completion.
   // Only ask MapLibre for a draw when the approval lacks a frame certificate.
   if(!pending){
    const certificate=generation+'|'+contextRevision+'|'+sourceRevision+'|'+camera;
    if(requestedCertificate!==certificate){requestedCertificate=certificate;map.triggerRepaint();}
   }
   return {succeeded:false,deferred:true,presentationReady:false};
  }
  if(initialMapLoading){
   // The certified frame still contains the loading surface. Draw the real
   // scene and its symbols behind those saved pixels before admitting it.
   preserveDisplayedFrame();
   initialFrameStaging='drawing';
   initialMapLoading=false;
   syncInitialMapSkeleton();
   dirty();
   map.triggerRepaint();
   return {succeeded:false,deferred:true,presentationReady:false};
  }
  presentation.markTemporalFrame(frame);preparedReady=true;
  const result={succeeded:true,presentationReady:true,frameId:frame.frameId,viewRevision:frame.viewRevision,projectionRevision:frame.projectionRevision};
  if(presentation.canPresentVisualFrame(frame,result)){state.countryVisualPhase='canonical';if(stats.firstCanonicalFrameMs===null)stats.firstCanonicalFrameMs=performance.now();}
  return result;
 }
 function commitVisualFrame(frame){
  const committed=presentation.commitVisualFrame(frame);
  if(committed){
   if(!initialMapLoading)camera.markPresented();
   if(initialFrameStaging)initialFrameStaging='certified';
   projectFrameHeld=false;zoomFramePending=false;
   discardUnusedPreservedFrame();
   metrics.publish();pendingFrame=null;ready=true;notify('ready','지도 준비 완료');
   datedSources.scheduleRetirement();
  }
  return committed;
 }
 function failMapPreparation(cause){if(disposed)return;error=cause;ready=false;preparedReady=false;notify('error','지도 불러오기 실패');presentation.rejectMapPresentationWaiters(cause);presentation.failTemporalPresentation(cause);deps.feedback.reportOperationError(cause,'지도를 표시하지 못했습니다.','PL-MAPLIBRE-001');}
 function retryMapPreparation(){error=null;polarDisplay.invalidateInputs();selection.reset();polarDisplay.retry();selection.refresh();invalidate('map-retry');}
 function invalidateCountryColors(){
  if(!styleReady()){pendingCountryPaint=true;return;}
  syncCountryPaint(datedSources.active('territories'),countryDisplay.rows);
  dirty();invalidate('country-paint');
 }
 function invalidateStyle(){if(loaded&&!styleReady()){pendingStyleRefresh=true;return;}if(loaded){
  setTerritorialFeatures(territories).catch(failMapPreparation);
  hydroDisplay.invalidateVisibility();syncHydroState();syncBaseLayer();
  if(initialMapLoading)syncInitialMapSkeleton();
  dirty();
 }invalidate('map-paint');}
 function setInitialMapLoading(value){
  if(value!==true&&initialFrameStaging==='certified'){
   initialFrameStaging=null;
   if(initialZoomHidden){initialZoomHidden=false;map.getCanvas().style.removeProperty('visibility');}
   discardUnusedPreservedFrame();
   return;
  }
  if(value!==true&&!initialMapLoading)return;
  initialMapLoading=value===true;syncInitialMapSkeleton();dirty();invalidate('initial-map-skeleton');
 }
 return Object.freeze({registerFeature,previewExternalBasemap,cameraSnapshot:camera.cameraSnapshot,setInitialMapLoading,attach,initialize,setTerritorialFeatures,setSceneDomains,setSelection,queryObjectRefs,getPickingRevision:()=>sourceRevision,syncCameraFromState,syncPhysicalContext,syncHydroState,
 get map(){return map;},get projection(){return projection;},get loaded(){return loaded;},isStyleReady:styleReady,renderFrame,commitVisualFrame,measureWork:metrics.track,measureSyncWork:metrics.run,
  panBy:camera.panBy,fitGeometry:camera.fitGeometry,
  fitMapBounds,fitWorld:camera.fitWorld,isAtWorldView,
  canPresentVisualFrame:presentation.canPresentVisualFrame,prepareTemporalCountrySource:presentation.prepareTemporalCountrySource,
  beginTemporalViewTransition(isCurrent,onPresented){datedSources.cancelRetirement();const ticket=presentation.beginTemporalViewTransition(isCurrent,onPresented);if(externalBasemap&&!basemapRecovery){const finish=()=>{basemapRecovery=null;flushStyleChanges();invalidate('basemap-transition-recovered');};const recovery=Promise.resolve().then(()=>externalBasemap.cancelPending()).then(value=>{finish();return value;},cause=>{finish();throw cause;});basemapRecovery=recovery;recovery.catch(failMapPreparation);}return ticket;},
  admitTemporalViewTransition(ticket){
   if(!presentation.admitTemporalViewTransition(ticket))return false;
   selection.onTemporalAdmission();
   return true;
  },
  preserveTemporalFrame,releaseTemporalFrame,isFramePreserved:()=>!!temporalOverlay||initialZoomHidden,
  finishTemporalViewTransition(ticket){const finished=presentation.finishTemporalViewTransition(ticket);if(finished)datedSources.scheduleRetirement();return finished;},
  waitForTemporalPresentation:presentation.waitForTemporalPresentation,
  waitForMapPresentation:presentation.waitForMapPresentation,getProjectGeneration:()=>generation,
  resetProjectRenderState(options){if(options.presentation!=='temporal'){
   if(!initialMapLoading&&!initialFrameStaging&&camera.hasPresented()){preserveDisplayedFrame();projectFrameHeld=true;}
   zoomFramePending=false;camera.resetPresented();releaseTemporalFrame();hydroDisplay.resetProject();
  }countryGeometryAbort?.abort();borders.reset();geometryClient.reset();physicalBase.resetProject();polarDisplay.resetProject();selection.reset();generation=options.generation;scene.resetPendingDomains();sourceWrites.reset();if(activeCountryTasks.size){countryDisplay.markSourceStale();countryTail=Promise.resolve();}countrySequence++;countryGeneration=-1;error=null;ready=false;preparedReady=false;presentation.resetForProject(options);},
  labelZoomVisibility,
  getRuntimeState:()=>({...stats,projectRenderBlocked:!!error,mapReady:ready,webglContextLost:contextLost,temporalPresentationPending:presentation.temporalPending(),temporalViewPending:presentation.temporalPending()&&presentation.ticket?.kind==='view',temporalSourceAdmitted:presentation.ticket?.sourceAdmitted!==false,physicalContextRevision:physicalBase.revision}),
  getStats:()=>({...stats,datedSources:{territories:datedSources.active('territories'),land:datedSources.active('physical-land'),water:datedSources.active('physical-water')},performance:metrics.snapshot(),polar:polarDisplay.stats(),highlight:selection.stats(),hydro:hydroDisplay.stats,errorMessage:error?.message||null,generation,projectReplacing:!!state.projectReplacing,webglContextLost:contextLost,projectRenderBlocked:!!error,displayedRevision:ready?sourceRevision:0,mapReadiness:{mapReady:ready,status:error?'error':ready?'ready':'loading'},hydroFeatureCount:hydroDisplay.features.length,sourceRevision,certifiedRevision,labelLayout:deps.countryLabelModel.labelLayoutMetrics,mapMoving:state.mapMoving}),
  setHydroManifest,
  invalidateCountryColors,invalidateCountryPalette:invalidateStyle,invalidatePhysicalStyle:invalidateStyle,
  invalidateHydroVisibility(){refreshHydroDetail();if(loaded&&!styleReady()){pendingStyleRefresh=true;return;}if(loaded){syncHydroState();dirty();}invalidate('hydro-visibility');},
  setRenderQuality(value){quality=value;if(map&&value?.dprCap&&Math.abs(map.getPixelRatio()-value.dprCap)>1e-9)map.setPixelRatio(value.dprCap);},
  setInteractionStyle,
  getRenderPixelRatio:()=>quality?.dprCap||window.devicePixelRatio||1,
  verifyLayout:()=>camera.verifyLayout(syncBaseLayer),failMapPreparation,retryMapPreparation,
  dispose(){disposed=true;camera.dispose();datedSources.cancelRetirement();countryGeometryAbort?.abort();geometryClient.dispose();selection.dispose();polarDisplay.dispose();externalBasemap?.dispose();if(externalAttribution)map?.removeControl(externalAttribution);externalAttribution=null;for(const record of mapFeatures.values()){try{record.owner.dispose();}catch(cause){deps.feedback.reportOperationError(cause,'추가 지도 기능을 정리하지 못했습니다.','PL-MAPLIBRE-OPTIONAL-001');}}mapFeatures.clear();zoomFramePending=false;releaseTemporalFrame();presentation.dispose();hydroDisplay.dispose();physicalBase.dispose();scene.dispose();map?.remove();if(window.__PANDOLAB_MAPLIBRE__===map)delete window.__PANDOLAB_MAPLIBRE__;stylesheet?.remove();container?.remove();},
 });
}
