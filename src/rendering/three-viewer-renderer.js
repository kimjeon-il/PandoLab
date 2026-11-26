import {createStoredAssetLoader} from '../data/stored-asset-loader.js';
import {normalizeObjectRef} from '../document/object-ref-identity.js';
import {coordinateBounds} from '../geometry/coordinate-bounds.js';
import {geometryReferenceFor} from '../geometry/geometry-version-store.js';
import {INTERACTION_ROLE_PRIORITY, layerStyle, territorialNamesVisible} from '../ui/layer-presentation.js';
import {resolveMapStrokeStyle} from '../map/map-interaction-style.js';
import {PLACE_DISPLAY_ZOOM_FLOOR} from '../map/map-display-zoom.js';
import {territorialNativeLabelRows} from '../ui/territorial-native-label.js';
import {createGlobeCamera} from './globe-camera.js';
import {COUNTRY_LABEL_MIN_ZOOM} from './three-globe-labels.js';
import {automaticLabelSettings, labelKey} from './label-layout.js';
import {decodeGlobeMesh,decodeGlobeStrokes,globeMeshResourceKey,globeTerritoryKey} from './globe-mesh.js';
import {decodeGlobePickGrid,pickGlobeSlots,pickGlobeStrokeSlots} from './globe-picking.js';
import {createMapPresentationSession} from './map-presentation-session.js';
import {createThreeGlobeSurface} from './three-globe-surface.js';
import {createRenderingMetrics} from './rendering-metrics.js';
import {createGlobeRiverDetail,selectGlobeRiverChunks} from './three-globe-rivers.js';
import {renderCacheBudget} from './render-cache-budget.js';
import {createGlobePhysicalAssets} from './three-globe-physical.js';

const centerOf=([a,b])=>[(a[0]+b[0])/2,(a[1]+b[1])/2];
const span=([a,b])=>Math.max(1,Math.hypot(a[0]-b[0],a[1]-b[1]));
const copyCamera=(view,backup)=>({...backup,...view,center:view?.center??(view?.globeRotation&&view.globeRotation.slice(0,2).map(v=>-v))??backup.center});

export function createThreeViewerRenderer(deps,{meta,initialCamera,presentMapPreparation,onMapPreparationStatus,readSafeInsets,onWorldFitChange}){
 const {state}=deps.projectState;
 const spec=meta.globePreview,baseSlots=spec.countrySlots;
 const slots=[...baseSlots,...spec.historicalCountries];
 const slotByKey=new Map(slots.map(({id,geometry},slot)=>[globeTerritoryKey(id,geometry),slot]));
 const labelsBySlot=[...baseSlots.map(row=>spec.countryLabels[row.id]),...spec.historicalCountries.map(row=>row.label)];
 const refs=slots.map(({id})=>normalizeObjectRef({domain:'territorial',type:'entity',id}));
 const baseTerritories={view:null,slots:baseSlots.map((_,slot)=>slot)};
 const datedTerritories=new Map([baseTerritories,...spec.historicalViews.map(view=>({view,slots:view.slots}))].map(row=>{
  const key=row.slots.join(',');return [key,{...row,key}];
 }));
 const historicalCountries=new Map(),historicalBorders=new Map();
 const requestedOutlines=new Set();
 const invalidate=reason=>deps.domains.renderingDomain.invalidateView(reason);
 const events=new Map(),pointers=new Map(),lifetime=new AbortController();
 const metrics=createRenderingMetrics();
 let host,canvas,surface,assets,camera,viewport,pending,disposed=false,lost=false,loaded=false,ready=false,error;
 let generation=0,contextRevision=0,revision=0,lastFrame=null,lastCamera=null,features=null,acceptedFeatures=null;
 let territories=baseTerritories,acceptedTerritories=baseTerritories,territoryParts=null,acceptedTerritoryParts=null,activeSlots=new Set(baseTerritories.slots);
 let selection=null,style=null,paintDirty=true,moving=false,moveTimer,velocity,pointerTravel=0,lastPointerMove=0;
 let outlineSlots=new Set();
 let labelContentDirty=true;
 let framePreserved=false,initialLoading=true,drawCount=0,unsupported=false;
 let riverDetail,riverCamera=null,riverVisible=null,riverContext=null;
 let physical=null,acceptedPhysical=null;
 let acceptedRiverChunks=[],hydroMetadata=null;
 const riverPickGrids=new WeakMap(),hydroSlots=new Map();
 let view={center:[15,12],zoom:2,bearing:0,pitch:0,roll:0};
 const readyState=()=>({mapReady:ready,status:error?'error':ready?'ready':'loading'});
 const presentation=createMapPresentationSession({getGeneration:()=>generation,getContextRevision:()=>contextRevision,
  isDisposed:()=>disposed,getReadiness:readyState,invalidateFrame:invalidate,prepareContentKey:rows=>requireTerritorialGeometry(state.timelineCursor,featureRefs(rows)).key,
  isProjectBlocked:()=>Boolean(error),isRecoveryFrameAdmissible:()=>!lost,
  waitForCanonicalFrame:()=>presentation.waitForMapPresentation(generation),onTemporalRetired:()=>{framePreserved=false;}});

 function notify(status,label){
  const value={status,label,mapReady:ready,retry:false};
  presentMapPreparation(value,{retry:retryMapPreparation});onMapPreparationStatus?.(value,generation);
 }
 function failMapPreparation(cause){
  if(disposed)return;
  error=cause;ready=false;notify('error','지도 불러오기 실패');
  presentation.rejectMapPresentationWaiters(cause);presentation.failTemporalPresentation(cause);
  deps.feedback.reportOperationError(cause,'Three.js 지도를 표시하지 못했습니다.','PL-THREE-001');
 }
 function retryMapPreparation(){error=null;return invalidate('map-retry');}
 function subscribeInput(type,callback){
  if(!events.has(type))events.set(type,new Set());
  events.get(type).add(callback);return ()=>events.get(type)?.delete(callback);
 }
 function emit(type,event={}){for(const callback of events.get(type)??[])callback(event);}
 function finishMovement(){
  clearTimeout(moveTimer);if(!moving)return;
  moving=false;velocity=null;emit('moveend');onWorldFitChange();
  deps.domains.renderingDomain.endInteraction('three-move-end');
 }
 function beginMovement(){
  clearTimeout(moveTimer);if(moving)return;
  moving=true;emit('movestart');deps.domains.renderingDomain.beginInteraction('three-move');
 }
 function screenPoint(event){const rect=canvas.getBoundingClientRect();return [event.clientX-rect.left,event.clientY-rect.top];}
 function setCamera(next){camera=next;view=next.view;invalidate('three-camera');}
 function installInput(){
  const listen=(type,fn,options)=>canvas.addEventListener(type,fn,{signal:lifetime.signal,...options});
  listen('pointerdown',event=>{
   if(!camera||event.button!==0)return;
   if(!pointers.size)pointerTravel=0;
   velocity=null;pointers.set(event.pointerId,screenPoint(event));canvas.setPointerCapture(event.pointerId);
  });
  listen('pointermove',event=>{
   const point=screenPoint(event),previous=pointers.get(event.pointerId);
   if(!previous){emit('mousemove',{point,originalEvent:event});return;}
   if(pointers.size>2)return;
   const now=performance.now(),dt=Math.max(8,now-lastPointerMove);lastPointerMove=now;
   pointerTravel+=Math.hypot(point[0]-previous[0],point[1]-previous[1]);
   pointers.set(event.pointerId,point);
   if(pointerTravel<3&&pointers.size===1)return;
   beginMovement();
   if(pointers.size===1){
    velocity=[(point[0]-previous[0])/dt,(point[1]-previous[1])/dt];
    setCamera(camera.drag(previous,point));
   }else{
    const other=[...pointers].find(([id])=>id!==event.pointerId)[1],from=centerOf([previous,other]),to=centerOf([point,other]);
    velocity=null;setCamera(camera.drag(from,to).zoomAt(to,Math.log2(span([point,other])/span([previous,other]))));
   }
  });
  const end=event=>{
   if(!pointers.delete(event.pointerId)||pointers.size)return;
   if(event.type==='pointerup'&&pointerTravel<3&&!moving)emit('click',{point:screenPoint(event),originalEvent:event});
   if(event.type!=='pointerup'||matchMedia('(prefers-reduced-motion: reduce)').matches||performance.now()-lastPointerMove>75||!velocity)finishMovement();
   else invalidate('three-inertia');
  };
  for(const type of ['pointerup','pointercancel','lostpointercapture'])listen(type,end);
  listen('pointerleave',()=>emit('mouseout'));
  listen('wheel',event=>{
   if(!camera)return;event.preventDefault();beginMovement();velocity=null;
   const units=event.deltaMode===1?16:event.deltaMode===2?viewport.height:1;
   setCamera(camera.zoomAt(screenPoint(event),Math.max(-1,Math.min(1,-event.deltaY*units/400))));
   moveTimer=setTimeout(finishMovement,140);
  },{passive:false});
  listen('webglcontextlost',event=>{event.preventDefault();lost=true;ready=false;notify('loading','그래픽 연결 복구 중');});
  listen('webglcontextrestored',()=>{lost=false;contextRevision++;presentation.rebaseContext();invalidate('three-context-restored');});
 }

 function attach(element){
  host=element;canvas=document.createElement('canvas');
  canvas.style.cssText='display:block;width:100%;height:100%;touch-action:none';
  host.appendChild(canvas);installInput();
 }
 const loader=createStoredAssetLoader({dataRevision:meta.dataRevision,cachePolicy:'immutable',resolveUrl:row=>new URL(row.url,document.baseURI).href});
 async function load(row,decode,{phase='startup',label='Three.js 지도 자산',signal=lifetime.signal}={}){
  const result=await loader.loadAsset(row,phase,row.sha256,label,bytes=>metrics.run('three.decode-packet',()=>decode(bytes)),signal);
  return result.value;
 }
 const loadMesh=async row=>({packet:await load(row,decodeGlobeMesh),gridSpec:row.pickGrid});
 const meshGrids=new WeakMap();
 async function pickMesh(mesh,ray,visible,options){
  const grid=await historicalResource(meshGrids,mesh,()=>load(mesh.gridSpec,
   bytes=>decodeGlobePickGrid(bytes,mesh.packet.indices.length/3),{phase:'background',label:'지도 선택 인덱스'}));
  return pickGlobeSlots(mesh.packet,grid,ray,visible,options);
 }
 async function loadOutlines(row,owners){
  return load(row,bytes=>{
   const packet=decodeGlobeStrokes(bytes);
   if(!owners.length||owners.some(group=>!group.length||group.some(slot=>!Number.isInteger(slot)||slot<0||slot>=slots.length))||
     packet.ownerGroups.length!==packet.count||packet.ownerGroups.some(group=>group>=owners.length))throw Error('Invalid globe outline owners');
   return {packet,owners};
  },{phase:'background',label:'선택 윤곽선'});
 }
 async function loadAssets(){
  const [countries,borders,graticule]=await Promise.all([
   loadMesh(spec.countries),load(spec.borders,decodeGlobeStrokes),
   load(spec.graticule,decodeGlobeStrokes),
   physicalAssets.prepare(spec.physical.identity),
  ]);
  return {countries,borders,graticule};
 }
 const physicalAssets=createGlobePhysicalAssets([spec.physical,...spec.physicalContexts],{
  loadMesh,loadStroke:row=>load(row,decodeGlobeStrokes),
 });
 function initialize(){
  if(pending)return pending;
  pending=(async()=>{
   notify('loading','지도 불러오는 중');
   const context=canvas.getContext('webgl2',{alpha:false,antialias:true});
   if(!context){unsupported=true;throw Error('Three.js requires WebGL2');}
   const threeUrl=new URL(spec.moduleUrl,document.baseURI);
   const [THREE,packets,restored]=await Promise.all([import(threeUrl.href),metrics.track('three.prepare-assets',loadAssets),initialCamera,
    document.fonts.load('800 56px "Pretendard Variable"','대한민국')]);
   lifetime.signal.throwIfAborted();assets=packets;
   surface=createThreeGlobeSurface(THREE,{canvas,context,palette:deps.preferences.mapPalette(),countryCount:slots.length,hydroCount:spec.hydroCount,packets:{
    countries:assets.countries.packet,borders:assets.borders,borderGroupCount:spec.borderOwners.length,graticule:assets.graticule,
   }});
   // Each resident detail packet has a CPU copy and one GPU copy of its arrays.
   riverDetail=createGlobeRiverDetail({byteBudget:renderCacheBudget().hydroBytes/2,
    load:(row,signal)=>load(row.spec,decodeGlobeStrokes,{phase:'background',label:'Three.js 상세 하천',signal}),
    attach:surface.attachRiverDetail,invalidate:()=>invalidate('three-river-detail'),
    onError:cause=>deps.feedback.reportOperationError(cause,'상세 하천을 불러오지 못했습니다.','PL-THREE-RIVER-001'),
   });
   verifyLayout();if(restored)syncCameraFromState(restored);else fitWorld();
   loaded=true;return true;
  })();pending.catch(failMapPreparation);return pending;
 }
 function verifyLayout(){
  if(!surface)return;
  const width=host.clientWidth,height=host.clientHeight,dpr=window.devicePixelRatio||1,safe=readSafeInsets();
  if(!width||!height)return;
  const next={width,height,dpr,...safe};
  if(viewport&&Object.keys(next).every(key=>viewport[key]===next[key]))return;
  if(!viewport||viewport.width!==width||viewport.height!==height||viewport.dpr!==dpr)surface.resize(width,height,dpr);
  viewport=next;camera=createGlobeCamera(view,viewport);
 }
 function syncCameraFromState(next=state.view){
  if(!viewport)return;
  setCamera(createGlobeCamera(copyCamera(next,view),viewport));
  if(loaded&&!moving)deps.domains.renderingDomain.invalidateViewport('three-camera-jump');
 }
 function worldFit(){
  const {width,height,left=0,right=0,top=0,bottom=0}=viewport,focal=height*1.5;
  const radius=Math.min(width-left-right,height-top-bottom)*0.43;
  const distance=Math.hypot(1,focal/Math.max(radius,1))-1;
  return {center:[15,12],zoom:Math.log2(2*Math.PI*focal/(512*distance)),bearing:0,pitch:0,roll:0};
 }
 function fitWorld(){if(!viewport)return false;syncCameraFromState(worldFit());onWorldFitChange();return true;}
 function fitMapBounds(bounds){
  if(!viewport)return false;
  const [[west,south],[east,north]]=bounds, longitudeWidth=east>=west?east-west:east+360-west;
  const extent=Math.max(longitudeWidth,north-south);
  syncCameraFromState({center:[west+longitudeWidth/2,(south+north)/2],zoom:extent?Math.log2(Math.min(viewport.width,viewport.height)*0.65*360/(512*extent)):view.zoom});
  return true;
 }
 function fitGeometry(feature){
  const boxes=[];
  const visit=row=>{if(row?.type==='FeatureCollection')row.features.forEach(visit);else if(row?.type==='Feature')visit(row.geometry);
   else if(row?.type==='GeometryCollection')row.geometries.forEach(visit);else if(row?.coordinates)boxes.push(coordinateBounds(row.coordinates));};
  visit(feature);
  const valid=boxes.filter(box=>box.every(Number.isFinite));
  return Boolean(valid.length)&&fitMapBounds([[Math.min(...valid.map(box=>box[0])),Math.min(...valid.map(box=>box[1]))],
   [Math.max(...valid.map(box=>box[2])),Math.max(...valid.map(box=>box[3]))]]);
 }
 function requirePhysicalSource(month,identity){
  if(!physicalAssets.has(identity))
   throw Object.assign(Error(`${month}에 준비된 Three.js 물리 지도가 없습니다.`),{code:'PL-THREE-MONTH'});
  return identity;
 }
 async function preparePhysicalContext(month,{isCurrent=()=>true}={}){
  const assertCurrent=()=>{if(!isCurrent())throw Object.assign(new Error('Physical preparation superseded'),{name:'AbortError',cancelled:true});};
  assertCurrent();
  const identity=requirePhysicalSource(month,deps.physicalResources.physicalSourceIdentityAtMonth(month));
  await Promise.all([initialize(),physicalAssets.prepare(identity)]);
  assertCurrent();return true;
 }
 function requireTerritorialGeometry(month,references){
  const active=[];
  for(const [id,reference] of references){
   const slot=slotByKey.get(globeTerritoryKey(id,reference));
   if(slot===undefined||(reference.contentSha256!==undefined&&reference.contentSha256!==slots[slot].geometry.contentSha256))break;
   active.push(slot);
  }
  const match=active.length===references.size?datedTerritories.get(active.sort((a,b)=>a-b).join(',')):null;
  if(!match)throw Object.assign(Error(`${month}에 준비된 Three.js 영토 형상이 없습니다.`),{code:'PL-THREE-IDENTITY'});
  return match;
 }
 function featureRefs(rows){return new Map(rows.map(row=>[String(row.id),geometryReferenceFor(row.geometry)]));}
 function historicalResource(cache,key,read){
  if(!cache.has(key)){
   const promise=read();cache.set(key,promise);
   promise.catch(()=>{if(cache.get(key)===promise)cache.delete(key);});
  }
  return cache.get(key);
 }
 async function loadHistoricalAssets(view){
  if(!view)return null;
  const [countries,borders]=await Promise.all([
   Promise.all(view.slots.filter(slot=>slot>=baseSlots.length).map(async slot=>{
    const row=spec.historicalCountries[slot-baseSlots.length].countries;
    const key=globeMeshResourceKey(row);
    return {slot,key,mesh:await historicalResource(historicalCountries,key,()=>loadMesh(row))};
   })),
   Promise.all(view.borders.map(async index=>{
    const row=spec.historicalBorders[index];
    return {key:row.sha256,packet:await historicalResource(historicalBorders,row.sha256,()=>load(row,decodeGlobeStrokes))};
   })),
  ]);
  return {countries,borders};
 }
 async function prepareDatedTerritories(month,references,{isCurrent=()=>true}={}){
  const prepared=requireTerritorialGeometry(month,references);
  await loadHistoricalAssets(prepared.view);
  if(!isCurrent())throw Object.assign(Error('Territorial preparation superseded'),{name:'AbortError',cancelled:true});
 }
 let territorialRequest=0;
 async function setTerritorialFeatures(rows){
  const request=++territorialRequest,requestGeneration=generation;
  const month=state.timelineCursor;
  const identity=requirePhysicalSource(month,deps.physicalResources.physicalSourceIdentity);
  const prepared=requireTerritorialGeometry(month,featureRefs(rows));
  const [parts,nextPhysical]=await Promise.all([loadHistoricalAssets(prepared.view),physicalAssets.prepare(identity)]);
  if(disposed||request!==territorialRequest||requestGeneration!==generation||month!==state.timelineCursor)return false;
  territories=prepared;territoryParts=parts;physical=nextPhysical;activeSlots=new Set(prepared.slots);
  features=new Map(rows.map(row=>[String(row.id),row]));paintDirty=true;labelContentDirty=true;return true;
 }
 function updateLabelContent(){
  const namesVisible=territorialNamesVisible(state);
  const countries=territories.slots.flatMap(slot=>{
   const ref=refs[slot],metadata=labelsBySlot[slot];
   if(!metadata)return [];
   const row=features.get(ref.id),primaryName=deps.objectPresentation.territorialEntityName(row,{fallback:''});
   const settings=automaticLabelSettings('country',state.labelSettings[labelKey('territorial',ref.id)]||{});
   const lines=territorialNativeLabelRows(row,state.timelineCursor,{
    enabled:deps.preferences.userPreferences.labels.place.showNativeNames===true,primaryName,
   }).map(label=>label.text);
   return lines.length?[{ref,key:ref.key,area:metadata.area,
    coordinate:settings.pinned&&settings.manualPosition?settings.manualPosition:metadata.coordinate,
    minZoom:settings.minZoom,maxZoom:settings.maxZoom,lines,visible:namesVisible&&deps.objectRefVisible(ref)
      &&deps.layerPresentation.isLayerItemVisible('objectLabels',ref.id),
   }]:[];
  });
  const {rows:placeCandidates}=deps.countryLabelModel.placeLabelCandidates({zoom:view.zoom,geographicBounds:camera.geographicBounds()});
  const places=placeCandidates.filter(row=>row.viewportVisible||row.selected).flatMap(row=>{
   const ref=normalizeObjectRef({domain:'label',type:row.source.kind,id:row.source.id});
   if(!ref||!deps.objectRefVisible(ref))return [];
   return [{ref,key:ref.key,place:true,coordinate:row.coordinate,selected:row.selected,priority:row.priority,
    marker:['capital','city','town'].includes(row.source.kind)?row.source.kind:'',
    minZoom:row.minZoom,maxZoom:row.maxZoom,lines:row.rows.map(label=>label.text)}];
  });
  surface.labels.setCandidates([...countries,...places]);
  labelContentDirty=false;
 }
 function requestOutlines(){
  for(const slot of outlineSlots){
   if(requestedOutlines.has(slot))continue;
   requestedOutlines.add(slot);
   const row=slot===null?spec:slots[slot];
   loadOutlines(row.outlines,row.outlineOwners).then(data=>{
    if(disposed)return;
    surface.installOutlines(slot,data);
    paintDirty=true;
    invalidate('three-outlines-ready');
   }).catch(cause=>{
    requestedOutlines.delete(slot);
    if(!disposed)deps.feedback.reportOperationError(cause,'선택 윤곽선을 불러오지 못했습니다.','PL-THREE-OUTLINE-001');
   });
  }
 }
 function updatePaint(){
  const colors=layerStyle(state.layerPresentation,'objects').colorVisible!==false;
  const selected=selection?.selection;
  const candidates=deps.highlightCandidates(),candidateKeys=new Set(candidates.map(ref=>ref.key));
  const roles=new Uint8Array(refs.length),roleStyles=[{width:0,alpha:0}];
  if(style)for(const [role,code] of Object.entries(INTERACTION_ROLE_PRIORITY))roleStyles[code]=resolveMapStrokeStyle(style,role);
  const roleFor=ref=>selected?.primaryKey===ref.key?'primary':selected?.keys.includes(ref.key)?'secondary':
    selection?.hover?.key===ref.key?'hover':candidateKeys.has(ref.key)?'candidate':null;
  outlineSlots=new Set();
  surface.setCountryPaint(refs.map((ref,slot)=>{
   if(!activeSlots.has(slot))return {color:null,visible:false};
   const role=roleFor(ref);
   const visible=deps.objectRefVisible(ref);
   const appearance=role&&style?roleStyles[INTERACTION_ROLE_PRIORITY[role]]:null;
   if(appearance&&visible){
    roles[slot]=INTERACTION_ROLE_PRIORITY[role];
    if(appearance.width>0&&appearance.alpha>0)outlineSlots.add(slot<baseSlots.length?null:slot);
   }
   return {color:colors?deps.colorModel.territorialEntityColor(features.get(ref.id)):null,visible,
    highlight:appearance?{color:appearance.color,alpha:appearance.fillAlpha}:null};
  }));
  surface.setOutlinePaint(roles,roleStyles,style?.selection.color);
  if(ready)requestOutlines();
  const hydroRoles=new Map(),waterRoles=new Map();
  if(style)for(const ref of [...(selected?.items??[]),selection?.hover,...candidates]){
   if(ref?.domain!=='hydro'||!deps.objectRefVisible(ref))continue;
   const code=INTERACTION_ROLE_PRIORITY[roleFor(ref)],slot=hydroSlots.get(ref.id);
   if(slot!==undefined)hydroRoles.set(slot,code);
   waterRoles.set(ref.id,code);
  }
  surface.setHydroPaint(hydroRoles,waterRoles,roleStyles,style?.selection.color);
  for(const layer of ['lakes','rivers'])surface.setLayerVisibility(layer,state.layerVisibility[layer]!==false);
  surface.setLayerVisibility('borders',state.layerVisibility.objects!==false&&layerStyle(state.layerPresentation,'objects').boundaryVisible!==false);
  paintDirty=false;
 }
 function renderFrame(frame){
  const base={frameId:frame.frameId,viewRevision:frame.viewRevision,projectionRevision:frame.projectionRevision};
  if(!features||lost||error||!presentation.countrySourceAdmitted(territories.key))return {...base,deferred:true};
  surface.activateDatedView(territories.view,territoryParts);
  surface.activatePhysicalContext(physical);
  surface.setLayerVisibility('graticule',state.backgroundSettings?.graticule!==false&&state.resourceCapabilities?.graticule!==false);
  if(paintDirty)metrics.run('three.country-paint',updatePaint);
  if(labelContentDirty)metrics.run('three.label-content',updateLabelContent);
  const showRivers=state.layerVisibility.rivers!==false;
  if((!moving&&riverCamera!==camera)||riverVisible!==showRivers||riverContext!==physical){
   riverCamera=camera;riverVisible=showRivers;riverContext=physical;
   riverDetail.update(showRivers?selectGlobeRiverChunks(physical.spec.riverDetail,camera.geographicBounds(),view.zoom):[]);
  }
  metrics.run('three.submit-frame',()=>surface.draw(camera,viewport.width,viewport.height));
  drawCount++;lastFrame=frame;lastCamera=camera;acceptedFeatures=features;
  acceptedTerritories=territories;acceptedTerritoryParts=territoryParts;acceptedPhysical=physical;
  acceptedRiverChunks=riverDetail.activeEntries();
  presentation.markTemporalFrame(frame);emit('render');
  if(moving&&!pointers.size&&velocity){
   const now=performance.now(),dt=Math.min(32,now-lastPointerMove);lastPointerMove=now;
   const point=camera.frame.center;velocity=velocity.map(value=>value*Math.exp(-dt/135));
   if(Math.hypot(...velocity)<0.02)finishMovement();
   else setCamera(camera.drag(point,[point[0]+velocity[0]*dt,point[1]+velocity[1]*dt]));
  }
  return {...base,succeeded:true,presentationReady:true};
 }
 function commitVisualFrame(frame){
  const first=!ready;ready=true;
  if(!presentation.commitVisualFrame(frame)){ready=!first;return false;}
  if(first){metrics.publish();notify('ready','지도 표시 준비 완료');requestOutlines();}
  revision++;return true;
 }
 async function pickHydroFeatures(point,active,camera,lakeSlots,waterFeatures){
  const slots=new Set(lakeSlots);
  if(state.layerVisibility.rivers!==false&&camera.view.zoom>=active.spec.riverMinZoom){
   const chunks=[{row:{spec:active.spec.rivers,minZoom:active.spec.riverMinZoom},packet:active.rivers},
    ...acceptedRiverChunks.filter(({row})=>camera.view.zoom>=row.minZoom)];
   await Promise.all(chunks.map(async({row,packet})=>{
    if(!riverPickGrids.has(packet))riverPickGrids.set(packet,new Map());
    const gridSpec=row.spec.pickGrid;
    const grid=await historicalResource(riverPickGrids.get(packet),gridSpec.sha256,
     ()=>load(gridSpec,bytes=>decodeGlobePickGrid(bytes,packet.count)));
    for(const slot of pickGlobeStrokeSlots(packet,grid,camera,point))slots.add(slot);
   }));
  }
  if(!slots.size)return waterFeatures;
  if(!hydroMetadata){
   hydroMetadata=load(spec.hydroMetadata,bytes=>{
    const rows=JSON.parse(new TextDecoder().decode(bytes));
    if(!Array.isArray(rows)||rows.length!==spec.hydroCount)throw Error('Invalid Three.js hydro identities');
    rows.forEach((row,slot)=>hydroSlots.set(row.id,slot));
    return rows;
   });
   hydroMetadata.catch(()=>{hydroMetadata=null;});
  }
  const items=await hydroMetadata;
  return [...waterFeatures,...[...slots].map(slot=>items[slot])];
 }
 async function queryObjectRefs(point,{includeHydro=true,includeLabels=true}={}){
  if(!acceptedFeatures||framePreserved||!lastCamera)return [];
  const label=includeLabels?surface.labels.hitTest(point):null;
  if(label)return [label];
  const sampledCamera=lastCamera,active=acceptedPhysical,territory=acceptedTerritories,generationAtPick=generation,ray=sampledCamera.worldRay(point);
  if(!ray)return [];
  const isCurrent=()=>!disposed&&!framePreserved&&lastCamera===sampledCamera&&acceptedPhysical===active&&
   acceptedTerritories===territory&&generationAtPick===generation;
  const [waterHits,lakeHits]=await Promise.all([
   Promise.all(active.waters.map(({mesh})=>pickMesh(mesh,ray,undefined,{firstHit:true}))),
   Promise.all(state.layerVisibility.lakes===false?[]:active.lakes.filter(({minZoom})=>sampledCamera.view.zoom>=minZoom).map(({mesh})=>pickMesh(mesh,ray))),
  ]);
  if(!isCurrent())return [];
  const waters=active.waters.filter((_,index)=>waterHits[index].length>0),lakeSlots=lakeHits.flat();
  let hydroRefs=[];
  if(includeHydro){
   const candidates=await pickHydroFeatures(point,active,sampledCamera,lakeSlots,waters.map(row=>row.feature));
   if(!isCurrent())return [];
   const visible=[...new Map(candidates.filter(feature=>deps.physicalServices.isHydroFeatureVisible(feature)).map(feature=>[feature.id,feature])).values()];
   const missing=visible.filter(feature=>{
    const existing=deps.hydroModel.hydroFeatureById(feature.id);
    return !existing||existing.__awBounds!==feature.__awBounds;
   });
   if(missing.length)await deps.physicalResources.admitHydroFeatures(missing,{isCurrent});
   if(!isCurrent())return [];
   hydroRefs=visible.map(feature=>normalizeObjectRef({domain:'hydro',type:feature.properties.category,id:feature.id}));
  }
  if(waters.length||lakeSlots.length)return hydroRefs;
  const visibleSlot=slot=>territory.slots.includes(slot)&&deps.objectRefVisible(refs[slot]);
  const meshes=[...(acceptedTerritoryParts?.countries??[]).map(row=>row.mesh),assets.countries];
  const hits=await Promise.all(meshes.map(row=>pickMesh(row,ray,visibleSlot)));
  return isCurrent()?[...hydroRefs,...hits.flat().map(slot=>refs[slot])]:[];
 }
 function appearance(){paintDirty=true;invalidate('three-style');}
 const projection=Object.freeze({projectCoordinate:coord=>camera?.projectCoordinate(coord)??null,
  projectVisibleCoordinate:(coord,options)=>camera?.projectVisibleCoordinate(coord,options)??null,
  screenToGeo:point=>camera?.screenToGeo(point)??null,geographicBounds:()=>camera?.geographicBounds()??null});
 const getRuntimeState=()=>({renderer:unsupported?'failed':'three',mapReady:ready,webglContextLost:lost,projectRenderBlocked:Boolean(error),moving,
  temporalPresentationPending:presentation.temporalPending(),temporalSourceAdmitted:presentation.ticket?.sourceAdmitted!==false});
 return Object.freeze({kind:'three',projection,get loaded(){return loaded;},inputElement:()=>canvas,subscribeInput,isMoving:()=>moving,attach,initialize,
  cameraSnapshot:()=>camera?.view??null,getRenderPixelRatio:()=>window.devicePixelRatio||1,verifyLayout,syncCameraFromState,fitWorld,fitMapBounds,fitGeometry,
  isAtWorldView:()=>Boolean(viewport&&Math.abs(view.zoom-worldFit().zoom)<0.01&&Math.abs(view.center[0]-15)<0.1&&Math.abs(view.center[1]-12)<0.1),
  panBy(dx,dy){if(!camera)return false;beginMovement();const point=camera.frame.center;setCamera(camera.drag(point,[point[0]+dx,point[1]+dy]));finishMovement();return true;},
  setTerritorialFeatures,preparePhysicalContext,prepareDatedTerritories,
  setSelection(value){selection=value;paintDirty=true;},setInteractionStyle(value){style=value;appearance();},
  invalidateCountryColors:appearance,invalidateCountryPalette:appearance,invalidatePhysicalStyle:appearance,invalidateHydroVisibility:appearance,
  setRenderQuality:appearance,
  labelZoomVisibility:()=>({country:Boolean(camera&&camera.view.zoom>=COUNTRY_LABEL_MIN_ZOOM),
   places:Boolean(camera&&camera.view.zoom>=PLACE_DISPLAY_ZOOM_FLOOR)}),
  invalidateLabelContent(){labelContentDirty=true;},getPickingRevision:()=>revision,queryObjectRefs,
  setInitialMapLoading(value){initialLoading=value;},isStyleReady:()=>loaded,renderFrame,commitVisualFrame,
  canPresentVisualFrame:presentation.canPresentVisualFrame,prepareTemporalCountrySource:presentation.prepareTemporalCountrySource,
  beginTemporalViewTransition:presentation.beginTemporalViewTransition,admitTemporalViewTransition:presentation.admitTemporalViewTransition,
  finishTemporalViewTransition:presentation.finishTemporalViewTransition,waitForMapPresentation:presentation.waitForMapPresentation,
  waitForTemporalPresentation:presentation.waitForTemporalPresentation,getProjectGeneration:()=>generation,
  preserveTemporalFrame(){framePreserved=true;},isFramePreserved:()=>framePreserved,
  resetProjectRenderState(options){generation=options.generation;features=null;ready=false;error=null;presentation.resetForProject(options);},
  measureWork:metrics.track,measureSyncWork:metrics.run,failMapPreparation,retryMapPreparation,getRuntimeState,
  getStats:()=>({...getRuntimeState(),mapReadiness:readyState(),displayedRevision:ready?revision:0,sourceRevision:revision,
   generation,certifiedRevision:ready&&!lost&&!presentation.temporalPending()?revision:null,
   frameId:lastFrame?.frameId,drawCount,drawCalls:surface?.drawCalls()??0,performance:metrics.snapshot(),
   countrySlotCount:acceptedTerritories.slots.length,activeHistoricalTerritories:acceptedTerritoryParts?.countries.length??0,
   physicalWaterIds:acceptedPhysical?.waters.map(row=>row.id)??[],
   countryLabelCount:surface?.labels.visibleCount(false)??0,
   placeLabelCount:surface?.labels.visibleCount(true)??0,riverDetail:riverDetail?.stats()??null,
   labelAtlasEntries:surface?.labels.atlasEntryCount()??0,errorMessage:error?.message??null,initialLoading}),
  dispose(){disposed=true;clearTimeout(moveTimer);lifetime.abort();presentation.dispose();events.clear();riverDetail?.dispose();surface?.dispose();canvas?.remove();},
 });
}
