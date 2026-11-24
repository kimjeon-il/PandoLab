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
import {createMapLibreHydroPresentation,hiddenMapLibreHydroIds,mapLibreHydroStyle,syncMapLibreHydroVisibility,prepareMapLibreHydroFeatures,joinHydroLineParts} from './maplibre-hydro-presentation.js';
import {HYDRO_DISPLAY_ZOOMS,hydroDisplayStages,isWithinDisplayZoom} from '../map/map-display-zoom.js';
import {createMapPresentationSession} from './map-presentation-session.js';
import {createTerritorialFillResolver} from './territorial-fill-style.js';
import {createHydroTileWindow,hydroTileSpecsForWindow} from '../data/hydro-tile-window.js';
import {normalizeObjectRef} from '../document/object-ref-identity.js';
import {admittedGeometryKey as geometryKey,geometryReferenceFor} from '../geometry/geometry-version-store.js';
import {countryDefaultColor} from '../ui/color-adapter.js';
import {distributionEntriesForLayer,DISTRIBUTION_MODES} from '../document/distribution-model.js';
import {createMapLibreVectorGroup} from './maplibre-vector-group.js';
import {createMapLibreHighlight,partitionHighlightLines} from './maplibre-highlight.js';
import {createMapLibreGeometryClient} from './maplibre-geometry-client.js';
import {createMapObjectSpatialIndex} from '../map/map-object-spatial-index.js';
import {coordinateBounds} from '../geometry/coordinate-bounds.js';
import {projectedLineDistance} from '../geometry/geometry-screen-hit.js';
import {layerObjectRank,layerStyle} from '../ui/layer-presentation.js';
import {createRenderingMetrics} from './rendering-metrics.js';
import {createMapLibreSourceWrites,createMapLibreDatedSources} from './maplibre-source-lifecycle.js';

const collection=features=>({type:'FeatureCollection',features});
const empty=()=>collection([]);
// Display-only simplification is performed by MapLibre per tile/zoom; canonical geometry stays intact.
const countryTileSource=()=>({type:'geojson',data:empty(),promoteId:'objectKey',tolerance:0.5});
const countryFillFilter=batch=>['all',['==',['get','displayRole'],'country-fill'],['==',['get','paintBatch'],batch],['==',['get','blendMode'],'normal']];
const SOURCE_LAYERS={'territories':['territories','borders'],'physical-land':['physical-land-fill'],'physical-water':['physical-water']};
import {createMapLibreCamera,ZOOM_EPSILON,WORLD_VIEW_BOUNDS} from './maplibre-camera-controller.js';

export {createMapGeometryRequester} from './maplibre-geometry-client.js';
const layerVisibleAtZoom=(layer,zoom)=>layer.visible&&isWithinDisplayZoom(zoom,layer.minzoom,layer.maxzoom);

/** MapLibre owns map pixels and picking. Core and the physical owner retain all data. */
export function createMapLibreViewerRenderer(deps,{presentMapPreparation,onMapPreparationStatus,initialCamera,readSafeInsets=()=>({}),onWorldFitChange}={}) {
 if(typeof deps.objectRefVisible!=='function')throw new TypeError('MapLibre requires the canonical object visibility query.');
 const state=deps.projectState.state;
 const metrics=createRenderingMetrics();
 const camera=createMapLibreCamera({getMap:()=>map,isLoaded:()=>loaded,getProjection:()=>projection,getView:()=>state.view,readSafeInsets,onWorldFitChange,
  onFarJump:()=>{if(lastPresentedZoom!==null&&!state.projectReplacing&&!contextLost){preserveDisplayedFrame();zoomFramePending=true;ready=false;preparedReady=false;}}});
 const {fitMapBounds,refreshWorldFit,applyCameraFit,isAtWorldView,labelZoomVisibility,jumpCamera,syncCameraFromState}=camera;
 let map,api,projection,container,stylesheet,initialization,loadedStyle=null,disposed=false,loaded=false,generation=0,contextRevision=0,contextLost=false;

 let sourceRevision=0,certifiedRevision=-1,certifiedGeneration=-1,certifiedContext=-1,certifiedCamera='',pendingFrame=null,ready=false,preparedReady=false,error=null,countryGeneration=-1,countryContentKey='';
 let requestedCertificate=null,previousActiveRender=null;
 let endSourceFrame=null;
 let territories=[],landRevision=null,hydroLoader,hydroPresentation,hydroFeatures=[],hydroManifest=null;
 let hydroStartup,hydroStartupAbort,hydroAppliedSource=null;
 let sceneKey='',countryKey='',quality=null,interactionStyle=null;
 let acceptedCountryInputs=null;
 const dynamicLayers=new Set(),dynamicSources=new Set(),sceneGroups=new Map();
 let countryRows=new Map(),hydroStateKey='',hydroEditsKey='',physicalLandKey='',physicalWaterKey='',physicalLandSource=null,physicalWaterSource=null,selectionSnapshot=null;
 let countryTileRows=new Map(),countryBoundaryGeometry=new Map();
 const physicalPending=new Map();
 let countrySequence=0,countryTail=Promise.resolve(),countrySourceSerial=0,countrySourceNeedsSwap=false;
 const activeCountryTasks=new Set();
 let sceneVectors=[];
 let acknowledgedBoundary=null,boundaryRequest=0,countryGeometryAbort=null;
 const geometryClient=createMapLibreGeometryClient({runtimeAssetUrl:path=>deps.platform.runtimeAssetUrl(path),isDisposed:()=>disposed,getGeneration:()=>generation,onRestart:()=>{acknowledgedBoundary=null;},getStats:()=>stats,metrics});
 const {preparePhysicalDisplay,prepareRenderGeometry}=geometryClient;

 const vectorLayers=new Map(),strokeDomains=new Map(),strokeSignatures=new Map();
 let sceneOrder=[],highlight=null;
 const highlightLines=new WeakMap();
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
  externalBasemap ||=createExternalBasemap(map,{getRevision:()=>JSON.stringify([generation,contextRevision,sourceRevision,presentation.temporalPending(),temporalFrameHeld]),onChange:()=>{syncVectorGroups();dirty();invalidate('external-basemap-change');},onRemoveStart:preserveTemporalFrame,onRemoveEnd:()=>{if(!presentation.temporalPending())releaseTemporalFrame();},onCancelled:()=>{if(externalAttribution){map.removeControl(externalAttribution);externalAttribution=null;}},onFailure:(cause,{removed})=>{
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
 let initialMapLoading=false,initialFrameStaging=null;
 let temporalOverlay=null,temporalInteractions=[],temporalOptionalLayers=[];
 let temporalFrameHeld=false,projectFrameHeld=false,zoomFramePending=false,initialZoomHidden=false,lastPresentedZoom=null,lastCameraZoom=null;
 function suspendOptionalLayers(){
  for(const layer of map.getStyle()?.layers||[]){
   if(!layer.source||requiredSource(layer.source)||highlight?.owns(layer.source)||datedSources.has(layer.source)||layer.source==='hydro'||layer.layout?.visibility==='none'||temporalOptionalLayers.some(item=>item.id===layer.id))continue;
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
  context.drawImage(source,0,0);stats.preservedFrameCopies++;overlay.append(snapshot);
  stage.append(overlay);temporalOverlay=overlay;
 }
 function discardUnusedPreservedFrame(){
  if(!disposed&&(temporalFrameHeld||projectFrameHeld||zoomFramePending||initialFrameStaging))return;
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
   order,role:name==='edited-water-strokes'?'project-hydro':undefined,
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
   id:'country-border:'+index,paint,key:JSON.stringify([paint,owners]),owners,
  }));
  const prepared=await prepareBoundaryGroups(countryFeatures,topologyKey,rows,revision,signal);
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
  const items=groups.map(row=>({kind:'stroke',cacheKey:row.key,countryVisibleIds:row.owners,
    knownGeometry:countryBoundaryGeometry.has(row.key)}));
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
 let polarLayer=null,polarInputs=[],polarLineInputs=[],polarVisibleLines=[],hydroMinZoomByStage=new Map();
 const polarGrid=polarGridPacket();
 const overlayLinePackets=new WeakMap();
 const rgba=(color,alpha=1)=>{const rgb=deps.platform.d3.rgb(color);return [rgb.r/255,rgb.g/255,rgb.b/255,alpha];};
 function positionPolarLayer(){
  if(!polarLayer||!map.getLayer(polarLayer.id))return;
  const before=!initialMapLoading&&map.getLayer('viewer-label-dot')?'viewer-label-dot':undefined;
  const layers=map.getLayersOrder(),index=layers.indexOf(polarLayer.id);
  if(before?layers[index+1]!==before:index!==layers.length-1)map.moveLayer(polarLayer.id,before);
 }
 function ensurePolar(){
  polarLayer ||=createPolarLayer({map,prepare:async geometry=>(await prepareRenderGeometry([
   {kind:'fill',cacheKey:'polar:'+geometryKey(geometry),geometry,polarCapOnly:true},
  ],generation)).packets[0].packet,onChange:()=>{dirty();invalidate('polar-ready');},onError:cause=>{if(cause.name==='AbortError'){polarInputs=[];invalidate('polar-cancelled');}else failMapPreparation(cause);}});
  polarLayer.ensure();
  return polarLayer;
 }
 function syncPolar(){
  if(!styleReady())return;
  ensurePolar();
  const style=currentMapStyle(),items=[],keys=[];
  const add=(geometry,color,alpha=1,multiply=false,loadingRole)=>{
   if(!color||!(alpha>0))return;
   const shape=polarGeometry(geometry);
   if(!shape)return;
   items.push({geometry:shape,color:rgba(color,alpha),multiply,loadingRole});
   keys.push([geometryKey(geometry),color,alpha,multiply,loadingRole]);
  };
  const context=deps.physicalResources.physicalLand;
  if(!context||!deps.physicalResources.physicalContextState.ready)return;
  const colored=colorsEnabled(),land=style.paint['physical-land-fill']['fill-color'];
  const inputs=[generation,countryKey,colored,context.geometry,context.water,context.revision,
   land,style.paint.ocean['background-color'],state.backgroundSettings?.graticule,state.resourceCapabilities?.graticule];
  if(inputs.length===polarInputs.length&&inputs.every((value,index)=>value===polarInputs[index]))return;
  polarInputs=inputs;
  add(context.geometry,style.paint['physical-land-fill']['fill-color'],1,false,'land');
  for(const f of countryRows.values())add(f.geometry,colored?f.properties.color:land,colored?f.properties.displayAlpha:1,colored&&f.properties.blendMode==='multiply');
  if(context.water)add(context.water,style.paint.ocean['background-color']);
  if(countryKey)for(const {key,paths,feature:{properties}} of countryBoundaryGeometry.values()){
   if(!paths.polar.indices.length)continue;
   const {borderColor,borderAlpha,borderWidth}=properties;
   items.push({packet:paths.polar,color:rgba(borderColor,borderAlpha),width:borderWidth});
   keys.push([key,borderColor,borderAlpha,borderWidth]);
  }
  if(state.backgroundSettings?.graticule!==false&&state.resourceCapabilities?.graticule!==false){
   items.push({packet:polarGrid,color:rgba('#777777',.15),width:.5,loadingRole:'grid'});
   keys.push('grid');
  }
  polarLayer.update(JSON.stringify([generation,keys,style.paint.ocean]),items,rgba(style.paint.ocean['background-color']));
  positionPolarLayer();
 }
 function objectKeyRef(objectKey){
  if(!objectKey)return null;
  const [domain,type,...id]=objectKey.split(':');
  return normalizeObjectRef({domain,type,id:decodeURIComponent(id.join(':'))});
 }
 function syncPolarLines(){
  if(!polarLayer)return;
  const palette=deps.preferences.mapPalette();
  const zoom=map.getZoom(),ocean=palette.ocean||'#ffffff',riverWidth=palette.strokes?.river?.width??1;
  const visibleStages=[...hydroMinZoomByStage].filter(([,minZoom])=>isWithinDisplayZoom(zoom,minZoom));
  const inputs=[sceneKey,hydroFeatures,hydroStateKey,hydroEditsKey,hydroMinZoomByStage,visibleStages.length,ocean,riverWidth];
  if(inputs.every((value,index)=>value===polarLineInputs[index]))return;
  polarLineInputs=inputs;
  const rows=[];
  const add=(geometry,style,ref,packFeatureId=null,displayMinZoom=-Infinity)=>{
   if(!['LineString','MultiLineString'].includes(geometry?.type)||!style.color||!(style.alpha>0)||!(style.width>0))return;
   if(!overlayLinePackets.has(geometry)){
    const bounds=pickBounds(geometry);
    const lines=geometry.type==='LineString'?[geometry.coordinates]:geometry.coordinates;
    overlayLinePackets.set(geometry,bounds[1]<=-POLAR_LATITUDE||bounds[3]>=POLAR_LATITUDE?polarLinePacket(lines):null);
   }
   const packet=overlayLinePackets.get(geometry);
   if(packet?.indices.length)rows.push({packet,geometry,ref,packFeatureId,displayMinZoom,color:rgba(style.color,style.alpha),width:style.width});
  };
  for(const row of sceneVectors){
   if(row.role==='graticule')continue;
   const style=row.style||{};
   add(row.geometry,{color:style.color,width:style.width??1,alpha:style.alpha??1},objectKeyRef(row.objectKey));
  }
  if(state.layerVisibility.rivers!==false){
   const paint={color:ocean,alpha:1,width:riverWidth};
   const visibleStageZooms=new Map(visibleStages);
   for(const feature of hydroFeatures){
    const {category,stage,logicalId,featureId,layerId}=feature.properties;
    if(category!=='river'||!visibleStageZooms.has(stage))continue;
    if(!deps.physicalServices.isHydroFeatureVisible({...feature,id:logicalId,properties:{...feature.properties,pandolab_id:logicalId,layer_id:layerId}}))continue;
    add(feature.geometry,paint,normalizeObjectRef({domain:'hydro',type:'river',id:String(logicalId)}),featureId??feature.id,visibleStageZooms.get(stage));
   }
   for(const feature of state.hydroEdits||emptyHydroEdits){
    if(feature.properties.category!=='river'||!deps.physicalServices.isHydroFeatureVisible(feature))continue;
    add(feature.geometry,{...paint,width:1},normalizeObjectRef({domain:'hydro',type:'river',id:String(feature.id)}));
   }
  }
  polarVisibleLines=rows;
  polarLayer.setOverlayLines(rows);
 }
 const stats={renderedFrames:0,preservedFrameCopies:0,sourceUpdates:0,sourceWrites:0,hydroVisibilityScans:0,geometryWorkerRequests:0,geometryWorkerTransferBytes:0,retainedSourceHits:0,boundaryRequests:0,boundaryGeometryRows:0,boundaryCacheMisses:0,approvalAttempts:0,renderer:'maplibre',firstCanonicalFrameMs:null,physicalLandPreparations:0,physicalLandPreparationMs:0,physicalLandAssetHits:0,strokePreparedPackets:0};
 const invalidate=reason=>deps.domains.renderingDomain?.invalidateView(reason);
 const cameraKey=()=>map?JSON.stringify([map.getCenter().lng,map.getCenter().lat,map.getZoom(),map.getBearing(),map.getPitch(),map.getRoll(),map.getCanvas().width,map.getCanvas().height]):'';
 const datedSources=createMapLibreDatedSources({getMap:()=>map,sourceLayers:SOURCE_LAYERS,sourceLayer,mapSourceLayers,
  createCountrySource:countryTileSource,createEmptySource:()=>({type:'geojson',data:empty()}),
  invalidateLayerIndex:()=>{indexedStyle=null;},dirty,
  canRetire:()=>styleReady()&&!presentation.temporalPending()&&!zoomFramePending&&!map.isMoving(),
  temporalPending:()=>presentation.temporalPending()});
 const sourceWrites=createMapLibreSourceWrites({getMap:()=>map,getGeneration:()=>generation,getContextRevision:()=>contextRevision,
  isDisposed:()=>disposed,requiredSource:id=>requiredSource(id),dirty,onError:failMapPreparation,
  track:(name,submit)=>metrics.track(name,()=>{stats.sourceWrites++;return submit();})});
 const requiredSource=id=>[datedSources.active('territories'),datedSources.active('physical-land'),datedSources.active('physical-water'),'hydro-edits','viewer-labels'].includes(id)
  ||dynamicSources.has(id)||(vectorLayers.has(id)&&vectorLayers.get(id).role!=='hydro-detail');
 let sourceLayers=[],indexedStyle=null,requiredLayerCache=null,pickLayerCache=null;
 function mapSourceLayers(){
  if(indexedStyle!==map.style){
   indexedStyle=map.style;
   sourceLayers=map.getLayersOrder().flatMap(id=>{
    const layer=map.getLayer(id);
    return layer?.source?[{id,source:layer.source,visible:map.getLayoutProperty(id,'visibility')!=='none',
     minzoom:layer.minzoom??-Infinity,maxzoom:layer.maxzoom??Infinity}]:[];
   });
   requiredLayerCache=pickLayerCache=null;
  }
  return sourceLayers;
 }
 function requiredSourcesReady(){
  if(!map?.style)return false;
  if(physicalPending.has('physical-land')||physicalPending.has('physical-water'))return false;
  for(const [kind,ids] of Object.entries(SOURCE_LAYERS)){
   const source=datedSources.active(kind);
   if(!map.getSource(source)||ids.some(id=>!map.getLayer(sourceLayer(id,source))))return false;
  }
  const zoom=map.getZoom(),layers=mapSourceLayers();
  if(!requiredLayerCache||zoom<requiredLayerCache.min||zoom>=requiredLayerCache.max){
   let min=-Infinity,max=Infinity;
   const sources=new Set();
   for(const layer of layers){
    if(!layer.visible||!requiredSource(layer.source))continue;
    for(const cutoff of [layer.minzoom,layer.maxzoom]){
     if(cutoff<=zoom)min=Math.max(min,cutoff);else max=Math.min(max,cutoff);
    }
    if(layerVisibleAtZoom(layer,zoom))sources.add(layer.source);
   }
   requiredLayerCache={min,max,sources};
  }
  for(const source of requiredLayerCache.sources){
   if(!map.getSource(source)){indexedStyle=null;return false;}
   if(!map.isSourceLoaded(source))return false;
  }
  return true;
 }
 function sourceLayer(id,source){
  return map.getLayer(id)?.source===source?id:id+'--'+source;
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
 function setData(id,data,isCurrent,options){return sourceWrites.update(source=>source.setData(data),id,isCurrent,options);}
 function preparePhysicalSource(kind,key,data,displayPrepared=false){
  const previous=physicalPending.get(kind);
  if(previous?.key===key&&previous.source===map.getSource(previous.id))return;
  const publish=(id,source)=>{
   datedSources.activate(kind,id);
   if(kind==='physical-land'){physicalLandKey=key;physicalLandSource=source;}
   else{physicalWaterKey=key;physicalWaterSource=source;}
   orderSceneLayers();
  };
  const cached=datedSources.reuse(kind,key);
  if(cached){
   physicalPending.delete(kind);
   publish(cached[0],cached[1].source);
   stats.retainedSourceHits++;
   return;
  }
  const active=datedSources.active(kind);
  const activeReady=datedSources.get(active)?.key;
  const id=(presentation.temporalPending()&&activeReady)||previous?.id===active?datedSources.reserve(kind):active;
  const source=map.getSource(id),entry={key,source,id,generation};
  physicalPending.set(kind,entry);
  datedSources.set(id,{kind,source});
  const current=()=>!disposed&&physicalPending.get(kind)===entry&&map.getSource(id)===source;
  if(kind==='physical-land'&&displayPrepared)stats.physicalLandAssetHits++;
  const prepared=kind==='physical-land'&&!displayPrepared?preparePhysicalDisplay(key,data.features[0].geometry).then(geometry=>collection([{...data.features[0],geometry}])):Promise.resolve(data);
  prepared.then(value=>current()?setData(id,value,current,{shareAcrossGenerations:true}):false,cause=>{if(current()){physicalPending.delete(kind);failMapPreparation(cause);}return false;})
   .then(applied=>{if(!current())return;physicalPending.delete(kind);if(applied){datedSources.set(id,{kind,source,key});publish(id,source);invalidate('physical-source-ready');}},cause=>{if(!current())return;physicalPending.delete(kind);if(entry.generation===generation)failMapPreparation(cause);else invalidate('physical-source-retry');});
 }
 function syncVectorGroups(){
  if(!loaded)return;
  const groups=new Map();
  for(const row of [...sceneVectors,...[...strokeDomains.values()].flat()].sort((a,b)=>a.order-b.order)){
   const kind=row.kind||'fill',id=row.role==='graticule'?'map-graticule':'vector-'+kind+'-'+row.order+'-'+(row.role==='territorial-fill'?'territorial':row.role==='hydro-detail'?'hydro-detail':'independent');
   if(!groups.has(id))groups.set(id,[]);groups.get(id).push({...row,style:kind==='line'?{...row.style,antiAlias:interactionStyle?.antiAlias??row.style?.antiAlias??true}:row.style,geometryRevision:kind+':'+row.geometryRevision});
  }
  for(const [id,entry]of vectorLayers)if(!groups.has(id)){entry.layer.dispose();vectorLayers.delete(id);indexedStyle=null;}
  for(const [id,originalItems]of groups){
   let items=originalItems;
   if(items[0]?.kind==='line'&&items.length>1){const batches=new Map();for(const row of items){const merge=!row.objectKey&&(row.style?.alpha??1)===1&&(!row.style?.casing||(row.style.casing.alpha??1)===1);const key=JSON.stringify([row.blendMode,row.style,merge?'':row.key]);if(!batches.has(key))batches.set(key,[]);batches.get(key).push(row);}items=[...batches.values()].map(rows=>rows.length===1?rows[0]:({...rows[0],key:rows.map(r=>r.key).join('|'),geometryRevision:rows.map(r=>r.geometryRevision).join('|'),geometry:{type:'MultiLineString',coordinates:rows.flatMap(r=>r.geometry.type==='MultiLineString'?r.geometry.coordinates:[r.geometry.coordinates])}}));}

   const signature=items.map(item=>[item.key,item.geometryRevision,item.blendMode,JSON.stringify(item.style)].join(':')).join('|');
   let entry=vectorLayers.get(id);
   if(!entry){
    const layer=createMapLibreVectorGroup(map,{id,sharedSource:items[0].role==='territorial-fill'?()=>datedSources.active('territories'):undefined,before:items[0].role==='territorial-fill'?'physical-water':map.getLayer('interaction-fill')?'interaction-fill':undefined,
     onChange:({structureChanged})=>{if(!disposed){if(structureChanged){indexedStyle=null;orderSceneLayers();}if(items[0].role!=='hydro-detail')dirty();invalidate('vector-ready');}}});
    entry={layer,signature:null,order:items[0].order,role:items[0].role};vectorLayers.set(id,entry);
   }
   else if(!map.getLayer(id))entry.signature=null;
   if(entry.signature!==signature){entry.signature=signature;entry.layer.update(items).catch(cause=>{if(entry.role==='hydro-detail')deps.feedback.reportOperationError(cause,'강 상세 표시를 준비하지 못했습니다.','PL-HYDRO-DETAIL-002');else failMapPreparation(cause);});}
  }
 }
 function moveInOrder(order,id,before){
  const from=order.indexOf(id);
  if(from<0||id===before||order[from+1]===before)return false;
  order.splice(from,1);
  const to=before===undefined?order.length:order.indexOf(before);
  order.splice(to<0?order.length:to,0,id);
  return true;
 }
 function orderSceneLayers(){
  const order=map.getLayersOrder(),desired=order.slice(),managed=new Set();
  const place=(id,before)=>{if(id&&map.getLayer(id)){managed.add(id);moveInOrder(desired,id,before);}};
  const water=sourceLayer('physical-water',datedSources.active('physical-water'));
  const country=sourceLayer('territories',datedSources.active('territories'));
  const ordered=[...sceneOrder,{id:sourceLayer('borders',datedSources.active('territories')),order:100},
   ...[...vectorLayers].map(([id,entry])=>({id,order:entry.order,role:entry.role}))];
  for(const row of ordered.sort((a,b)=>a.order-b.order)){
   if(row.role==='graticule')continue;
   const before=row.role==='territorial-fill'?water:row.order<0?country:undefined;
   for(const id of vectorLayers.get(row.id)?.layer.getLayerIds()||[row.id])place(id,before);
  }
  let before=water;
  for(const {id} of [...(countryFillGroups.get(datedSources.active('territories'))||[])].reverse())
   if(map.getLayer(id)){place(id,before);before=id;}
  for(const id of ['map-graticule',...(highlight?.ids()||[]),...MAPLIBRE_LABEL_LAYERS,'initial-map-ocean','initial-map-land'])place(id);
  place(polarLayer?.id,!initialMapLoading&&map.getLayer('viewer-label-dot')?'viewer-label-dot':undefined);
  let moved=false;
  for(let index=desired.length-1;index>=0;index--){
   const id=desired[index],next=desired[index+1];
   if(managed.has(id)&&moveInOrder(order,id,next)){map.moveLayer(id,next);moved=true;}
  }
  if(moved)indexedStyle=null;
 }
 function syncTerritorialFills(source,batches){
  const base=sourceLayer('territories',source),paint=currentMapStyle().territorialFillPaint;
  const suffix=base.slice('territories'.length);
  const next=batches.flatMap(({index,blendMode,ids})=>blendMode==='normal'
   ?[{id:index===0?base:'territories-fill-'+index+suffix,multiply:false,filter:countryFillFilter(index)}]
   :ids.map(id=>({id:'territories-multiply-'+id+suffix,multiply:true,filter:['==',['get','objectKey'],id]})));
  const wanted=new Set(next.map(group=>group.id));
  for(const {id} of countryFillGroups.get(source)||[])if(id!==base&&!wanted.has(id)&&map.getLayer(id)){map.removeLayer(id);indexedStyle=null;}
  for(const {id,multiply,filter} of next)if(!map.getLayer(id)){
   map.addLayer({id,type:'fill',source,filter,layout:{'fill-sort-key':['get','paintOrder'],visibility:'visible'},paint:{...paint,
    'fill-layer-blend':multiply&&colorsEnabled()?'multiply':'normal',
    'fill-layer-opacity':source===datedSources.active('territories')?1:0,'fill-layer-opacity-transition':{duration:0}}},sourceLayer('physical-water',datedSources.active('physical-water')));
   indexedStyle=null;
  }
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
  const changed=syncMapLibreBaseLayer(map,{style,landGeometry:geometryClient.physicalGeometry(deps.physicalResources.physicalLand?.revision)});
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
   camera.captureNativeMinZoom();
   styleController=createMapLibreStyleController(map);
   projection=createMapLibreProjection(map);
   map.on('styledata',()=>{indexedStyle=null;});
   map.on('style.load',()=>{
    hydroInputs=null;hydroStateKey=null;hydroEditsKey=null;
    if(loadedStyle!==map.style&&highlight){highlight.reset();pendingSelection=true;}
    loadedStyle=map.style;
    if(loaded&&!disposed){restoreFeatures();flushStyleChanges();refreshHydroDetail();}
   });
   map.on('webglcontextlost',()=>{contextRevision++;sourceWrites.reset();physicalPending.clear();physicalLandKey='';physicalWaterKey='';contextLost=true;ready=false;preparedReady=false;certifiedRevision=-1;notify('loading','지도 복구 중');});
   map.on('webglcontextrestored',()=>{
    const restore=()=>{if(disposed)return;styleController.apply(currentMapStyle(),{updateVisibility:!temporalOverlay});syncVectorGroups();polarLayer?.resetContext();highlight?.reset();pendingSelection=!!selectionSnapshot;contextLost=false;certifiedRevision=-1;dirty();flushStyleChanges();invalidate('map-context-restored');};
    if(loadedStyle===map.style)restore();else map.once('style.load',restore);
   });
   map.on('error',event=>{if(event.error?.name==='AbortError')return;
    if(event.error&&sourceWrites.handlesError(event.error))return;
    if(event.sourceId&&externalBasemap?.ownsSource(event.sourceId))return;if(event.sourceId==='viewer-labels')return;
    if(event.sourceId&&map.getSource(event.sourceId)&&!requiredSource(event.sourceId)){
     deps.feedback.reportOperationError(event.error||new Error('Optional source failed: '+event.sourceId),'추가 지도 자료를 불러오지 못했습니다.','PL-MAPLIBRE-OPTIONAL-001');return;
    }
    failMapPreparation(event.error||new Error('MapLibre render failed.'));
   });
   map.on('render',()=>{
    stats.renderedFrames++;
    requestedCertificate=null;
    if(loaded&&!contextLost)highlight?.onRender();

    const requiredReady=loaded&&!error&&!contextLost&&!polarLayer?.pending&&!sourceWrites.pendingCount()&&requiredSourcesReady();
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
   styleController.apply(currentMapStyle(),{updateVisibility:false});
   if(initialCamera)map.resize();
   const initialInsets=readSafeInsets('startup-camera');
   refreshWorldFit(initialInsets);
   if(initialCamera){
    if(startupView)syncCameraFromState(startupView);
    else fitMapBounds(WORLD_VIEW_BOUNDS,initialInsets);
    syncInitialMapSkeleton();
    map.once('render',()=>container.style.removeProperty('visibility'));
    map.triggerRepaint();
   }
   lastCameraZoom=map.getZoom();
   map.on('move',event=>{
    if(event.originalEvent&&zoomFramePending&&!initialMapLoading&&!initialFrameStaging){
     zoomFramePending=false;discardUnusedPreservedFrame();
    }
    const zoom=map.getZoom(),jump=Math.abs(zoom-lastCameraZoom)>=2-ZOOM_EPSILON;
    lastCameraZoom=zoom;
    if(jump&&!event.originalEvent&&!zoomFramePending&&(!state.projectReplacing||initialMapLoading)&&
     (lastPresentedZoom===null||Math.abs(zoom-lastPresentedZoom)>=2-ZOOM_EPSILON)){
     if(initialMapLoading){initialZoomHidden=true;map.getCanvas().style.visibility='hidden';}
     else if(lastPresentedZoom!==null)preserveDisplayedFrame();
     zoomFramePending=true;
    }
    if(zoomFramePending){ready=false;preparedReady=false;}
    if(camera.isApplying()||state.projectReplacing)return;
    invalidate('maplibre-camera');
   });
   map.on('movestart',()=>{previousActiveRender=null;highlight?.onCameraChange();deps.domains.renderingDomain?.beginInteraction('maplibre-move');});
   map.on('moveend',()=>{previousActiveRender=null;highlight?.onCameraChange();deps.domains.renderingDomain?.endInteraction('maplibre-move-end');datedSources.scheduleRetirement();});
   if(!initialCamera){
    if(camera.hasPendingFit())applyCameraFit();else syncCameraFromState(initialView);
   }
   window.__PANDOLAB_MAPLIBRE__=map;
   return true;
  })();
  initialization.catch(failMapPreparation);return initialization;
 }
 function setTerritorialFeatures(features){
  const entities=deps.territorialModel.entityRepository.list?.()??features;
  const countryStyle=currentMapStyle();
  const inputs={entities,features,generation,source:map?.getSource(datedSources.active('territories')),
   presentation:state.layerPresentation,visibility:state.itemVisibility?.objects,
   visible:state.layerVisibility.objects,stroke:JSON.stringify([countryStyle.countryStroke,countryStyle.borderAlpha])};
  const accepted=acceptedCountryInputs;
  const immutable=rows=>rows.every(row=>Object.isFrozen(row)&&Object.isFrozen(row.properties)&&geometryReferenceFor(row.geometry));
  // The country tiles consume geometry, hierarchy and fill inputs. Dated
  // names, flags and other metadata belong to the separate label scene.
  const equivalent=(before,after)=>before===after||before.length===after.length&&before.every((row,index)=>{
   const next=after[index];
   return row===next||row.id===next.id&&row.geometry===next.geometry
    &&row.properties.parentId===next.properties.parentId
    &&row.properties.entityKind===next.properties.entityKind
    &&row.properties.style?.color===next.properties.style?.color
    &&countryDefaultColor(row)===countryDefaultColor(next);
  });
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
     acceptedCountryInputs={...inputs,source:map.getSource(datedSources.active('territories'))};
    return applied;
   }
   finally{activeCountryTasks.delete(sequence);}
  }).catch(cause=>{if(disposed||sequence!==countrySequence||requestedGeneration!==generation)return false;throw cause;});
  countryTail=task.catch(()=>{});return task;
 }
 function replaceObsoleteCountrySource(){
  if(!countrySourceNeedsSwap)return;
  const oldId=datedSources.active('territories'),newId='territories-generation-'+(++countrySourceSerial),layers=map.getStyle().layers;
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
  indexedStyle=null;
  datedSources.replaceActive('territories',newId);countryFillGroups.delete(oldId);
  countryRows=new Map();countryTileRows=new Map();countryKey='';countrySourceNeedsSwap=false;dirty();
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
  const cached=datedSources.reuse('territories',key);
  const current=()=>!disposed&&requestedGeneration===generation&&sequence===countrySequence;
  const publish=(id,record)=>{
   datedSources.activate('territories',id);
   countryRows=record.rows;countryTileRows=record.tiles;countryKey=key;countryBoundaryGeometry=record.borders;
   syncCountryPaint(id,record.rows);orderSceneLayers();
  };
  const active=datedSources.get(datedSources.active('territories'));
  // A paint-only transition shares the already tiled source. Keep the actual
  // tile rows for the next native diff and update its paint through feature state.
  const paintOnly=!cached&&!countrySourceNeedsSwap&&active?.source===map.getSource(datedSources.active('territories'))
   &&active.rows?.size===presented.length&&presented.every(({id,geometry,properties})=>{
    const old=active.rows.get(id);
    return old&&geometryKey(old.geometry)===geometryKey(geometry)
     &&Object.entries(properties).every(([name,value])=>name==='color'||old.properties[name]===value);
   });
  if(paintOnly){
   const record={...active,key,rows:new Map(presented.map(row=>[row.id,row]))};
   datedSources.set(datedSources.active('territories'),record);publish(datedSources.active('territories'),record);dirty();
  }else if(cached){
   if(cached[0]!==datedSources.active('territories'))stats.retainedSourceHits++;
   countrySourceNeedsSwap=false;
   publish(...cached);
  }else{
   const preserve=presentation.temporalPending()&&datedSources.get(datedSources.active('territories'))?.key!=null;
   if(!preserve)replaceObsoleteCountrySource();
   else countrySourceNeedsSwap=false;
   const requestedSource=preserve?datedSources.reserve('territories'):datedSources.active('territories');
   const source=map.getSource(requestedSource);
   const previousTileRows=datedSources.get(requestedSource)?.tiles
    ??(requestedSource===datedSources.active('territories')?countryTileRows:new Map());
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
   const dirtyEntry={kind:'territories',source};datedSources.set(requestedSource,dirtyEntry);
   try{
    let applied=true;
    if(!previousTileRows.size)applied=await setData(requestedSource,collection(tileFeatures),ownsSource);
    else if(remove.length||add.length||update.length)applied=await sourceWrites.update(source=>source.updateData({remove,add,update}),requestedSource,ownsSource);
    if(!applied)return false;
   }catch(cause){if(current()){countryRows=new Map();countryTileRows=new Map();countryKey='';}throw cause;}
   if(!ownsSource())return false;
   syncTerritorialFills(requestedSource,nextBatches);
   const record={kind:'territories',source,key,rows:new Map(presented.map(feature=>[feature.id,feature])),
    tiles:next,borders:new Map(borders.map(row=>[row.key,row]))};
   datedSources.set(requestedSource,record);
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
  if(map.getSource(datedSources.active('physical-land'))&&(physicalLandKey!==context.revision||physicalLandSource!==map.getSource(datedSources.active('physical-land'))))
   preparePhysicalSource('physical-land',context.revision,collection([{type:'Feature',properties:{},geometry:context.geometry}]),context.displayPrepared);
  // The physical owner resolves the drawn water and its identities together.
  // Admission into the searchable hydro catalog can complete independently.
  const waterFeatures=context.waterFeatures??(context.water?[{type:'Feature',properties:{},geometry:context.water}]:[]);
  const waterKey=context.waterRevision||JSON.stringify(waterFeatures.map(feature=>geometryKey(feature.geometry)));
  if(waterKey!==physicalWaterKey||physicalWaterSource!==map.getSource(datedSources.active('physical-water')))
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
  const stages=hydroDisplayStages(manifest.stages);
  hydroPresentation?.dispose();hydroPresentation=null;hydroLoader?.dispose();hydroLoader=null;cancelHydroStartup();
  hydroManifest=manifest;hydroAppliedSource=null;
  await initialize();
  if(hydroManifest!==manifest||!hydroDetailEnabled())return false;
  const minZoomByStage=new Map(stages.map(stage=>[stage.id,stage.minZoom]));
  hydroMinZoomByStage=minZoomByStage;
  const lakeDisplayMinZoom=new Map(Object.entries(manifest.lakeDisplayMinZoom??{}));
  for(const [id,zoom] of lakeDisplayMinZoom)
   if(!/^\d+$/.test(id)||!HYDRO_DISPLAY_ZOOMS.includes(zoom))throw new RangeError('Invalid lake display zoom '+id);
  const displayFeatures=features=>features.flatMap(feature=>{
   const {stage,category}=feature.properties;
   const transportZoom=minZoomByStage.get(stage);
   if(transportZoom===undefined)throw new RangeError('Unknown hydro stage '+stage);
   const viewerMinZoom=category==='lake'?(lakeDisplayMinZoom.get(String(feature.properties.__logicalFid))??transportZoom):transportZoom;
   if(viewerMinZoom<transportZoom)throw new RangeError('Lake display zoom precedes its source stage');
   const geometry=category==='river'?clipMercatorLines(joinHydroLineParts(feature.geometry)):feature.geometry;
   if(!geometry.coordinates.length)return [];
   return [{...feature,geometry,properties:{...feature.properties,viewerMinZoom}}];
  });
  const viewportTiles=({zoom,width,height})=>{
   const bounds=projection.geographicBounds();
   return bounds?hydroTileSpecsForWindow(createHydroTileWindow({manifest:{stages},threshold:zoom,width,height,bounds})):[];
  };
  const createLoader=signal=>createHydroBrowserLoader({manifest,baseUrl:new URL('.',url).href,dataRevision:deps.physicalConfig.DATA_REVISION,signal,
   createWorker:()=>new Worker(deps.platform.runtimeAssetUrl('workers/hydro-tile-worker.js')),tilesForView:view=>view.tiles});
  const load=async (view,isCurrent,options)=>{
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
   return hydroLoader.view(view,options);
  };
  let quietTicket=presentation.ticket,quietUntil=performance.now()+250;
  hydroPresentation=createMapLibreHydroPresentation({map,isEnabled:hydroDetailEnabled,viewportTiles,
   needsSourceRestore:()=>!hydroAppliedSource||hydroAppliedSource!==map.getSource('hydro'),
   waitForSource:isCurrent=>waitForHydro(isCurrent,()=>styleReady()&&hydroAppliedSource===map.getSource('hydro')&&map.isSourceLoaded('hydro')),
   beforePublish:async isCurrent=>{
   // Optional pack aggregation and Core identity admission must yield to an
   // already requested dated frame, just like optional tile uploads. Wait for
   // a short quiet window too: successive date requests can otherwise start
   // immediately after a large optional synchronous admission has begun.
   while(!disposed&&isCurrent()){
    const current=presentation.ticket,now=performance.now();
    if(current!==quietTicket||presentation.temporalPending()&&!current?.error){quietTicket=current;quietUntil=now+250;}
    // Optional fetch and decode can run during a zoom; native source updates
    // share the tile workers needed to admit the preserved target frame.
    if(!zoomFramePending&&!map.isMoving()&&now>=quietUntil)return;
    await new Promise(resolve=>setTimeout(resolve,16));
   }
  },updateSource:async(diff,allFeatures,isCurrent)=>{
   const add=displayFeatures(diff.add);
   while(!disposed&&isCurrent()){
    if(!await waitForHydro(isCurrent,()=>!basemapRecovery&&styleReady()))return false;
    const source=map.getSource('hydro');if(!source)throw new Error('Hydro source missing from current style');
    const full=source!==hydroAppliedSource;
    try{
     const applied=await sourceWrites.update(s=>full?s.setData(collection(displayFeatures(allFeatures()))):
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
  const inputs=[map.style,hydroFeatures,hydroEdits,deps.physicalResources.hydroActivityView(),state.hydroFeatureCatalogRevision,
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
  const key=rows.map(row=>[row.key,row.objectKey,row.geometryRevision,row.order,row.role,row.blendMode,JSON.stringify(row.style)].join(':')).join('|');
  if(key===sceneKey)return;sceneKey=key;
  const groups=new Map();
  rows.filter(row=>!native(row)).sort((a,b)=>a.order-b.order).forEach(row=>{const kind=['Point','MultiPoint'].includes(row.geometry?.type)?'circle':row.kind,band=row.role==='territorial-fill'?'territorial':row.order<0?'base':'independent';const id='scene-'+kind+'-'+row.order+'-'+band;if(!groups.has(id))groups.set(id,[]);groups.get(id).push({...row,kind});});
  for(const id of dynamicLayers)if(!groups.has(id)){map.removeLayer(id);map.removeSource(id);dynamicLayers.delete(id);dynamicSources.delete(id);sceneGroups.delete(id);indexedStyle=null;}
  for(const [id,items]of groups){
   const signature=items.map(item=>[item.key,item.objectKey,item.geometryRevision,item.blendMode,JSON.stringify(item.style)].join(':')).join('|');
   const currentSource=map.getSource(id),previous=sceneGroups.get(id);
   if(previous&&previous.source===currentSource&&previous.signature===signature)continue;
   const next=new Map(items.filter(item=>item.geometry).map(item=>[item.key,{revision:item.geometryRevision,
    feature:{type:'Feature',id:item.key,geometry:item.geometry,properties:{objectKey:item.objectKey||'',color:item.style?.color||'#ffffff',alpha:item.style?.fillAlpha??item.style?.alpha??1}}}]));
   if(!next.size)continue;
   const data=()=>collection(Array.from(next.values(),row=>row.feature));
   if(currentSource){
    const group=previous?.source===currentSource?previous:{source:currentSource,rows:null};
    group.signature=signature;sceneGroups.set(id,group);
    sourceWrites.update(async source=>{
     const before=group.rows;
     if(!before)await source.setData(data());
     else{
      const remove=[...before.keys()].filter(key=>!next.has(key)),add=[],update=[];
      for(const [key,{feature,revision}] of next){
       const old=before.get(key);
       if(!old){add.push(feature);continue;}
       const newGeometry=old.revision!==revision||revision==null&&old.feature.geometry!==feature.geometry?feature.geometry:null;
       const properties=Object.entries(feature.properties).filter(([name,value])=>old.feature.properties[name]!==value)
        .map(([key,value])=>({key,value}));
       if(newGeometry||properties.length)update.push({id:key,...(newGeometry?{newGeometry}:{}),
        ...(properties.length?{addOrUpdateProperties:properties}:{})});
      }
      if(add.length||remove.length||update.length)await source.updateData({add,remove,update});
     }
    },id,()=>sceneGroups.get(id)===group&&group.signature===signature)
     .then(applied=>{
      if(applied){group.rows=next;return;}
      if(sceneGroups.get(id)===group&&group.signature===signature){group.signature=null;sceneKey='';}
     },()=>{
      if(sceneGroups.get(id)!==group)return;
      group.rows=null;
      if(group.signature===signature){group.signature=null;sceneKey='';}
     });
   }
   else{
    map.addSource(id,{type:'geojson',data:data()});dynamicSources.add(id);indexedStyle=null;
    sceneGroups.set(id,{source:map.getSource(id),rows:next,signature});
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
  selectionSnapshot=snapshot;
  submitSelection(snapshot);
 }
 function submitSelection(snapshot,selectionOnly=false){
  if(!styleReady()){pendingSelection=true;return;}
  pendingSelection=false;
  const polarOwner=ensurePolar();
  highlight ||=createMapLibreHighlight({map,write:setData,onStructure:orderSceneLayers,
   preparePolar:items=>polarOwner.prepareHighlights(items),clearPolar:()=>polarOwner.clearHighlights(),
   onRestoreSelection:()=>submitSelection(selectionSnapshot,true),
   onShown:result=>{metrics.record('highlight.prepare-to-render',result.shownAt-result.startedAt);invalidate('highlight-shown');},
   onError:cause=>{if(cause?.name!=='AbortError')deps.feedback.reportOperationError(cause,'지도 강조 표시를 준비하지 못했습니다.','PL-MAPLIBRE-HIGHLIGHT-001');invalidate('highlight-failed');}});
  const selected=snapshot.selection?.items||snapshot.selection?.refs||[];
  const hoverRef=selectionOnly||temporalFrameHeld&&presentation.temporalPending()?null:snapshot.hover;
  const primary=snapshot.selection?.primaryKey,hover=hoverRef?.key;
  const refs=[...selected];
  if(hoverRef&&!selected.some(ref=>ref.key===hover))refs.push(hoverRef);
  const native=[],polar=[],keys=[],selectedKeys=[],nativeKeys=[];
  for(const ref of refs){
   if(!deps.objectRefVisible(ref))continue;
   const feature=ref.domain==='territorial'?deps.territorialModel.entityRepository.get(ref.id):ref.domain==='generic'?state.genericFeatures.find(value=>String(value.id)===ref.id):ref.domain==='hydro'?deps.hydroModel.hydroFeatureById(ref.id):ref.domain==='label'?state.labels.find(value=>String(value.id)===ref.id):null;
   const geometries=ref.domain==='distribution'?distributionEntriesForLayer(state.distributionEntries,ref.id).map(entry=>entry.mode===DISTRIBUTION_MODES.TERRITORIAL?deps.territorialModel.entityRepository.get(entry.territorialUnitId)?.geometry:entry.geometry):feature?.geometry?[feature.geometry]:feature?.coordinates?[{type:'Point',coordinates:feature.coordinates}]:[];
   const hovered=ref.key===hover&&!selected.some(item=>item.key===ref.key);
   const role=ref.key===primary?interactionStyle?.selection.primary:hovered?interactionStyle?.hover:interactionStyle?.selection.secondary;
   const color=(hovered?interactionStyle?.hover.color:interactionStyle?.selection.color)||'#ffd453';
   const width=role?.innerWidth??role?.width??2,fillAlpha=role?.fillAlpha??0.2,strokeAlpha=role?.innerAlpha??role?.alpha??1;
   for(const geometry of geometries.filter(Boolean)){
    const revision=geometryKey(geometry);
    const key=[ref.key,revision,color,width,fillAlpha,strokeAlpha,hovered];
    keys.push(key);if(!hovered)selectedKeys.push(key);
    const cap=polarGeometry(geometry);
    const polygon=geometry.type==='Polygon'||geometry.type==='MultiPolygon';
    const addNative=(shape,alpha,partitioned=false)=>{
     nativeKeys.push([ref.key,revision,shape.type,color,alpha,width]);
     const properties={objectKey:ref.key,color,alpha,width};
     if(partitioned&&alpha<1)properties.splitOpacity=alpha;
     native.push({type:'Feature',geometry:shape,properties});
    };
    if(polygon&&fillAlpha>0)addNative(geometry,fillAlpha);
    if(geometry.type==='Point'||geometry.type==='MultiPoint')addNative(geometry,1);
    if(cap&&fillAlpha>0)polar.push({geometry:cap,color:rgba(color,fillAlpha)});
    if(!(strokeAlpha>0)||!(width>0)||(!polygon&&!['LineString','MultiLineString'].includes(geometry.type)))continue;
    let paths=highlightLines.get(geometry);
    if(!paths){
     paths={segments:buildRenderableBoundarySegments(geometry)};
     highlightLines.set(geometry,paths);
    }
    if(!paths.native){
     const clipped=clipMercatorLines({type:'MultiLineString',coordinates:connectBoundarySegments(paths.segments)});
     paths.native=partitionHighlightLines(clipped);
     paths.partitioned=paths.native!==clipped;
    }
    if(paths.native.coordinates.length)addNative(paths.native,strokeAlpha,paths.partitioned);
    const packet=paths.cap ||=polarLinePacket(paths.segments);
    if(packet.indices.length)polar.push({packet,color:rgba(color,strokeAlpha),width});
   }
  }
  highlight.submit(JSON.stringify(keys),native,polar,JSON.stringify(selectedKeys),JSON.stringify(nativeKeys));
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
 function pickingLayers(zoom,includeHydro,includeLabels){
  const sources=mapSourceLayers();
  if(!pickLayerCache||zoom<pickLayerCache.min||zoom>=pickLayerCache.max){
   const groups={map:[],hydro:[],labels:[]};
   const border=sourceLayer('borders',datedSources.active('territories'));
   let min=-Infinity,max=Infinity;
   for(const layer of sources){
    if(!layer.visible)continue;
    for(const cutoff of [layer.minzoom,layer.maxzoom]){
     if(cutoff<=zoom)min=Math.max(min,cutoff);else max=Math.min(max,cutoff);
    }
    if(!layerVisibleAtZoom(layer,zoom))continue;
    const {id,source}=layer;
    if(source==='viewer-labels')groups.labels.push(id);
    else if(['hydro','hydro-edits',datedSources.active('physical-water')].includes(source)||vectorLayers.get(source)?.role==='project-hydro')groups.hydro.push(id);
    else if(source!==datedSources.active('physical-land')&&!highlight?.owns(source)&&id!=='map-graticule'&&id!==border&&requiredSource(source))groups.map.push(id);
   }
   pickLayerCache={min,max,groups};
  }
  const groups=pickLayerCache.groups;
  return includeHydro||includeLabels?[...groups.map,...(includeHydro?groups.hydro:[]),...(includeLabels?groups.labels:[])]:groups.map;
 }
 function queryObjectRefs(point,{includeHydro=true,includeLabels=true}={}){
  if(!loaded||temporalOverlay||initialZoomHidden)return [];
  const coordinate=projection.screenToGeo(point);
  if(!coordinate)return [];
  const zoom=map.getZoom();
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
   for(const row of polarVisibleLines){
    if(!row.ref||!isWithinDisplayZoom(zoom,row.displayMinZoom)||!deps.objectRefVisible(row.ref)||row.ref.domain==='hydro'&&(!includeHydro
     ||row.packFeatureId!==null&&!hydroPresentation?.canPick(row.packFeatureId,row.ref.id)))continue;
    if(projectedLineDistance(row.geometry,point,vertex=>projection.projectVisibleCoordinate(vertex,{allowOutsideViewport:true}))<=Math.max(4,row.width/2))
     refs.push(row.ref);
   }
   return refs;
  }
  const refs=new Map();
  const layers=pickingLayers(zoom,includeHydro,includeLabels);
  if(!layers.length)return [];
  for(const feature of map.queryRenderedFeatures(point,{layers})){
   const p=feature.properties||{};if(p.displayRole==='country-border')continue;
   if(feature.source==='hydro'&&(!isWithinDisplayZoom(zoom,p.viewerMinZoom)||!hydroPresentation?.canPick(p.featureId,p.logicalId)))continue;
   if(feature.source==='viewer-labels'&&p.kind==='label'&&!isWithinDisplayZoom(zoom,p.viewerMinZoom))continue;
   let ref;
   if(p.objectKey)ref=objectKeyRef(p.objectKey);
   else if(p.logicalId&&p.category)ref=normalizeObjectRef({domain:'hydro',type:p.category,id:String(p.logicalId)});
   if(ref&&(includeHydro||ref.domain!=='hydro')&&(includeLabels||ref.domain!=='label'))refs.set(ref.key,ref);
  }
  return [...refs.values()];
 }
 function renderFrame(frame){
  stats.approvalAttempts++;
  if(error){pendingFrame=null;return {succeeded:false,presentationReady:false,error};}
  if(!styleReady()){pendingFrame=frame;return {succeeded:false,deferred:true,presentationReady:false};}
  pendingFrame=frame;metrics.run('physical.sync',syncPhysicalContext);metrics.run('polar.sync',()=>{syncPolar();syncPolarLines();});if(initialMapLoading)syncInitialMapSkeleton();else syncLabelVisibility();
  const pending=!!polarLayer?.pending||presentation.temporalPending()&&highlight?.selectionPending()||!!error||!loaded||contextLost||sourceWrites.pendingCount()||
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
  if(initialMapLoading){
   // The certified frame still contains the loading surface. Draw the real
   // scene and its symbols behind those saved pixels before admitting it.
   preserveDisplayedFrame();
   initialFrameStaging='drawing';
   initialMapLoading=false;
   syncInitialMapSkeleton();
   dirty();
   map.triggerRepaint();
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
   if(initialFrameStaging)initialFrameStaging='certified';
   projectFrameHeld=false;zoomFramePending=false;
   discardUnusedPreservedFrame();
   metrics.publish();pendingFrame=null;ready=true;notify('ready','지도 준비 완료');
   datedSources.scheduleRetirement();
  }
  return committed;
 }
 function failMapPreparation(cause){if(disposed)return;error=cause;ready=false;preparedReady=false;notify('error','지도 불러오기 실패');presentation.rejectMapPresentationWaiters(cause);presentation.failTemporalPresentation(cause);deps.feedback.reportOperationError(cause,'지도를 표시하지 못했습니다.','PL-MAPLIBRE-001');}
 function retryMapPreparation(){error=null;polarInputs=[];highlight?.reset();polarLayer?.retry();if(selectionSnapshot)setSelection(selectionSnapshot);invalidate('map-retry');}
 function invalidateCountryColors(){
  if(!styleReady()){pendingCountryPaint=true;return;}
  syncCountryPaint(datedSources.active('territories'),countryRows);
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
 function setInitialMapLoading(value){
  if(value!==true&&initialFrameStaging==='certified'){
   initialFrameStaging=null;
   if(initialZoomHidden){initialZoomHidden=false;map.getCanvas().style.removeProperty('visibility');}
   discardUnusedPreservedFrame();
   return;
  }
  if(value!==true&&!initialMapLoading)return;
  initialMapLoading=value===true;syncInitialMapSkeleton();dirty();invalidate('initial-map-skeleton');
 }
 return Object.freeze({registerFeature,previewExternalBasemap,cameraSnapshot(){return map&&loaded?readMapLibreCamera(map):null;},setInitialMapLoading,attach,initialize,setTerritorialFeatures,setSceneDomains,setSelection,queryObjectRefs,getPickingRevision:()=>sourceRevision,syncCameraFromState,syncPhysicalContext,syncHydroState,
 get map(){return map;},get projection(){return projection;},get loaded(){return loaded;},isStyleReady:styleReady,renderFrame,commitVisualFrame,measureWork:metrics.track,measureSyncWork:metrics.run,
  panBy(dx,dy){map.panBy([-dx,-dy],{animate:false});return true;},
  fitGeometry(feature,padding){
   const geometries=[];
   const collect=value=>{if(value?.type==='FeatureCollection'){value.features.forEach(collect);return;}if(value?.type==='Feature'){collect(value.geometry);return;}if(value?.type==='GeometryCollection'){value.geometries.forEach(collect);return;}if(value?.coordinates)geometries.push(value);};collect(feature);
   const boxes=geometries.map(geometry=>coordinateBounds(geometry.coordinates)).filter(box=>box.every(Number.isFinite));if(!boxes.length)return false;
   const bounds=[[Math.min(...boxes.map(box=>box[0])),Math.min(...boxes.map(box=>box[1]))],[Math.max(...boxes.map(box=>box[2])),Math.max(...boxes.map(box=>box[3]))]];
   if(bounds[0][0]===bounds[1][0]&&bounds[0][1]===bounds[1][1]){
    jumpCamera({center:bounds[0],zoom:map.getZoom()});return true;
   }
   return fitMapBounds(bounds,padding);
  },
  fitMapBounds,fitWorld:padding=>fitMapBounds(WORLD_VIEW_BOUNDS,padding),isAtWorldView,
  canPresentVisualFrame:presentation.canPresentVisualFrame,prepareTemporalCountrySource:presentation.prepareTemporalCountrySource,
  beginTemporalViewTransition(isCurrent,onPresented){datedSources.cancelRetirement();const ticket=presentation.beginTemporalViewTransition(isCurrent,onPresented);if(externalBasemap&&!basemapRecovery){const finish=()=>{basemapRecovery=null;flushStyleChanges();invalidate('basemap-transition-recovered');};const recovery=Promise.resolve().then(()=>externalBasemap.cancelPending()).then(value=>{finish();return value;},cause=>{finish();throw cause;});basemapRecovery=recovery;recovery.catch(failMapPreparation);}return ticket;},
  admitTemporalViewTransition(ticket){
   if(!presentation.admitTemporalViewTransition(ticket))return false;
   if(highlight?.hasHover())highlight.reset();
   if(selectionSnapshot)setSelection(selectionSnapshot);
   return true;
  },
  preserveTemporalFrame,releaseTemporalFrame,isFramePreserved:()=>!!temporalOverlay||initialZoomHidden,
  finishTemporalViewTransition(ticket){const finished=presentation.finishTemporalViewTransition(ticket);if(finished)datedSources.scheduleRetirement();return finished;},
  waitForTemporalPresentation:presentation.waitForTemporalPresentation,
  waitForMapPresentation:presentation.waitForMapPresentation,getProjectGeneration:()=>generation,
  resetProjectRenderState(options){if(options.presentation!=='temporal'){
   if(!initialMapLoading&&!initialFrameStaging&&lastPresentedZoom!==null){preserveDisplayedFrame();projectFrameHeld=true;}
   zoomFramePending=false;lastPresentedZoom=null;releaseTemporalFrame();hydroPresentation?.suspend();cancelHydroStartup();
  }countryGeometryAbort?.abort();geometryClient.reset();polarInputs=[];highlight?.reset();generation=options.generation;pendingSceneDomains=null;sourceWrites.reset();if(activeCountryTasks.size){countrySourceNeedsSwap=true;countryTail=Promise.resolve();}countrySequence++;countryGeneration=-1;error=null;ready=false;preparedReady=false;presentation.resetForProject(options);},
  labelZoomVisibility,
  getRuntimeState:()=>({...stats,projectRenderBlocked:!!error,mapReady:ready,webglContextLost:contextLost,temporalPresentationPending:presentation.temporalPending(),temporalViewPending:presentation.temporalPending()&&presentation.ticket?.kind==='view',temporalSourceAdmitted:presentation.ticket?.sourceAdmitted!==false,physicalContextRevision:landRevision}),
  getStats:()=>({...stats,datedSources:{territories:datedSources.active('territories'),land:datedSources.active('physical-land'),water:datedSources.active('physical-water')},performance:metrics.snapshot(),polar:polarLayer?.stats(),highlight:highlight?.stats(),hydro:hydroLoader?.stats(),errorMessage:error?.message||null,generation,projectReplacing:!!state.projectReplacing,webglContextLost:contextLost,projectRenderBlocked:!!error,displayedRevision:ready?sourceRevision:0,mapReadiness:{mapReady:ready,status:error?'error':ready?'ready':'loading'},hydroFeatureCount:hydroFeatures.length,sourceRevision,certifiedRevision,labelLayout:deps.countryLabelModel.labelLayoutMetrics,mapMoving:state.mapMoving}),
  setHydroManifest,
  invalidateCountryColors,invalidateCountryPalette:invalidateStyle,invalidatePhysicalStyle:invalidateStyle,
  invalidateHydroVisibility(){refreshHydroDetail();if(loaded&&!styleReady()){pendingStyleRefresh=true;return;}if(loaded){syncHydroState();dirty();}invalidate('hydro-visibility');},
  setRenderQuality(value){quality=value;if(map&&value?.dprCap&&Math.abs(map.getPixelRatio()-value.dprCap)>1e-9)map.setPixelRatio(value.dprCap);},
  setInteractionStyle,
  getRenderPixelRatio:()=>quality?.dprCap||window.devicePixelRatio||1,
  verifyLayout(){if(map){map.resize();refreshWorldFit();syncBaseLayer();applyCameraFit();}},failMapPreparation,retryMapPreparation,
  dispose(){disposed=true;datedSources.cancelRetirement();countryGeometryAbort?.abort();geometryClient.dispose();highlight?.dispose();polarLayer?.dispose();externalBasemap?.dispose();if(externalAttribution)map?.removeControl(externalAttribution);externalAttribution=null;for(const record of mapFeatures.values()){try{record.owner.dispose();}catch(cause){deps.feedback.reportOperationError(cause,'추가 지도 기능을 정리하지 못했습니다.','PL-MAPLIBRE-OPTIONAL-001');}}mapFeatures.clear();zoomFramePending=false;releaseTemporalFrame();presentation.dispose();hydroPresentation?.dispose();cancelHydroStartup();hydroLoader?.dispose();for(const entry of vectorLayers.values())entry.layer.dispose();vectorLayers.clear();map?.remove();if(window.__PANDOLAB_MAPLIBRE__===map)delete window.__PANDOLAB_MAPLIBRE__;stylesheet?.remove();container?.remove();},
 });
}
