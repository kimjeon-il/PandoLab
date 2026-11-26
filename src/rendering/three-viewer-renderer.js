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
import {globeMeshResourceKey,globeTerritoryKey} from './globe-mesh.js';
import {createGlobeHistoryIndex} from './globe-history-index.js';
import {createGlobeTemporalPresentation} from './globe-temporal-presentation.js';
import {createGlobePacketTasks} from './globe-packet-tasks.js';
import {globeRayIntersectsBounds,globeStrokePickPredicate,createGlobePacketIndex,createGlobePickBudget,pickGlobeSlotsCooperative,pickGlobeStrokeSlotsCooperative} from './globe-picking.js';
import {createMapPresentationSession} from './map-presentation-session.js';
import {createThreeGlobeSurface} from './three-globe-surface.js';
import {createRenderingMetrics} from './rendering-metrics.js';
import {createGlobeRiverDetail,selectGlobeRiverChunks} from './three-globe-rivers.js';
import {createRenderPacketCache,renderCacheBudget,createRenderResidencyBudget,createRenderLoadGate} from './render-cache-budget.js';
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
 const historyIndex=createGlobeHistoryIndex(spec.history,baseSlots.length);
 const baseTerritories=historyIndex.base;
 const cacheBudget=renderCacheBudget();
 const residency=createRenderResidencyBudget(cacheBudget.totalRenderBytes,{groups:{
  outline:{byteBudget:cacheBudget.outlineBytes},
  outlinePacket:{entryLimit:128},
  outlineChunk:{byteBudget:Math.floor(cacheBudget.outlineBytes/4),entryLimit:64,standbyOnly:true},
 }});
 const historicalCache=createRenderPacketCache({byteBudget:cacheBudget.historicalCpuBytes,residency});
 const loadGate=createRenderLoadGate({concurrency:cacheBudget.concurrentLoads,byteBudget:cacheBudget.pendingBytes});
 const hydroMetadataCache=createRenderPacketCache({byteBudget:16*1024*1024,entryLimit:1});
 let refreshRiverLedger=()=>{},refreshHydroLedger=()=>{};
 let acceptedPick=null,drawnFrame=null,countryPaintInputsDirty=true,basePaint=new Map(),visiblePaintSlots=new Set(),residencyDirty=true;
 const temporalInputs=createGlobeTemporalPresentation(),dirtyPaintSlots=new Set(),dirtyCountryLabels=new Set(),countryLabels=new Map();
 let allCountryLabelsDirty=true,countryLabelList=[],temporalStats={};
 const pendingOutlines=new Map(),requestScopes=new Map();
 let prefetchView=null,prefetchPhysical=null,visiblePhysicalPlan=null,publishedView=null,publishedPhysical=null;
 let visiblePhysicalFailed=null,fontReady=false,fontPending=null,fontFailed=false,lastLabelsNeeded=false;
 const failedLineLayers=new Set();
 const invalidate=reason=>deps.domains.renderingDomain.invalidateView(reason);
 const events=new Map(),pointers=new Map(),lifetime=new AbortController();
 const metrics=createRenderingMetrics(),packetTasks=createGlobePacketTasks();
 let host,canvas,surface,assets,camera,viewport,pending,disposed=false,lost=false,loaded=false,ready=false,error;
 let generation=0,contextRevision=0,revision=0,lastFrame=null,lastCamera=null,features=null;
 let territories=baseTerritories,acceptedTerritories=baseTerritories,territoryParts=null,acceptedTerritoryParts=null,activeSlots=new Set(baseTerritories.slots);
 let selection=null,style=null,paintDirty=true,fullPaintDirty=true,moving=false,moveTimer,velocity,pointerTravel=0,lastPointerMove=0;
 let activeSlotByKey=new Map(baseTerritories.slots.map(slot=>[refs[slot].key,slot]));
 let countryRoles=new Map(),pickingRevision=0,pickingChanged=false;
 let outlineSlots=new Set();
 let labelContentDirty=true;
 let framePreserved=false,initialLoading=true,drawCount=0,unsupported=false;
 let riverDetail,riverCamera=null,riverVisible=null,riverContext=null;
 let physical=null,acceptedPhysical=null;
 let acceptedRiverChunks=[],hydroMetadata=null;
 const hydroSlots=new Map();
 let view={center:[15,12],zoom:2,bearing:0,pitch:0,roll:0};
 const readyState=()=>({mapReady:ready,status:error?'error':ready?'ready':'loading'});
 const presentation=createMapPresentationSession({getGeneration:()=>generation,getContextRevision:()=>contextRevision,
  isDisposed:()=>disposed,getReadiness:readyState,invalidateFrame:invalidate,prepareContentKey:rows=>requireTerritorialGeometry(state.timelineCursor,featureRefs(rows)).key,
  isProjectBlocked:()=>Boolean(error),isRecoveryFrameAdmissible:()=>!lost,
  waitForCanonicalFrame:()=>presentation.waitForMapPresentation(generation),onTemporalRetired:()=>{framePreserved=false;}});

 function startRequest(name){
  const previous=requestScopes.get(name),controller=new AbortController();
  requestScopes.set(name,controller);previous?.abort();return controller;
 }
 const requestCurrent=(name,controller)=>requestScopes.get(name)===controller&&!controller.signal.aborted&&!disposed;
 function finishRequest(name,controller){if(requestScopes.get(name)===controller)requestScopes.delete(name);}
 function cancelRequest(name){
  const controller=requestScopes.get(name);requestScopes.delete(name);controller?.abort();
 }
 function clearPreparation(){
  for(const name of ['country-prefetch','physical-prefetch','territory-apply','physical-view','pick-click','pick-hover'])cancelRequest(name);
  prefetchView=null;prefetchPhysical=null;visiblePhysicalPlan=null;visiblePhysicalFailed=null;
  retainCpuResources();
 }
 function cancelOutlines(){
  for(const controller of pendingOutlines.values())controller.abort();
  pendingOutlines.clear();
 }
 function beginTemporalViewTransition(...args){clearPreparation();return presentation.beginTemporalViewTransition(...args);}
 function finishTemporalViewTransition(token){
  const current=presentation.ticket?.token===token;
  const accepted=presentation.ticket?.presented;
  const result=presentation.finishTemporalViewTransition(token);
  if(current&&!accepted)clearPreparation();
  return result;
 }
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
 function retryMapPreparation(){error=null;visiblePhysicalFailed=null;failedLineLayers.clear();fontFailed=false;return invalidate('map-retry');}
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
  listen('webglcontextrestored',()=>{lost=false;contextRevision++;surface?.restoreCountryPaint();pickingChanged=true;presentation.rebaseContext();invalidate('three-context-restored');});
 }

 function attach(element){
  host=element;canvas=document.createElement('canvas');
  canvas.style.cssText='display:block;width:100%;height:100%;touch-action:none';
  host.appendChild(canvas);installInput();
 }
 const loader=createStoredAssetLoader({dataRevision:meta.dataRevision,cachePolicy:'immutable',deferCacheWrite:true,resolveUrl:row=>new URL(row.url,document.baseURI).href});
 async function load(row,kind,{phase='startup',label='Three.js 지도 자산',signal=lifetime.signal,priority=phase==='startup'?10:0,...parameters}={}){
  const estimate=(Number(row.compressedBytes)||0)+Math.max(1,Number(row.decodedBytes)||0)*4;
  return loadGate.run({bytes:estimate,priority,signal},async()=>{
   const result=await loader.loadStoredAsset(row,phase,row.sha256,label,bytes=>
    metrics.track('three.decode-packet',()=>packetTasks.decode(kind,bytes,row,{signal,priority,...parameters})),signal);
   return result.value;
  });
 }
 const loadMesh=async(row,signal)=>({packet:await load(row,'mesh',{signal})});
 async function loadOutlines(row,owners,signal){
  if(!owners.length||owners.some(group=>!group.length||group.some(slot=>!Number.isInteger(slot)||slot<0||slot>=slots.length)))
   throw Error('Invalid globe outline owners');
  const packet=await load(row,'stroke',{phase:'background',label:'선택 윤곽선',signal,ownerCount:owners.length});
  return {packet,owners};
 }
 const graticuleNeeded=()=>state.backgroundSettings?.graticule!==false&&state.resourceCapabilities?.graticule!==false;
 const bordersNeeded=()=>state.layerVisibility.objects!==false&&layerStyle(state.layerPresentation,'objects').boundaryVisible!==false;
 async function loadAssets(){
  const [countries,borders,graticule]=await Promise.all([
   loadMesh(spec.countries),bordersNeeded()?load(spec.borders,'stroke'):null,
   graticuleNeeded()?load(spec.graticule,'stroke'):null,
  ]);
  return {countries,borders,graticule};
 }
 const physicalAssets=createGlobePhysicalAssets([spec.physical,...spec.physicalContexts],{
  loadMesh,loadStroke:(row,signal)=>load(row,'stroke',{signal}),byteBudget:cacheBudget.physicalCpuBytes,residency,
 });
 const physicalPlan=identity=>physicalAssets.plan(identity,{zoom:view.zoom,
  lakesVisible:state.layerVisibility.lakes!==false,riversVisible:state.layerVisibility.rivers!==false});
 function initialize(){
  if(pending)return pending;
  pending=(async()=>{
   notify('loading','지도 불러오는 중');
   const context=canvas.getContext('webgl2',{alpha:false,antialias:true});
   if(!context){unsupported=true;throw Error('Three.js requires WebGL2');}
   const threeUrl=new URL(spec.moduleUrl,document.baseURI);
   const [THREE,packets,restored]=await Promise.all([import(threeUrl.href),metrics.track('three.prepare-assets',loadAssets),initialCamera]);
   lifetime.signal.throwIfAborted();assets=packets;
   surface=createThreeGlobeSurface(THREE,{canvas,context,palette:deps.preferences.mapPalette(),countryCount:slots.length,hydroCount:spec.hydroCount,cacheBudget,residency,packets:{
    countries:assets.countries.packet,borders:assets.borders,borderGroupCount:spec.borderOwners.length,graticule:assets.graticule,
   }});
   // Each resident detail packet has a CPU copy and one GPU copy of its arrays.
   riverDetail=createGlobeRiverDetail({byteBudget:cacheBudget.hydroBytes,
    load:(row,signal)=>load(row.spec,'stroke',{phase:'background',label:'Three.js 상세 하천',signal}),
    attach:surface.attachRiverDetail,invalidate:()=>{refreshRiverLedger();residencyDirty=true;invalidate('three-river-detail');},
    onError:cause=>deps.feedback.reportOperationError(cause,'상세 하천을 불러오지 못했습니다.','PL-THREE-RIVER-001'),
   });
   refreshRiverLedger=residency.register(riverDetail.memoryEntries);
   refreshHydroLedger=residency.register(()=>hydroMetadata?[{protected:true,extraBytes:Math.max(0,Number(spec.hydroMetadata.decodedBytes)||0)*2+hydroSlots.size*64}]:[]);
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
  const controller=startRequest('physical-prefetch');
  const assertCurrent=()=>{if(!requestCurrent('physical-prefetch',controller)||!isCurrent())
   throw Object.assign(new Error('Physical preparation superseded'),{name:'AbortError',cancelled:true});};
  let target;
  try{
   assertCurrent();await initialize();assertCurrent();
   target=physicalPlan(requirePhysicalSource(month,deps.physicalResources.physicalSourceIdentityAtMonth(month)));
   prefetchPhysical=target;retainCpuResources();
   await physicalAssets.prepare(target,{signal:controller.signal});
   assertCurrent();return true;
  }catch(error){
   if(requestCurrent('physical-prefetch',controller)&&prefetchPhysical===target){prefetchPhysical=null;retainCpuResources();}
   throw error;
  }finally{controller.abort();finishRequest('physical-prefetch',controller);}
 }
 function requireTerritorialGeometry(month,references){
  const active=[];
  for(const [id,reference] of references){
   const slot=slotByKey.get(globeTerritoryKey(id,reference));
   if(slot===undefined||(reference.contentSha256!==undefined&&reference.contentSha256!==slots[slot].geometry.contentSha256))break;
   active.push(slot);
  }
  const match=active.length===references.size?historyIndex.find(active.sort((a,b)=>a-b)):null;
  if(!match)throw Object.assign(Error(`${month}에 준비된 Three.js 영토 형상이 없습니다.`),{code:'PL-THREE-IDENTITY'});
  return match;
 }
 function featureRefs(rows){return new Map(rows.map(row=>[String(row.id),geometryReferenceFor(row.geometry)]));}
 const countryCacheKey=row=>'country:'+globeMeshResourceKey(row);
 const borderPlans=new WeakMap();
 function borderBatchPlans(view){
  if(!view?.borders.length)return [];
  if(borderPlans.has(view))return borderPlans.get(view);
  const plans=[];let rows=[],bytes=0;
  function flush(){if(!rows.length)return;plans.push({rows,key:'border-batch:'+rows.map(row=>row.sha256).join(','),bytes});rows=[];bytes=0;}
  for(const index of view.borders){
   const row=spec.historicalBorders[index],size=Math.max(1,Number(row.decodedBytes)||0);
   if(rows.length&&(rows.length>=32||bytes+size>cacheBudget.borderBatchBytes))flush();
   rows.push(row);bytes+=size;
  }
  flush();borderPlans.set(view,plans);return plans;
 }
 function historicalKeys(view){
  if(!view)return [];
  return [...view.slots.filter(slot=>slot>=baseSlots.length).map(slot=>
   countryCacheKey(spec.historicalCountries[slot-baseSlots.length].countries)),...borderBatchPlans(view).map(row=>row.key)];
 }
 function retainCpuResources(){
  if(disposed)return;
  residencyDirty=true;
  const views=new Set([prefetchView,territories.view,publishedView]);
  historicalCache.retain([...views].flatMap(historicalKeys));
  physicalAssets.retain([prefetchPhysical,visiblePhysicalPlan,physical?.plan,publishedPhysical?.plan]);
 }
 async function loadBorderBatches(view,signal){
  const batches=[];
  // Bound the original packets held by a merge and avoid cloning their
  // display indexes. Keep every completed batch independently reusable.
  for(const plan of borderBatchPlans(view)){
   signal?.throwIfAborted();
   const packet=await historicalCache.read(plan.key,async readSignal=>{
    if(plan.rows.length===1)return load(plan.rows[0],'stroke',{signal:readSignal});
    // Reserve the complete working set before loading any member. The
    // loader still verifies each content hash and keeps its disk cache.
    // Only private compressed copies cross the Worker boundary.
    const estimate=plan.rows.reduce((sum,row)=>sum+(Number(row.compressedBytes)||0)*2+(Number(row.decodedBytes)||0)*5,0);
    return loadGate.run({bytes:estimate,priority:10,signal:readSignal},async()=>{
     const inputs=[];
     for(const row of plan.rows){
      readSignal.throwIfAborted();
      const result=await loader.loadStoredAsset(row,'startup',row.sha256,'역사 국경선',bytes=>bytes,readSignal);
      inputs.push({bytes:result.value,spec:row});
     }
     readSignal.throwIfAborted();
     return metrics.track('three.combine-borders',()=>packetTasks.combineStoredStrokes(inputs,{signal:readSignal}));
    });
   },signal);
   batches.push({key:plan.key,packet});
  }
  return batches;
 }
 async function loadHistoricalAssets(view,signal){
  if(!view)return null;
  const [countries,borderBatches]=await Promise.all([
   Promise.all(view.slots.filter(slot=>slot>=baseSlots.length).map(async slot=>{
    const row=spec.historicalCountries[slot-baseSlots.length].countries;
    const key=globeMeshResourceKey(row);
    return {slot,key,mesh:await historicalCache.read(countryCacheKey(row),readSignal=>loadMesh(row,readSignal),signal)};
   })),
   loadBorderBatches(view,signal),
  ]);
  return {countries,borderBatches};
 }
 async function prepareDatedTerritories(month,references,{isCurrent=()=>true}={}){
  const prepared=requireTerritorialGeometry(month,references);
  const controller=startRequest('country-prefetch');
  prefetchView=prepared.view;retainCpuResources();
  try{
   if(!isCurrent())throw Object.assign(Error('Territorial preparation superseded'),{name:'AbortError',cancelled:true});
   if(prepared.key!==territories.key||!features)await loadHistoricalAssets(prepared.view,controller.signal);
   if(!requestCurrent('country-prefetch',controller)||!isCurrent())throw Object.assign(Error('Territorial preparation superseded'),{name:'AbortError',cancelled:true});
  }catch(error){
   if(requestCurrent('country-prefetch',controller)&&prefetchView===prepared.view){prefetchView=null;retainCpuResources();}
   throw error;
  }finally{controller.abort();finishRequest('country-prefetch',controller);}
 }
 let territorialRequest=0;
 async function setTerritorialFeatures(rows,{sourceRows=rows}={}){
  const request=++territorialRequest,requestGeneration=generation;
  const month=state.timelineCursor;
  const identity=requirePhysicalSource(month,deps.physicalResources.physicalSourceIdentity);
  const prepared=requireTerritorialGeometry(month,featureRefs(rows));
  const controller=startRequest('territory-apply'),target=physicalPlan(identity);
  cancelRequest('physical-view');visiblePhysicalPlan=null;visiblePhysicalFailed=null;
  prefetchView=prepared.view;prefetchPhysical=target;retainCpuResources();
  try{
   const [parts,nextPhysical]=await Promise.all([
    prepared.key===territories.key&&features?territoryParts:loadHistoricalAssets(prepared.view,controller.signal),physicalAssets.prepare(target,{signal:controller.signal}),
   ]);
   if(!requestCurrent('territory-apply',controller)||request!==territorialRequest||requestGeneration!==generation||month!==state.timelineCursor)return false;
   const delta=temporalInputs.advance(sourceRows,month);
   const previousSlots=activeSlots,geometryChanged=prepared.key!==territories.key||!features;
   if(geometryChanged){
    territories=prepared;territoryParts=parts;activeSlots=new Set(prepared.slots);
    activeSlotByKey=new Map(prepared.slots.map(slot=>[refs[slot].key,slot]));pickingChanged=true;
    for(const slot of previousSlots)if(!activeSlots.has(slot)){dirtyPaintSlots.add(slot);dirtyCountryLabels.add(slot);}
    for(const slot of activeSlots)if(!previousSlots.has(slot)){dirtyPaintSlots.add(slot);dirtyCountryLabels.add(slot);}
   }
   if(physical!==nextPhysical){physical=nextPhysical;pickingChanged=true;paintDirty=true;}
   if(!features||geometryChanged)features=new Map(rows.map(row=>[String(row.id),row]));
   else for(const id of delta.changedIds){
    const row=temporalInputs.get(id);
    if(row?.properties?.entityKind==='general')features.set(id,row);else features.delete(id);
   }
   for(const id of delta.dirtyIds){
    const key=normalizeObjectRef({domain:'territorial',type:'entity',id}).key,slot=activeSlotByKey.get(key);
    if(slot!==undefined){dirtyPaintSlots.add(slot);dirtyCountryLabels.add(slot);}
   }
   if(delta.first){countryPaintInputsDirty=true;allCountryLabelsDirty=true;}
   temporalStats={examinedRows:delta.examined,receipt:delta.receipt,changedRows:delta.changedIds.size,dirtyPaintSlots:dirtyPaintSlots.size,dirtyCountryLabels:dirtyCountryLabels.size};
   paintDirty||=dirtyPaintSlots.size>0||countryPaintInputsDirty;labelContentDirty=true;return true;
  }catch(error){
   if(controller.signal.aborted)return false;
   throw error;
  }finally{
   if(requestScopes.get('territory-apply')===controller){
    prefetchView=null;prefetchPhysical=null;retainCpuResources();
   }
   controller.abort();finishRequest('territory-apply',controller);
  }
 }
 // Zoom/visibility changes only request newly necessary physical tiers.
 // Keep the already published same-date context during ordinary camera input.
 function ensureVisiblePhysical(){
  if(!physical)return false;
  const target=physicalPlan(physical.spec.identity);
  if(physical.plan.key===target.key){
   if(visiblePhysicalPlan){cancelRequest('physical-view');visiblePhysicalPlan=null;retainCpuResources();}
   visiblePhysicalFailed=null;return true;
  }
  if(visiblePhysicalPlan?.key===target.key||visiblePhysicalFailed===target.key)return false;
  const controller=startRequest('physical-view'),requestedGeneration=generation;
  visiblePhysicalPlan=target;retainCpuResources();
  physicalAssets.prepare(target,{signal:controller.signal}).then(next=>{
   if(!requestCurrent('physical-view',controller)||generation!==requestedGeneration||
    physical?.spec.identity!==target.spec.identity||physicalPlan(target.spec.identity).key!==target.key)return;
   physical=next;paintDirty=fullPaintDirty=true;pickingChanged=true;invalidate('three-physical-tier-ready');
  }).catch(error=>{
   if(!requestCurrent('physical-view',controller))return;
   visiblePhysicalFailed=target.key;
   if(!ready||framePreserved)failMapPreparation(error);
   else deps.feedback.reportOperationError(error,'확대 수준의 수역을 불러오지 못했습니다.','PL-THREE-HYDRO-TIER-001');
  }).finally(()=>{
   if(requestScopes.get('physical-view')===controller){visiblePhysicalPlan=null;retainCpuResources();}
   controller.abort();finishRequest('physical-view',controller);
  });
  return false;
 }
 function ensureLineLayer(name,wanted,has,install,row,label){
  surface.setLayerVisibility(name,wanted);
  if(!wanted){cancelRequest(name);failedLineLayers.delete(name);return true;}
  if(has())return true;
  if(failedLineLayers.has(name)||requestScopes.has(name))return false;
  const controller=startRequest(name);
  load(row,'stroke',{phase:'background',label,signal:controller.signal}).then(packet=>{
   if(!requestCurrent(name,controller))return;
   install(packet);invalidate('three-'+name+'-ready');
  }).catch(error=>{
   if(!requestCurrent(name,controller))return;
   failedLineLayers.add(name);
   if(!ready||framePreserved)failMapPreparation(error);
   else deps.feedback.reportOperationError(error,label+'을 불러오지 못했습니다.','PL-THREE-LINE-LAYER-001');
  }).finally(()=>finishRequest(name,controller));
  return false;
 }
 function labelsNeeded(){
  return view.zoom>=COUNTRY_LABEL_MIN_ZOOM&&territorialNamesVisible(state)||view.zoom>=PLACE_DISPLAY_ZOOM_FLOOR&&state.layerVisibility.labels!==false;
 }
 function ensureLabelFont(){
  const wanted=labelsNeeded();
  if(wanted!==lastLabelsNeeded){lastLabelsNeeded=wanted;labelContentDirty=true;}
  if(!wanted||fontReady)return true;
  if(fontPending||fontFailed)return false;
  fontPending=document.fonts.load('800 56px "Pretendard Variable"','대한민국').then(()=>{
   if(disposed)return;
   fontReady=true;labelContentDirty=true;invalidate('three-label-font-ready');
  }).catch(error=>{
   if(disposed)return;
   fontFailed=true;
   if(labelsNeeded()&&(!ready||framePreserved))failMapPreparation(error);
   else deps.feedback.reportOperationError(error,'지도 글꼴을 불러오지 못했습니다.','PL-THREE-FONT-001');
  }).finally(()=>{fontPending=null;});
  return false;
 }
 function updateLabelContent(){
  if(!labelsNeeded()||!fontReady){surface.labels.setCandidateGroups([],[]);labelContentDirty=false;return;}
  const namesVisible=territorialNamesVisible(state)&&view.zoom>=COUNTRY_LABEL_MIN_ZOOM;
  if(namesVisible){
   const changed=allCountryLabelsDirty?new Set([...countryLabels.keys(),...activeSlots]):dirtyCountryLabels;
   for(const slot of changed){
    if(!activeSlots.has(slot)){countryLabels.delete(slot);continue;}
    const ref=refs[slot],metadata=labelsBySlot[slot];
    if(!metadata){countryLabels.delete(slot);continue;}
    const row=features.get(ref.id),primaryName=deps.objectPresentation.territorialEntityName(row,{fallback:''});
    const settings=automaticLabelSettings('country',state.labelSettings[labelKey('territorial',ref.id)]||{});
    const lines=territorialNativeLabelRows(row,state.timelineCursor,{
     enabled:deps.preferences.userPreferences.labels.place.showNativeNames===true,primaryName,
    }).map(label=>label.text);
    if(lines.length)countryLabels.set(slot,{ref,key:ref.key,area:metadata.area,shortSide:metadata.shortSide,
     coordinate:settings.pinned&&settings.manualPosition?settings.manualPosition:metadata.coordinate,
     minZoom:settings.minZoom,maxZoom:settings.maxZoom,lines,visible:deps.objectRefVisible(ref)
       &&deps.layerPresentation.isLayerItemVisible('objectLabels',ref.id)});
    else countryLabels.delete(slot);
   }
   if(changed.size||allCountryLabelsDirty)countryLabelList=[...countryLabels.values()];
   allCountryLabelsDirty=false;dirtyCountryLabels.clear();
  }
  const placeCandidates=view.zoom>=PLACE_DISPLAY_ZOOM_FLOOR&&state.layerVisibility.labels!==false?
   deps.countryLabelModel.placeLabelCandidates({zoom:view.zoom,geographicBounds:camera.geographicBounds()}).rows:[];
  const places=placeCandidates.filter(row=>row.viewportVisible||row.selected).flatMap(row=>{
   const ref=normalizeObjectRef({domain:'label',type:row.source.kind,id:row.source.id});
   if(!ref||!deps.objectRefVisible(ref))return [];
   return [{ref,key:ref.key,place:true,coordinate:row.coordinate,selected:row.selected,priority:row.priority,
    marker:['capital','city','town'].includes(row.source.kind)?row.source.kind:'',
    minZoom:row.minZoom,maxZoom:row.maxZoom,lines:row.rows.map(label=>label.text)}];
  });
  surface.labels.setCandidateGroups(namesVisible?countryLabelList:[],places);labelContentDirty=false;
 }
 function requestOutlines(){
  for(const [slot,controller] of pendingOutlines)if(!outlineSlots.has(slot)){
   pendingOutlines.delete(slot);controller.abort();
  }
  for(const slot of outlineSlots){
   if(pendingOutlines.has(slot)||surface.hasOutlines(slot))continue;
   const controller=new AbortController();pendingOutlines.set(slot,controller);
   const row=slot===null?spec:slots[slot];
   loadOutlines(row.outlines,row.outlineOwners,controller.signal).then(data=>{
    if(disposed||controller.signal.aborted||pendingOutlines.get(slot)!==controller||!outlineSlots.has(slot))return;
    surface.installOutlines(slot,data);paintDirty=true;invalidate('three-outlines-ready');
   }).catch(cause=>{
    if(!disposed&&!controller.signal.aborted)deps.feedback.reportOperationError(cause,'선택 윤곽선을 불러오지 못했습니다.','PL-THREE-OUTLINE-001');
   }).finally(()=>{if(pendingOutlines.get(slot)===controller)pendingOutlines.delete(slot);});
  }
 }
 function updatePaint(){
  const colors=layerStyle(state.layerPresentation,'objects').colorVisible!==false;
  const selected=selection?.selection,selectedKeys=new Set(selected?.keys??[]);
  const candidates=deps.highlightCandidates(),candidateKeys=new Set(candidates.map(ref=>ref.key));
  const roleStyles=[{width:0,alpha:0}];
  if(style)for(const [role,code] of Object.entries(INTERACTION_ROLE_PRIORITY))roleStyles[code]=resolveMapStrokeStyle(style,role);
  const roleFor=ref=>selected?.primaryKey===ref.key?'primary':selectedKeys.has(ref.key)?'secondary':
    selection?.hover?.key===ref.key?'hover':candidateKeys.has(ref.key)?'candidate':null;
  const nextRoles=new Map();
  outlineSlots=new Set();
  if(style){
   const keys=new Set([...selectedKeys,selected?.primaryKey,selection?.hover?.key,...candidateKeys]);
   for(const key of keys){
    const slot=activeSlotByKey.get(key);
    if(slot===undefined||!deps.objectRefVisible(refs[slot]))continue;
    const code=INTERACTION_ROLE_PRIORITY[roleFor(refs[slot])],appearance=roleStyles[code];
    if(!appearance)continue;
    nextRoles.set(slot,code);
    if(appearance.width>0&&appearance.alpha>0)outlineSlots.add(slot<baseSlots.length?null:slot);
   }
  }
  const changed=new Set([...countryRoles.keys(),...nextRoles.keys()].filter(slot=>countryRoles.get(slot)!==nextRoles.get(slot)));
  if(fullPaintDirty||countryPaintInputsDirty||dirtyPaintSlots.size){
   const pendingSlots=fullPaintDirty||countryPaintInputsDirty?new Set([...basePaint.keys(),...activeSlots]):dirtyPaintSlots;
   let nextVisible=null;
   for(const slot of pendingSlots){
    const previous=basePaint.get(slot);
    if(!activeSlots.has(slot)){
     if(previous){basePaint.delete(slot);changed.add(slot);}
     if(visiblePaintSlots.has(slot)){nextVisible??=new Set(visiblePaintSlots);nextVisible.delete(slot);}
     continue;
    }
    const ref=refs[slot],color=colors?deps.colorModel.territorialEntityColor(features.get(ref.id)):null,visible=Boolean(deps.objectRefVisible(ref));
    if(!previous||previous.color!==color||previous.visible!==visible){basePaint.set(slot,{color,visible});changed.add(slot);}
    if(visible!==visiblePaintSlots.has(slot)){
     nextVisible??=new Set(visiblePaintSlots);if(visible)nextVisible.add(slot);else nextVisible.delete(slot);
    }
   }
   if(nextVisible){visiblePaintSlots=nextVisible;pickingChanged=true;}
   countryPaintInputsDirty=false;dirtyPaintSlots.clear();
  }
  if(fullPaintDirty)for(const slot of new Set([...countryRoles.keys(),...nextRoles.keys()]))changed.add(slot);
  surface.setCountryPaint([...changed].map(slot=>{
   const base=basePaint.get(slot)??{color:null,visible:false},appearance=roleStyles[nextRoles.get(slot)];
   return [slot,{...base,highlight:appearance?{color:appearance.color,alpha:appearance.fillAlpha}:null}];
  }),{full:changed.size>Math.max(64,activeSlots.size/2)});
  countryRoles=nextRoles;
  surface.setOutlinePaint(nextRoles,roleStyles,style?.selection.color);
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
  paintDirty=fullPaintDirty=false;
 }
 function renderFrame(frame){
  const base={frameId:frame.frameId,viewRevision:frame.viewRevision,projectionRevision:frame.projectionRevision};
  if(!features||lost||error||!presentation.countrySourceAdmitted(territories.key))return {...base,deferred:true};
  const physicalReady=ensureVisiblePhysical(),fontAvailable=ensureLabelFont();
  const graticuleReady=ensureLineLayer('graticule',graticuleNeeded(),surface.hasGraticule,surface.installGraticule,spec.graticule,'경위선');
  const bordersReady=ensureLineLayer('borders',bordersNeeded(),surface.hasBaseBorders,surface.installBaseBorders,spec.borders,'기본 국경선');
  if((!ready||framePreserved)&&(!physicalReady||!graticuleReady||!bordersReady||!fontAvailable))return {...base,deferred:true};
  surface.activateDatedView(territories.view,territoryParts);
  surface.activatePhysicalContext(physical);
  pickingChanged||=lastCamera!==camera||acceptedTerritories!==territories||acceptedPhysical!==physical;
  if(paintDirty)metrics.run('three.country-paint',updatePaint);
  if(labelContentDirty)metrics.run('three.label-content',updateLabelContent);
  const showRivers=state.layerVisibility.rivers!==false;
  if((!moving&&riverCamera!==camera)||riverVisible!==showRivers||riverContext!==physical){
   riverCamera=camera;riverVisible=showRivers;riverContext=physical;
   if(riverDetail.update(showRivers?selectGlobeRiverChunks(physical.spec.riverDetail,camera.geographicBounds(),view.zoom):[])){refreshRiverLedger();residencyDirty=true;}
  }
  metrics.run('three.submit-frame',()=>surface.draw(camera,viewport.width,viewport.height));
  drawCount++;
  drawnFrame={frame,camera,territories,territoryParts,physical,visibleSlots:visiblePaintSlots,riverChunks:riverDetail.activeEntries(),
   labelHit:surface.labels.hitSnapshot(),lakesVisible:state.layerVisibility.lakes!==false,riversVisible:showRivers,generation};
  presentation.markTemporalFrame(frame);
  if(moving&&!pointers.size&&velocity){
   const now=performance.now(),dt=Math.min(32,now-lastPointerMove);lastPointerMove=now;
   const point=camera.frame.center;velocity=velocity.map(value=>value*Math.exp(-dt/135));
   if(Math.hypot(...velocity)<0.02)finishMovement();
   else setCamera(camera.drag(point,[point[0]+velocity[0]*dt,point[1]+velocity[1]*dt]));
  }
  return {...base,succeeded:true,presentationReady:true};
 }
 function publishPickSnapshot(draw){
  const previous=acceptedPick,riverChunks=draw.riverChunks;
  const sameRivers=previous&&riverChunks.length===previous.riverChunks.length&&riverChunks.every((row,i)=>row.packet===previous.riverChunks[i].packet);
  const sameCountries=previous&&draw.territoryParts===previous.territoryParts;
  const samePhysical=previous&&draw.physical===previous.physical;
  if(!pickingChanged&&previous&&previous.generation===draw.generation&&previous.camera===draw.camera&&sameCountries&&samePhysical&&sameRivers&&
    previous.visibleSlots===draw.visibleSlots&&previous.labelHit===draw.labelHit&&previous.lakesVisible===draw.lakesVisible&&previous.riversVisible===draw.riversVisible)return;
  const active=draw.physical;
  cancelRequest('pick-click');cancelRequest('pick-hover');
  acceptedPick={...draw,
   countryIndex:sameCountries?previous.countryIndex:createGlobePacketIndex([...(draw.territoryParts?.countries??[]).map(row=>row.mesh),assets.countries],row=>row.packet.spatialBounds),
   waterIndex:samePhysical?previous.waterIndex:createGlobePacketIndex(active.waters,row=>row.mesh.packet.spatialBounds),
   lakeIndex:samePhysical?previous.lakeIndex:createGlobePacketIndex(active.lakes,row=>row.mesh.packet.spatialBounds),
   riverIndex:samePhysical&&sameRivers?previous.riverIndex:createGlobePacketIndex([
    ...(active.rivers?[{packet:active.rivers,minZoom:active.spec.riverMinZoom}]:[]),
    ...riverChunks.map(row=>({packet:row.packet,minZoom:row.row.minZoom})),
   ].flatMap(row=>row.packet.spatialParts.map(part=>({...part,minZoom:row.minZoom}))),row=>row.index.rootBounds),
  };
  pickingRevision++;pickingChanged=false;
 }
 function commitVisualFrame(frame){
  const draw=drawnFrame;
  if(!draw||draw.frame!==frame)return false;
  const first=!ready;ready=true;
  if(!presentation.commitVisualFrame(frame)){ready=!first;drawnFrame=null;return false;}
  lastFrame=frame;lastCamera=draw.camera;
  acceptedTerritories=draw.territories;acceptedTerritoryParts=draw.territoryParts;acceptedPhysical=draw.physical;
  acceptedRiverChunks=draw.riverChunks;
  publishPickSnapshot(draw);drawnFrame=null;
  if(publishedView!==draw.territories.view||publishedPhysical!==draw.physical||first){
   publishedView=draw.territories.view;publishedPhysical=draw.physical;
   if(prefetchView===publishedView)prefetchView=null;
   if(prefetchPhysical?.key===publishedPhysical?.plan.key)prefetchPhysical=null;
   retainCpuResources();
  }
  const riverChanged=riverDetail.commit(acceptedRiverChunks),surfaceChanged=surface.trimResidency();
  if(riverChanged)refreshRiverLedger();
  if(first||residencyDirty||riverChanged||surfaceChanged){residencyDirty=false;residency.trim();}
  if(first){metrics.publish();notify('ready','지도 표시 준비 완료');requestOutlines();}
  revision++;emit('render');return true;
 }
 async function hydroFeaturesForSlots(slots,waterFeatures,signal){
  if(!slots.size)return waterFeatures;
  const items=hydroMetadata??await hydroMetadataCache.read('hydro-metadata',async readSignal=>{
   const rows=await load(spec.hydroMetadata,'hydro',{phase:'background',priority:30,identityCount:spec.hydroCount,signal:readSignal});
   readSignal.throwIfAborted();
   hydroMetadata=rows;rows.forEach((row,slot)=>hydroSlots.set(row.id,slot));refreshHydroLedger();paintDirty=residencyDirty=true;invalidate('three-hydro-identities');
   return rows;
  },signal);
  signal?.throwIfAborted();
  return [...waterFeatures,...[...slots].map(slot=>items[slot]).filter(Boolean)];
 }
 async function queryObjectRefs(point,{includeHydro=true,includeLabels=true,signal:consumerSignal}={}){
  const sample=acceptedPick;
  if(!sample||framePreserved||!ready||sample.generation!==generation)throw new DOMException('Picking frame unavailable','AbortError');
  const controller=startRequest(includeHydro||includeLabels?'pick-click':'pick-hover');
  const abort=()=>controller.abort(consumerSignal?.reason);
  consumerSignal?.addEventListener('abort',abort,{once:true});if(consumerSignal?.aborted)abort();
  const {signal}=controller;
  const isCurrent=()=>!signal.aborted&&!disposed&&!framePreserved&&ready&&acceptedPick===sample&&sample.generation===generation;
  const assertCurrent=()=>{signal.throwIfAborted();if(!isCurrent())throw new DOMException('Picking frame superseded','AbortError');};
  try{
   assertCurrent();
   const label=includeLabels?sample.labelHit(point):null;
   if(label)return [label];
   const sampledCamera=sample.camera,ray=sampledCamera.worldRay(point);
   if(!ray)return [];
   const budget=createGlobePickBudget({signal,isCurrent});
   const intersect=bounds=>globeRayIntersectsBounds(ray,bounds),waterFeatures=[],lakeSlots=new Set();
   for(const row of await sample.waterIndex.queryCooperative(intersect,budget)){
    const packet=row.mesh.packet;
    if((await pickGlobeSlotsCooperative(packet,packet.spatial,ray,undefined,{firstHit:true,budget})).length){
     if(!includeHydro)return [];
     waterFeatures.push(row.feature);
    }
   }
   if(sample.lakesVisible)for(const row of await sample.lakeIndex.queryCooperative(intersect,budget)){
    if(sampledCamera.view.zoom<row.minZoom)continue;
    const packet=row.mesh.packet,hits=await pickGlobeSlotsCooperative(packet,packet.spatial,ray,undefined,{firstHit:!includeHydro,budget});
    if(hits.length&&!includeHydro)return [];
    for(const slot of hits)lakeSlots.add(slot);
   }
   let hydroRefs=[];
   if(includeHydro){
    const slots=new Set(lakeSlots);
    if(sample.riversVisible&&sampledCamera.view.zoom>=sample.physical.spec.riverMinZoom){
     const predicate=globeStrokePickPredicate(sampledCamera,point,5);
     for(const row of await sample.riverIndex.queryCooperative(predicate,budget)){
      if(sampledCamera.view.zoom<row.minZoom)continue;
      for(const slot of await pickGlobeStrokeSlotsCooperative(row.packet,row.index,sampledCamera,point,5,{predicate,budget}))slots.add(slot);
     }
    }
    const candidates=await hydroFeaturesForSlots(slots,waterFeatures,signal);assertCurrent();
    const visible=[...new Map(candidates.filter(feature=>deps.physicalServices.isHydroFeatureVisible(feature)).map(feature=>[feature.id,feature])).values()];
    const missing=visible.filter(feature=>{const existing=deps.hydroModel.hydroFeatureById(feature.id);return !existing||existing.__awBounds!==feature.__awBounds;});
    if(missing.length)await deps.physicalResources.admitHydroFeatures(missing,{isCurrent});
    assertCurrent();hydroRefs=visible.map(feature=>normalizeObjectRef({domain:'hydro',type:feature.properties.category,id:feature.id}));
   }
   if(waterFeatures.length||lakeSlots.size)return hydroRefs;
   const hits=[];
   for(const {packet} of await sample.countryIndex.queryCooperative(intersect,budget))hits.push(...await pickGlobeSlotsCooperative(packet,packet.spatial,ray,slot=>sample.visibleSlots.has(slot),{budget}));
   assertCurrent();return [...hydroRefs,...hits.map(slot=>refs[slot])];
  }finally{consumerSignal?.removeEventListener('abort',abort);finishRequest(includeHydro||includeLabels?'pick-click':'pick-hover',controller);}
 }
 function appearance(){paintDirty=fullPaintDirty=countryPaintInputsDirty=true;invalidate('three-style');}
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
  setSelection(value){
   const prior=(selection?.selection?.items??[]).filter(ref=>ref.domain==='label').map(ref=>ref.key);
   const next=(value?.selection?.items??[]).filter(ref=>ref.domain==='label').map(ref=>ref.key);
   if(prior.length!==next.length||prior.some((key,i)=>key!==next[i]))labelContentDirty=true;
   selection=value;paintDirty=true;
  },setInteractionStyle(value){style=value;appearance();},
  invalidateCountryColors:appearance,invalidateCountryPalette:appearance,invalidatePhysicalStyle:appearance,invalidateHydroVisibility:appearance,
  setRenderQuality:appearance,
  labelZoomVisibility:()=>({country:Boolean(camera&&camera.view.zoom>=COUNTRY_LABEL_MIN_ZOOM),
   places:Boolean(camera&&camera.view.zoom>=PLACE_DISPLAY_ZOOM_FLOOR)}),
  invalidateLabelContent({countries=true}={}){labelContentDirty=true;if(countries)allCountryLabelsDirty=true;},getPickingRevision:()=>pickingRevision,queryObjectRefs,
  setInitialMapLoading(value){initialLoading=value;},isStyleReady:()=>loaded,renderFrame,commitVisualFrame,
  canPresentVisualFrame:presentation.canPresentVisualFrame,prepareTemporalCountrySource:presentation.prepareTemporalCountrySource,
  beginTemporalViewTransition,admitTemporalViewTransition:presentation.admitTemporalViewTransition,
  finishTemporalViewTransition,waitForMapPresentation:presentation.waitForMapPresentation,
  waitForTemporalPresentation:presentation.waitForTemporalPresentation,getProjectGeneration:()=>generation,
  preserveTemporalFrame(){framePreserved=true;},isFramePreserved:()=>framePreserved,
  resetProjectRenderState(options){generation=options.generation;features=null;ready=false;error=null;
    drawnFrame=null;clearPreparation();cancelOutlines();temporalInputs.reset();countryLabels.clear();countryLabelList=[];dirtyPaintSlots.clear();dirtyCountryLabels.clear();allCountryLabelsDirty=countryPaintInputsDirty=true;labelContentDirty=true;presentation.resetForProject(options);},
  measureWork:metrics.track,measureSyncWork:metrics.run,failMapPreparation,retryMapPreparation,getRuntimeState,
  getStats:()=>({...getRuntimeState(),mapReadiness:readyState(),displayedRevision:ready?revision:0,sourceRevision:revision,
   generation,certifiedRevision:ready&&!lost&&!presentation.temporalPending()?revision:null,
   frameId:lastFrame?.frameId,drawCount,drawCalls:surface?.drawCalls()??0,spatialRendering:surface?.spatialStats()??null,performance:metrics.snapshot(),
   countrySlotCount:acceptedTerritories.slots.length,activeHistoricalTerritories:acceptedTerritoryParts?.countries.length??0,
   physicalWaterIds:acceptedPhysical?.waters.map(row=>row.id)??[],
   countryLabelCount:surface?.labels.visibleCount(false)??0,
   placeLabelCount:surface?.labels.visibleCount(true)??0,riverDetail:riverDetail?.stats()??null,
   labelAtlasEntries:surface?.labels.atlasEntryCount()??0,
   historicalCache:historicalCache.stats(),historicalMetadata:historyIndex.stats(),temporalPresentation:temporalStats,physicalCache:physicalAssets.stats(),residentCache:surface?.cacheStats()??null,
   labelAtlas:surface?.labels.cacheStats()??null,packetWorker:packetTasks.stats(),residency:residency.stats(),loadGate:loadGate.stats(),errorMessage:error?.message??null,initialLoading}),
  dispose(){disposed=true;clearTimeout(moveTimer);lifetime.abort();for(const name of requestScopes.keys())cancelRequest(name);cancelOutlines();presentation.dispose();events.clear();historicalCache.dispose();physicalAssets.dispose();hydroMetadataCache.dispose();riverDetail?.dispose();loadGate.dispose();packetTasks.dispose();surface?.dispose();residency.dispose();canvas?.remove();
   acceptedPick=drawnFrame=features=territoryParts=acceptedTerritoryParts=physical=acceptedPhysical=publishedPhysical=hydroMetadata=null;
   acceptedRiverChunks=[];hydroSlots.clear();basePaint.clear();temporalInputs.reset();countryLabels.clear();countryLabelList=[];assets=surface=riverDetail=null;},
 });
}
