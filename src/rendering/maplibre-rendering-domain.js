import {createMapContentPresentation} from '../ui/map-content-presentation.js';
import {createMapLibreLabelPresentation} from './maplibre-label-presentation.js';
import {HYDRO_DISPLAY_ZOOMS} from '../map/map-display-zoom.js';

/** Assemble geographic sources before MapLibre draws; publish labels after its render event. */
export function createMapLibreRenderingDomain(options){
 const {mapRenderer:renderer,selectionDomain,prepareView,renderers,reportDiagnostic}=options;
 let disposed=false,queued=false,frameId=0,contentDirty=true,selectionDirty=true,labelsDirty=true,lastFrame=null;
 let boundaryDirty=false,previousLabelVisibility=null;
 let previousHydroZoomBand=null;
 let pendingPlaceViewport=null,placesDirty=true;
 const hydroZoomBand=()=>{
  const zoom=renderer.map.getZoom();
  return HYDRO_DISPLAY_ZOOMS.filter(threshold=>zoom>=threshold).length;
 };
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
 const preparePlacesForPublication=()=>{
  placesDirty=false;
  const task=options.labelResources.preparePlaces();
  if(pendingPlaceViewport===task)return;
  pendingPlaceViewport=task;stats.placePreparations=(stats.placePreparations||0)+1;
  const observed=renderer.measureWork?.('dated.place.viewport',()=>task)??task;
  observed.then(()=>{
   if(pendingPlaceViewport!==task||disposed)return;
   pendingPlaceViewport=null;
   // The place snapshot callback owns label invalidation; wake only admission.
   if(renderer.isFramePreserved())invalidate('settled-place-viewport',false,false);
  },error=>{if(pendingPlaceViewport===task&&!disposed){pendingPlaceViewport=null;renderer.failMapPreparation(error);}});
 };
 const labels=createMapLibreLabelPresentation({renderer,labels:options.labelResources,
  onChange:()=>invalidate('map-labels-ready',false,false),
  onSourceError:renderer.failMapPreparation});
 const content=createMapContentPresentation({mapPalette:options.mapPalette,
  territorial:options.territorialResources,generic:options.genericResources,distribution:options.distributionResources,
  territorialBoundary:options.territorialBoundaryResources,base:options.baseResources,isDisposed:()=>disposed,
  prepareMapDisplay:options.prepareMapDisplay&&((...args)=>renderer.measureWork
   ?renderer.measureWork('dated.internal-boundary.prepare',()=>options.prepareMapDisplay(...args)):options.prepareMapDisplay(...args)),onMapDisplayReady:()=>{
   boundaryDirty=true;invalidate('display-ready',false,false);
  },
  onMapDisplayFailed:()=>invalidate('display-failed',false,false),reportDiagnostic});
 function render(){
  queued=false;if(disposed||!renderer.loaded||!renderer.isStyleReady()||renderer.getRuntimeState().webglContextLost)return;
  try{
   const labelVisibility=renderer.labelZoomVisibility();
   const preserved=renderer.isFramePreserved();
   const updateViewport=!renderer.map.isMoving?.()||preserved;
   const labelThresholdChanged=previousLabelVisibility!==null&&
    (labelVisibility.country!==previousLabelVisibility.country||labelVisibility.places!==previousLabelVisibility.places);
   labelsDirty||=labelThresholdChanged;placesDirty||=labelThresholdChanged;
   previousLabelVisibility=labelVisibility;
   previousHydroZoomBand=hydroZoomBand();
   const updateLabels=labelsDirty&&updateViewport;
   const frame=prepareView({frameId:++frameId,withBounds:updateLabels});lastFrame=frame;
   const refreshContent=contentDirty,refreshBoundaries=boundaryDirty;
   contentDirty=false;boundaryDirty=false;
   if(placesDirty&&updateViewport)preparePlacesForPublication();
   // Start independent physical source writes before assembling the scene
   // and symbols; neither country tiling nor boundary completion is awaited.
   const physicalPrepared=!renderer.getRuntimeState().projectRenderBlocked;
   if(physicalPrepared)renderer.syncPhysicalContext();
   renderer.syncHydroState();
   if(refreshContent){
    content.renderTerritorialUnits(frame);content.renderBase(frame);
    content.renderGenericFeatures(frame);content.renderDistributions(frame);
   }else if(refreshBoundaries)content.renderTerritorialBoundaries();
   if(refreshContent||refreshBoundaries)options.syncMapScene();
   if(selectionDirty){selectionDirty=false;renderer.setSelection(selectionDomain.snapshot());}
   // Prepare symbol sources alongside geometry, behind the preserved temporal
   // frame. Publication still waits for both sources and a subsequent render.
   if(updateLabels){
    const layout=renderers.labelLayout(frame);
    if(!layout.pending){
     labelsDirty=false;
     labels.renderTerritorialLabels(layout,{deferWhileMoving:!preserved});
    }
   }
   const waitingForVisibleLabels=(labelVisibility.country||labelVisibility.places)&&(updateLabels&&labelsDirty||labels.pending);
   const waitingForPlaces=labelVisibility.places&&preserved&&(placesDirty||pendingPlaceViewport!==null);
   const runtime=renderer.getRuntimeState();
   const waitingForBoundaries=renderer.isFramePreserved()&&runtime.temporalPresentationPending&&content.territorialBoundariesPending();
   const boundaryFailure=waitingForBoundaries&&runtime.temporalSourceAdmitted&&content.territorialBoundaryFailure();
   if(boundaryFailure&&!runtime.projectRenderBlocked){
    renderer.failMapPreparation(boundaryFailure);return;
   }
   const domainPending=!!(waitingForVisibleLabels||waitingForPlaces||waitingForBoundaries||contentDirty||boundaryDirty
    ||(preserved&&labelsDirty&&(labelVisibility.country||labelVisibility.places)));
   const result=renderer.renderFrame(frame,{physicalPrepared,domainPending});
   if(domainPending||result.deferred||!renderer.canPresentVisualFrame(frame,result))return;
   if(!renderer.commitVisualFrame(frame))return;
   stats.visualFrameCommittedCount++;stats.lastCommittedVisualFrameId=frame.frameId;
   options.onFrameComplete?.({durationMs:0,viewFrame:true,frameId:frame.frameId});
  }catch(error){renderer.failMapPreparation(error);}
 }
 const methods={
  isPreparingTemporalFrame:()=>renderer.getRuntimeState().temporalPresentationPending,
  invalidateView:reason=>{
   if(reason==='map-retry'){placesDirty=true;labels.retry();content.retryTerritorialBoundaries();return invalidate(reason,true);}
   if(reason==='maplibre-camera'){
    if(renderer.map.isMoving?.()&&!renderer.isFramePreserved())return false;
    const visibility=renderer.labelZoomVisibility();
    const crossesDisplayThreshold=!previousLabelVisibility||visibility.country!==previousLabelVisibility.country||
     visibility.places!==previousLabelVisibility.places||hydroZoomBand()!==previousHydroZoomBand;
    return crossesDisplayThreshold||renderer.isFramePreserved()?invalidate(reason,false,false):false;
   }
   // Source/render certificates never change label identities. Keep the
   // existing symbol source while waiting for the native frame to publish.
   if(['maplibre-presented','vector-ready','physical-source-ready','polar-ready','hydro-ready','country-paint','temporal-source-admitted','await-current-map-frame','highlight-shown','highlight-failed'].includes(reason))
    return invalidate(reason,false,false);
   return invalidate(reason);
  },invalidateViewport:reason=>{placesDirty=true;renderer.verifyLayout();return invalidate(reason,true);},
  invalidateDocument(reason,{content=false,selection=false}={}){
   placesDirty=true;selectionDirty||=selection;return invalidate(reason,content,true);
  },
  invalidateProject:reason=>{
   if(reason!=='physical-water-ready'&&reason!=='physical-land-ready')placesDirty=true;
   return invalidate(reason,true);
  },invalidateSelection:reason=>{selectionDirty=true;return invalidate(reason,false,reason!=='selection-hover');},
  invalidateLabels:reason=>invalidate(reason),invalidateQuality:reason=>invalidate(reason),
  invalidateBaseScene:reason=>invalidate(reason,true),invalidateOverlayGeometry:(_domain,reason)=>invalidate(reason,true),
  invalidateOverlayStyle:reason=>invalidate(reason,true),invalidateSelectionStyle:reason=>{selectionDirty=true;return invalidate(reason);},
  beginInteraction(){options.labelResources.getState().mapMoving=true;options.labelResources.beginPlaceInteraction();},
  endInteraction(reason){options.labelResources.getState().mapMoving=false;placesDirty=true;return invalidate(reason);},
  resetProjectGeneration(generation,presentation){renderer.resetProjectRenderState({generation,...presentation});content.resetContentCaches();pendingPlaceViewport=null;placesDirty=true;boundaryDirty=false;contentDirty=true;selectionDirty=true;return invalidate('project-generation',true);},
  getStats:()=>({...stats,lastFrameId:lastFrame?.frameId}),getDistributionRenderRows:()=>content.buildDistributionRenderRows(),
  getTerritorialBoundaryStats:content.getTerritorialBoundaryStats,
  recordSelectionRenderError:entry=>reportDiagnostic(entry),
  dispose(){disposed=true;labels.dispose();content.resetContentCaches();options.disposeMapDisplay?.();options.labelResources.disposePlaces();},
 };
 for(const name of ['invalidateCountryPatch','invalidateHydroPatch','invalidateTerritorialPatch','invalidateGenericPatch','invalidateProjection','invalidateViewSettle'])methods[name]=reason=>invalidate(reason,true);
 return Object.freeze(methods);
}
