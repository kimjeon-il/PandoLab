import {createMapPresentationSession} from './map-presentation-session.js';
import {countryContentIdentity,isCountryContentIdentity} from './country-content-identity.js';
import {sameRenderIdentity} from './render-identity.js';

// Own the displayed-frame lifecycle. The supplied display controllers retain
// their own source, camera, geometry, and selection state.
export function createMapLibreFrameController({
 getMap,getContainer,isLoaded,isDisposed=()=>false,isStyleReady,isStyleCurrent,state,metrics,stats,invalidate,
 presentMapPreparation,onMapPreparationStatus,camera,scene,selection,physicalBase,polarDisplay,physicalResources,
 sourceWrites,datedSources,getExternalBasemap,flushStyleChanges,feedback,renderQuality,rgba,getCountryStatus,
 isProjectReplacing=()=>!!state.projectReplacing,markCanonicalFrame=()=>{state.countryVisualPhase='canonical';},
 createElement=tag=>document.createElement(tag),isDocumentHidden=()=>document.hidden
}){
 let generation=0,contextRevision=0,contextLost=false,closed=false;
 let sourceRevision=0,certifiedRevision=-1,certifiedGeneration=-1,certifiedContext=-1,certifiedCamera='';
 let pendingFrame=null,ready=false,preparedReady=false,error=null,requestedCertificate=null,approvedFrame=null;
 let previousActiveRender=null,endSourceFrame=null,basemapRecovery=null;
 let initialMapLoading=false,initialFrameStaging=null,initialZoomHidden=false;
 let temporalOverlay=null,temporalInteractions=[],temporalOptionalLayers=[];
 let temporalFrameHeld=false,projectFrameHeld=false,zoomFramePending=false;
 let attachedMap=null,pendingStyleRestore=null;
 const styleWaiters=new Set();
 const unavailable=()=>closed||isDisposed();
 const abortError=reason=>Object.assign(new Error(reason),{name:'AbortError',cancelled:true});
 const presentation=createMapPresentationSession({
  getGeneration:()=>generation,getContextRevision:()=>contextRevision,isDisposed:unavailable,
  getReadiness:()=>({mapReady:preparedReady}),invalidateFrame:invalidate,
  prepareContentKey:async features=>countryContentIdentity(features),sameContentKey:sameRenderIdentity,isImmutableContentKey:isCountryContentIdentity,
  isProjectBlocked:()=>!!error,isRecoveryFrameAdmissible:()=>!error&&isLoaded()&&!contextLost&&!unavailable(),
  onTemporalRetired:()=>{if(presentation.ticket?.presented)releaseTemporalFrame();},
  waitForCanonicalFrame:()=>presentation.waitForMapPresentation(generation)
 });
 function notify(status,label){
  const value={status,label,retry:status==='error',mapReady:ready};
  presentMapPreparation?.(value,{retry:retryMapPreparation});
  onMapPreparationStatus?.(value,generation);
 }
 function dirty(){
  sourceRevision++;ready=false;preparedReady=false;approvedFrame=null;stats.sourceUpdates++;
  endSourceFrame??=metrics.begin('source-to-render');
 }
 function suspendOptionalLayers(){
  const map=getMap();
  for(const layer of map.getStyle()?.layers||[]){
   if(!layer.source||scene.requiredSource(layer.source)||selection.owns(layer.source)||datedSources.has(layer.source)
     ||layer.source==='hydro'||layer.layout?.visibility==='none'||temporalOptionalLayers.some(item=>item.id===layer.id))continue;
   temporalOptionalLayers.push({id:layer.id,visibility:map.getLayoutProperty(layer.id,'visibility')});
   map.setLayoutProperty(layer.id,'visibility','none');
  }
 }
 function preserveDisplayedFrame(){
  if(temporalOverlay)return;
  const source=getMap().getCanvas(),stage=getContainer().parentNode;
  const overlay=createElement('div');overlay.dataset.mapPreservedFrame='';
  Object.assign(overlay.style,{position:'absolute',inset:'0',zIndex:'10',overflow:'hidden',pointerEvents:'none'});
  const snapshot=createElement('canvas');snapshot.width=source.width;snapshot.height=source.height;
  Object.assign(snapshot.style,{position:'absolute',inset:'0',width:'100%',height:'100%'});
  const context=snapshot.getContext('2d');
  if(!context)throw new Error('Cannot preserve the displayed map frame.');
  context.drawImage(source,0,0);stats.preservedFrameCopies++;overlay.append(snapshot);
  stage.append(overlay);temporalOverlay=overlay;
 }
 function discardUnusedPreservedFrame(){
  if(!unavailable()&&(temporalFrameHeld||projectFrameHeld||zoomFramePending||initialFrameStaging))return;
  temporalOverlay?.remove();temporalOverlay=null;
 }
 function preserveTemporalFrame(){
  if(temporalFrameHeld)return;
  preserveDisplayedFrame();temporalFrameHeld=true;suspendOptionalLayers();
  const map=getMap();
  temporalInteractions=['dragPan','scrollZoom','boxZoom','doubleClickZoom','touchZoomRotate','keyboard']
   .map(name=>map[name]).filter(handler=>handler?.isEnabled());
  for(const handler of temporalInteractions)handler.disable();
 }
 function releaseTemporalFrame(){
  temporalFrameHeld=false;discardUnusedPreservedFrame();
  const map=getMap();
  for(const layer of temporalOptionalLayers)
   if(map?.getLayer(layer.id)&&map.getLayoutProperty(layer.id,'visibility')==='none')
    map.setLayoutProperty(layer.id,'visibility',layer.visibility);
  temporalOptionalLayers=[];
  for(const handler of temporalInteractions)handler.enable();
  temporalInteractions=[];
 }
 function syncLabelVisibility(){if(isStyleReady()&&scene.syncLabelVisibility(initialMapLoading))dirty();}
 function syncInitialMapSkeleton(){
  if(!isLoaded()||!scene.hasStyleController())return;
  const map=getMap(),style=scene.getStyle(),{paint}=style;
  polarDisplay.positionPolarLayer();
  const layer=polarDisplay.layer;
  const before=initialMapLoading&&layer&&map.getLayer(layer.id)?layer.id:undefined;
  scene.syncLoadingSurface(style,initialMapLoading,before);
  polarDisplay.setLoadingSurface(initialMapLoading?{
   ocean:rgba(paint['initial-map-ocean']['background-color']),land:rgba(paint['initial-map-land']['fill-color'])
  }:null);
  syncLabelVisibility();
 }
 function setInitialMapLoading(value){
  if(value!==true&&initialFrameStaging==='certified'){
   initialFrameStaging=null;
   if(initialZoomHidden){initialZoomHidden=false;getMap().getCanvas().style.removeProperty('visibility');}
   discardUnusedPreservedFrame();return;
  }
  if(value!==true&&!initialMapLoading)return;
  initialMapLoading=value===true;syncInitialMapSkeleton();dirty();invalidate('initial-map-skeleton');
 }
 function onFarCameraJump(){
  if(camera.hasPresented()&&!isProjectReplacing()&&!contextLost){
   preserveDisplayedFrame();zoomFramePending=true;ready=false;preparedReady=false;approvedFrame=null;
  }
 }
 function onCameraMove({userInitiated,largeJump,farFromPresented,applying,hasPresented}){
  if(userInitiated&&zoomFramePending&&!initialMapLoading&&!initialFrameStaging){
   zoomFramePending=false;discardUnusedPreservedFrame();
  }
  if(largeJump&&!userInitiated&&!zoomFramePending&&(!isProjectReplacing()||initialMapLoading)&&farFromPresented){
   if(initialMapLoading){initialZoomHidden=true;getMap().getCanvas().style.visibility='hidden';}
   else if(hasPresented)preserveDisplayedFrame();
   zoomFramePending=true;
  }
  if(zoomFramePending){ready=false;preparedReady=false;approvedFrame=null;}
  if(!applying&&!isProjectReplacing())invalidate('maplibre-camera');
 }
 function invalidateCertificate(){
  certifiedRevision=-1;certifiedGeneration=-1;certifiedContext=-1;certifiedCamera='';
  requestedCertificate=null;approvedFrame=null;
 }
 function certificateCurrent(){
  return certifiedRevision===sourceRevision&&certifiedGeneration===generation
    &&certifiedContext===contextRevision&&certifiedCamera===camera.cameraKey();
 }
 function onRender(){
  if(unavailable())return;
  stats.renderedFrames++;requestedCertificate=null;
  if(isLoaded()&&!contextLost)selection.onRender();
  const requiredReady=isLoaded()&&!error&&!contextLost&&!polarDisplay.pending
    &&!sourceWrites.pendingCount()&&scene.requiredSourcesReady();
  const sampled=requiredReady&&!isDocumentHidden()&&getMap().isMoving()?performance.now():null;
  if(sampled!==null&&previousActiveRender!==null&&renderQuality?.renderQualityController.recordFrame(0,{frameIntervalMs:sampled-previousActiveRender}))
   renderQuality.queueAdaptiveRenderQualityRefresh('maplibre-frame-cadence');
  previousActiveRender=sampled;
  if(!requiredReady)return;
  certifiedRevision=sourceRevision;certifiedGeneration=generation;certifiedContext=contextRevision;certifiedCamera=camera.cameraKey();
  endSourceFrame?.();endSourceFrame=null;
  if(pendingFrame)invalidate('maplibre-presented');
 }
 function requiredFramePending(country,map){
  return !!polarDisplay.pending
    || (presentation.temporalPending()&&selection.selectionPending())
    || !!error || !isLoaded() || contextLost
    || sourceWrites.pendingCount() || scene.requiredVectorPending()
    || country.generation!==generation
    || !presentation.countrySourceAdmitted(country.contentKey)
    || !physicalResources.physicalContextState.ready || !scene.requiredSourcesReady()
    || (zoomFramePending&&map.isMoving());
 }
 function renderFrame(frame){
  stats.approvalAttempts++;approvedFrame=null;
  if(error){pendingFrame=null;return {succeeded:false,presentationReady:false,error};}
  if(!isStyleReady()||unavailable()){pendingFrame=frame;return {succeeded:false,deferred:true,presentationReady:false};}
  pendingFrame=frame;
  metrics.run('physical.sync',physicalBase.syncPhysicalContext);
  metrics.run('polar.sync',()=>{polarDisplay.syncPolar();polarDisplay.syncPolarLines();});
  if(initialMapLoading)syncInitialMapSkeleton();else syncLabelVisibility();
  const country=getCountryStatus(),map=getMap();
  const pending=requiredFramePending(country,map);
  if(pending||!certificateCurrent()){
   ready=false;preparedReady=false;
   if(!pending){
    const certificate=generation+'|'+contextRevision+'|'+sourceRevision+'|'+camera.cameraKey();
    if(requestedCertificate!==certificate){requestedCertificate=certificate;map.triggerRepaint();}
   }
   return {succeeded:false,deferred:true,presentationReady:false};
  }
  if(initialMapLoading){
   preserveDisplayedFrame();initialFrameStaging='drawing';initialMapLoading=false;
   syncInitialMapSkeleton();dirty();map.triggerRepaint();
   return {succeeded:false,deferred:true,presentationReady:false};
  }
  presentation.markTemporalFrame(frame);preparedReady=true;approvedFrame=frame;
  const result={succeeded:true,presentationReady:true,frameId:frame.frameId,viewRevision:frame.viewRevision,projectionRevision:frame.projectionRevision};
  if(presentation.canPresentVisualFrame(frame,result)){
   markCanonicalFrame();if(stats.firstCanonicalFrameMs===null)stats.firstCanonicalFrameMs=performance.now();
  }
  return result;
 }
 function approved(frame){
  return preparedReady&&!!approvedFrame&&frame?.projectGeneration===generation&&approvedFrame.projectGeneration===generation
    &&approvedFrame.frameId===frame.frameId&&approvedFrame.viewRevision===frame.viewRevision
    &&approvedFrame.projectionRevision===frame.projectionRevision&&certificateCurrent()&&isStyleReady();
 }
 function canPresentVisualFrame(frame,result=null){
  return (result===null||approved(frame))&&presentation.canPresentVisualFrame(frame,result);
 }
 function commitVisualFrame(frame){
  if(!approved(frame)||!presentation.commitVisualFrame(frame))return false;
  if(!initialMapLoading)camera.markPresented();
  if(initialFrameStaging)initialFrameStaging='certified';
  projectFrameHeld=false;zoomFramePending=false;discardUnusedPreservedFrame();
  metrics.publish();pendingFrame=null;approvedFrame=null;ready=true;notify('ready','지도 준비 완료');datedSources.scheduleRetirement();
  return true;
 }
 function failMapPreparation(cause){
  if(unavailable())return;
  error=cause;ready=false;preparedReady=false;approvedFrame=null;
  notify('error','지도 불러오기 실패');
  for(const waiter of styleWaiters)waiter.finish(cause);
  presentation.rejectMapPresentationWaiters(cause);presentation.failTemporalPresentation(cause);
  feedback.reportOperationError(cause,'지도를 표시하지 못했습니다.','PL-MAPLIBRE-001');
 }
 function retryMapPreparation(){
  if(unavailable())return;
  error=null;invalidateCertificate();ready=false;preparedReady=false;
  selection.reset();polarDisplay.retry();selection.refresh();invalidate('map-retry');
 }
 function beginTemporalViewTransition(isCurrent,onPresented){
  datedSources.cancelRetirement();
  const ticket=presentation.beginTemporalViewTransition(isCurrent,onPresented);
  const external=getExternalBasemap();
  if(external&&!basemapRecovery){
   const finish=()=>{basemapRecovery=null;if(!unavailable()){flushStyleChanges();styleAvailable();invalidate('basemap-transition-recovered');}};
   const recovery=Promise.resolve().then(()=>external.cancelPending())
    .then(value=>{finish();return value;},cause=>{finish();throw cause;});
   basemapRecovery=recovery;recovery.catch(failMapPreparation);
  }
  return ticket;
 }
 function admitTemporalViewTransition(ticket){
  if(!presentation.admitTemporalViewTransition(ticket))return false;
  selection.onTemporalAdmission();return true;
 }
 function finishTemporalViewTransition(ticket){
  const finished=presentation.finishTemporalViewTransition(ticket);
  if(finished)datedSources.scheduleRetirement();
  return finished;
 }
 function prepareProjectReset(options){
  if(options.presentation!=='temporal'){
   if(!initialMapLoading&&!initialFrameStaging&&camera.hasPresented()){preserveDisplayedFrame();projectFrameHeld=true;}
   zoomFramePending=false;camera.resetPresented();releaseTemporalFrame();
  }
 }
 function resetForProject(options){
  generation=options.generation;error=null;ready=false;preparedReady=false;
  invalidateCertificate();previousActiveRender=null;pendingFrame=null;
  presentation.resetForProject(options);
 }
 function cancelStyleRestore(){
  if(pendingStyleRestore){pendingStyleRestore.map.off('style.load',pendingStyleRestore.restore);pendingStyleRestore=null;}
 }
 function onContextLost(){
  if(unavailable())return;
  cancelStyleRestore();contextRevision++;contextLost=true;ready=false;preparedReady=false;
  invalidateCertificate();previousActiveRender=null;sourceWrites.reset();physicalBase.resetContext();
  presentation.rebaseContext();notify('loading','지도 복구 중');
 }
 function onContextRestored(){
  if(unavailable())return;
  cancelStyleRestore();
  const map=getMap(),revision=contextRevision;
  const restore=()=>{
   pendingStyleRestore=null;
   if(unavailable()||getMap()!==map||revision!==contextRevision)return;
   scene.applyStyle(scene.getStyle(),{updateVisibility:!temporalOverlay});scene.syncVectorGroups();
   polarDisplay.resetContext();selection.reset({restore:true});
   contextLost=false;invalidateCertificate();dirty();flushStyleChanges();styleAvailable();invalidate('map-context-restored');
  };
  if(isStyleCurrent())restore();
  else{pendingStyleRestore={map,restore};map.once('style.load',restore);}
 }
 function handleMapError(event){
  if(unavailable()||event.error?.name==='AbortError'||event.error&&sourceWrites.handlesError(event.error))return;
  if(event.sourceId&&getExternalBasemap()?.ownsSource(event.sourceId)||event.sourceId==='viewer-labels')return;
  if(event.sourceId&&getMap().getSource(event.sourceId)&&!scene.requiredSource(event.sourceId)){
   feedback.reportOperationError(event.error||new Error('Optional source failed: '+event.sourceId),'추가 지도 자료를 불러오지 못했습니다.','PL-MAPLIBRE-OPTIONAL-001');return;
  }
  failMapPreparation(event.error||new Error('MapLibre render failed.'));
 }
 function attachMap(){
  const map=getMap();if(attachedMap===map)return;
  detachMap();attachedMap=map;
  map.on('render',onRender);map.on('webglcontextlost',onContextLost);
  map.on('webglcontextrestored',onContextRestored);map.on('error',handleMapError);
 }
 function detachMap(){
  cancelStyleRestore();if(!attachedMap)return;
  attachedMap.off('render',onRender);attachedMap.off('webglcontextlost',onContextLost);
  attachedMap.off('webglcontextrestored',onContextRestored);attachedMap.off('error',handleMapError);attachedMap=null;
 }
 function waitForStyle(signal){
  if(unavailable()||signal?.aborted)return Promise.reject(abortError('Map style request superseded.'));
  if(isStyleReady())return Promise.resolve();
  return new Promise((resolve,reject)=>{
   const waiter={finish(cause){styleWaiters.delete(waiter);signal?.removeEventListener('abort',cancel);if(cause)reject(cause);else resolve();}};
   const cancel=()=>waiter.finish(abortError('Map style request superseded.'));
   styleWaiters.add(waiter);signal?.addEventListener('abort',cancel,{once:true});
  });
 }
 function styleAvailable(){if(isStyleReady())for(const waiter of styleWaiters)waiter.finish();}
 function runtimeState(){return {projectRenderBlocked:!!error,mapReady:ready,webglContextLost:contextLost,
  temporalPresentationPending:presentation.temporalPending(),
  temporalViewPending:presentation.temporalPending()&&presentation.ticket?.kind==='view',
  temporalSourceAdmitted:presentation.ticket?.sourceAdmitted!==false};}
 function frameStats(){return {errorMessage:error?.message||null,generation,webglContextLost:contextLost,
  projectRenderBlocked:!!error,displayedRevision:ready?sourceRevision:0,
  mapReadiness:{mapReady:ready,status:error?'error':ready?'ready':'loading'},sourceRevision,certifiedRevision};}
 return Object.freeze({attachMap,notify,dirty,renderFrame,canPresentVisualFrame,commitVisualFrame,failMapPreparation,retryMapPreparation,
  beginTemporalViewTransition,admitTemporalViewTransition,finishTemporalViewTransition,
  prepareTemporalCountrySource:presentation.prepareTemporalCountrySource,
  waitForTemporalPresentation:presentation.waitForTemporalPresentation,waitForMapPresentation:presentation.waitForMapPresentation,
  temporalPending:presentation.temporalPending,get ticket(){return presentation.ticket;},
  preserveTemporalFrame,releaseTemporalFrame,isFramePreserved:()=>!!temporalOverlay||initialZoomHidden,
  suspendOptionalLayersIfHeld(){if(temporalFrameHeld)suspendOptionalLayers();},
  externalRevisionKey:()=>JSON.stringify([generation,contextRevision,sourceRevision,presentation.temporalPending(),temporalFrameHeld]),
  get generation(){return generation;},get contextRevision(){return contextRevision;},get contextLost(){return contextLost;},
  get sourceRevision(){return sourceRevision;},get blocked(){return !!error;},
  get basemapRecovery(){return basemapRecovery;},get hasOverlay(){return !!temporalOverlay;},
  get zoomPending(){return zoomFramePending;},get initialMapLoading(){return initialMapLoading;},
  suppressHover:()=>temporalFrameHeld&&presentation.temporalPending(),
  onFarCameraJump,onCameraMove,resetCadence(){previousActiveRender=null;},
  syncInitialMapSkeleton,setInitialMapLoading,prepareProjectReset,resetForProject,waitForStyle,styleAvailable,runtimeState,stats:frameStats,
  dispose(){
   if(closed)return;closed=true;detachMap();zoomFramePending=false;releaseTemporalFrame();presentation.dispose();
   for(const waiter of styleWaiters)waiter.finish(abortError('Renderer disposed.'));
   endSourceFrame?.();endSourceFrame=null;pendingFrame=null;approvedFrame=null;ready=false;preparedReady=false;
  }
 });
}
