import {readMapLibreCamera} from './maplibre-projection.js';
import {coordinateBounds} from '../geometry/coordinate-bounds.js';
import {isWithinDisplayZoom} from '../map/map-display-zoom.js';
import {MAPLIBRE_LABEL_MIN_ZOOM} from './maplibre-label-presentation.js';
export const ZOOM_EPSILON=1e-9;
export const WORLD_VIEW_BOUNDS=[[-89.999,-85.0511287798066],[89.999,85.0511287798066]];
export function createMapLibreCamera({getMap,isLoaded,getProjection,getView,readSafeInsets,onWorldFitChange,onFarJump=()=>{},onMove=()=>{},onMoveStart=()=>{},onMoveEnd=()=>{}}){
 let pendingCameraFit=null,worldFit=null,nativeMinZoom;
 let lastCameraZoom=null,lastPresentedZoom=null,attachedMap=null;
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
  return Object.fromEntries(['left','right','top','bottom'].map(side=>{
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

 function fitGeometry(feature,padding){
   const geometries=[];
   const collect=value=>{if(value?.type==='FeatureCollection'){value.features.forEach(collect);return;}if(value?.type==='Feature'){collect(value.geometry);return;}if(value?.type==='GeometryCollection'){value.geometries.forEach(collect);return;}if(value?.coordinates)geometries.push(value);};collect(feature);
   const boxes=geometries.map(geometry=>coordinateBounds(geometry.coordinates)).filter(box=>box.every(Number.isFinite));if(!boxes.length)return false;
   const bounds=[[Math.min(...boxes.map(box=>box[0])),Math.min(...boxes.map(box=>box[1]))],[Math.max(...boxes.map(box=>box[2])),Math.max(...boxes.map(box=>box[3]))]];
   if(bounds[0][0]===bounds[1][0]&&bounds[0][1]===bounds[1][1]){
    jumpCamera({center:bounds[0],zoom:getMap().getZoom()});return true;
   }
   return fitMapBounds(bounds,padding);
  }
 function cameraSnapshot(){const map=getMap();return map&&isLoaded()?readMapLibreCamera(map):null;}
 function cameraKey(){
  const map=getMap();
  return map?JSON.stringify([map.getCenter().lng,map.getCenter().lat,map.getZoom(),map.getBearing(),map.getPitch(),map.getRoll(),map.getCanvas().width,map.getCanvas().height]):'';
 }
 function handleMove(event={}){
  const zoom=getMap().getZoom();
  const largeJump=lastCameraZoom!==null&&Math.abs(zoom-lastCameraZoom)>=2-ZOOM_EPSILON;
  lastCameraZoom=zoom;
  onMove({userInitiated:!!event.originalEvent,largeJump,
   farFromPresented:lastPresentedZoom===null||Math.abs(zoom-lastPresentedZoom)>=2-ZOOM_EPSILON,
   applying:applyingCamera,hasPresented: lastPresentedZoom!==null});
 }
 function attachMovement(){
  const map=getMap();
  if(attachedMap===map)return;
  detachMovement();attachedMap=map;lastCameraZoom=map.getZoom();
  map.on('move',handleMove);map.on('movestart',onMoveStart);map.on('moveend',onMoveEnd);
 }
 function detachMovement(){
  if(!attachedMap)return;
  attachedMap.off('move',handleMove);attachedMap.off('movestart',onMoveStart);attachedMap.off('moveend',onMoveEnd);
  attachedMap=null;lastCameraZoom=null;
 }
 function verifyLayout(onResize=()=>{}){
  const map=getMap();if(!map)return;
  map.resize();refreshWorldFit();onResize();applyCameraFit();
 }
 return Object.freeze({fitGeometry,cameraSnapshot,cameraKey,attachMovement,detachMovement,verifyLayout,
  panBy(dx,dy){getMap().panBy([-dx,-dy],{animate:false});return true;},
  fitWorld:padding=>fitMapBounds(WORLD_VIEW_BOUNDS,padding),
  hasPresented:()=>lastPresentedZoom!==null,
  markPresented(){lastPresentedZoom=getMap().getZoom();},
  resetPresented(){lastPresentedZoom=null;},
  dispose(){detachMovement();pendingCameraFit=null;worldFit=null;lastPresentedZoom=null;},
  fitMapBounds,refreshWorldFit,applyCameraFit,isAtWorldView,labelZoomVisibility,jumpCamera,syncCameraFromState,
  captureNativeMinZoom(){nativeMinZoom=getMap().getMinZoom();worldFit=null;},
  hasPendingFit:()=>!!pendingCameraFit,isApplying:()=>applyingCamera});
}
