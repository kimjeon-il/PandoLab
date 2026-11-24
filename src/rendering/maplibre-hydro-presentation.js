import {sameRenderIdentity} from './render-identity.js';
import {mapLibreGeoJsonSource} from './maplibre-source-spec.js';
import {HYDRO_DISPLAY_ZOOMS} from '../map/map-display-zoom.js';

const layerFilter=(category,zoom,hiddenIds)=>['all',['==',['get','category'],category],['==',['get','viewerMinZoom'],zoom],
 ...(hiddenIds.length?[['!',['in',['get','logicalId'],['literal',hiddenIds]]]]:[])];
const hydroLayers=[['lakes','lake','fill'],['rivers','river','line']].flatMap(([baseId,category,type])=>
 HYDRO_DISPLAY_ZOOMS.map((zoom,index)=>({id:index===0?baseId:baseId+'-'+zoom,baseId,category,type,zoom})));
const hydroLayerById=new Map(hydroLayers.map(layer=>[layer.id,layer]));
export const mapLibreHydroLayer=id=>hydroLayerById.get(id);

// Preserve a feature's ordered path before GeoJSON tiling simplifies each part.
export function joinHydroLineParts(geometry) {
 if(geometry.type!=='MultiLineString'||geometry.coordinates.length<2)return geometry;
 const lines=[];
 let joined=null;
 for(const part of geometry.coordinates){
  const previous=lines.at(-1);
  const end=previous?.at(-1),start=part[0];
  if(end&&start&&end[0]===start[0]&&end[1]===start[1]){
   if(previous!==joined){
    joined=previous.slice();
    lines[lines.length-1]=joined;
   }
   for(let index=1;index<part.length;index++)joined.push(part[index]);
  } else lines.push(part);
 }
 return lines.length===geometry.coordinates.length?geometry:{...geometry,coordinates:lines};
}

const riverWidthTaperStart=3,riverWidthTaperEnd=4;
export function riverWidthAtZoom(zoom,width=1){
 const lowZoomWidth=Math.max(1.5,width);
 const remaining=Math.max(0,Math.min(1,(riverWidthTaperEnd-zoom)/(riverWidthTaperEnd-riverWidthTaperStart)));
 return width+(lowZoomWidth-width)*remaining;
}

export function mapLibreRiverWidth(width=1){
 return ['interpolate',['linear'],['zoom'],riverWidthTaperStart,riverWidthAtZoom(riverWidthTaperStart,width),riverWidthTaperEnd,width];
}

// Globe coverage can use more than one tile zoom at the same time.
// Paint expressions use the camera zoom regardless of the source tile level.
export const mapLibreHydroOpacity=(zoom=HYDRO_DISPLAY_ZOOMS[0],opacity=1)=>['step',['zoom'],0,zoom,opacity];
export function mapLibreHydroPaint(paint,type,zoom,opacity=1){
 return {...paint,[type+'-opacity']:mapLibreHydroOpacity(zoom,opacity)};
}

export function mapLibreHydroStyle({antiAlias=true,stylePaint=null}={}){
 const paints=stylePaint||{
  lakes:{'fill-antialias':antiAlias,'fill-color':'#5aa9d6'},
  rivers:{'line-color':'#3b82c4','line-width':mapLibreRiverWidth()},
 };
 return {sources:{hydro:mapLibreGeoJsonSource('hydro',undefined,{promoteId:'featureId'})},
  layers:hydroLayers.map(({id,baseId,category,type,zoom})=>({
   id,type,source:'hydro',filter:layerFilter(category,zoom,[]),
   paint:mapLibreHydroPaint(paints[baseId],type,zoom),
   ...(category==='river'?{layout:{'line-join':'round','line-cap':'round'}}:{}),
  }))};
}

export function syncMapLibreHydroVisibility(map,hiddenIds,visibility){
 for(const {id,baseId,category,zoom}of hydroLayers){
  const filter=layerFilter(category,zoom,hiddenIds);
  if(!sameRenderIdentity(map.getFilter(id),filter))map.setFilter(id,filter);
  const value=visibility[baseId]===false?'none':'visible';
  if(map.getLayoutProperty(id,'visibility')!==value)map.setLayoutProperty(id,'visibility',value);
 }
}

export function hiddenMapLibreHydroIds(features,isVisible){
 const hidden=new Set(),checked=new Set();
 for(const feature of features){
  const {logicalId,layerId}=feature.properties;
  if(checked.has(logicalId))continue;
  checked.add(logicalId);
  if(!isVisible({...feature,id:logicalId,properties:{...feature.properties,pandolab_id:logicalId,layer_id:layerId}}))
   hidden.add(logicalId);
 }
 return [...hidden].sort();
}

export function prepareMapLibreHydroFeatures(features,prepare){
 const groups=new Map();
 for(const feature of features){const id=String(feature.properties.logicalId);if(!groups.has(id))groups.set(id,[]);groups.get(id).push(feature);}
 return [...groups].map(([id,fragments])=>{
  const first=fragments[0],polygon=first.properties.category==='lake';
  const coordinates=fragments.flatMap(feature=>feature.geometry.type===(polygon?'MultiPolygon':'MultiLineString')?feature.geometry.coordinates:[feature.geometry.coordinates]);
  return prepare({type:'Feature',id,geometry:{type:polygon?'MultiPolygon':'MultiLineString',coordinates},properties:{...first.properties,pandolab_id:id,layer_id:first.properties.layerId}});
 });
}

export function createMapLibreHydroPresentation({map,admitFeatures,onFeatures,load,cancel,onError,updateSource,
 beforePublish=async()=>{},waitForSource=async()=>true,needsSourceRestore=()=>false,isEnabled=()=>true,viewportTiles}){
 if(!map||typeof admitFeatures!=='function'||typeof onFeatures!=='function'||typeof load!=='function'||typeof onError!=='function'||typeof updateSource!=='function')
  throw new TypeError('Hydro presentation requires the map, data and selection owners');
 let generation=0,disposed=false,pending=Promise.resolve(),tail=Promise.resolve(),presentedKey=null,publishedKey=null,activePacks=new Map();
 let currentWindow=null,movementTimer=null,windowFailed=false,flushProgress=null,resumePublication=null;
 const fragmentsById=new Map();
 const needsAdmission=new Set();
 let selectable=new Set(),lastFailureKey='';
 let presentedFeatures=()=>[];
 async function publish(version,key){
  const current=()=>!disposed&&version===generation&&isEnabled();
  if(await waitForSource(current)===false||!current())return;
  const changed=[...needsAdmission].flatMap(id=>[...fragmentsById.get(id)?.values()||[]]);
  if(changed.length&&await admitFeatures(changed,current)===false)return;
  if(!current())return;
  const features=presentedFeatures();
  needsAdmission.clear();
  selectable=new Set(features.map(feature=>String(feature.id)));
  onFeatures(features);publishedKey=key;
 }
 async function applyView(version,result,{partial=false}={}){
  const current=()=>!disposed&&version===generation&&isEnabled();
  if(!current())return;
  const key=partial?[...new Set([...activePacks.keys(),...result.packs.map(pack=>pack.id)])].sort((a,b)=>a-b).join(','):result.key;
  const {failedPacks=[]}=result;
  if(!partial){
   const failureKey=failedPacks.map(({id,message})=>id+':'+message).sort().join('|');
   if(failureKey&&failureKey!==lastFailureKey)onError(Object.assign(Error(failedPacks[0].message),{failedPacks,diagnostic:failedPacks[0].diagnostic}));
   lastFailureKey=failureKey;
  }
  if(key===presentedKey&&!needsSourceRestore()&&publishedKey===key&&!needsAdmission.size)return;
  await beforePublish(current);
  if(!current())return;
  if(key===presentedKey){
   if(needsSourceRestore()&&!await updateSource({add:[],remove:[]},presentedFeatures,current))return;
   if(current())await publish(version,key);
   return;
  }
  const addPacks=result.packs?.filter(pack=>!activePacks.has(pack.id))??result.addPacks;
  const wanted=result.packIds&&new Set(result.packIds);
  const removePacks=partial?[]:wanted?[...activePacks.keys()].filter(id=>!wanted.has(id)):result.removePacks;
  const next=new Map(activePacks),remove=[],add=[],changed=new Map();
  const fragmentsFor=feature=>{
   const id=String(feature.properties.logicalId);
   if(!changed.has(id))changed.set(id,new Map(fragmentsById.get(id)));
   return changed.get(id);
  };
  for(const id of removePacks||[]){
   for(const feature of next.get(id)||[]){remove.push(feature.id);fragmentsFor(feature).delete(feature.id);}
   next.delete(id);
  }
  for(const pack of addPacks||[]){
   next.set(pack.id,pack.features);
   for(const feature of pack.features){add.push(feature);fragmentsFor(feature).set(feature.id,feature);}
  }
  let snapshot;
  const allFeatures=()=>snapshot??=[...next.values()].flat();
  if(add.length||remove.length||needsSourceRestore()){
   for(const id of changed.keys())needsAdmission.add(id);
   const applied=await updateSource({add,remove},allFeatures,current);
   if(!applied)return;
  }
  if(!disposed){
   // updateData has already changed the source, so retain its actual pack
   // baseline even when a newer view arrived while the worker was applying it.
   for(const [id,fragments]of changed){
    if(fragments.size)fragmentsById.set(id,fragments);else fragmentsById.delete(id);
   }
   activePacks=next;presentedKey=key;presentedFeatures=allFeatures;
   if(current())await publish(version,key);
  }
 }
 const releasePublication=()=>{const resume=resumePublication;resumePublication=null;resume?.();};
 const suspend=()=>{generation++;currentWindow=null;windowFailed=false;flushProgress=null;releasePublication();clearTimeout(movementTimer);movementTimer=null;cancel?.();};
 function settle(force=false,retry=false){
  if(disposed||!isEnabled())return Promise.resolve();
  const center=map.getCenter(),canvas=map.getCanvas();
  const view={center:[center.lng,center.lat],zoom:map.getZoom(),width:canvas.clientWidth,height:canvas.clientHeight,knownKey:presentedKey};
  if(viewportTiles){
   view.tiles=viewportTiles(view);
   const key=view.tiles.map(({stage,x,y})=>stage+'/'+x+'-'+y).sort().join(',');
   if(!force&&key===currentWindow&&!(retry&&windowFailed))return pending;
   currentWindow=key;
  }
  windowFailed=false;
  const version=++generation;
  // An existing scene is the fallback while a new viewport loads. Only an
  // empty initial scene benefits from progressive native source writes.
  const progressive=presentedKey===null&&!map.isMoving?.();
  releasePublication();
  const current=()=>!disposed&&version===generation&&isEnabled();
  let progress=[],progressTimer=null;
  const enqueue=(result,options)=>{
   const task=tail.then(()=>applyView(version,result,options));
   tail=task.catch(()=>{});
   return task;
  };
  const progressReady=()=>{
   clearTimeout(progressTimer);progressTimer=null;
   if(!current()||map.isMoving?.())return;
   const packs=progress;progress=[];
   if(!packs.length)return;
   enqueue({packs},{partial:true}).catch(error=>{if(current()&&error?.name!=='AbortError')onError(error);});
  };
  flushProgress=progressReady;
  const onProgress=({packs})=>{
   if(!progressive||!current())return;
   progress.push(...packs);
   if(!progressTimer&&!map.isMoving?.())progressTimer=setTimeout(progressReady,16);
  };
  pending=Promise.resolve().then(()=>current()?load(view,current,{onProgress}):null)
   .then(async result=>{
    clearTimeout(progressTimer);progressTimer=null;progress=[];
    if(flushProgress===progressReady)flushProgress=null;
    if(!result||!current())return;
    // Keep the last rendered coverage while the camera is moving. A new
    // viewport or suspension releases the waiter and invalidates its result.
    while(current()&&map.isMoving?.())await new Promise(resolve=>{resumePublication=resolve;});
    if(current()){windowFailed=!!result.failedPacks?.length;return enqueue(result);}
   })
   .catch(error=>{
    clearTimeout(progressTimer);
    if(flushProgress===progressReady)flushProgress=null;
    if(current()&&error?.name!=='AbortError'){windowFailed=true;throw error;}
   });
  pending.catch(onError);
  return pending;
 }
 const moving=()=>{
  if(movementTimer||!isEnabled())return;
  movementTimer=setTimeout(()=>{movementTimer=null;settle();},100);
 };
 const moveEnded=()=>{
  clearTimeout(movementTimer);movementTimer=null;
  const settled=settle(false,true);
  releasePublication();
  flushProgress?.();
  return settled;
 };
 map.on('move',moving);
 map.on('moveend',moveEnded);
 return {refresh:()=>settle(true),suspend,ready:()=>pending,
  canPick:(id,logicalId)=>isEnabled()&&!needsSourceRestore()&&selectable.has(String(id))&&!needsAdmission.has(String(logicalId)),
  dispose(){disposed=true;suspend();map.off('move',moving);map.off('moveend',moveEnded);activePacks.clear();fragmentsById.clear();selectable.clear();needsAdmission.clear();presentedFeatures=()=>[];}};
}
