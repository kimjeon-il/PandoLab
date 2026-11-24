import {coordinateBounds} from '../geometry/coordinate-bounds.js';
import {isWithinDisplayZoom} from '../map/map-display-zoom.js';
import {MAPLIBRE_LABEL_MIN_ZOOM} from './maplibre-label-presentation.js';
export const ZOOM_EPSILON=1e-9;
export const WORLD_VIEW_BOUNDS=[[-89.999,-85.0511287798066],[89.999,85.0511287798066]];
export function createMapLibreCamera({getMap,isLoaded,getProjection,getView,readSafeInsets,onWorldFitChange,onFarJump}){
 let pendingCameraFit=null,worldFit=null,nativeMinZoom;
 function fitMapBounds(bounds,safeInsets={}){
  pendingCameraFit={bounds,safeInsets};
  return applyCameraFit();
 }
 function fitPadding(safeInsets,world=false){
  const {clientWidth:width,clientHeight:height}=getMap().getCanvas();
  if(!width||!height)return null;
  // With a large canvas, fitting the geographic samples alone can clip the
  // globe's silhouette. Provide extra fit padding only for the whole globe.
  const minimum=world?Math.max(24,(Math.min(width,height)-1024)*.18):24;
  return Object.fromEntries(['left','right','top','bottom'].getMap()(side=>{
   const extent=side==='left'||side==='right'?width:height;
   return [side,Math.min(extent/4,Math.max(minimum,Number(safeInsets[side])||0))];
  }));
 }
 function refreshWorldFit(safeInsets=readSafeInsets()){
  if(!isLoaded())return null;
  const padding=fitPadding(safeInsets,true);
  if(!padding)return null;
  const {clientWidth,clientHeight}=getMap().getCanvas();
  const key=[clientWidth,clientHeight,...Object.values(padding)].join(':');
  if(worldFit?.key===key)return worldFit.camera;
  // The globe's fit calculation clones the current transform, including minZoom.
  // Remove the old floor synchronously so it cannot constrain the new fit.
  let minimum=getMap().getMinZoom();
  if(minimum!==nativeMinZoom)getMap().setMinZoom(nativeMinZoom);
  try{
   const camera=getMap().cameraForBounds(WORLD_VIEW_BOUNDS,{padding,bearing:0});
   if(!camera||!Number.isFinite(camera.zoom))return null;
   // MapLibre stores the globe's minimum at the equator and adjusts it by latitude.
   const latitude=Math.min(Math.abs(camera.center.lat),WORLD_VIEW_BOUNDS[1][1]);
   const latitudeAdjustment=Math.log2(Math.cos(latitude*Math.PI/180));
   minimum=Math.max(nativeMinZoom,Math.min(getMap().getMaxZoom(),camera.zoom-latitudeAdjustment));
   worldFit={key,camera:{...camera,zoom:Math.max(camera.zoom,minimum+latitudeAdjustment)}};
  }finally{
   if(getMap().getMinZoom()!==minimum)getMap().setMinZoom(minimum);
  }
  onWorldFitChange?.();
  return worldFit.camera;
 }
 function applyCameraFit(){
  if(!isLoaded()||!pendingCameraFit)return false;
  const {bounds,safeInsets}=pendingCameraFit;
  const padding=fitPadding(safeInsets);
  if(!padding)return false;
  const camera=bounds===WORLD_VIEW_BOUNDS?refreshWorldFit(safeInsets):getMap().cameraForBounds(bounds,{padding,bearing:0});
  if(!camera)return false;
  pendingCameraFit=null;
  jumpCamera({...camera,pitch:0,roll:0});return true;
 }
 function isAtWorldView(){
  const world=worldFit?.camera;
  if(!world)return true;
  const center=getMap().getCenter();
  return Math.abs(center.wrap().lng-world.center.wrap().lng)<0.1
   &&Math.abs(center.lat-world.center.lat)<0.1&&Math.abs(getMap().getZoom()-world.zoom)<0.01
   &&Math.abs(getMap().getBearing())<0.1&&Math.abs(getMap().getPitch())<0.1&&Math.abs(getMap().getRoll())<0.1;
 }
 function labelZoomVisibility(){
  if(!isLoaded())return {country:false,places:false};
  const zoom=getMap().getZoom();
  return {country:isWithinDisplayZoom(zoom,MAPLIBRE_LABEL_MIN_ZOOM.country),places:isWithinDisplayZoom(zoom,MAPLIBRE_LABEL_MIN_ZOOM.places)};
 }
 let applyingCamera=false;
 function jumpCamera(target){
  const center=Array.isArray(target.center)?target.center:target.center.toArray();
  const far=Math.abs(target.zoom-getMap().getZoom())>=2-ZOOM_EPSILON||!getProjection().projectVisibleCoordinate(center);
  if(far)onFarJump();
  getMap().jumpTo(target);
 }
 function syncCameraFromState(view=getView()){
  pendingCameraFit=null;
  if(!getMap()||!isLoaded())return;
  const center=[-view.globeRotation[0],-view.globeRotation[1]];
  const zoom=Number.isFinite(view.zoom)?view.zoom:getMap().getZoom();
  const orientation={};for(const key of ['bearing','pitch','roll'])if(Number.isFinite(view[key]))orientation[key]=view[key];
  const current=getMap().getCenter();
  if(Math.abs(current.lng-center[0])<1e-8&&Math.abs(current.lat-center[1])<1e-8&&Math.abs(getMap().getZoom()-zoom)<1e-8&&Object.entries(orientation).every(([key,value])=>Math.abs(({bearing:()=>getMap().getBearing(),pitch:()=>getMap().getPitch(),roll:()=>getMap().getRoll()})[key]()-value)<1e-8))return;
  applyingCamera=true;try{jumpCamera({center,zoom,...orientation});}finally{applyingCamera=false;}
 }

 return Object.freeze({fitMapBounds,refreshWorldFit,applyCameraFit,isAtWorldView,labelZoomVisibility,jumpCamera,syncCameraFromState,
  captureNativeMinZoom(){nativeMinZoom=getMap().getMinZoom();worldFit=null;},
  hasPendingFit:()=>!!pendingCameraFit,isApplying:()=>applyingCamera});
}
