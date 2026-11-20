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
import {admittedGeometryKey as geometryKey,geometryReferenceFor} from '../geometry/geometry-version-store.js';
import {classifyTerritorialPropertyOnly} from '../document/territorial-entity-store.js';
import {distributionEntriesForLayer,DISTRIBUTION_MODES} from '../document/distribution-model.js';
import {createMapLibreVectorGroup} from './maplibre-vector-group.js';
import {createVerifiedCoreWorker} from '../runtime/core-wasm-loader.js';
import {createMapObjectSpatialIndex} from '../map/map-object-spatial-index.js';
import {createWorkerRpcClient} from '../runtime/worker-rpc.js';
import {coordinateBounds} from '../geometry/coordinate-bounds.js';
import {layerObjectRank,layerStyle} from '../ui/layer-presentation.js';
import {createRenderingMetrics} from './rendering-metrics.js';

const collection=features=>({type:'FeatureCollection',features});
const empty=()=>collection([]);
const countryTileSource=()=>({type:'geojson',data:empty(),promoteId:'objectKey',tolerance:0});
const countryFillFilter=batch=>['all',['==',['get','displayRole'],'country-fill'],['==',['get','paintBatch'],batch],['==',['get','blendMode'],'normal']];
const SOURCE_LAYERS={'territories':['territories','borders'],'physical-land':['physical-land-fill'],'physical-water':['physical-water']};
const slotOpacity=type=>type==='line'?'line-layer-opacity':'fill-layer-opacity';
const ZOOM_EPSILON=1e-9;
const WORLD_VIEW_BOUNDS=[[-89.999,-85.0511287798066],[89.999,85.0511287798066]];
const layerVisibleAtZoom=(layer,zoom)=>layer.layout?.visibility!=='none'&&
 zoom>=(layer.minzoom??-Infinity)&&zoom<(layer.maxzoom??Infinity);

/** MapLibre owns map pixels and picking. Core and the physical owner retain all data. */
export function createMapLibreViewerRenderer(deps,{presentMapPreparation,onMapPreparationStatus,initialCamera,readInitialSafeInsets}={}) {
 if(typeof deps.objectRefVisible!=='function')throw new TypeError('MapLibre requires the canonical object visibility query.');
 const state=deps.projectState.state;
 const metrics=createRenderingMetrics();
 let map,api,projection,container,stylesheet,initialization,loadedStyle=null,disposed=false,loaded=false,generation=0,contextRevision=0,contextLost=false;
 let pendingCameraFit=null;
 let sourceRevision=0,certifiedRevision=-1,certifiedGeneration=-1,certifiedContext=-1,certifiedCamera='',pendingFrame=null,ready=false,preparedReady=false,error=null,countryGeneration=-1,countryContentKey='';
 let requestedCertificate=null,previousActiveRender=null;
 let endSourceFrame=null;
 let territories=[],landRevision=null,hydroLoader,hydroPresentation,hydroFeatures=[],hydroManifest=null;
 let hydroStartup,hydroStartupAbort,hydroAppliedSource=null;
 let sceneKey='',countryKey='',quality=null,interactionStyle=null;
 let acceptedCountryInputs=null;
  const pendingSourceOperations=new Set();
 const pendingSources=()=>{for(const entry of pendingSourceOperations)if(entry.generation!==generation||entry.context!==contextRevision||map.getSource(entry.id)!==entry.source)pendingSourceOperations.delete(entry);return [...pendingSourceOperations].filter(entry=>requiredSource(entry.id)).length;};
 const dynamicLayers=new Set(),dynamicSources=new Set(),sceneGroups=new Map();
 let countryRows=new Map(),hydroStateKey='',hydroEditsKey='',physicalLandKey='',physicalWaterKey='',physicalLandSource=null,physicalWaterSource=null,selectionSnapshot=null;
 const physicalDisplayCache=new Map(),retainedSources=new Map();
 let countryTileRows=new Map(),countryBoundaryGeometry=new Map();
 const physicalPending=new Map();
 const handledSourceErrors=new WeakSet(),sourceQueues=new WeakMap();
 let countrySequence=0,countryTail=Promise.resolve(),countrySourceId='territories',countrySourceSerial=0,countrySourceNeedsSwap=false;
 let physicalLandSourceId='physical-land',physicalWaterSourceId='physical-water';
 const activeCountryTasks=new Set();
 let sceneVectors=[],geometryRpc=null,geometryAbort=new AbortController();
 let acknowledgedBoundary=null,boundaryRequest=0,countryGeometryAbort=null;
 const vectorLayers=new Map(),strokeDomains=new Map(),strokeSignatures=new Map();
 let sceneOrder=[],lastSceneOrder='',interactionRevision=0,interactionPending=null,interactionApplied=null;
 const mapFeatures=new Map();
 const colorsEnabled=()=>layerStyle(state.layerPresentation,'objects').colorVisible;
 let externalBasemap=null,externalAttribution=null,basemapRecovery=null,styleController=null;
 const currentMapStyle=()=>resolveMapLibreMapStyle({
  palette:deps.preferences.mapPalette(),antiAlias:interactionStyle?.antiAlias!==false,
  layerVisibility:state.layerVisibility,
 });
 let pendingStyleRefresh=false,pendingCountryPaint=false,pendingSelection=false,pendingInteractionStyle=null,pendingSceneDomains=null;
 const styleReady=()=>loaded&&!contextLost&&!basemapRecovery&&!!map&&loadedStyle===map.style;
 function flushStyleChanges(){
  if(!styleReady())return;
  if(pendingInteractionStyle){const value=pendingInteractionStyle;pendingInteractionStyle=null;setInteractionStyle(value);}
  if(pendingStyleRefresh){pendingStyleRefresh=false;invalidateStyle();}
  if(pendingCountryPaint){pendingCountryPaint=false;invalidateCountryColors();}
  if(pendingSceneDomains){const value=pendingSceneDomains;pendingSceneDomains=null;setSceneDomains(value);}
  if(pendingSelection&&selectionSnapshot)setSelection(selectionSnapshot);
  invalidate('map-paint-ready');
 }
 async function previewExternalBasemap(style){
  if(disposed||!loaded||presentation.temporalPending()||temporalOverlay)throw new Error('The map is not available for a basemap change.');
  for(const layer of style?.layers||[])if(map.getLayer(layer.id))throw new Error('Basemap layer collision: '+layer.id);
  externalBasemap ||=createExternalBasemap(map,{getRevision:()=>JSON.stringify([generation,contextRevision,sourceRevision,presentation.temporalPending(),!!temporalOverlay]),onChange:()=>{syncVectorGroups();dirty();invalidate('external-basemap-change');},onRemoveStart:()=>{if(!temporalOverlay)preserveTemporalFrame();},onRemoveEnd:()=>{if(!presentation.temporalPending())releaseTemporalFrame();},onCancelled:()=>{if(externalAttribution){map.removeControl(externalAttribution);externalAttribution=null;}},onFailure:(cause,{removed})=>{
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
 const countryFillGroups=new Map(),countryPaintState=new WeakMap();
 let initialMapLoading=false;
 let temporalOverlay=null,temporalInteractions=[],temporalOptionalLayers=[];
 let temporalFrameHeld=false,zoomFramePending=false,initialZoomHidden=false,lastPresentedZoom=null,lastCameraZoom=null;
 function suspendOptionalLayers(){
  for(const layer of map.getStyle()?.layers||[]){
   if(!layer.source||requiredSource(layer.source)||retainedSources.has(layer.source)||layer.source==='hydro'||layer.layout?.visibility==='none'||temporalOptionalLayers.some(item=>item.id===layer.id))continue;
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
   const style=styleFor(feature),geometry=feature.geometry;
   if(!(style.width>0)||!(style.alpha>0)||!['Polygon','MultiPolygon','LineString','MultiLineString'].includes(geometry.type))continue;
   const key=JSON.stringify(style);
   if(!groups.has(key))groups.set(key,{style,geometries:[],revisions:[]});
   const group=groups.get(key);group.geometries.push(geometry);group.revisions.push(geometryKey(geometry));
  }
  const revision=group=>group.revisions.join('|');
  const signature=[...groups].map(([key,group])=>key+':'+revision(group)).join(';');
  if(strokeSignatures.get(name)===signature)return;
  strokeSignatures.set(name,signature);
  const lines=geometry=>geometry.type==='LineString'?[geometry.coordinates]:geometry.type==='MultiLineString'
   ?geometry.coordinates:connectBoundarySegments(buildRenderableBoundarySegments(geometry));
  strokeDomains.set(name,[...groups].map(([key,group])=>({key:name+key,kind:'line',
   order,role:name==='interaction-strokes'?'interaction-stroke':name==='edited-water-strokes'?'project-hydro':undefined,
   geometryRevision:name+':'+revision(group),geometry:{type:'MultiLineString',coordinates:group.geometries.flatMap(lines)},style:group.style,blendMode:'normal'})));
  syncVectorGroups();
 }
 async function prepareCountryBorders(features,revision,signal){
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
  const prepared=needed.length?await prepareBoundaryGroups(countryFeatures,topologyKey,needed,revision,signal):null;
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
 async function prepareBoundaryGroups(features,key,groups,revision,signal){
  const serial=++boundaryRequest;
  const versions=new Map(features.map(feature=>[feature.id,geometryKey(feature.geometry)]));
  const previous=acknowledgedBoundary;
  const items=groups.map(row=>({kind:'stroke',cacheKey:row.key,countryVisibleIds:row.owners}));
  const request=async(base)=>{
   const boundary=metrics.run('border.payload',()=>({
    key,baseKey:base?.key??null,
    upserts:features.filter(row=>base?.versions.get(row.id)!==versions.get(row.id))
     .map(({id,geometry})=>({id,geometry})),
    remove:base?[...base.versions.keys()].filter(id=>!versions.has(id)):[],
   }));
   stats.boundaryRequests++;
   stats.boundaryGeometryRows+=boundary.upserts.length;
   return prepareRenderGeometry(items,revision,boundary,signal);
  };
  let result=await request(previous);
  if(result.boundaryMiss){
   stats.boundaryCacheMisses++;
   result=await request(null);
  }
  if(result.boundaryMiss)throw new Error('Shared border worker could not synchronize its source');
  if(serial===boundaryRequest)acknowledgedBoundary={key,versions};
  return result;
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
  polarLayer ||=createPolarLayer({map,prepare:async geometry=>(await prepareRenderGeometry([{kind:'fill',cacheKey:'polar:'+geometryKey(geometry),geometry}],generation)).packets[0].packet,onChange:()=>{dirty();invalidate('polar-ready');},onError:cause=>{if(cause.name==='AbortError'){polarInputs=[];invalidate('polar-cancelled');}else failMapPreparation(cause);}});
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
  const colored=colorsEnabled(),land=style.paint['physical-land-fill']['fill-color'];
  const inputs=[generation,countryKey,colored,context.geometry,context.water,context.revision,interactionStyle,
   interactionRevision,style.paint['physical-land-fill']['fill-color'],style.paint.ocean['background-color'],state.backgroundSettings?.graticule,state.resourceCapabilities?.graticule];
  if(inputs.length===polarInputs.length&&inputs.every((value,index)=>value===polarInputs[index]))return;
  polarInputs=inputs;
  add(context.geometry,style.paint['physical-land-fill']['fill-color'],1,false,false,'land');
  for(const f of countryRows.values())add(f.geometry,colored?f.properties.color:land,colored?f.properties.displayAlpha:1,colored&&f.properties.blendMode==='multiply');
  if(context.water)add(context.water,style.paint.ocean['background-color']);
  if(countryKey)for(const {key,paths,feature:{properties}} of countryBoundaryGeometry.values()){
   if(!paths.polar.indices.length)continue;
   const {borderColor,borderAlpha,borderWidth}=properties;
   items.push({packet:paths.polar,color:rgba(borderColor,borderAlpha),width:borderWidth});
   keys.push([key,borderColor,borderAlpha,borderWidth]);
  }
  if(state.backgroundSettings?.graticule!==false&&state.resourceCapabilities?.graticule!==false){items.push({packet:polarGrid,color:rgba('#777777',.15),width:.5});keys.push('grid');}
  for(const ref of selectionSnapshot?.selection?.items||[]){if(!deps.objectRefVisible(ref))continue;const f=ref.domain==='territorial'?deps.territorialModel.entityRepository.get(ref.id):ref.domain==='hydro'?deps.hydroModel.hydroFeatureById(ref.id):null;const role=ref.key===selectionSnapshot.selection.primaryKey?interactionStyle?.selection.primary:interactionStyle?.selection.secondary;if(f?.geometry){add(f.geometry,interactionStyle?.selection.color||'#0080ff',role?.fillAlpha??.2);line(f.geometry,interactionStyle?.selection.color||'#0080ff',role?.innerAlpha??role?.alpha??1,role?.innerWidth??role?.width??2);}}
  if(polarHover){
   const {geometry,properties:{color,alpha,strokeAlpha,width}}=polarHover;
   add(geometry,color,alpha,false,true);
   line(geometry,color,strokeAlpha,width,true);
  }
  polarLayer.update(JSON.stringify([generation,keys,style.paint.ocean]),items,rgba(style.paint.ocean['background-color']));
  positionPolarLayer();
 }
 const stats={renderedFrames:0,sourceUpdates:0,sourceWrites:0,hydroVisibilityScans:0,geometryWorkerRequests:0,geometryWorkerTransferBytes:0,retainedSourceHits:0,boundaryRequests:0,boundaryGeometryRows:0,boundaryCacheMisses:0,approvalAttempts:0,renderer:'maplibre',firstCanonicalFrameMs:null,physicalLandPreparations:0,physicalLandPreparationMs:0,physicalLandAssetHits:0,strokePreparedPackets:0};
 const invalidate=reason=>deps.domains.renderingDomain?.invalidateView(reason);
 const cameraKey=()=>map?JSON.stringify([map.getCenter().lng,map.getCenter().lat,map.getZoom(),map.getBearing(),map.getPitch(),map.getRoll(),map.getCanvas().width,map.getCanvas().height]):'';
 const activeSource=kind=>kind==='territories'?countrySourceId:kind==='physical-land'?physicalLandSourceId:physicalWaterSourceId;
 const requiredSource=id=>[countrySourceId,physicalLandSourceId,physicalWaterSourceId,'hydro-edits','viewer-labels','interaction'].includes(id)
  ||dynamicSources.has(id)||(vectorLayers.has(id)&&vectorLayers.get(id).role!=='hydro-detail');
 let layerIds=[],sourceLayers=[],indexedStyle=null;
 function mapSourceLayers(){
  const ids=map.getLayersOrder();
  if(indexedStyle!==map.style||ids.length!==layerIds.length||ids.some((id,index)=>id!==layerIds[index])){
   indexedStyle=map.style;layerIds=ids.slice();
   sourceLayers=ids.map(id=>map.getLayer(id)).filter(layer=>layer?.source);
  }
  return sourceLayers;
 }
 function visibleSourceLayer(layer,zoom){
  return map.getLayoutProperty(layer.id,'visibility')!=='none'&&layerVisibleAtZoom(layer,zoom);
 }
 function requiredSourcesReady(){
  if(!map?.style)return false;
  for(const [kind,ids] of Object.entries(SOURCE_LAYERS)){
   const source=activeSource(kind);
   if(!map.getSource(source)||ids.some(id=>!map.getLayer(sourceLayer(id,source))))return false;
  }
  if(physicalPending.has('physical-land')||physicalPending.has('physical-water'))return false;
  const zoom=map.getZoom(),loadedSources=new Set();
  for(const layer of mapSourceLayers()){
   const {source}=layer;
   if(loadedSources.has(source)||!requiredSource(source)||!visibleSourceLayer(layer,zoom))continue;
   if(!map.isSourceLoaded(source))return false;
   loadedSources.add(source);
  }
  return true;
 }
 function sourceLayer(id,source){
  return map.getLayer(id)?.source===source?id:id+'--'+source;
 }
 function slots(kind){
  return [...retainedSources].filter(([id,record])=>record.kind===kind&&map.getSource(id)===record.source);
 }
 function reuseSource(kind,key){return slots(kind).find(([,record])=>record.key===key);}
 function reserveSource(kind){
  const active=activeSource(kind);
  const standby=slots(kind).find(([id])=>id!==active);
  if(standby)return standby[0];
  const id=active===kind?kind+'-retained':kind;
  if(!map.getSource(id))map.addSource(id,kind==='territories'?countryTileSource():{type:'geojson',data:empty()});
  const layers=map.getStyle().layers;
  for(const base of SOURCE_LAYERS[kind]){
   const spec=layers.find(layer=>layer.id===sourceLayer(base,active));
   const layerId=sourceLayer(base,id);
   if(!map.getLayer(layerId))map.addLayer({...spec,id:layerId,source:id,paint:{...spec.paint,[slotOpacity(spec.type)]:0}},spec.id);
  }
  retainedSources.set(id,{kind,source:map.getSource(id)});
  return id;
 }
 function activateSource(kind,id){
  const previous=activeSource(kind);
  if(previous===id)return;
  for(const layer of map.getStyle().layers){
   if(layer.source!==previous&&layer.source!==id)continue;
   if(layer.type==='fill'||layer.type==='line')map.setPaintProperty(layer.id,slotOpacity(layer.type),layer.source===id?1:0);
  }
  if(kind==='territories')countrySourceId=id;
  else if(kind==='physical-land')physicalLandSourceId=id;
  else physicalWaterSourceId=id;
  dirty();
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
 function sourceUpdate(start,id,isCurrent=()=>true,{shareAcrossGenerations=false}={}){
  const requestedGeneration=generation,requestedContext=contextRevision;if(requiredSource(id))dirty();
  const source=map.getSource(id),previous=sourceQueues.get(source)||Promise.resolve(),pending={id,source,generation:requestedGeneration,context:requestedContext};pendingSourceOperations.add(pending);
  const outcome=previous.catch(()=>{}).then(async()=>{
   if(disposed||requestedContext!==contextRevision||map.getSource(id)!==source||!isCurrent()||(!shareAcrossGenerations&&requestedGeneration!==generation))return false;
   let sourceError=null;const onSourceError=event=>{sourceError=event.error||new Error('Source update failed: '+id);if(typeof sourceError==='object'&&sourceError!==null){const handled=sourceError;handledSourceErrors.add(handled);queueMicrotask(()=>handledSourceErrors.delete(handled));}};
   source.on('error',onSourceError);
   try{await metrics.track('source:'+id.replace(/-generation-\d+$/,''),()=>{stats.sourceWrites++;return start(source);});if(sourceError)throw sourceError;return true;}finally{source.off('error',onSourceError);}
  });
  sourceQueues.set(source,outcome);
  const finish=()=>pendingSourceOperations.delete(pending);
  outcome.then(()=>{finish();if(sourceQueues.get(source)===outcome)sourceQueues.delete(source);if(!disposed&&map.getSource(id)===source&&requestedGeneration===generation&&requestedContext===contextRevision)map.triggerRepaint();},cause=>{finish();if(sourceQueues.get(source)===outcome)sourceQueues.delete(source);if(requiredSource(id)&&!disposed&&map.getSource(id)===source&&isCurrent()&&requestedGeneration===generation&&requestedContext===contextRevision)failMapPreparation(cause);});
  return outcome;
 }
 function setData(id,data,isCurrent,options){return sourceUpdate(source=>source.setData(data),id,isCurrent,options);}
 function preparePhysicalSource(kind,key,data){
  const previous=physicalPending.get(kind);
  if(previous?.key===key&&previous.source===map.getSource(previous.id))return;
  const publish=(id,source)=>{
   activateSource(kind,id);
   if(kind==='physical-land'){physicalLandKey=key;physicalLandSource=source;}
   else{physicalWaterKey=key;physicalWaterSource=source;}
   orderSceneLayers();
  };
  const cached=reuseSource(kind,key);
  if(cached){
   physicalPending.delete(kind);
   publish(cached[0],cached[1].source);
   stats.retainedSourceHits++;
   return;
  }
  const active=activeSource(kind);
  const activeReady=retainedSources.get(active)?.key;
  const id=(presentation.temporalPending()&&activeReady)||previous?.id===active?reserveSource(kind):active;
  const source=map.getSource(id),entry={key,source,id,generation};
  physicalPending.set(kind,entry);
  retainedSources.set(id,{kind,source});
  const current=()=>!disposed&&physicalPending.get(kind)===entry&&map.getSource(id)===source;
  const prepared=kind==='physical-land'?preparePhysicalDisplay(key,data.features[0].geometry).then(geometry=>collection([{...data.features[0],geometry}])):Promise.resolve(data);
  prepared.then(value=>current()?setData(id,value,current,{shareAcrossGenerations:true}):false,cause=>{if(current()){physicalPending.delete(kind);failMapPreparation(cause);}return false;})
   .then(applied=>{if(!current())return;physicalPending.delete(kind);if(applied){retainedSources.set(id,{kind,source,key});publish(id,source);invalidate('physical-source-ready');}},cause=>{if(!current())return;physicalPending.delete(kind);if(entry.generation===generation)failMapPreparation(cause);else invalidate('physical-source-retry');});
 }
 function geometryWorker(){
  return geometryRpc ||=createWorkerRpcClient({createWorker:()=>createVerifiedCoreWorker(deps.platform.runtimeAssetUrl('workers/map-geometry-worker.js')),
   isCurrent:({entry,message})=>entry.projectRevision===message.projectRevision});
 }
 function preparePhysicalDisplay(key,geometry){
  const cached=physicalDisplayCache.get(key);
  if(cached){physicalDisplayCache.delete(key);physicalDisplayCache.set(key,cached);return cached.task;}
  if(physicalDisplayCache.size===2){
   const oldest=physicalDisplayCache.keys().next().value;
   physicalDisplayCache.get(oldest).controller.abort();
   physicalDisplayCache.delete(oldest);
  }
  const entry={controller:new AbortController(),geometry:null,task:null};physicalDisplayCache.set(key,entry);
  entry.task=Promise.resolve(deps.physicalResources.loadPhysicalLandDisplay?.(key)).then(prepared=>{
    if(prepared){stats.physicalLandAssetHits++;return {result:{geometry:prepared,durationMs:0}};}
    return geometryWorker().request('geometry.physical-land',{sourceKey:'physical-display-union-v1:'+key,geometry},{projectRevision:generation,signal:entry.controller.signal});
  })
   .then(({result})=>{entry.geometry=result.geometry;stats.physicalLandPreparations++;stats.physicalLandPreparationMs+=result.durationMs;return result.geometry;},cause=>{if(physicalDisplayCache.get(key)===entry)physicalDisplayCache.delete(key);throw cause;});
  return entry.task;
 }
 async function prepareRenderGeometry(items,revision,boundary,signal=geometryAbort.signal){
  if(!items.length)return {packets:[]};
  const sentAt=performance.timeOrigin+performance.now();
  const request=async()=>{
   signal.throwIfAborted();
   const worker=geometryWorker();
   stats.geometryWorkerRequests++;
   try{return (await metrics.track('geometry.prepare',()=>worker.request('geometry.prepare',{items,boundary},{projectRevision:revision,signal}))).result;}
   catch(cause){
    if(cause.code==='PL-MAP-GEOMETRY-INITIALIZATION'&&geometryRpc===worker){
     worker.stop('geometry-initialization-retry');geometryRpc=null;acknowledgedBoundary=null;
    }
    throw cause;
   }
  };
  let result;
  try{result=await request();}
  catch(cause){
   if(cause.name==='AbortError'||signal.aborted||disposed)throw cause;
   await new Promise(resolve=>setTimeout(resolve,100));
   result=await request();
  }
  stats.geometryWorkerTransferBytes+=result.stats?.transferBytes||0;
  const receivedAt=performance.timeOrigin+performance.now();
  if(result.boundaryMiss)return result;
  if(result.stats){
   const {workerMs,startedAt,finishedAt}=result.stats;
   metrics.record('geometry.worker',workerMs);
   metrics.record('geometry.dispatch',Math.max(0,startedAt-sentAt));
   metrics.record('geometry.reply',Math.max(0,receivedAt-finishedAt));
  }
  if(result.stats)stats.geometryPreparation={boundarySeedFailure:result.stats.boundarySeedFailure,boundarySeeded:result.stats.boundarySeeded,boundaryChangedCount:result.stats.boundaryChangedCount,packets:result.stats.slowestPackets?.map(row=>({kind:row.kind,durationMs:row.durationMs,packetBytes:row.packetBytes,assetHits:(row.assetHitsAfter??0)-(row.assetHitsBefore??0)}))};
  return result;
 }
 function syncVectorGroups(){
  if(!loaded)return;
  const groups=new Map();
  for(const row of [...sceneVectors,...[...strokeDomains.values()].flat()].sort((a,b)=>a.order-b.order)){
   const kind=row.kind||'fill',id=row.role==='graticule'?'map-graticule':'vector-'+kind+'-'+row.order+'-'+(row.role==='territorial-fill'?'territorial':row.role==='hydro-detail'?'hydro-detail':'independent');
   if(!groups.has(id))groups.set(id,[]);groups.get(id).push({...row,style:kind==='line'?{...row.style,antiAlias:interactionStyle?.antiAlias??row.style?.antiAlias??true}:row.style,geometryRevision:kind+':'+row.geometryRevision});
  }
  for(const [id,entry]of vectorLayers)if(!groups.has(id)){entry.layer.dispose();vectorLayers.delete(id);}
  for(const [id,originalItems]of groups){
   let items=originalItems;
   if(items[0]?.kind==='line'&&items.length>1){const batches=new Map();for(const row of items){const merge=!row.objectKey&&(row.style?.alpha??1)===1&&(!row.style?.casing||(row.style.casing.alpha??1)===1);const key=JSON.stringify([row.blendMode,row.style,merge?'':row.key]);if(!batches.has(key))batches.set(key,[]);batches.get(key).push(row);}items=[...batches.values()].map(rows=>rows.length===1?rows[0]:({...rows[0],key:rows.map(r=>r.key).join('|'),geometryRevision:rows.map(r=>r.geometryRevision).join('|'),geometry:{type:'MultiLineString',coordinates:rows.flatMap(r=>r.geometry.type==='MultiLineString'?r.geometry.coordinates:[r.geometry.coordinates])}}));}

   const signature=items.map(item=>[item.key,item.geometryRevision,item.blendMode,JSON.stringify(item.style)].join(':')).join('|');
   let entry=vectorLayers.get(id);
   if(!entry){
    const layer=createMapLibreVectorGroup(map,{id,sharedSource:items[0].role==='territorial-fill'?()=>countrySourceId:undefined,before:items[0].role==='territorial-fill'?'physical-water':items[0].role==='interaction-stroke'?undefined:map.getLayer('interaction-fill')?'interaction-fill':undefined,
     onChange:()=>{if(!disposed){orderSceneLayers();if(items[0].role!=='hydro-detail')dirty();invalidate('vector-ready');}}});
    entry={layer,signature:null,order:items[0].order,role:items[0].role};vectorLayers.set(id,entry);
   }
   else if(!map.getLayer(id))entry.signature=null;
   if(entry.signature!==signature){entry.signature=signature;entry.layer.update(items).catch(cause=>{if(entry.role==='hydro-detail')deps.feedback.reportOperationError(cause,'강 상세 표시를 준비하지 못했습니다.','PL-HYDRO-DETAIL-002');else failMapPreparation(cause);});}
  }
  orderTerritorialFills();
 }
 function moveLayerIfNeeded(id,before){
  const order=map.getLayersOrder(),position=order.indexOf(id);
  if(position>=0&&(before?order[position+1]!==before:position!==order.length-1))map.moveLayer(id,before);
 }
 function orderTerritorialFills(){
  let before=sourceLayer('physical-water',physicalWaterSourceId);
  if(!map.getLayer(before))return;
  const fills=countryFillGroups.get(countrySourceId)||[];
  for(let index=fills.length-1;index>=0;index--){
   const {id}=fills[index];
   if(map.getLayer(id)){moveLayerIfNeeded(id,before);before=id;}
  }
 }
 function orderSceneLayers(){
  const orderKey=countrySourceId+';'+physicalWaterSourceId+';'+sceneOrder.map(row=>row.id+':'+row.order+':'+row.role).join('|');
  const key=map.getLayersOrder().join('|')+';'+orderKey;
  if(key===lastSceneOrder)return;
  const ordered=[...sceneOrder,{id:sourceLayer('borders',countrySourceId),order:100},...[...vectorLayers].map(([id,entry])=>({id,order:entry.order,role:entry.role}))];
  for(const row of ordered.sort((a,b)=>a.order-b.order))if(row.role!=='graticule'&&map.getLayer(row.id)){
   const before=row.role==='territorial-fill'?'physical-water':row.order<0?'territories':undefined;
   if(vectorLayers.has(row.id))vectorLayers.get(row.id).layer.move(before);else map.moveLayer(row.id,before);
  }
  orderTerritorialFills();
  if(map.getLayer('map-graticule'))map.moveLayer('map-graticule');
  for(const id of ['interaction-fill','interaction-line','interaction-point'])if(map.getLayer(id))map.moveLayer(id);
  for(const entry of vectorLayers.values())if(entry.role==='interaction-stroke')entry.layer.move();
  for(const id of [...MAPLIBRE_LABEL_LAYERS,'initial-map-ocean','initial-map-land'])if(map.getLayer(id))map.moveLayer(id);
  positionPolarLayer();
  lastSceneOrder=map.getLayersOrder().join('|')+';'+orderKey;
 }
 function syncTerritorialFills(source,batches){
  const base=sourceLayer('territories',source),paint=currentMapStyle().territorialFillPaint;
  const suffix=base.slice('territories'.length);
  const next=batches.flatMap(({index,blendMode,ids})=>blendMode==='normal'
   ?[{id:index===0?base:'territories-fill-'+index+suffix,multiply:false,filter:countryFillFilter(index)}]
   :ids.map(id=>({id:'territories-multiply-'+id+suffix,multiply:true,filter:['==',['get','objectKey'],id]})));
  const wanted=new Set(next.map(group=>group.id));
  for(const {id} of countryFillGroups.get(source)||[])if(id!==base&&!wanted.has(id)&&map.getLayer(id))map.removeLayer(id);
  for(const {id,multiply,filter} of next)if(!map.getLayer(id))
   map.addLayer({id,type:'fill',source,filter,layout:{'fill-sort-key':['get','paintOrder']},paint:{...paint,
    'fill-layer-blend':multiply&&colorsEnabled()?'multiply':'normal',
    'fill-layer-opacity':source===countrySourceId?1:0}},sourceLayer('physical-water',physicalWaterSourceId));
  countryFillGroups.set(source,next);
 }
 function syncCountryPaint(id,rows){
  const source=map.getSource(id),neutral=!colorsEnabled();
  const previous=countryPaintState.get(source);
  if(previous?.neutral===neutral&&previous.rows===rows)return;
  for(const key of previous?.rows.keys()||[])if(!rows.has(key))map.removeFeatureState({source:id,id:key});
  for(const [key,row] of rows)if(previous?.neutral!==neutral||previous.rows.get(key)?.properties.color!==row.properties.color)
   map.setFeatureState({source:id,id:key},{neutral,countryColor:row.properties.color});
  for(const group of countryFillGroups.get(id)||[])if(group.multiply&&map.getLayer(group.id))
   map.setPaintProperty(group.id,'fill-layer-blend',neutral?'normal':'multiply');
  countryPaintState.set(source,{rows,neutral});
 }
 function syncBaseLayer(){
  if(!loaded)return false;
  const style=currentMapStyle();
  const changed=syncMapLibreBaseLayer(map,{style,landGeometry:physicalDisplayCache.get(deps.physicalResources.physicalLand?.revision)?.geometry});
  styleController?.apply(style,{updateVisibility:!temporalOverlay});
  if(changed)externalBasemap?.reposition();
  return changed;
 }
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
   const hydroStyle=mapLibreHydroStyle({antiAlias:interactionStyle?.antiAlias!==false,stylePaint:initialStyle.paint});
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
   styleController=createMapLibreStyleController(map);
   projection=createMapLibreProjection(map);
   map.on('styledata',()=>{indexedStyle=null;});
   map.on('style.load',()=>{hydroInputs=null;hydroStateKey=null;hydroEditsKey=null;loadedStyle=map.style;if(loaded&&!disposed){restoreFeatures();flushStyleChanges();refreshHydroDetail();}});
   map.on('webglcontextlost',()=>{contextRevision++;pendingSourceOperations.clear();physicalPending.clear();physicalLandKey='';physicalWaterKey='';contextLost=true;ready=false;preparedReady=false;certifiedRevision=-1;notify('loading','지도 복구 중');});
   map.on('webglcontextrestored',()=>{
    const restore=()=>{if(disposed)return;syncVectorGroups();polarLayer?.resetContext();contextLost=false;certifiedRevision=-1;dirty();flushStyleChanges();invalidate('map-context-restored');};
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
    requestedCertificate=null;

    const requiredReady=loaded&&!contextLost&&!polarLayer?.pending&&!pendingSources()&&requiredSourcesReady();
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
   if(initialCamera){
    map.resize();
    if(startupView)syncCameraFromState(startupView);
    else fitMapBounds(WORLD_VIEW_BOUNDS,readInitialSafeInsets());
    syncInitialMapSkeleton();
    map.once('render',()=>container.style.removeProperty('visibility'));
    map.triggerRepaint();
   }
   lastCameraZoom=map.getZoom();
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
   map.on('movestart',()=>{previousActiveRender=null;deps.domains.renderingDomain?.beginInteraction('maplibre-move');});
   map.on('moveend',()=>{previousActiveRender=null;deps.domains.renderingDomain?.endInteraction('maplibre-move-end');});
   if(!initialCamera){
    if(pendingCameraFit)applyCameraFit();else syncCameraFromState(initialView);
   }
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
  const entities=deps.territorialModel.entityRepository.list?.()??features;
  const countryStyle=currentMapStyle();
  const inputs={entities,features,generation,source:map?.getSource(countrySourceId),
   presentation:state.layerPresentation,visibility:state.itemVisibility?.objects,
   visible:state.layerVisibility.objects,stroke:JSON.stringify([countryStyle.countryStroke,countryStyle.borderAlpha])};
  const accepted=acceptedCountryInputs;
  const immutable=rows=>rows.every(row=>Object.isFrozen(row)&&Object.isFrozen(row.properties)&&geometryReferenceFor(row.geometry));
  const equivalent=(before,after)=>before===after||before.length===after.length&&before.every((row,index)=>row===after[index])
    ||classifyTerritorialPropertyOnly(before,after)?.paintChangedIds.length===0;
  if(accepted&&styleReady()&&!error&&countryGeneration===generation&&!activeCountryTasks.size&&!countrySourceNeedsSwap
    &&accepted.generation===inputs.generation&&accepted.source===inputs.source&&accepted.stroke===inputs.stroke
    &&accepted.presentation===inputs.presentation&&accepted.visibility===inputs.visibility&&accepted.visible===inputs.visible
    &&immutable(accepted.entities)&&immutable(entities)&&immutable(accepted.features)&&immutable(features)
    &&equivalent(accepted.entities,entities)&&equivalent(accepted.features,features)){
   territories=features;acceptedCountryInputs=inputs;return Promise.resolve(true);
  }
  if(activeCountryTasks.size){countrySourceNeedsSwap=true;countryTail=Promise.resolve();}
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
     acceptedCountryInputs={...inputs,source:map.getSource(countrySourceId)};
    return applied;
   }
   finally{activeCountryTasks.delete(sequence);}
  }).catch(cause=>{if(disposed||sequence!==countrySequence||requestedGeneration!==generation)return false;throw cause;});
  countryTail=task.catch(()=>{});return task;
 }
 function replaceObsoleteCountrySource(){
  if(!countrySourceNeedsSwap)return;
  const oldId=countrySourceId,newId='territories-generation-'+(++countrySourceSerial),layers=map.getStyle().layers;
  const affected=layers.map((layer,index)=>({layer,index})).filter(({layer})=>layer.source===oldId);
  const mandatory=new Set(SOURCE_LAYERS.territories.map(id=>sourceLayer(id,oldId)));
  map.addSource(newId,countryTileSource());
  for(const {layer}of affected)map.removeLayer(layer.id);
  for(const {layer,index}of affected.reverse()){
   if(!mandatory.has(layer.id))continue;
   const before=layers.slice(index+1).find(candidate=>map.getLayer(candidate.id));
   const base=layer.id.split('--',1)[0];
   map.addLayer({...layer,id:map.getLayer(base)?base+'--'+newId:base,source:newId},before?.id);
  }
  if(map.getSource(oldId))map.removeSource(oldId);
  retainedSources.delete(oldId);countryFillGroups.delete(oldId);
  countrySourceId=newId;countryRows=new Map();countryTileRows=new Map();countryKey='';countrySourceNeedsSwap=false;dirty();
 }
 async function applyTerritorialFeatures(features,sequence,requestedGeneration,entityRepository,signal){
  if(basemapRecovery)await basemapRecovery;
  await initialize();
  if(!styleReady())await new Promise(resolve=>map.once('style.load',resolve));
  if(disposed)return false;
  if(requestedGeneration!==generation||sequence!==countrySequence)return false;
  const resolvedStyle=currentMapStyle();
  const resolve=createTerritorialFillResolver({state,entityRepository,resolveStoredColors:true});
  const nextBatches=[];
  const ordered=features.filter(feature=>state.layerVisibility.objects!==false&&deps.layerPresentation.isLayerItemVisible('objects',String(feature.id))).map(feature=>({feature,fill:resolve(feature),ref:normalizeObjectRef({domain:'territorial',type:'entity',id:String(feature.id)})}));
  ordered.sort((a,b)=>a.fill.depth-b.fill.depth||layerObjectRank(state.layerPresentation,a.ref.key)-layerObjectRank(state.layerPresentation,b.ref.key)||a.ref.key.localeCompare(b.ref.key));
  const presented=ordered.map(({feature,fill,ref},paintOrder)=>{

   const border=resolvedStyle.countryStroke,style=layerStyle(state.layerPresentation,'objects',ref.key);
   // Object color and opacity belong to territorial presentation, not the base.
   const effectiveAlpha=fill.fillAlpha;
   const blendMode=effectiveAlpha>0?fill.blendMode:'normal';
   let batch=nextBatches.at(-1);
   if(!batch||batch.blendMode!==blendMode){batch={index:nextBatches.length,blendMode,ids:[]};nextBatches.push(batch);}
   batch.ids.push(ref.key);
   return {type:'Feature',geometry:feature.geometry,id:ref.key,properties:{objectKey:ref.key,displayRole:'country-fill',color:fill.color||null,displayAlpha:fill.fillAlpha,alpha:blendMode==='multiply'?0:fill.fillAlpha,blendMode,paintOrder,paintBatch:batch.index,borderColor:border.color,borderAlpha:style.boundaryVisible?resolvedStyle.borderAlpha:0,borderWidth:border.width||0.6}};
  });
  const key=presented.map(feature=>[feature.id,geometryKey(feature.geometry),JSON.stringify(feature.properties)].join(':')).join('|');
  const cached=reuseSource('territories',key);
  const current=()=>!disposed&&requestedGeneration===generation&&sequence===countrySequence;
  const publish=(id,record)=>{
   activateSource('territories',id);
   countryRows=record.rows;countryTileRows=record.tiles;countryKey=key;countryBoundaryGeometry=record.borders;
   syncCountryPaint(id,record.rows);orderSceneLayers();
  };
  const active=retainedSources.get(countrySourceId);
  // A paint-only transition shares the already tiled source. Keep the actual
  // tile rows for the next native diff and update its paint through feature state.
  const paintOnly=!cached&&!countrySourceNeedsSwap&&active?.source===map.getSource(countrySourceId)
   &&active.rows?.size===presented.length&&presented.every(({id,geometry,properties})=>{
    const old=active.rows.get(id);
    return old&&geometryKey(old.geometry)===geometryKey(geometry)
     &&Object.entries(properties).every(([name,value])=>name==='color'||old.properties[name]===value);
   });
  if(paintOnly){
   const record={...active,key,rows:new Map(presented.map(row=>[row.id,row]))};
   retainedSources.set(countrySourceId,record);publish(countrySourceId,record);dirty();
  }else if(cached){
   if(cached[0]!==countrySourceId)stats.retainedSourceHits++;
   countrySourceNeedsSwap=false;
   publish(...cached);
  }else{
   const preserve=presentation.temporalPending()&&retainedSources.get(countrySourceId)?.key!=null;
   if(!preserve)replaceObsoleteCountrySource();
   else countrySourceNeedsSwap=false;
   const requestedSource=preserve?reserveSource('territories'):countrySourceId;
   const source=map.getSource(requestedSource);
   const previousTileRows=retainedSources.get(requestedSource)?.tiles
    ??(requestedSource===countrySourceId?countryTileRows:new Map());
   const borders=await prepareCountryBorders(presented,requestedGeneration,signal);
   const ownsSource=()=>current()&&map.getSource(requestedSource)===source;
   if(!ownsSource())return false;
   const tileFeatures=[...presented,...borders.map(row=>row.feature).filter(feature=>feature.geometry.coordinates.length)];
   const next=new Map(tileFeatures.map(feature=>[feature.id,feature]));
   const remove=[...previousTileRows.keys()].filter(id=>!next.has(id)),add=[],update=[];
   for(const [id,feature]of next){const previous=previousTileRows.get(id);if(!previous){add.push(feature);continue;}
    const geometryChanged=previous.geometry!==feature.geometry&&geometryKey(previous.geometry)!==geometryKey(feature.geometry);
    const properties=Object.entries(feature.properties).filter(([name,value])=>previous.properties[name]!==value).map(([key,value])=>({key,value}));
    if(geometryChanged||properties.length)update.push({id,...(geometryChanged?{newGeometry:feature.geometry}:{}),...(properties.length?{addOrUpdateProperties:properties}:{})});
   }
   const dirtyEntry={kind:'territories',source};retainedSources.set(requestedSource,dirtyEntry);
   try{
    let applied=true;
    if(!previousTileRows.size)applied=await setData(requestedSource,collection(tileFeatures),ownsSource);
    else if(remove.length||add.length||update.length)applied=await sourceUpdate(source=>source.updateData({remove,add,update}),requestedSource,ownsSource);
    if(!applied)return false;
   }catch(cause){if(current()){countryRows=new Map();countryTileRows=new Map();countryKey='';}throw cause;}
   if(!ownsSource())return false;
   syncTerritorialFills(requestedSource,nextBatches);
   const record={kind:'territories',source,key,rows:new Map(presented.map(feature=>[feature.id,feature])),
    tiles:next,borders:new Map(borders.map(row=>[row.key,row]))};
   retainedSources.set(requestedSource,record);
   publish(requestedSource,record);
  }
  if(sequence!==countrySequence||requestedGeneration!==generation)return false;
  if(requestedGeneration===generation&&sequence===countrySequence){countryGeneration=generation;countryContentKey=features.map(feature=>String(feature.id)+':'+geometryKey(feature.geometry)).join('|');}
  map.triggerRepaint();
  return true;
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
  if(map.getSource(physicalLandSourceId)&&(physicalLandKey!==context.revision||physicalLandSource!==map.getSource(physicalLandSourceId)))
   preparePhysicalSource('physical-land',context.revision,collection([{type:'Feature',properties:{},geometry:context.geometry}]));
  // The physical owner resolves the drawn water and its identities together.
  // Admission into the searchable hydro catalog can complete independently.
  const waterFeatures=context.waterFeatures??(context.water?[{type:'Feature',properties:{},geometry:context.water}]:[]);
  const waterKey=context.waterRevision||JSON.stringify(waterFeatures.map(feature=>geometryKey(feature.geometry)));
  if(waterKey!==physicalWaterKey||physicalWaterSource!==map.getSource(physicalWaterSourceId))
   preparePhysicalSource('physical-water',waterKey,collection(waterFeatures));
  return true;
 }
 const hydroDetailEnabled=()=>!disposed&&deps.physicalResources.hydroDetailEnabled();
 function cancelHydroStartup(){
  hydroStartupAbort?.abort();hydroStartupAbort=null;hydroStartup=null;
 }
 function refreshHydroDetail(){
  if(!hydroPresentation)return;
  if(hydroDetailEnabled())hydroPresentation.refresh();
  else{hydroPresentation.suspend();cancelHydroStartup();}
 }
 async function waitForHydro(isCurrent,ready){
  const deadline=performance.now()+15000;
  while(isCurrent()&&!ready()){
   if(performance.now()>=deadline)throw new Error('Hydro style or tiles did not become ready');
   await new Promise(resolve=>setTimeout(resolve,32));
  }
  return isCurrent();
 }
 async function setHydroManifest(manifest,url){
  if(!hydroDetailEnabled())return false;
  if(hydroManifest===manifest&&hydroPresentation){await hydroPresentation.refresh();return hydroDetailEnabled();}
  const stages=mapLibreHydroStages(manifest.stages);
  hydroPresentation?.dispose();hydroPresentation=null;hydroLoader?.dispose();hydroLoader=null;cancelHydroStartup();
  hydroManifest=manifest;hydroAppliedSource=null;
  await initialize();
  if(hydroManifest!==manifest||!hydroDetailEnabled())return false;
  const minZoomByStage=new Map(stages.map(stage=>[stage.id,stage.minZoom]));
  const displayFeatures=features=>features.flatMap(feature=>{
   const {stage,category}=feature.properties;
   const viewerMinZoom=minZoomByStage.get(stage);
   if(viewerMinZoom===undefined)throw new RangeError('Unknown hydro stage '+stage);
   const geometry=category==='river'?clipMercatorLines(feature.geometry):feature.geometry;
   if(!geometry.coordinates.length)return [];
   return [{...feature,geometry,properties:{...feature.properties,viewerMinZoom}}];
  });
  const createLoader=signal=>createHydroBrowserLoader({manifest,baseUrl:new URL('.',url).href,dataRevision:deps.physicalConfig.DATA_REVISION,signal,
   createWorker:()=>new Worker(deps.platform.runtimeAssetUrl('workers/hydro-tile-worker.js')),
   tilesForView:({zoom,width,height})=>{
    const bounds=projection.geographicBounds();
    return bounds?hydroTileSpecsForWindow(createHydroTileWindow({manifest:{stages},threshold:zoom,width,height,bounds})):[];
   }});
  const load=async (view,isCurrent)=>{
   if(!hydroLoader||hydroLoader.disposed){
    if(!hydroStartup){
     const controller=new AbortController();
     hydroStartupAbort=controller;
     const task=createLoader(controller.signal).then(loader=>{
      if(controller.signal.aborted||hydroManifest!==manifest||!hydroDetailEnabled()){
       loader.dispose();throw new DOMException('Hydro startup superseded','AbortError');
      }
      hydroLoader=loader;
      return loader;
     }).finally(()=>{if(hydroStartup===task){hydroStartup=null;hydroStartupAbort=null;}});
     hydroStartup=task;
    }
    await hydroStartup;
   }
   if(!isCurrent())throw new DOMException('Hydro view superseded','AbortError');
   return hydroLoader.view(view);
  };
  hydroPresentation=createMapLibreHydroPresentation({map,isEnabled:hydroDetailEnabled,
   needsSourceRestore:()=>!hydroAppliedSource||hydroAppliedSource!==map.getSource('hydro'),
   waitForSource:isCurrent=>waitForHydro(isCurrent,()=>styleReady()&&hydroAppliedSource===map.getSource('hydro')&&map.isSourceLoaded('hydro')),
   beforePublish:async isCurrent=>{
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
  },updateSource:async(diff,allFeatures,isCurrent)=>{
   const add=displayFeatures(diff.add);
   while(!disposed&&isCurrent()){
    if(!await waitForHydro(isCurrent,()=>!basemapRecovery&&styleReady()))return false;
    const source=map.getSource('hydro');if(!source)throw new Error('Hydro source missing from current style');
    const full=source!==hydroAppliedSource;
    try{
     const applied=await sourceUpdate(s=>full?s.setData(collection(displayFeatures(allFeatures()))):
      s.updateData({...diff,add}),'hydro',isCurrent,{shareAcrossGenerations:true});
     if(applied&&source===map.getSource('hydro')){
      hydroAppliedSource=source;return true;
     }
    }catch(cause){
     if(source===map.getSource('hydro')){
      hydroAppliedSource=null;
      if(isCurrent())throw cause;
     }
    }
   }
   return false;
  },admitFeatures:async (features,isCurrent)=>{
   const prepared=prepareMapLibreHydroFeatures(features,deps.physicalResources.prepareHydroFeature);
   return metrics.track('hydro.core-admission',()=>deps.physicalResources.admitHydroFeatures(prepared,{isCurrent}));
  },onFeatures:features=>{
   hydroFeatures=features;if(selectionSnapshot?.selection.items.some(ref=>ref.domain==='hydro'))setSelection(selectionSnapshot);invalidate('hydro-ready');
  },load,cancel:()=>hydroLoader?.cancel(),onError:cause=>{if(cause?.name==='AbortError'||cause?.cancelled)return;deps.feedback.reportOperationError(cause,'강·호수 상세 자료 일부를 불러오지 못했습니다. 지도를 이동하면 다시 시도합니다.','PL-HYDRO-DETAIL-001',4200);}});
  await hydroPresentation.refresh();return hydroDetailEnabled()&&hydroManifest===manifest;
 }
 const emptyHydroEdits=[];
 let hydroInputs=null;
 function syncHydroState(){
  if(!styleReady())return;
  const {rivers,lakes}=state.layerVisibility;
  const ocean=deps.preferences.mapPalette().ocean||'#ffffff';
  const hydroEdits=state.hydroEdits||emptyHydroEdits;
  const inputs=[map.style,hydroFeatures,hydroEdits,state.timelineCursor,state.hydroFeatureCatalogRevision,
   JSON.stringify(state.itemVisibility?.hydro??{}),state.physicalSettings?.hydroLayers,rivers,lakes,ocean];
  if(hydroInputs?.every((value,index)=>value===inputs[index]))return;
  hydroInputs=inputs;stats.hydroVisibilityScans++;
  const ids=hiddenMapLibreHydroIds(hydroFeatures,deps.physicalServices.isHydroFeatureVisible);
  const key=ids.join('|')+'|'+state.layerVisibility.rivers+'|'+state.layerVisibility.lakes;
  if(key!==hydroStateKey){hydroStateKey=key;
   syncMapLibreHydroVisibility(map,ids,state.layerVisibility);
  }
  const edits=hydroEdits.filter(deps.physicalServices.isHydroFeatureVisible);
  const editsKey=edits.map(feature=>String(feature.id)+':'+geometryKey(feature.geometry)).join('|')+'|'+ocean;
  if(editsKey!==hydroEditsKey){hydroEditsKey=editsKey;
   if(!map.getSource('hydro-edits')){
    map.addSource('hydro-edits',{type:'geojson',data:empty()});
    map.addLayer({id:'hydro-edits-fill',type:'fill',source:'hydro-edits',filter:['==',['geometry-type'],'Polygon'],paint:{'fill-color':['get','color']}});
    map.addLayer({id:'hydro-edits-line',type:'line',source:'hydro-edits',paint:{'line-color':['get','color'],'line-width':1,'line-opacity':0}});
   }
   strokeDomain('edited-water-strokes',edits,()=>({color:ocean,width:1,alpha:1,cap:'round'}),210);
   setData('hydro-edits',collection(edits.map(feature=>({type:'Feature',id:String(feature.id),geometry:feature.geometry,properties:{objectKey:normalizeObjectRef({domain:'hydro',type:feature.properties.category||'river',id:String(feature.id)}).key,color:ocean}}))));
  }
 }
 function setSceneDomains(domains){
  if(!loaded)return;
  if(!styleReady()){pendingSceneDomains=domains;return;}
  const rows=[...domains].flatMap(([domain,value])=>domain==='physical-land'||domain==='physical-water'?[]:[...value.polygons.map(item=>({...item,kind:'fill'})),...value.strokes.map(item=>({...item,kind:'line'}))]);
  const native=row=>row.kind==='line'||row.blendMode==='multiply'||row.style?.blendMode==='multiply';
  sceneVectors=rows.filter(native).filter(row=>row.kind==='fill'?(row.style?.fillAlpha??1)>0:(row.style?.alpha??1)>0).map(row=>['Point','MultiPoint'].includes(row.geometry?.type)?{...row,kind:'point'}:row);
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
  syncVectorGroups();
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
  setData('interaction',collection(features),()=>interactionPending===request).then(applied=>{
   if(applied&&map.getSource('interaction')===source)interactionApplied=request;
   if(interactionPending===request)interactionPending=null;
  },()=>{
   if(map.getSource('interaction')===source)interactionApplied=null;
   if(interactionPending===request)interactionPending=null;
  });
  strokeDomain('interaction-strokes',features,f=>({color:f.properties.color,width:f.properties.width,alpha:f.properties.strokeAlpha,cap:'round'}),10000);
 }
 const polarPicking=createMapObjectSpatialIndex(),polarFeatureBounds=new WeakMap();
 let indexedTerritories=null;
 const polarTerritories=new Map();
 function pickBounds(geometry){
  if(polarFeatureBounds.has(geometry))return polarFeatureBounds.get(geometry);
  const [west,south,east,north]=coordinateBounds(geometry.coordinates);
  const wide=east-west>=180||south<=-89.999||north>=89.999;
  const bounds=[west,south,east,north].every(Number.isFinite)?[
   wide?-180:Math.max(-180,west-1e-3),Math.max(-90,south-1e-3),
   wide?180:Math.min(180,east+1e-3),Math.min(90,north+1e-3),
  ]:[-180,-90,180,90];
  polarFeatureBounds.set(geometry,bounds);
  return bounds;
 }
 function territorialPolarCandidates(coordinate){
  if(indexedTerritories!==territories){
   indexedTerritories=territories;polarTerritories.clear();polarPicking.clearDomain('territorial');
   for(const feature of territories){
    if(!feature.geometry)continue;
    const bounds=pickBounds(feature.geometry);
    if(bounds[1]>-POLAR_LATITUDE&&bounds[3]<POLAR_LATITUDE)continue;
    const id=String(feature.id);polarTerritories.set(id,feature);
    polarPicking.upsert({key:id,id,domain:'territorial',bounds});
   }
  }
  const [lon,lat]=coordinate;
  return polarPicking.query([lon,lat,lon,lat]).map(record=>polarTerritories.get(record.id));
 }
 function queryObjectRefs(point,{includeHydro=true,includeLabels=true}={}){
  if(!loaded||temporalOverlay||initialZoomHidden)return [];
  const coordinate=projection.screenToGeo(point);
  if(!coordinate)return [];
  if(Math.abs(coordinate[1])>=POLAR_LATITUDE){
   const refs=[];
   for(const feature of territorialPolarCandidates(coordinate)){
    const ref=normalizeObjectRef({domain:'territorial',type:'entity',id:String(feature.id)});
    if(deps.objectRefVisible(ref)&&deps.containsGeometry(coordinate,feature.geometry))refs.push(ref);
   }
   if(includeHydro)for(const feature of state.hydroFeatureCache.values()){
    if(!feature.properties.physical_water||!feature.geometry||!deps.physicalServices.isHydroFeatureVisible(feature))continue;
    const [west,south,east,north]=pickBounds(feature.geometry),[lon,lat]=coordinate;
    if(lon>=west&&lon<=east&&lat>=south&&lat<=north&&deps.containsGeometry(coordinate,feature.geometry))
     refs.push(normalizeObjectRef({domain:'hydro',type:feature.properties.category,id:String(feature.id)}));
   }
   return refs;
  }
  const refs=new Map(),zoom=map.getZoom();
  const layers=mapSourceLayers().filter(layer=>{
   const {id,source}=layer;
   if(source==='viewer-labels')return includeLabels&&visibleSourceLayer(layer,zoom);
   if(['hydro','hydro-edits',physicalWaterSourceId].includes(source)||vectorLayers.get(source)?.role==='project-hydro')
    return includeHydro&&visibleSourceLayer(layer,zoom);
   return source!==physicalLandSourceId&&source!=='interaction'&&id!=='map-graticule'&&
    vectorLayers.get(source)?.role!=='interaction-stroke'&&id!==sourceLayer('borders',countrySourceId)&&requiredSource(source)&&visibleSourceLayer(layer,zoom);
  }).map(layer=>layer.id);
  if(!layers.length)return [];
  for(const feature of map.queryRenderedFeatures(point,{layers})){
   const p=feature.properties||{};if(p.displayRole==='country-border')continue;
   if(feature.source==='hydro'&&(!(zoom>=p.viewerMinZoom)||!hydroPresentation?.canPick(p.featureId,p.logicalId)))continue;
   let ref;
   if(p.objectKey){const [domain,type,...id]=p.objectKey.split(':');ref=normalizeObjectRef({domain,type,id:decodeURIComponent(id.join(':'))});}
   else if(p.logicalId&&p.category)ref=normalizeObjectRef({domain:'hydro',type:p.category,id:String(p.logicalId)});
   if(ref&&(includeHydro||ref.domain!=='hydro')&&(includeLabels||ref.domain!=='label'))refs.set(ref.key,ref);
  }
  return [...refs.values()];
 }
 function renderFrame(frame){
  stats.approvalAttempts++;
  if(error){pendingFrame=null;return {succeeded:false,presentationReady:false,error};}
  if(!styleReady()){pendingFrame=frame;return {succeeded:false,deferred:true,presentationReady:false};}
  pendingFrame=frame;metrics.run('physical.sync',syncPhysicalContext);metrics.run('polar.sync',syncPolar);if(initialMapLoading)syncInitialMapSkeleton();else syncLabelVisibility();
  const pending=!!polarLayer?.pending||!!error||!loaded||contextLost||pendingSources()||
   [...vectorLayers.values()].some(entry=>entry.role!=='hydro-detail'&&entry.layer.pending)||
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
 function retryMapPreparation(){error=null;polarInputs=[];interactionApplied=null;polarLayer?.retry();invalidate('map-retry');}
 function invalidateCountryColors(){
  if(!styleReady()){pendingCountryPaint=true;return;}
  syncCountryPaint(countrySourceId,countryRows);
  dirty();invalidate('country-paint');
 }
 function invalidateStyle(){if(loaded&&!styleReady()){pendingStyleRefresh=true;return;}if(loaded){
  setTerritorialFeatures(territories).catch(failMapPreparation);
  hydroStateKey='';syncHydroState();syncBaseLayer();
  if(initialMapLoading)syncInitialMapSkeleton();
  dirty();
 }invalidate('map-paint');}
 function setInteractionStyle(value){if(loaded&&!styleReady()){pendingInteractionStyle=value;return;}const changed=interactionStyle?.antiAlias!==value.antiAlias;interactionStyle=value;
  if(changed&&loaded){styleController?.apply(currentMapStyle(),{updateVisibility:!temporalOverlay});if(map.getLayer('hydro-edits-fill')?.type==='fill')map.setPaintProperty('hydro-edits-fill','fill-antialias',value.antiAlias!==false);}
  syncVectorGroups();if(selectionSnapshot)setSelection(selectionSnapshot);invalidate('interaction-style');
 }
 return Object.freeze({registerFeature,previewExternalBasemap,cameraSnapshot(){return map&&loaded?readMapLibreCamera(map):null;},setInitialMapLoading(value){initialMapLoading=value===true;syncInitialMapSkeleton();dirty();invalidate('initial-map-skeleton');},attach,initialize,setTerritorialFeatures,setSceneDomains,setSelection,queryObjectRefs,syncCameraFromState,syncPhysicalContext,syncHydroState,
  get map(){return map;},get projection(){return projection;},get loaded(){return loaded;},isStyleReady:styleReady,renderFrame,commitVisualFrame,measureWork:metrics.track,
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
  resetProjectRenderState(options){if(options.presentation!=='temporal'){zoomFramePending=false;lastPresentedZoom=null;releaseTemporalFrame();hydroPresentation?.suspend();cancelHydroStartup();}countryGeometryAbort?.abort();geometryAbort.abort();geometryAbort=new AbortController();polarInputs=[];generation=options.generation;pendingSceneDomains=null;pendingSourceOperations.clear();if(activeCountryTasks.size){countrySourceNeedsSwap=true;countryTail=Promise.resolve();}countrySequence++;countryGeneration=-1;error=null;ready=false;preparedReady=false;presentation.resetForProject(options);},
  labelZoomVisibility,
  getRuntimeState:()=>({...stats,projectRenderBlocked:!!error,mapReady:ready,webglContextLost:contextLost,temporalPresentationPending:presentation.temporalPending(),temporalViewPending:presentation.temporalPending()&&presentation.ticket?.kind==='view',physicalContextRevision:landRevision}),
  getStats:()=>({...stats,datedSources:{territories:countrySourceId,land:physicalLandSourceId,water:physicalWaterSourceId},performance:metrics.snapshot(),polar:polarLayer?.stats(),errorMessage:error?.message||null,generation,projectReplacing:!!state.projectReplacing,webglContextLost:contextLost,projectRenderBlocked:!!error,displayedRevision:ready?sourceRevision:0,mapReadiness:{mapReady:ready,status:error?'error':ready?'ready':'loading'},hydroFeatureCount:hydroFeatures.length,sourceRevision,certifiedRevision,labelLayout:deps.countryLabelModel.labelLayoutMetrics,mapMoving:state.mapMoving}),
  setHydroManifest,
  invalidateCountryColors,invalidateCountryPalette:invalidateStyle,invalidatePhysicalStyle:invalidateStyle,
  invalidateHydroVisibility(){refreshHydroDetail();if(loaded&&!styleReady()){pendingStyleRefresh=true;return;}if(loaded){syncHydroState();dirty();}invalidate('hydro-visibility');},
  setRenderQuality(value){quality=value;if(map&&value?.dprCap&&Math.abs(map.getPixelRatio()-value.dprCap)>1e-9)map.setPixelRatio(value.dprCap);},
  setInteractionStyle,
  getRenderPixelRatio:()=>quality?.dprCap||window.devicePixelRatio||1,
  verifyLayout(){if(map){map.resize();syncBaseLayer();applyCameraFit();}},failMapPreparation,retryMapPreparation,
  dispose(){disposed=true;countryGeometryAbort?.abort();geometryAbort.abort();polarLayer?.dispose();externalBasemap?.dispose();if(externalAttribution)map?.removeControl(externalAttribution);externalAttribution=null;for(const record of mapFeatures.values()){try{record.owner.dispose();}catch(cause){deps.feedback.reportOperationError(cause,'추가 지도 기능을 정리하지 못했습니다.','PL-MAPLIBRE-OPTIONAL-001');}}mapFeatures.clear();zoomFramePending=false;releaseTemporalFrame();presentation.dispose();hydroPresentation?.dispose();cancelHydroStartup();hydroLoader?.dispose();geometryRpc?.stop('maplibre-dispose');for(const entry of vectorLayers.values())entry.layer.dispose();vectorLayers.clear();map?.remove();if(window.__PANDOLAB_MAPLIBRE__===map)delete window.__PANDOLAB_MAPLIBRE__;stylesheet?.remove();container?.remove();},
 });
}
