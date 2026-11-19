import {clipMercatorLines,createPolarLayer,polarGeometry,polarLinePacket,polarGridPacket,POLAR_LATITUDE} from './maplibre-polar-layer.js';
import {buildRenderableBoundarySegments} from '../geometry/geographic-boundary.js';
import {connectBoundarySegments} from '../geometry/boundary-lines.js';
import {createTerritorialEntityRepository} from '../document/territorial-entity-repository.js';
import {createMapLibreProjection,readMapLibreCamera} from './maplibre-projection.js';
import {installManagedMapLibreFeature} from './maplibre-feature-lifecycle.js';
import {syncMapLibreBaseLayer} from './maplibre-base-layer.js';
import {resolveMapLibreMapStyle} from './maplibre-map-style.js';
import {createMapLibreStyleController} from './maplibre-style-controller.js';
import {MAPLIBRE_LABEL_LAYERS,MAPLIBRE_LABEL_MIN_ZOOM} from './maplibre-label-presentation.js';
import {createExternalBasemap} from './maplibre-external-style.js';
import {createHydroBrowserLoader} from '../data/maplibre-hydro-loader.js';
import {createMapLibreHydroPresentation,hiddenMapLibreHydroIds,mapLibreHydroStages,mapLibreHydroStyle,syncMapLibreHydroVisibility,prepareMapLibreHydroFeatures} from './maplibre-hydro-presentation.js';
import {createMapPresentationSession} from './map-presentation-session.js';
import {createTerritorialFillResolver} from './territorial-fill-style.js';
import {createHydroTileWindow,hydroTileSpecsForWindow} from '../data/hydro-tile-window.js';
import {normalizeObjectRef} from '../document/object-ref-identity.js';
import {geometryRevisionKey} from '../geometry/geometry-versions.js';
import {geometryReferenceFor} from '../geometry/geometry-version-store.js';
import {distributionEntriesForLayer,DISTRIBUTION_MODES} from '../document/distribution-model.js';
import {createMapLibreVectorGroup} from './maplibre-vector-group.js';
import {createWorkerRpcClient} from '../runtime/worker-rpc.js';
import {coordinateBounds} from '../geometry/coordinate-bounds.js';
import {layerObjectRank,layerStyle} from '../ui/layer-presentation.js';
import {createRenderingMetrics} from './rendering-metrics.js';

const collection=features=>({type:'FeatureCollection',features});
const empty=()=>collection([]);
const countryTileSource=()=>({type:'geojson',data:empty(),promoteId:'objectKey',tolerance:0});
const countryFillFilter=batch=>['all',['==',['get','displayRole'],'country-fill'],['==',['get','paintBatch'],batch]];
const ZOOM_EPSILON=1e-9;
const WORLD_VIEW_BOUNDS=[[-89.999,-85.0511287798066],[89.999,85.0511287798066]];
const layerVisibleAtZoom=(layer,zoom)=>layer.layout?.visibility!=='none'&&
 zoom>=(layer.minzoom??-Infinity)&&zoom<(layer.maxzoom??Infinity);
const geometryKey=geometry=>{const ref=geometryReferenceFor(geometry);return ref?JSON.stringify([ref.id,ref.version]):geometryRevisionKey(geometry);};

/** MapLibre owns map pixels and picking. Core and the physical owner retain all data. */
export function createMapLibreViewerRenderer(deps,{presentMapPreparation,onMapPreparationStatus}={}) {
 if(typeof deps.objectRefVisible!=='function')throw new TypeError('MapLibre requires the canonical object visibility query.');
 const state=deps.projectState.state;
 const metrics=createRenderingMetrics();
 let map,api,projection,container,stylesheet,initialization,loadedStyle=null,disposed=false,loaded=false,generation=0,contextRevision=0,contextLost=false;
 let pendingCameraFit=null;
 let sourceRevision=0,certifiedRevision=-1,certifiedCamera='',pendingFrame=null,ready=false,preparedReady=false,error=null,countryGeneration=-1,countryContentKey='';
 let territories=[],landRevision=null,hydroLoader,hydroPresentation,hydroFeatures=[],hydroManifest=null;
 let sceneKey='',countryKey='',quality=null,interactionStyle=null;
  const pendingSourceOperations=new Set();
 const pendingSources=()=>{for(const entry of pendingSourceOperations)if(entry.generation!==generation||entry.context!==contextRevision||map.getSource(entry.id)!==entry.source)pendingSourceOperations.delete(entry);return [...pendingSourceOperations].filter(entry=>requiredSource(entry.id)).length;};
 const dynamicLayers=new Set(),dynamicSources=new Set(),sceneGroups=new Map();
 let countryRows=new Map(),hydroStateKey='',hydroEditsKey='',physicalLandKey='',physicalWaterKey='',physicalLandSource=null,physicalWaterSource=null,selectionSnapshot=null,requestedAt=null;
 let physicalDisplayCache=null;
 let countryTileRows=new Map(),countryBoundaryGeometry=new Map();
 const physicalPending=new Map();
 const handledSourceErrors=new WeakSet(),sourceQueues=new WeakMap();
 let countrySequence=0,countryTail=Promise.resolve(),countrySourceId='territories',countrySourceSerial=0,countrySourceNeedsSwap=false;
 let physicalWaterSourceId='physical-water',physicalWaterSourceSerial=0;
 const activeCountryTasks=new Set();
 let territorialMultiply=[],sceneMultiply=[],multiplyRpc=null;
 const multiplyLayers=new Map(),strokeDomains=new Map(),strokeSignatures=new Map();
 let sceneOrder=[],lastSceneOrder='',interactionRevision=0,interactionPending=null,interactionApplied=null;
 const mapFeatures=new Map();
 let externalBasemap=null,externalAttribution=null,basemapRecovery=null,styleController=null;
 const currentMapStyle=()=>resolveMapLibreMapStyle({
  palette:deps.preferences.mapPalette(),antiAlias:interactionStyle?.antiAlias!==false,
  layerVisibility:state.layerVisibility,
 });
 let pendingStyleRefresh=false,pendingSelection=false,pendingInteractionStyle=null,pendingSceneDomains=null;
 const styleReady=()=>loaded&&!contextLost&&!basemapRecovery&&!!map&&loadedStyle===map.style;
 function flushStyleChanges(){
  if(!styleReady())return;
  if(pendingInteractionStyle){const value=pendingInteractionStyle;pendingInteractionStyle=null;setInteractionStyle(value);}
  if(pendingStyleRefresh){pendingStyleRefresh=false;invalidateStyle();}
  if(pendingSceneDomains){const value=pendingSceneDomains;pendingSceneDomains=null;setSceneDomains(value);}
  if(pendingSelection&&selectionSnapshot)setSelection(selectionSnapshot);
  invalidate('map-paint-ready');
 }
 async function previewExternalBasemap(style){
  if(disposed||!loaded||presentation.temporalPending()||temporalOverlay)throw new Error('The map is not available for a basemap change.');
  for(const layer of style?.layers||[])if(map.getLayer(layer.id))throw new Error('Basemap layer collision: '+layer.id);
  externalBasemap ||=createExternalBasemap(map,{getRevision:()=>JSON.stringify([generation,contextRevision,sourceRevision,presentation.temporalPending(),!!temporalOverlay]),onChange:()=>{syncMultiply();dirty();invalidate('external-basemap-change');},onRemoveStart:()=>{if(!temporalOverlay)preserveTemporalFrame();},onRemoveEnd:()=>{if(!presentation.temporalPending())releaseTemporalFrame();},onCancelled:()=>{if(externalAttribution){map.removeControl(externalAttribution);externalAttribution=null;}},onFailure:(cause,{removed})=>{
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
 const territorialFillLayers=new Set();
 let territorialBatches=[],initialMapLoading=false;
 let temporalOverlay=null,temporalInteractions=[],temporalOptionalLayers=[];
 let temporalFrameHeld=false,zoomFramePending=false,initialZoomHidden=false,lastPresentedZoom=null,lastCameraZoom=null;
 function suspendOptionalLayers(){
  for(const layer of map.getStyle()?.layers||[]){
   if(!layer.source||requiredSource(layer.source)||layer.layout?.visibility==='none'||temporalOptionalLayers.some(item=>item.id===layer.id))continue;
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
  context.drawImage(source,0,0);overlay.append(snapshot);
  stage.append(overlay);temporalOverlay=overlay;
 }
 function discardUnusedPreservedFrame(){
  if(temporalFrameHeld||zoomFramePending)return;
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
  if(!loaded||!styleController)return;
  const style=currentMapStyle(),{paint}=style;
  positionPolarLayer();
  const before=initialMapLoading&&polarLayer&&map.getLayer(polarLayer.id)?polarLayer.id:undefined;
  styleController.syncLoadingSurface(style,initialMapLoading,before);
  polarLayer?.setLoadingSurface(initialMapLoading?{
   ocean:rgba(paint['initial-map-ocean']['background-color']),
   land:rgba(paint['initial-map-land']['fill-color']),
  }:null);
  syncLabelVisibility();
 }
 function syncLabelVisibility(){
  if(styleReady()&&styleController.syncLabelVisibility(initialMapLoading))dirty();
 }

 function strokeDomain(name,features,styleFor,order){
  const groups=new Map();
  for(const feature of features){
   const style={...styleFor(feature),antiAlias:interactionStyle?.antiAlias!==false};
   if(!(style.width>0)||!(style.alpha>0))continue;
   const geometry=feature.geometry;
   const polygon=['Polygon','MultiPolygon'].includes(geometry.type);
   const lines=polygon?connectBoundarySegments(buildRenderableBoundarySegments(geometry)):geometry.type==='LineString'?[geometry.coordinates]:geometry.type==='MultiLineString'?geometry.coordinates:[];
   if(!lines.length)continue;
   const key=JSON.stringify(style);
   if(!groups.has(key))groups.set(key,{style,lines:[],revisions:[]});
   const group=groups.get(key);group.lines.push(...lines);group.revisions.push(geometryKey(geometry));
  }
  const packetKey=group=>group.revisions.join('|');
  const signature=[...groups].map(([key,group])=>key+':'+packetKey(group)).join(';');
  if(strokeSignatures.get(name)===signature){syncMultiply();return;}
  strokeSignatures.set(name,signature);
  strokeDomains.set(name,[...groups].map(([key,group])=>({key:name+key,kind:'line',
   order,role:name==='interaction-strokes'?'interaction-stroke':name==='river-strokes'?'hydro-detail':undefined,
   geometryRevision:name+':'+packetKey(group),geometry:{type:'MultiLineString',coordinates:group.lines},style:group.style,blendMode:'normal'})));
  syncMultiply();
 }
 async function prepareCountryBorders(features,revision){
  const countryFeatures=[...features].sort((a,b)=>a.id.localeCompare(b.id));
  const topologyKey=countryFeatures.map(feature=>feature.id+':'+geometryKey(feature.geometry)).join('|');
  const groups=new Map();
  for(const {id,properties:{borderColor,borderAlpha,borderWidth}} of countryFeatures){
   if(!(borderAlpha>0&&borderWidth>0))continue;
   const key=JSON.stringify([borderColor,borderAlpha,borderWidth]);
   if(!groups.has(key))groups.set(key,{borderColor,borderAlpha,borderWidth,owners:[]});
   groups.get(key).owners.push(id);
  }
  const rows=[...groups.values()].map(({owners,...paint},index)=>({
   id:'country-border:'+index,paint,key:JSON.stringify([topologyKey,owners]),owners,
  }));
  const needed=rows.filter(row=>!countryBoundaryGeometry.has(row.key));
  const prepared=needed.length?await prepareMultiply(needed.map(row=>({
   kind:'stroke',cacheKey:row.key,countryFeatures,countryVisibleIds:row.owners,
  })),revision):null;
  const geometries=new Map(prepared?.packets.map(({cacheKey,geometry})=>[
   cacheKey,{native:clipMercatorLines(geometry),polar:polarLinePacket(geometry.coordinates)},
  ]));
  stats.strokePreparedPackets+=geometries.size;
  return rows.map(row=>{
   const paths=geometries.get(row.key)||countryBoundaryGeometry.get(row.key)?.paths;
   if(!paths)throw new Error('Shared country boundary was not prepared');
   return {key:row.key,paths,feature:{type:'Feature',id:row.id,geometry:paths.native,
    properties:{...row.paint,objectKey:row.id,displayRole:'country-border'}}};
  });
 }
 let polarLayer=null,polarInputs=[],polarHover=null,polarHoverKey='';
 const polarLines=new WeakMap(),fullHoverLines=new WeakMap(),polarGrid=polarGridPacket();
 const rgba=(color,alpha=1)=>{const rgb=deps.platform.d3.rgb(color);return [rgb.r/255,rgb.g/255,rgb.b/255,alpha];};
 function positionPolarLayer(){
  if(!polarLayer||!map.getLayer(polarLayer.id))return;
  const before=!initialMapLoading&&map.getLayer('viewer-label-dot')?'viewer-label-dot':undefined;
  const layers=map.getLayersOrder(),index=layers.indexOf(polarLayer.id);
  if(before?layers[index+1]!==before:index!==layers.length-1)map.moveLayer(polarLayer.id,before);
 }
 function syncPolar(){
  if(!styleReady())return;
  polarLayer ||=createPolarLayer({map,prepare:async geometry=>(await prepareMultiply([{kind:'fill',cacheKey:'polar:'+geometryKey(geometry),geometry}],generation)).packets[0].packet,onChange:()=>{dirty();invalidate('polar-ready');},onError:failMapPreparation});
  polarLayer.ensure();
  const style=currentMapStyle(),items=[],keys=[];
  const add=(geometry,color,alpha=1,multiply=false,fullExtent=false,loadingRole)=>{if(!color||!(alpha>0))return;const shape=fullExtent?geometry:polarGeometry(geometry);if(!shape)return;items.push({geometry:shape,color:rgba(color,alpha),multiply,fullExtent,loadingRole});keys.push([geometryKey(geometry),color,alpha,multiply,fullExtent,loadingRole]);};
  const line=(geometry,color,alpha,width,fullExtent=false)=>{
   if((!fullExtent&&!polarGeometry(geometry))||!(alpha>0)||!(width>0))return;
   const cache=fullExtent?fullHoverLines:polarLines;
   if(!cache.has(geometry))cache.set(geometry,polarLinePacket(buildRenderableBoundarySegments(geometry),{fullExtent}));
   items.push({packet:cache.get(geometry),color:rgba(color,alpha),width,fullExtent});keys.push([geometryKey(geometry),color,alpha,width,'line',fullExtent]);
  };
  const context=deps.physicalResources.physicalLand;
  if(!context||!deps.physicalResources.physicalContextState.ready)return;
  const inputs=[generation,countryKey,context.geometry,context.water,context.revision,interactionStyle,
   interactionRevision,style.paint['map-base-fallback']['fill-color'],style.paint.ocean['background-color'],state.backgroundSettings?.graticule,state.resourceCapabilities?.graticule];
  if(inputs.length===polarInputs.length&&inputs.every((value,index)=>value===polarInputs[index]))return;
  polarInputs=inputs;
  add(context.geometry,style.paint['map-base-fallback']['fill-color'],1,false,false,'land');
  for(const f of countryRows.values())add(f.geometry,f.properties.color,f.properties.displayAlpha,f.properties.blendMode==='multiply');
  if(context.water)add(context.water,style.paint.ocean['background-color']);
  if(countryKey)for(const {key,paths,feature:{properties}} of countryBoundaryGeometry.values()){
   if(!paths.polar.indices.length)continue;
   const {borderColor,borderAlpha,borderWidth}=properties;
   items.push({packet:paths.polar,color:rgba(borderColor,borderAlpha),width:borderWidth});
   keys.push([key,borderColor,borderAlpha,borderWidth]);
  }
  if(state.backgroundSettings?.graticule!==false&&state.resourceCapabilities?.graticule!==false){items.push({packet:polarGrid,color:rgba('#777777',.15),width:.5,loadingRole:'grid'});keys.push('grid');}
  for(const ref of selectionSnapshot?.selection?.items||[]){if(!deps.objectRefVisible(ref))continue;const f=ref.domain==='territorial'?deps.territorialModel.entityRepository.get(ref.id):ref.domain==='hydro'?deps.hydroModel.hydroFeatureById(ref.id):null;const role=ref.key===selectionSnapshot.selection.primaryKey?interactionStyle?.selection.primary:interactionStyle?.selection.secondary;if(f?.geometry){add(f.geometry,interactionStyle?.selection.color||'#0080ff',role?.fillAlpha??.2);line(f.geometry,interactionStyle?.selection.color||'#0080ff',role?.innerAlpha??role?.alpha??1,role?.innerWidth??role?.width??2);}}
  if(polarHover){
   const {geometry,properties:{color,alpha,strokeAlpha,width}}=polarHover;
   add(geometry,color,alpha,false,true);
   line(geometry,color,strokeAlpha,width,true);
  }
  polarLayer.update(JSON.stringify([generation,keys,style.paint.ocean]),items,rgba(style.paint.ocean['background-color']));
  positionPolarLayer();
 }
 const stats={renderedFrames:0,sourceUpdates:0,renderer:'maplibre',firstCanonicalFrameMs:null,physicalLandPreparations:0,physicalLandPreparationMs:0,physicalLandAssetHits:0,strokePreparedPackets:0};
 const invalidate=reason=>deps.domains.renderingDomain?.invalidateView(reason);
 const cameraKey=()=>map?JSON.stringify([map.getCenter().lng,map.getCenter().lat,map.getZoom(),map.getBearing(),map.getPitch(),map.getRoll(),map.getCanvas().width,map.getCanvas().height]):'';
 const requiredSource=id=>[countrySourceId,'physical-land',physicalWaterSourceId,'hydro-edits','viewer-labels','interaction'].includes(id)
  ||dynamicSources.has(id)||(multiplyLayers.has(id)&&multiplyLayers.get(id).role!=='hydro-detail');
 function requiredSourcesReady(){
  if(!map?.getStyle())return false;
  for(const [id,source] of [['map-base-fallback','physical-land'],['territories',countrySourceId],
    ['physical-water',physicalWaterSourceId],['borders',countrySourceId]]){
   const layer=map.getLayer(id);if(!layer||layer.source!==source||!map.getSource(source))return false;
  }
  if(physicalPending.has('physical-land')||physicalPending.has('physical-water'))return false;
  const zoom=map.getZoom();
  const visibleSources=new Set(map.getStyle().layers
   .filter(layer=>layer.source&&requiredSource(layer.source)&&layerVisibleAtZoom(layer,zoom))
   .map(layer=>layer.source));
  return [...visibleSources].every(id=>map.isSourceLoaded(id));
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
 function dirty(){sourceRevision++;ready=false;preparedReady=false;stats.sourceUpdates++;}
 function sourceUpdate(start,id,isCurrent=()=>true,{shareAcrossGenerations=false}={}){
  const requestedGeneration=generation,requestedContext=contextRevision;if(requiredSource(id))dirty();
  const source=map.getSource(id),previous=sourceQueues.get(source)||Promise.resolve(),pending={id,source,generation:requestedGeneration,context:requestedContext};pendingSourceOperations.add(pending);
  const outcome=previous.catch(()=>{}).then(async()=>{
   if(disposed||requestedContext!==contextRevision||map.getSource(id)!==source||!isCurrent()||(!shareAcrossGenerations&&requestedGeneration!==generation))return false;
   let sourceError=null;const onSourceError=event=>{sourceError=event.error||new Error('Source update failed: '+id);if(typeof sourceError==='object'&&sourceError!==null){const handled=sourceError;handledSourceErrors.add(handled);queueMicrotask(()=>handledSourceErrors.delete(handled));}};
   source.on('error',onSourceError);
   try{await metrics.track('source:'+id.replace(/-generation-\d+$/,''),()=>start(source));if(sourceError)throw sourceError;return true;}finally{source.off('error',onSourceError);}
  });
  sourceQueues.set(source,outcome);
  const finish=()=>pendingSourceOperations.delete(pending);
  outcome.then(()=>{finish();if(sourceQueues.get(source)===outcome)sourceQueues.delete(source);if(!disposed&&map.getSource(id)===source&&requestedGeneration===generation&&requestedContext===contextRevision)map.triggerRepaint();},cause=>{finish();if(sourceQueues.get(source)===outcome)sourceQueues.delete(source);if(!disposed&&map.getSource(id)===source&&isCurrent()&&requestedGeneration===generation&&requestedContext===contextRevision)failMapPreparation(cause);});
  return outcome;
 }
 function setData(id,data,isCurrent,options){return sourceUpdate(source=>source.setData(data),id,isCurrent,options);}
 function preparePhysicalSource(kind,key,data){
  let id=kind==='physical-water'?physicalWaterSourceId:kind;
  const previous=physicalPending.get(kind);
  if(kind==='physical-water'&&previous&&previous.key!==key&&previous.source===map.getSource(id)){
   const layers=map.getStyle().layers,index=layers.findIndex(item=>item.id==='physical-water'),layer=layers[index];
   const nextId='physical-water-generation-'+(++physicalWaterSourceSerial),before=layers.slice(index+1).find(item=>map.getLayer(item.id));
   map.addSource(nextId,{type:'geojson',data:empty()});map.removeLayer('physical-water');
   map.addLayer({...layer,source:nextId},before?.id);map.removeSource(id);
   physicalWaterSourceId=nextId;physicalWaterKey='';physicalWaterSource=null;id=nextId;
  }
  const source=map.getSource(id);if(previous?.key===key&&previous.source===source)return;
  const entry={key,source};physicalPending.set(kind,entry);
  const current=()=>!disposed&&physicalPending.get(kind)===entry&&map.getSource(id)===source;
  const prepared=kind==='physical-land'?preparePhysicalDisplay(key,data.features[0].geometry).then(geometry=>collection([{...data.features[0],geometry}])):Promise.resolve(data);
  prepared.then(value=>current()?setData(id,value,current,{shareAcrossGenerations:true}):false,cause=>{if(current()){physicalPending.delete(kind);failMapPreparation(cause);}return false;})
   .then(applied=>{if(!current())return;physicalPending.delete(kind);if(applied){if(kind==='physical-land'){physicalLandKey=key;physicalLandSource=source;}else{physicalWaterKey=key;physicalWaterSource=source;}}invalidate('physical-source-ready');},()=>{if(!current())return;physicalPending.delete(kind);invalidate('physical-source-retry');});
 }
 function geometryWorker(){
  return multiplyRpc ||=createWorkerRpcClient({createWorker:()=>new Worker(deps.platform.runtimeAssetUrl('workers/gpu-mesh-worker.js')),
   isCurrent:({entry,message})=>entry.projectRevision===message.projectRevision});
 }
 function preparePhysicalDisplay(key,geometry){
  if(physicalDisplayCache?.key===key)return physicalDisplayCache.task;
  physicalDisplayCache?.controller.abort();
  const entry={key,controller:new AbortController(),geometry:null,failed:false,task:null};physicalDisplayCache=entry;
  entry.task=Promise.resolve(deps.physicalResources.loadPhysicalLandDisplay?.(key)).then(prepared=>{
    if(prepared){stats.physicalLandAssetHits++;return {result:{geometry:prepared,durationMs:0}};}
    return geometryWorker().request('geometry.physical-land',{sourceKey:'physical-display-union-v1:'+key,geometry},{projectRevision:generation,signal:entry.controller.signal});
  })
   .then(({result})=>{entry.geometry=result.geometry;stats.physicalLandPreparations++;stats.physicalLandPreparationMs+=result.durationMs;return result.geometry;},cause=>{entry.failed=true;throw cause;});
  return entry.task;
 }
 async function prepareMultiply(items,revision){
  const points=items.filter(item=>item.kind==='point').map(item=>({cacheKey:item.cacheKey,packet:{points:item.geometry.type==='Point'?[item.geometry.coordinates]:item.geometry.coordinates}}));
  const polygons=items.filter(item=>item.kind!=='point');if(!polygons.length)return {packets:points};
  const result=(await metrics.track('geometry.prepare',()=>geometryWorker().request('geometry.prepare',{items:polygons},{projectRevision:revision}))).result;
  if(result.stats)stats.geometryPreparation={boundarySeedFailure:result.stats.boundarySeedFailure,boundarySeeded:result.stats.boundarySeeded,boundaryChangedCount:result.stats.boundaryChangedCount,packets:result.stats.slowestPackets?.map(row=>({kind:row.kind,durationMs:row.durationMs,packetBytes:row.packetBytes,assetHits:(row.assetHitsAfter??0)-(row.assetHitsBefore??0)}))};
  return {...result,packets:[...points,...result.packets]};
 }
 function syncMultiply(){
  if(!loaded)return;
  const groups=new Map();
  for(const row of [...territorialMultiply,...sceneMultiply,...[...strokeDomains.values()].flat()].sort((a,b)=>a.order-b.order)){
   const kind=row.kind||'fill',id=row.role==='graticule'?'map-graticule':'multiply-'+kind+'-'+row.order+'-'+(row.role==='territorial-fill'?'territorial':row.role==='hydro-detail'?'hydro-detail':'independent');
   if(!groups.has(id))groups.set(id,[]);groups.get(id).push({...row,style:kind==='line'?{...row.style,antiAlias:interactionStyle?.antiAlias??row.style?.antiAlias??true}:row.style,geometryRevision:kind+':'+row.geometryRevision});
  }
  for(const [id,entry]of multiplyLayers)if(!groups.has(id)){entry.layer.dispose();multiplyLayers.delete(id);}
  for(const [id,originalItems]of groups){
   let items=originalItems;
   if(items[0]?.kind==='line'&&items.length>1){const batches=new Map();for(const row of items){const merge=!row.objectKey&&(row.style?.alpha??1)===1&&(!row.style?.casing||(row.style.casing.alpha??1)===1);const key=JSON.stringify([row.blendMode,row.style,merge?'':row.key]);if(!batches.has(key))batches.set(key,[]);batches.get(key).push(row);}items=[...batches.values()].map(rows=>rows.length===1?rows[0]:({...rows[0],key:rows.map(r=>r.key).join('|'),geometryRevision:rows.map(r=>r.geometryRevision).join('|'),geometry:{type:'MultiLineString',coordinates:rows.flatMap(r=>r.geometry.type==='MultiLineString'?r.geometry.coordinates:[r.geometry.coordinates])}}));}

   const signature=items.map(item=>[item.key,item.geometryRevision,item.blendMode,JSON.stringify(item.style)].join(':')).join('|');
   let entry=multiplyLayers.get(id);
   if(!entry){
    const layer=createMapLibreVectorGroup(map,{id,sharedSource:items[0].role==='territorial-fill'?()=>countrySourceId:undefined,before:items[0].role==='territorial-fill'?'physical-water':items[0].role==='interaction-stroke'?undefined:map.getLayer('interaction-fill')?'interaction-fill':undefined,
     onChange:()=>{if(!disposed){orderSceneLayers();if(items[0].role!=='hydro-detail')dirty();invalidate('vector-ready');}}});
    entry={layer,signature:null,order:items[0].order,role:items[0].role};multiplyLayers.set(id,entry);
   }
   else if(!map.getLayer(id))entry.signature=null;
   if(entry.signature!==signature){entry.signature=signature;entry.layer.update(items).catch(cause=>{if(entry.role==='hydro-detail')deps.feedback.reportOperationError(cause,'강 상세 표시를 준비하지 못했습니다.','PL-HYDRO-DETAIL-002');else failMapPreparation(cause);});}
  }
  orderTerritorialFills();
 }
 function orderTerritorialFills(){
  for(const batch of territorialBatches){
   const id=batch.blendMode==='multiply'?'multiply-fill-'+batch.order+'-territorial':batch.index===0?'territories':'territories-fill-'+batch.index;
   if(map.getLayer(id)){if(multiplyLayers.has(id))multiplyLayers.get(id).layer.move('physical-water');else map.moveLayer(id,'physical-water');}
  }
 }
 function orderSceneLayers(){
  const key=map.getLayersOrder().join('|')+';'+sceneOrder.map(row=>row.id+':'+row.order+':'+row.role).join('|');
  if(key===lastSceneOrder)return;
  const ordered=[...sceneOrder,{id:'borders',order:100},...[...multiplyLayers].map(([id,entry])=>({id,order:entry.order,role:entry.role}))];
  for(const row of ordered.sort((a,b)=>a.order-b.order))if(row.role!=='graticule'&&map.getLayer(row.id)){
   const before=row.role==='territorial-fill'?'physical-water':row.order<0?'territories':undefined;
   if(multiplyLayers.has(row.id))multiplyLayers.get(row.id).layer.move(before);else map.moveLayer(row.id,before);
  }
  orderTerritorialFills();
  if(map.getLayer('map-graticule'))map.moveLayer('map-graticule');
  for(const id of ['interaction-fill','interaction-line','interaction-point'])if(map.getLayer(id))map.moveLayer(id);
  for(const entry of multiplyLayers.values())if(entry.role==='interaction-stroke')entry.layer.move();
  for(const id of [...MAPLIBRE_LABEL_LAYERS,'initial-map-ocean','initial-map-land'])if(map.getLayer(id))map.moveLayer(id);
  positionPolarLayer();
  lastSceneOrder=map.getLayersOrder().join('|')+';'+sceneOrder.map(row=>row.id+':'+row.order+':'+row.role).join('|');
 }
 function syncTerritorialFills(){
  const wanted=new Set(territorialBatches.filter(batch=>batch.blendMode==='normal'&&batch.index!==0).map(batch=>'territories-fill-'+batch.index));
  for(const id of territorialFillLayers)if(!wanted.has(id)){map.removeLayer(id);territorialFillLayers.delete(id);}
  for(const batch of territorialBatches)if(batch.blendMode==='normal'&&batch.index!==0){
   const id='territories-fill-'+batch.index;
   if(!map.getLayer(id)){map.addLayer({id,type:'fill',source:countrySourceId,filter:countryFillFilter(batch.index),layout:{'fill-sort-key':['get','paintOrder']},paint:currentMapStyle().territorialFillPaint},'physical-water');territorialFillLayers.add(id);}
  }
  syncMultiply();
 }
 function syncBaseLayer(){
  if(!loaded)return false;
  const style=currentMapStyle();
  const changed=syncMapLibreBaseLayer(map,{style,landGeometry:physicalDisplayCache&&physicalDisplayCache.key===deps.physicalResources.physicalLand?.revision?physicalDisplayCache.geometry:null});
  styleController?.apply(style,{updateVisibility:!temporalOverlay});
  if(changed)externalBasemap?.reposition();
  return changed;
 }
 function attach(canvas){
  if(container)return;
  container=document.createElement('div');container.className='maplibre-map-surface';
  Object.assign(container.style,{position:'absolute',inset:'0'});
  canvas.parentNode.insertBefore(container,canvas);canvas.remove();
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
   const hydroStyle=mapLibreHydroStyle({antiAlias:interactionStyle?.antiAlias!==false,stylePaint:initialStyle.paint});
   // Draw native symbol placement with the tile's first frame so a published
   // camera frame and its visible labels share the same approval.
   map=new api.Map({container,trackResize:false,attributionControl:false,interactive:true,fadeDuration:0,canvasContextAttributes:{preserveDrawingBuffer:true},dragRotate:false,pitchWithRotate:false,
    center:[-state.view.globeRotation[0],-state.view.globeRotation[1]],...(Number.isFinite(state.view.zoom)?{zoom:state.view.zoom}:{}),
    style:{version:8,projection:{type:'globe'},sources:{
     'physical-land':{type:'geojson',data:empty()},'physical-water':{type:'geojson',data:empty()},
     territories:countryTileSource(),...hydroStyle.sources,
    },layers:[{id:'ocean',type:'background',paint:initialStyle.paint.ocean},
     {id:'map-base-fallback',type:'fill',source:'physical-land',paint:initialStyle.paint['map-base-fallback']},
     {id:'territories',type:'fill',source:'territories',filter:countryFillFilter(0),layout:{'fill-sort-key':['get','paintOrder']},paint:initialStyle.paint.territories},
     {id:'physical-water',type:'fill',source:'physical-water',paint:initialStyle.paint['physical-water']},
     ...hydroStyle.layers,
     {id:'borders',type:'line',source:'territories',filter:['==',['get','displayRole'],'country-border'],
      layout:{'line-cap':'round','line-join':'round'},paint:initialStyle.paint.borders},
    ]}});
   styleController=createMapLibreStyleController(map);
   projection=createMapLibreProjection(map);
   map.on('style.load',()=>{loadedStyle=map.style;if(loaded&&!disposed){restoreFeatures();flushStyleChanges();}});
   map.on('webglcontextlost',()=>{contextRevision++;pendingSourceOperations.clear();physicalPending.clear();physicalLandKey='';physicalWaterKey='';contextLost=true;ready=false;preparedReady=false;certifiedRevision=-1;notify('loading','지도 복구 중');});
   map.on('webglcontextrestored',()=>{
    const restore=()=>{if(disposed)return;syncMultiply();polarLayer?.resetContext();contextLost=false;certifiedRevision=-1;dirty();flushStyleChanges();invalidate('map-context-restored');};
    if(loadedStyle===map.style)restore();else map.once('style.load',restore);
   });
   map.on('error',event=>{if(event.error?.name==='AbortError')return;
    if(event.error&&handledSourceErrors.has(event.error))return;
    if(event.sourceId&&externalBasemap?.ownsSource(event.sourceId))return;if(event.sourceId==='viewer-labels')return;
    if(event.sourceId&&map.getSource(event.sourceId)&&!requiredSource(event.sourceId)){
     deps.feedback.reportOperationError(event.error||new Error('Optional source failed: '+event.sourceId),'추가 지도 자료를 불러오지 못했습니다.','PL-MAPLIBRE-OPTIONAL-001');return;
    }
    failMapPreparation(event.error||new Error('MapLibre render failed.'));
   });
   map.on('render',()=>{
    stats.renderedFrames++;

    if(requestedAt!==null&&deps.renderQuality?.renderQualityController){
     const active=loaded&&!contextLost&&!document.hidden&&!pendingSources()&&map.areTilesLoaded();
     const changed=deps.renderQuality.renderQualityController.recordFrame(0,{frameIntervalMs:performance.now()-requestedAt,suspended:!active});
     if(changed)deps.renderQuality.queueAdaptiveRenderQualityRefresh('maplibre-frame-cadence');
     requestedAt=null;
    }
    if(!loaded||contextLost||polarLayer?.pending||pendingSources()||!requiredSourcesReady())return;
    certifiedRevision=sourceRevision;certifiedCamera=cameraKey();
    if(pendingFrame)invalidate('maplibre-presented');
   });
   await new Promise((resolve,reject)=>{map.once('load',resolve);map.once('error',event=>reject(event.error));});
   const initialView=state.view;
   loaded=true;lastCameraZoom=map.getZoom();
   map.on('move',()=>{
    const zoom=map.getZoom(),jump=Math.abs(zoom-lastCameraZoom)>=2-ZOOM_EPSILON;
    lastCameraZoom=zoom;
    if(jump&&!zoomFramePending&&(!state.projectReplacing||initialMapLoading)&&
     (lastPresentedZoom===null||Math.abs(zoom-lastPresentedZoom)>=2-ZOOM_EPSILON)){
     if(initialMapLoading){initialZoomHidden=true;map.getCanvas().style.visibility='hidden';}
     else if(lastPresentedZoom!==null)preserveDisplayedFrame();
     zoomFramePending=true;
    }
    ready=false;preparedReady=false;
    if(applyingCamera||state.projectReplacing)return;
    invalidate('maplibre-camera');
   });
   map.on('movestart',()=>deps.domains.renderingDomain?.beginInteraction('maplibre-move'));
   map.on('moveend',()=>deps.domains.renderingDomain?.endInteraction('maplibre-move-end'));
   if(pendingCameraFit)applyCameraFit();else syncCameraFromState(initialView);
   window.__PANDOLAB_MAPLIBRE__=map;
   return true;
  })();
  initialization.catch(failMapPreparation);return initialization;
 }
 function fitMapBounds(bounds,safeInsets={}){
  pendingCameraFit={bounds,safeInsets};
  return applyCameraFit();
 }
 function cameraForMapBounds(bounds,safeInsets){
  if(!loaded)return null;
  const {clientWidth:width,clientHeight:height}=map.getCanvas();
  if(!width||!height)return null;
  const padding=Object.fromEntries(['left','right','top','bottom'].map(side=>{
   const extent=side==='left'||side==='right'?width:height;
   return [side,Math.min(extent/4,Math.max(24,Number(safeInsets[side])||0))];
  }));
  return map.cameraForBounds(bounds,{padding,bearing:0});
 }
 function applyCameraFit(){
  if(!pendingCameraFit)return false;
  const camera=cameraForMapBounds(pendingCameraFit.bounds,pendingCameraFit.safeInsets);
  if(!camera)return false;
  pendingCameraFit=null;
  map.jumpTo({...camera,pitch:0,roll:0});return true;
 }
 function isAtWorldView(padding){
  const world=cameraForMapBounds(WORLD_VIEW_BOUNDS,padding);
  if(!world)return true;
  const center=map.getCenter();
  return Math.abs(center.wrap().lng-world.center.wrap().lng)<0.1
   &&Math.abs(center.lat-world.center.lat)<0.1&&Math.abs(map.getZoom()-world.zoom)<0.01
   &&Math.abs(map.getBearing())<0.1&&Math.abs(map.getPitch())<0.1&&Math.abs(map.getRoll())<0.1;
 }
 function labelZoomVisibility(){
  if(!loaded)return {country:false,places:false};
  const zoom=map.getZoom();
  return {country:zoom>=MAPLIBRE_LABEL_MIN_ZOOM.country,places:zoom>=MAPLIBRE_LABEL_MIN_ZOOM.places};
 }
 let applyingCamera=false;
 function syncCameraFromState(view=state.view){
  pendingCameraFit=null;
  if(!map||!loaded)return;
  const center=[-view.globeRotation[0],-view.globeRotation[1]];
  const zoom=Number.isFinite(view.zoom)?view.zoom:map.getZoom();
  const orientation={};for(const key of ['bearing','pitch','roll'])if(Number.isFinite(view[key]))orientation[key]=view[key];
  const current=map.getCenter();
  if(Math.abs(current.lng-center[0])<1e-8&&Math.abs(current.lat-center[1])<1e-8&&Math.abs(map.getZoom()-zoom)<1e-8&&Object.entries(orientation).every(([key,value])=>Math.abs(({bearing:()=>map.getBearing(),pitch:()=>map.getPitch(),roll:()=>map.getRoll()})[key]()-value)<1e-8))return;
  applyingCamera=true;try{map.jumpTo({center,zoom,...orientation});}finally{applyingCamera=false;}
 }
 function setTerritorialFeatures(features){
  if(activeCountryTasks.size){countrySourceNeedsSwap=true;countryTail=Promise.resolve();}
  const entities=deps.territorialModel.entityRepository.list?deps.territorialModel.entityRepository.list():features;
  const rows=[...new Map([...entities,...features].map(feature=>[String(feature.id),{...feature,properties:structuredClone(feature.properties)}])).values()];
  const entityRepository=createTerritorialEntityRepository({getEntities:()=>rows});
  territories=features;const sequence=++countrySequence,requestedGeneration=generation;countryGeneration=-1;
  const task=countryTail.then(async()=>{if(sequence!==countrySequence||requestedGeneration!==generation||disposed)return false;activeCountryTasks.add(sequence);try{return await applyTerritorialFeatures(features,sequence,requestedGeneration,entityRepository);}finally{activeCountryTasks.delete(sequence);}}).catch(cause=>{if(disposed||sequence!==countrySequence||requestedGeneration!==generation)return false;throw cause;});
  countryTail=task.catch(()=>{});return task;
 }
 function replaceObsoleteCountrySource(){
  if(!countrySourceNeedsSwap)return;
  const oldId=countrySourceId,newId='territories-generation-'+(++countrySourceSerial),layers=map.getStyle().layers;
  const affected=layers.map((layer,index)=>({layer,index})).filter(({layer})=>layer.source===oldId);
  map.addSource(newId,countryTileSource());
  for(const {layer}of affected)map.removeLayer(layer.id);
  for(const {layer,index}of affected.reverse()){
   const before=layers.slice(index+1).find(candidate=>map.getLayer(candidate.id));
   map.addLayer({...layer,source:newId},before?.id);
  }
  if(map.getSource(oldId))map.removeSource(oldId);
  countrySourceId=newId;countryRows=new Map();countryTileRows=new Map();countryKey='';countrySourceNeedsSwap=false;dirty();
 }
 async function applyTerritorialFeatures(features,sequence,requestedGeneration,entityRepository){
  if(basemapRecovery)await basemapRecovery;
  await initialize();
  if(!styleReady())await new Promise(resolve=>map.once('style.load',resolve));
  if(disposed)return false;
  if(requestedGeneration!==generation||sequence!==countrySequence)return false;
  replaceObsoleteCountrySource();const requestedSource=countrySourceId;
  const resolvedStyle=currentMapStyle();
  const resolve=createTerritorialFillResolver({state,entityRepository,neutralColor:resolvedStyle.paint['map-base-fallback']['fill-color']});
  const nextMultiply=[],nextBatches=[];
  const ordered=features.filter(feature=>state.layerVisibility.objects!==false&&deps.layerPresentation.isLayerItemVisible('objects',String(feature.id))).map(feature=>({feature,fill:resolve(feature),ref:normalizeObjectRef({domain:'territorial',type:'entity',id:String(feature.id)})}));
  ordered.sort((a,b)=>a.fill.depth-b.fill.depth||layerObjectRank(state.layerPresentation,a.ref.key)-layerObjectRank(state.layerPresentation,b.ref.key)||a.ref.key.localeCompare(b.ref.key));
  const presented=ordered.map(({feature,fill,ref},paintOrder)=>{

   const border=resolvedStyle.countryStroke,style=layerStyle(state.layerPresentation,'objects',ref.key);
   // Object color and opacity belong to territorial presentation, not the base.
   const effectiveAlpha=fill.fillAlpha;
   const blendMode=effectiveAlpha>0?fill.blendMode:'normal';
   let batch=nextBatches.at(-1);
   if(!batch||batch.blendMode!==blendMode){batch={index:nextBatches.length,blendMode,order:-1000+nextBatches.length};nextBatches.push(batch);}
   if(blendMode==='multiply')nextMultiply.push({key:ref.key,geometry:feature.geometry,geometryRevision:geometryKey(feature.geometry),order:batch.order,role:'territorial-fill',blendMode,style:{color:fill.color,fillAlpha:effectiveAlpha}});
   return {type:'Feature',geometry:feature.geometry,id:ref.key,properties:{objectKey:ref.key,displayRole:'country-fill',color:fill.color||null,displayAlpha:fill.fillAlpha,alpha:blendMode==='multiply'?0:fill.fillAlpha,blendMode,paintOrder,paintBatch:batch.index,borderColor:border.color,borderAlpha:style.boundaryVisible?resolvedStyle.borderAlpha:0,borderWidth:border.width||0.6}};
  });
  const key=presented.map(feature=>[feature.id,geometryKey(feature.geometry),JSON.stringify(feature.properties)].join(':')).join('|');
  if(key!==countryKey){
   const borders=await prepareCountryBorders(presented,requestedGeneration);
   const current=()=>!disposed&&requestedGeneration===generation&&sequence===countrySequence&&requestedSource===countrySourceId;
   if(!current())return false;
   const tileFeatures=[...presented,...borders.map(row=>row.feature).filter(feature=>feature.geometry.coordinates.length)];
   const next=new Map(tileFeatures.map(feature=>[feature.id,feature]));
   const remove=[...countryTileRows.keys()].filter(id=>!next.has(id)),add=[],update=[];
   for(const [id,feature]of next){const previous=countryTileRows.get(id);if(!previous){add.push(feature);continue;}
    const geometryChanged=previous.geometry!==feature.geometry&&geometryKey(previous.geometry)!==geometryKey(feature.geometry);
    const properties=Object.entries(feature.properties).filter(([name,value])=>previous.properties[name]!==value).map(([key,value])=>({key,value}));
    if(geometryChanged||properties.length)update.push({id,...(geometryChanged?{newGeometry:feature.geometry}:{}),...(properties.length?{addOrUpdateProperties:properties}:{})});
   }
   try{
    let applied=true;
    if(!countryTileRows.size)applied=await setData(requestedSource,collection(tileFeatures),current);
    else if(remove.length||add.length||update.length)applied=await sourceUpdate(source=>source.updateData({remove,add,update}),requestedSource,current);
    if(!applied)return false;
   }catch(cause){if(current()){countryRows=new Map();countryTileRows=new Map();countryKey='';}throw cause;}
   if(!current())return false;
   countryRows=new Map(presented.map(feature=>[feature.id,feature]));
   countryTileRows=next;countryKey=key;
   countryBoundaryGeometry=new Map(borders.map(row=>[row.key,row]));
  }
  if(sequence!==countrySequence||requestedGeneration!==generation)return false;
  territorialMultiply=nextMultiply;territorialBatches=nextBatches;
  if(requestedGeneration===generation&&sequence===countrySequence){countryGeneration=generation;countryContentKey=features.map(feature=>String(feature.id)+':'+geometryKey(feature.geometry)).join('|');}
  syncTerritorialFills();
 }
 function syncPhysicalContext(){
  const context=deps.physicalResources.physicalLand;
  if(!loaded||contextLost||basemapRecovery||loadedStyle!==map.style||!context||!deps.physicalResources.physicalContextState.ready)return false;
  const key=context.revision+'|'+(context.waterRevision||'');
  if(key!==landRevision){
   landRevision=key;
  }
  // The derived land revision includes any actual change to the land mask.
  // A water-only change must keep the existing land tiles and their coverage.
  if(map.getSource('physical-land')&&(physicalLandKey!==context.revision||physicalLandSource!==map.getSource('physical-land')))
   preparePhysicalSource('physical-land',context.revision,collection([{type:'Feature',properties:{},geometry:context.geometry}]));
  const waterFeatures=[...state.hydroFeatureCache.values()].filter(feature=>feature.properties.physical_water&&deps.physicalServices.isHydroFeatureVisible(feature));
  const waterKey=key+'|'+waterFeatures.map(feature=>String(feature.id)+':'+geometryRevisionKey(feature.geometry)).join('|');
  if(waterKey!==physicalWaterKey||physicalWaterSource!==map.getSource(physicalWaterSourceId))
   preparePhysicalSource('physical-water',waterKey,waterFeatures.length?collection(waterFeatures.map(feature=>({type:'Feature',geometry:feature.geometry,properties:{objectKey:normalizeObjectRef({domain:'hydro',type:feature.properties.category,id:String(feature.id)}).key}}))):context.water?collection([{type:'Feature',properties:{},geometry:context.water}]):empty());
  return true;
 }
 async function setHydroManifest(manifest,url){
  if(hydroManifest===manifest)return true;
  const stages=mapLibreHydroStages(manifest.stages);
  hydroPresentation?.dispose();hydroLoader?.dispose();hydroManifest=manifest;
  await initialize();
  const minZoomByStage=new Map(stages.map(stage=>[stage.id,stage.minZoom]));
  const displayFeatures=features=>features.flatMap(feature=>{
   const {stage,category}=feature.properties;
   const viewerMinZoom=minZoomByStage.get(stage);
   if(viewerMinZoom===undefined)throw new RangeError('Unknown hydro stage '+stage);
   const geometry=category==='river'?clipMercatorLines(feature.geometry):feature.geometry;
   if(!geometry.coordinates.length)return [];
   return [{...feature,geometry,properties:{...feature.properties,viewerMinZoom}}];
  });
  hydroLoader=await createHydroBrowserLoader({manifest,baseUrl:new URL('.',url).href,dataRevision:deps.physicalConfig.DATA_REVISION,
   createWorker:()=>new Worker(deps.platform.runtimeAssetUrl('workers/hydro-tile-worker.js')),
   tilesForView:({zoom,width,height})=>{
    const bounds=projection.geographicBounds();
    return bounds?hydroTileSpecsForWindow(createHydroTileWindow({manifest:{stages},threshold:zoom,width,height,bounds})):[];
   }});
  hydroPresentation=createMapLibreHydroPresentation({map,beforePublish:async isCurrent=>{
   // Optional pack aggregation and Core identity admission must yield to an
   // already requested dated frame, just like optional tile uploads. Wait for
   // a short quiet window too: successive date requests can otherwise start
   // immediately after a large optional synchronous admission has begun.
   let ticket=presentation.ticket,quietUntil=performance.now()+250;
   while(!disposed&&isCurrent()){
    const current=presentation.ticket,now=performance.now();
    if(current!==ticket||presentation.temporalPending()&&!current?.error){ticket=current;quietUntil=now+250;}
    if(now>=quietUntil)return;
    await new Promise(resolve=>setTimeout(resolve,16));
   }
  },updateSource:async(diff,features,isCurrent)=>{
   let full=false;
   while(!disposed&&isCurrent()){
    if(basemapRecovery)await basemapRecovery;
    if(!styleReady())await new Promise(resolve=>map.once('style.load',resolve));
    if(!isCurrent()||disposed)return false;
    const source=map.getSource('hydro');if(!source)throw new Error('Hydro source missing from current style');
    try{
     const applied=await sourceUpdate(s=>full?s.setData(collection(displayFeatures(features))):
      s.updateData({...diff,add:displayFeatures(diff.add)}),'hydro',isCurrent,{shareAcrossGenerations:true});
     if(applied&&source===map.getSource('hydro')&&styleReady())return true;
    }catch(cause){if(source===map.getSource('hydro')&&isCurrent())throw cause;}
    full=true;
   }
   return false;
  },admitFeatures:async features=>{
   const prepared=prepareMapLibreHydroFeatures(features,deps.physicalResources.prepareHydroFeature);
   await deps.physicalResources.admitHydroFeatures(prepared);
  },onFeatures:features=>{
   hydroFeatures=features;if(selectionSnapshot?.selection.items.some(ref=>ref.domain==='hydro'))setSelection(selectionSnapshot);invalidate('hydro-ready');
  },load:view=>hydroLoader.view(view),cancel:()=>hydroLoader.cancel(),onError:cause=>{if(cause?.name==='AbortError'||cause?.cancelled)return;deps.feedback.reportOperationError(cause,'강·호수 상세 자료를 불러오지 못했습니다. 지도를 이동하면 다시 시도합니다.','PL-HYDRO-DETAIL-001',4200);}});
  await hydroPresentation.refresh();return true;
 }
 function syncHydroState(){
  if(!styleReady())return;
  const ids=hiddenMapLibreHydroIds(hydroFeatures,deps.physicalServices.isHydroFeatureVisible);
  const key=ids.join('|')+'|'+state.layerVisibility.rivers+'|'+state.layerVisibility.lakes;
  if(key!==hydroStateKey){hydroStateKey=key;
   syncMapLibreHydroVisibility(map,ids,state.layerVisibility);
  }
  const edits=(state.hydroEdits||[]).filter(deps.physicalServices.isHydroFeatureVisible);
  const editsKey=edits.map(feature=>String(feature.id)+':'+geometryRevisionKey(feature.geometry)).join('|')+'|'+currentMapStyle().paint.ocean['background-color'];
  if(editsKey!==hydroEditsKey){hydroEditsKey=editsKey;
   if(!map.getSource('hydro-edits')){
    map.addSource('hydro-edits',{type:'geojson',data:empty()});
    map.addLayer({id:'hydro-edits-fill',type:'fill',source:'hydro-edits',filter:['==',['geometry-type'],'Polygon'],paint:{'fill-color':['get','color']}});
    map.addLayer({id:'hydro-edits-line',type:'line',source:'hydro-edits',paint:{'line-color':['get','color'],'line-width':1,'line-opacity':0}});
   }
   strokeDomain('edited-water-strokes',edits,()=>({color:currentMapStyle().paint.ocean['background-color'],width:1,alpha:1,cap:'round'}),210);
   setData('hydro-edits',collection(edits.map(feature=>({type:'Feature',id:String(feature.id),geometry:feature.geometry,properties:{objectKey:normalizeObjectRef({domain:'hydro',type:feature.properties.category||'river',id:String(feature.id)}).key,color:currentMapStyle().paint.ocean['background-color']}}))));
  }
 }
 function setSceneDomains(domains){
  if(!loaded)return;
  if(!styleReady()){pendingSceneDomains=domains;return;}
  const rows=[...domains].flatMap(([domain,value])=>domain==='physical-land'||domain==='physical-water'?[]:[...value.polygons.map(item=>({...item,kind:'fill'})),...value.strokes.map(item=>({...item,kind:'line'}))]);
  const native=row=>row.kind==='line'||row.blendMode==='multiply'||row.style?.blendMode==='multiply';
  sceneMultiply=rows.filter(native).filter(row=>row.kind==='fill'?(row.style?.fillAlpha??1)>0:(row.style?.alpha??1)>0).map(row=>['Point','MultiPoint'].includes(row.geometry?.type)?{...row,kind:'point'}:row);
  const key=rows.map(row=>[row.key,row.geometryRevision,row.order,row.role,row.blendMode,JSON.stringify(row.style)].join(':')).join('|');
  if(key===sceneKey)return;sceneKey=key;
  const groups=new Map();
  rows.filter(row=>!native(row)).sort((a,b)=>a.order-b.order).forEach(row=>{const kind=['Point','MultiPoint'].includes(row.geometry?.type)?'circle':row.kind,band=row.role==='territorial-fill'?'territorial':row.order<0?'base':'independent';const id='scene-'+kind+'-'+row.order+'-'+band;if(!groups.has(id))groups.set(id,[]);groups.get(id).push({...row,kind});});
  for(const id of dynamicLayers)if(!groups.has(id)){map.removeLayer(id);map.removeSource(id);dynamicLayers.delete(id);dynamicSources.delete(id);sceneGroups.delete(id);}
  for(const [id,items]of groups){
   const features=items.filter(item=>item.geometry).map(item=>({type:'Feature',id:item.key,geometry:item.geometry,properties:{objectKey:item.objectKey||'',color:item.style?.color||'#ffffff',alpha:item.style?.fillAlpha??item.style?.alpha??1}}));
   if(!features.length)continue;
   const signature=items.map(item=>[item.key,item.geometryRevision,item.blendMode,JSON.stringify(item.style)].join(':')).join('|');
   if(sceneGroups.get(id)===signature)continue;sceneGroups.set(id,signature);
   if(map.getSource(id))setData(id,collection(features));
   else{
    map.addSource(id,{type:'geojson',data:collection(features)});dynamicSources.add(id);
    const kind=items[0].kind;
    const paint=kind==='fill'?{'fill-color':['get','color'],'fill-opacity':['get','alpha']}:{'circle-color':['get','color'],'circle-radius':5,'circle-opacity':['get','alpha']};
    const before=items[0].role==='territorial-fill'?'physical-water':items[0].order<0?'territories':undefined;
    map.addLayer({id,type:kind,source:id,paint},before);dynamicLayers.add(id);
   }
  }
  syncMultiply();
  sceneOrder=[...groups].map(([id,items])=>({id,order:items[0].order,role:items[0].role}));orderSceneLayers();
  dirty();
 }
 function setSelection(snapshot){
  selectionSnapshot=snapshot;if(!loaded)return;if(!styleReady()){pendingSelection=true;return;}pendingSelection=false;
  const primary=snapshot.selection?.primaryKey,hover=snapshot.hover?.key;
  const refs=[...(snapshot.selection?.items||snapshot.selection?.refs||[])];if(snapshot.hover&&!refs.some(ref=>ref.key===snapshot.hover.key))refs.push(snapshot.hover);
  let nextPolarHover=null;
  const features=refs.flatMap(ref=>{
   if(!deps.objectRefVisible(ref))return [];
   const feature=ref.domain==='territorial'?deps.territorialModel.entityRepository.get(ref.id):ref.domain==='generic'?state.genericFeatures.find(value=>String(value.id)===ref.id):ref.domain==='hydro'?deps.hydroModel.hydroFeatureById(ref.id):ref.domain==='label'?state.labels.find(value=>String(value.id)===ref.id):null;
   const geometries=ref.domain==='distribution'?distributionEntriesForLayer(state.distributionEntries,ref.id).map(entry=>entry.mode===DISTRIBUTION_MODES.TERRITORIAL?deps.territorialModel.entityRepository.get(entry.territorialUnitId)?.geometry:entry.geometry):feature?.geometry?[feature.geometry]:feature?.coordinates?[{type:'Point',coordinates:feature.coordinates}]:[];
   const hovered=ref.key===hover&&!snapshot.selection.items.some(item=>item.key===ref.key);
   const role=ref.key===primary?interactionStyle?.selection.primary:hovered?interactionStyle?.hover:interactionStyle?.selection.secondary;
   const color=hovered?interactionStyle?.hover.color:interactionStyle?.selection.color;
   const paint={color:color||'#ffd453',alpha:role?.fillAlpha??0.2,width:role?.innerWidth??role?.width??2,strokeAlpha:role?.innerAlpha??role?.alpha??1};
   return geometries.filter(Boolean).flatMap(geometry=>{
    const row={type:'Feature',geometry,properties:paint};
    if(hovered&&ref.domain==='territorial'&&polarGeometry(geometry)){
     // One draw path owns this entire highlight across the latitude handoff.
     nextPolarHover=row;
     return [];
    }
    return [row];
   });
  });
  const nextPolarHoverKey=nextPolarHover?JSON.stringify([geometryKey(nextPolarHover.geometry),nextPolarHover.properties]):'';
  if(nextPolarHoverKey!==polarHoverKey){polarHoverKey=nextPolarHoverKey;polarHover=nextPolarHover;interactionRevision++;}
  if(!map.getSource('interaction')){
   map.addSource('interaction',{type:'geojson',data:empty()});
   map.addLayer({id:'interaction-fill',type:'fill',source:'interaction',filter:['==',['geometry-type'],'Polygon'],paint:{'fill-antialias':false,'fill-color':['get','color'],'fill-opacity':['get','alpha']}});
   map.addLayer({id:'interaction-line',type:'line',source:'interaction',paint:{'line-color':['get','color'],'line-width':['get','width'],'line-opacity':0}});
   map.addLayer({id:'interaction-point',type:'circle',source:'interaction',filter:['==',['geometry-type'],'Point'],paint:{'circle-color':['get','color'],'circle-radius':7}});
  }
  const source=map.getSource('interaction'),key=JSON.stringify([snapshot.selection,nextPolarHover?null:snapshot.hover,features.map(f=>[geometryKey(f.geometry),f.properties])]);
  if((interactionPending?.source===source&&interactionPending.key===key)||(!interactionPending&&interactionApplied?.source===source&&interactionApplied.key===key))return;
  interactionRevision++;
  const request={source,key};interactionPending=request;
  setData('interaction',collection(features)).then(applied=>{if(applied&&map.getSource('interaction')===source)interactionApplied=request;else interactionApplied=null;if(interactionPending===request)interactionPending=null;},()=>{interactionApplied=null;if(interactionPending===request)interactionPending=null;});
  strokeDomain('interaction-strokes',features,f=>({color:f.properties.color,width:f.properties.width,alpha:f.properties.strokeAlpha,cap:'round'}),10000);
 }
 function queryObjectRefs(point){
  if(!loaded||temporalOverlay||initialZoomHidden)return [];
  const coordinate=projection.screenToGeo(point);
  if(!coordinate)return [];
  if(Math.abs(coordinate[1])>=POLAR_LATITUDE){
   const refs=[];for(const f of territories)if(deps.containsGeometry(coordinate,f.geometry)){const ref=normalizeObjectRef({domain:'territorial',type:'entity',id:String(f.id)});if(deps.objectRefVisible(ref))refs.push(ref);}
   for(const f of state.hydroFeatureCache.values())if(f.properties.physical_water&&deps.physicalServices.isHydroFeatureVisible(f)&&deps.containsGeometry(coordinate,f.geometry))refs.push(normalizeObjectRef({domain:'hydro',type:f.properties.category,id:String(f.id)}));
   return refs;
  }
  const refs=new Map(),zoom=map.getZoom();for(const feature of map.queryRenderedFeatures(point)){
   if(!requiredSource(feature.source)&&!['viewer-labels','hydro'].includes(feature.source))continue;
   if(!layerVisibleAtZoom(feature.layer,zoom))continue;
   const p=feature.properties||{};if(p.displayRole==='country-border')continue;
   if(feature.source==='hydro'&&!(zoom>=p.viewerMinZoom))continue;
   let ref;
   if(p.objectKey){const [domain,type,...id]=p.objectKey.split(':');ref=normalizeObjectRef({domain,type,id:decodeURIComponent(id.join(':'))});}
   else if(p.logicalId&&p.category)ref=normalizeObjectRef({domain:'hydro',type:p.category,id:String(p.logicalId)});
   if(ref)refs.set(ref.key,ref);
  }return [...refs.values()];
 }
 function renderFrame(frame){
  if(error){pendingFrame=null;requestedAt=null;return {succeeded:false,presentationReady:false,error};}
  if(!styleReady()){pendingFrame=frame;return {succeeded:false,deferred:true,presentationReady:false};}
  pendingFrame=frame;requestedAt=performance.now();metrics.run('physical.sync',syncPhysicalContext);metrics.run('polar.sync',syncPolar);if(initialMapLoading)syncInitialMapSkeleton();else syncLabelVisibility();
  const deferred=!!polarLayer?.pending||!!error||!loaded||contextLost||pendingSources()||[...multiplyLayers.values()].some(entry=>entry.role!=='hydro-detail'&&entry.layer.pending)||countryGeneration!==generation||!presentation.countrySourceAdmitted(countryContentKey)||!deps.physicalResources.physicalContextState.ready||certifiedRevision!==sourceRevision||certifiedCamera!==cameraKey()||!requiredSourcesReady();
  if(deferred||zoomFramePending&&map.isMoving()){ready=false;preparedReady=false;map?.triggerRepaint();return {succeeded:false,deferred:true,presentationReady:false};}
  presentation.markTemporalFrame(frame);preparedReady=true;
  const result={succeeded:true,presentationReady:true,frameId:frame.frameId,viewRevision:frame.viewRevision,projectionRevision:frame.projectionRevision};
  if(presentation.canPresentVisualFrame(frame,result)){state.countryVisualPhase='canonical';if(stats.firstCanonicalFrameMs===null)stats.firstCanonicalFrameMs=performance.now();}
  return result;
 }
 function commitVisualFrame(frame){
  const committed=presentation.commitVisualFrame(frame);
  if(committed){
   if(!initialMapLoading)lastPresentedZoom=map.getZoom();
   zoomFramePending=false;discardUnusedPreservedFrame();
   if(initialZoomHidden&&!initialMapLoading){initialZoomHidden=false;map.getCanvas().style.removeProperty('visibility');}
   metrics.publish();pendingFrame=null;ready=true;notify('ready','지도 준비 완료');
  }
  return committed;
 }
 function failMapPreparation(cause){if(disposed)return;error=cause;ready=false;preparedReady=false;notify('error','지도 불러오기 실패');presentation.rejectMapPresentationWaiters(cause);presentation.failTemporalPresentation(cause);deps.feedback.reportOperationError(cause,'지도를 표시하지 못했습니다.','PL-MAPLIBRE-001');}
 function retryMapPreparation(){error=null;polarInputs=[];interactionApplied=null;polarLayer?.retry();if(physicalDisplayCache?.failed)physicalDisplayCache=null;invalidate('map-retry');}
 function invalidateStyle(){if(loaded&&!styleReady()){pendingStyleRefresh=true;return;}if(loaded){
  setTerritorialFeatures(territories).catch(failMapPreparation);
  hydroStateKey='';syncHydroState();syncBaseLayer();
  if(initialMapLoading)syncInitialMapSkeleton();
  dirty();
 }invalidate('map-paint');}
 function setInteractionStyle(value){if(loaded&&!styleReady()){pendingInteractionStyle=value;return;}const changed=interactionStyle?.antiAlias!==value.antiAlias;interactionStyle=value;
  if(changed&&loaded){styleController?.apply(currentMapStyle(),{updateVisibility:!temporalOverlay});if(map.getLayer('hydro-edits-fill')?.type==='fill')map.setPaintProperty('hydro-edits-fill','fill-antialias',value.antiAlias!==false);}
  syncMultiply();if(selectionSnapshot)setSelection(selectionSnapshot);invalidate('interaction-style');
 }
 return Object.freeze({registerFeature,previewExternalBasemap,cameraSnapshot(){return map&&loaded?readMapLibreCamera(map):null;},setInitialMapLoading(value){initialMapLoading=value===true;syncInitialMapSkeleton();dirty();invalidate('initial-map-skeleton');},attach,initialize,setTerritorialFeatures,setSceneDomains,setSelection,queryObjectRefs,syncCameraFromState,syncPhysicalContext,syncHydroState,
  get map(){return map;},get projection(){return projection;},get loaded(){return loaded;},isStyleReady:styleReady,renderFrame,commitVisualFrame,
  panBy(dx,dy){map.panBy([-dx,-dy],{animate:false});return true;},
  fitGeometry(feature,padding){
   const geometries=[];
   const collect=value=>{if(value?.type==='FeatureCollection'){value.features.forEach(collect);return;}if(value?.type==='Feature'){collect(value.geometry);return;}if(value?.type==='GeometryCollection'){value.geometries.forEach(collect);return;}if(value?.coordinates)geometries.push(value);};collect(feature);
   const boxes=geometries.map(geometry=>coordinateBounds(geometry.coordinates)).filter(box=>box.every(Number.isFinite));if(!boxes.length)return false;
   const bounds=[[Math.min(...boxes.map(box=>box[0])),Math.min(...boxes.map(box=>box[1]))],[Math.max(...boxes.map(box=>box[2])),Math.max(...boxes.map(box=>box[3]))]];
   if(bounds[0][0]===bounds[1][0]&&bounds[0][1]===bounds[1][1]){
    map.jumpTo({center:bounds[0],zoom:map.getZoom()});return true;
   }
   return fitMapBounds(bounds,padding);
  },
  fitMapBounds,fitWorld:padding=>fitMapBounds(WORLD_VIEW_BOUNDS,padding),isAtWorldView,
  canPresentVisualFrame:presentation.canPresentVisualFrame,prepareTemporalCountrySource:presentation.prepareTemporalCountrySource,
  beginTemporalViewTransition(isCurrent){const ticket=presentation.beginTemporalViewTransition(isCurrent);if(externalBasemap&&!basemapRecovery){const finish=()=>{basemapRecovery=null;flushStyleChanges();invalidate('basemap-transition-recovered');};const recovery=Promise.resolve().then(()=>externalBasemap.cancelPending()).then(value=>{finish();return value;},cause=>{finish();throw cause;});basemapRecovery=recovery;recovery.catch(failMapPreparation);}return ticket;},admitTemporalViewTransition:presentation.admitTemporalViewTransition,
  preserveTemporalFrame,releaseTemporalFrame,isFramePreserved:()=>!!temporalOverlay||initialZoomHidden,
  finishTemporalViewTransition:presentation.finishTemporalViewTransition,waitForTemporalPresentation:presentation.waitForTemporalPresentation,
  waitForMapPresentation:presentation.waitForMapPresentation,getProjectGeneration:()=>generation,
  resetProjectRenderState(options){if(options.presentation!=='temporal'){zoomFramePending=false;lastPresentedZoom=null;releaseTemporalFrame();}generation=options.generation;pendingSceneDomains=null;pendingSourceOperations.clear();if(activeCountryTasks.size){countrySourceNeedsSwap=true;countryTail=Promise.resolve();}countrySequence++;countryGeneration=-1;error=null;ready=false;preparedReady=false;presentation.resetForProject(options);},
  labelZoomVisibility,
  getRuntimeState:()=>({...stats,projectRenderBlocked:!!error,mapReady:ready,webglContextLost:contextLost,temporalPresentationPending:presentation.temporalPending(),temporalViewPending:presentation.temporalPending()&&presentation.ticket?.kind==='view',physicalContextRevision:landRevision}),
  getStats:()=>({...stats,performance:metrics.snapshot(),polar:polarLayer?.stats(),errorMessage:error?.message||null,generation,projectReplacing:!!state.projectReplacing,webglContextLost:contextLost,projectRenderBlocked:!!error,displayedRevision:ready?sourceRevision:0,mapReadiness:{mapReady:ready,status:error?'error':ready?'ready':'loading'},hydroFeatureCount:hydroFeatures.length,sourceRevision,certifiedRevision,labelLayout:deps.countryLabelModel.labelLayoutMetrics,mapMoving:state.mapMoving}),
  setHydroManifest,
  getHydroFeatures:()=>hydroFeatures,presentedCountryFeature:id=>territories.find(feature=>String(feature.id)===String(id)),
  pickHydro(point){const ref=queryObjectRefs(point).find(value=>value.domain==='hydro');return ref?{feature:deps.hydroModel.hydroFeatureById(ref.id),ref}:null;},
  invalidateCountryPalette:invalidateStyle,syncCountryBoundaryScene:invalidateStyle,invalidatePhysicalStyle:invalidateStyle,
  invalidateHydroVisibility(){if(loaded&&!styleReady()){pendingStyleRefresh=true;return;}if(loaded){syncHydroState();dirty();}invalidate('hydro-visibility');},
  setRenderQuality(value){quality=value;if(map&&value?.dprCap&&Math.abs(map.getPixelRatio()-value.dprCap)>1e-9)map.setPixelRatio(value.dprCap);},
  setInteractionStyle,
  getRenderPixelRatio:()=>quality?.dprCap||window.devicePixelRatio||1,
  verifyLayout(){if(map){map.resize();syncBaseLayer();applyCameraFit();}},failMapPreparation,retryMapPreparation,
  dispose(){disposed=true;polarLayer?.dispose();externalBasemap?.dispose();if(externalAttribution)map?.removeControl(externalAttribution);externalAttribution=null;for(const record of mapFeatures.values()){try{record.owner.dispose();}catch(cause){deps.feedback.reportOperationError(cause,'추가 지도 기능을 정리하지 못했습니다.','PL-MAPLIBRE-OPTIONAL-001');}}mapFeatures.clear();zoomFramePending=false;releaseTemporalFrame();presentation.dispose();hydroPresentation?.dispose();hydroLoader?.dispose();multiplyRpc?.stop('maplibre-dispose');for(const entry of multiplyLayers.values())entry.layer.dispose();multiplyLayers.clear();map?.remove();if(window.__PANDOLAB_MAPLIBRE__===map)delete window.__PANDOLAB_MAPLIBRE__;stylesheet?.remove();container?.remove();},
 });
}
