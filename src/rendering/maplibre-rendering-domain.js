import {createMapContentPresentation} from '../ui/map-content-presentation.js';
import {createMapLibreLabelPresentation} from './maplibre-label-presentation.js';

/** Assemble geographic sources before MapLibre draws; publish labels after its render event. */
export function createMapLibreRenderingDomain(options){
 const {gpuMapRenderer:renderer,selectionDomain,prepareView,renderers,reportDiagnostic}=options;
 let disposed=false,queued=false,frameId=0,contentDirty=true,selectionDirty=true,labelsDirty=true,lastFrame=null;
 let viewportOverlaysDirty=false;
 let lastPlaceQueryAt=-Infinity;
 let previousLabelVisibility=null;
 let pendingPlaceViewport=null;
 const stats={invalidations:0,visualFrameCommittedCount:0};
 // MapLibre owns per-frame camera projection and symbol placement. Keep label
 // sources intact across moves; a new source snapshot or settled view changes them.
 const invalidate=(reason='map-change',content=false,labels=true)=>{
  if(disposed)return false;
  contentDirty||=content;if(content)selectionDirty=true;
  labelsDirty||=labels;
  stats.invalidations++;stats.lastReason=reason;
  if(!queued){queued=true;requestAnimationFrame(render);}return true;
 };
 const prepareMovingPlaces=()=>{
  const now=globalThis.performance?.now?.()??Date.now();
  if(now-lastPlaceQueryAt<100)return;
  lastPlaceQueryAt=now;
  options.labelResources.preparePlaces();
 };
 const preparePlacesForPublication=()=>{
  const task=options.labelResources.preparePlaces();
  pendingPlaceViewport=task;
  task.then(()=>{
   if(pendingPlaceViewport!==task||disposed)return;
   pendingPlaceViewport=null;
   if(renderer.isFramePreserved())invalidate('settled-place-viewport');
  },error=>{if(pendingPlaceViewport===task&&!disposed)renderer.failMapPreparation(error);});
 };
 const labels=createMapLibreLabelPresentation({renderer,labels:options.labelResources,
  onChange:()=>invalidate('map-labels-ready',false,false),onFlagsReady:()=>invalidate('map-flags-ready'),
  onSourceError:renderer.failMapPreparation,
  onError:error=>reportDiagnostic({operation:'map-labels',stage:'prepare',result:'failed',message:error.message,error})});
 const content=createMapContentPresentation({countries:options.countryResources,
  territorial:options.territorialResources,generic:options.genericResources,distribution:options.distributionResources,
  territorialBoundary:options.territorialBoundaryResources,base:options.baseResources,isDisposed:()=>disposed,
  prepareMapDisplay:options.prepareMapDisplay,onMapDisplayReady:()=>invalidate('display-ready',true),reportDiagnostic});
 function render(){
  queued=false;if(disposed||!renderer.loaded||!renderer.isStyleReady()||renderer.getRuntimeState().webglContextLost)return;
  try{
   const labelVisibility=renderer.labelZoomVisibility();
   const labelThresholdChanged=previousLabelVisibility!==null&&
    (labelVisibility.country!==previousLabelVisibility.country||labelVisibility.places!==previousLabelVisibility.places);
   labelsDirty||=labelThresholdChanged;
   previousLabelVisibility=labelVisibility;
   const frame=prepareView({frameId:++frameId,withBounds:labelsDirty});lastFrame=frame;
   renderer.syncHydroState();
   const refreshContent=contentDirty;
   const refreshViewportOverlays=viewportOverlaysDirty;
   if(refreshContent){contentDirty=false;preparePlacesForPublication();content.renderBase(frame);}
   if(refreshContent||refreshViewportOverlays){
    viewportOverlaysDirty=false;
    content.renderTerritorialUnits(frame);content.renderGenericFeatures(frame);content.renderDistributions(frame);
   }
   if(refreshContent)content.renderCountries(frame);
   if(refreshContent||refreshViewportOverlays)options.countryResources.syncGpuRenderScene();
   if(selectionDirty){selectionDirty=false;renderer.setSelection(selectionDomain.snapshot());}
   // Prepare symbol sources alongside geometry, behind the preserved temporal
   // frame. Publication still waits for both sources and a subsequent render.
   if(labelsDirty){
    const layout=renderers.labelLayout(frame);
    if(!layout.pending){
     labels.prepareFlags(layout,labelVisibility.country);
     labelsDirty=false;
     labels.renderTerritorialLabels(layout);
    }
   }
   const result=renderer.renderFrame(frame);
   const waitingForVisibleLabels=(labelVisibility.country||labelVisibility.places)&&(labelsDirty||labels.pending);
   const waitingForPlaces=labelVisibility.places&&renderer.isFramePreserved()&&pendingPlaceViewport!==null;
   if(result.deferred||waitingForVisibleLabels||waitingForPlaces||!renderer.canPresentVisualFrame(frame,result))return;
   if(!renderer.commitVisualFrame(frame))return;
   labels.publishOptionalFlags();
   stats.visualFrameCommittedCount++;stats.lastCommittedVisualFrameId=frame.frameId;
   options.onFrameComplete?.({durationMs:0,viewFrame:true,frameId:frame.frameId});
  }catch(error){renderer.failMapPreparation(error);}
 }
 const methods={
  isPreparingTemporalFrame:()=>renderer.getRuntimeState().temporalPresentationPending,
  invalidateView:reason=>{
   if(reason==='map-retry')labels.retry();
   if(reason==='maplibre-camera'){
    if(renderer.labelZoomVisibility().places)prepareMovingPlaces();
    else if(previousLabelVisibility?.places)options.labelResources.preparePlaces();
    return invalidate(reason,false,false);
   }
   // Source/render certificates never change label identities. Keep the
   // existing symbol source while waiting for the native frame to publish.
   if(['maplibre-presented','vector-ready','physical-source-ready','polar-ready','hydro-ready','country-paint','temporal-source-admitted','await-current-map-frame'].includes(reason))
    return invalidate(reason,false,false);
   return invalidate(reason);
  },invalidateViewport:reason=>{renderer.verifyLayout();return invalidate(reason,true);},
  invalidateProject:reason=>invalidate(reason,true),invalidateSelection:reason=>{selectionDirty=true;return invalidate(reason,false,reason!=='selection-hover');},
  invalidateLabels:reason=>invalidate(reason),invalidateQuality:reason=>invalidate(reason),
  invalidateBaseScene:reason=>invalidate(reason,true),invalidateOverlayGeometry:(_domain,reason)=>invalidate(reason,true),
  invalidateOverlayStyle:reason=>invalidate(reason,true),invalidateSelectionStyle:reason=>{selectionDirty=true;return invalidate(reason);},
  invalidateGpuFrame:reason=>invalidate(reason),invalidateGpuInteraction:reason=>{selectionDirty=true;return invalidate(reason);},
  invalidateGpuContext:reason=>invalidate(reason,true),
  beginInteraction(){lastPlaceQueryAt=-Infinity;options.labelResources.getState().mapMoving=true;options.labelResources.beginPlaceInteraction();},
  endInteraction(reason){lastPlaceQueryAt=-Infinity;options.labelResources.getState().mapMoving=false;preparePlacesForPublication();viewportOverlaysDirty=true;return invalidate(reason);},
  resetProjectGeneration(generation,presentation){renderer.resetProjectRenderState({generation,...presentation});content.resetTerritorialBoundaryCache();contentDirty=true;selectionDirty=true;return invalidate('project-generation',true);},
  getStats:()=>({...stats,lastFrameId:lastFrame?.frameId}),getDistributionRenderRows:()=>content.buildDistributionRenderRows(),
  getTerritorialBoundaryStats:content.getTerritorialBoundaryStats,
  recordSelectionRenderError:entry=>reportDiagnostic(entry),
  dispose(){disposed=true;labels.dispose();content.resetTerritorialBoundaryCache();options.disposeMapDisplay?.();options.labelResources.disposePlaces();},
 };
 for(const name of ['invalidateCountryPatch','invalidateHydroPatch','invalidateTerritorialPatch','invalidateGenericPatch','invalidateProjection','invalidateViewSettle'])methods[name]=reason=>invalidate(reason,true);
 return Object.freeze(methods);
}
