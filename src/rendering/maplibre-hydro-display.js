import {clipMercatorLines} from './maplibre-polar-layer.js';
import {createMapLibreHydroPresentation,hiddenMapLibreHydroIds,syncMapLibreHydroVisibility,prepareMapLibreHydroFeatures,joinHydroLineParts,mapLibreHydroStyle} from './maplibre-hydro-presentation.js';
import {HYDRO_DISPLAY_ZOOMS,hydroDisplayStages} from '../map/map-display-zoom.js';
import {createHydroBrowserLoader} from '../data/maplibre-hydro-loader.js';
import {createHydroTileWindow,hydroTileSpecsForWindow} from '../data/hydro-tile-window.js';
import {normalizeObjectRef} from '../document/object-ref-identity.js';
import {sameRenderIdentity} from './render-identity.js';
import {admittedGeometryKey as geometryKey} from '../geometry/geometry-version-store.js';
const collection=features=>({type:'FeatureCollection',features}),empty=()=>collection([]);
// Optional hydro tile loading and editing overlays are renderer-side display
// state, not authoritative geometry or source-data ownership.
export function createMapLibreHydroDisplay({state,physicalResources,physicalServices,physicalConfig,
 preferences,platform,feedback,getMap,getProjection,getPresentation,initialize,
 styleReady,isDisposed,isZoomFramePending,getBasemapRecovery,getSelectionSnapshot,setSelection,
 sourceWrites,setData,strokeDomain,metrics,getStats,invalidate}){
 let hydroLoader=null,hydroPresentation=null,hydroFeatures=[],hydroManifest=null;
 let hydroStartup=null,hydroStartupAbort=null,hydroAppliedSource=null;
 let hydroStateKey='',hydroEditsKey='',hydroMinZoomByStage=new Map(),hydroInputs=null;
 const hydroDetailEnabled=()=>!isDisposed()&&physicalResources.hydroDetailEnabled();
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
  const map=getMap(),projection=getProjection(),presentation=getPresentation();
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
  const createLoader=signal=>createHydroBrowserLoader({manifest,baseUrl:new URL('.',url).href,dataRevision:physicalConfig.DATA_REVISION,signal,
   createWorker:()=>new Worker(platform.runtimeAssetUrl('workers/hydro-tile-worker.js')),tilesForView:view=>view.tiles});
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
   while(!isDisposed()&&isCurrent()){
    const current=presentation.ticket,now=performance.now();
    if(current!==quietTicket||presentation.temporalPending()&&!current?.error){quietTicket=current;quietUntil=now+250;}
    // Optional fetch and decode can run during a zoom; native source updates
    // share the tile workers needed to admit the preserved target frame.
    if(!isZoomFramePending()&&!map.isMoving()&&now>=quietUntil)return;
    await new Promise(resolve=>setTimeout(resolve,16));
   }
  },updateSource:async(diff,allFeatures,isCurrent)=>{
   const add=displayFeatures(diff.add);
   while(!isDisposed()&&isCurrent()){
    if(!await waitForHydro(isCurrent,()=>!getBasemapRecovery()&&styleReady()))return false;
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
   const prepared=prepareMapLibreHydroFeatures(features,physicalResources.prepareHydroFeature);
   return metrics.track('hydro.core-admission',()=>physicalResources.admitHydroFeatures(prepared,{isCurrent}));
  },onFeatures:features=>{
   hydroFeatures=features;const snapshot=getSelectionSnapshot();if(snapshot?.selection.items.some(ref=>ref.domain==='hydro'))setSelection(snapshot);invalidate('hydro-ready');
  },load,cancel:()=>hydroLoader?.cancel(),onError:cause=>{if(cause?.name==='AbortError'||cause?.cancelled)return;feedback.reportOperationError(cause,'강·호수 상세 자료 일부를 불러오지 못했습니다. 지도를 이동하면 다시 시도합니다.','PL-HYDRO-DETAIL-001',4200);}});
  await hydroPresentation.refresh();return hydroDetailEnabled()&&hydroManifest===manifest;
 }
 const emptyHydroEdits=[];
 function syncHydroState(){
  if(!styleReady())return;
  const map=getMap();
  const {rivers,lakes}=state.layerVisibility;
  const ocean=preferences.mapPalette().ocean||'#ffffff';
  const hydroEdits=state.hydroEdits||emptyHydroEdits;
  const inputs=[map.style,hydroFeatures,hydroEdits,physicalResources.hydroActivityView(),state.hydroFeatureCatalogRevision,
   Object.entries(state.itemVisibility?.hydro??{}),state.physicalSettings?.hydroLayers,rivers,lakes,ocean];
  if(hydroInputs?.every((value,index)=>index===5?sameRenderIdentity(value,inputs[index]):value===inputs[index]))return;
  hydroInputs=inputs;getStats().hydroVisibilityScans++;
  const ids=hiddenMapLibreHydroIds(hydroFeatures,physicalServices.isHydroFeatureVisible);
  const key=[ids,state.layerVisibility.rivers,state.layerVisibility.lakes];
  if(!sameRenderIdentity(key,hydroStateKey)){hydroStateKey=key;
   syncMapLibreHydroVisibility(map,ids,state.layerVisibility);
  }
  const edits=hydroEdits.filter(physicalServices.isHydroFeatureVisible);
  const editsKey=[ocean,edits.map(feature=>[String(feature.id),geometryKey(feature.geometry),feature.properties.category])];
  if(!sameRenderIdentity(editsKey,hydroEditsKey)){hydroEditsKey=editsKey;
   if(!map.getSource('hydro-edits')){
    map.addSource('hydro-edits',{type:'geojson',data:empty()});
    map.addLayer({id:'hydro-edits-fill',type:'fill',source:'hydro-edits',filter:['==',['geometry-type'],'Polygon'],paint:{'fill-color':['get','color']}});
    map.addLayer({id:'hydro-edits-line',type:'line',source:'hydro-edits',paint:{'line-color':['get','color'],'line-width':1,'line-opacity':0}});
   }
   strokeDomain('edited-water-strokes',edits,()=>({color:ocean,width:1,alpha:1,cap:'round'}),210);
   setData('hydro-edits',collection(edits.map(feature=>({type:'Feature',id:String(feature.id),geometry:feature.geometry,properties:{objectKey:normalizeObjectRef({domain:'hydro',type:feature.properties.category||'river',id:String(feature.id)}).key,color:ocean}}))));
  }
 }

 return Object.freeze({setHydroManifest,syncHydroState,refreshHydroDetail,cancelHydroStartup,
  get features(){return hydroFeatures;},get manifest(){return hydroManifest;},
  get presentation(){return hydroPresentation;},get loader(){return hydroLoader;},
  get stageZooms(){return hydroMinZoomByStage;},get visibilityKey(){return hydroStateKey;},get editsKey(){return hydroEditsKey;},
  get stats(){return hydroLoader?.stats();},
  canPick:(...args)=>hydroPresentation?.canPick(...args),
  initialStyle:options=>mapLibreHydroStyle(options),
  resetStyle(){hydroInputs=null;hydroStateKey=null;hydroEditsKey=null;},
  invalidateVisibility(){hydroStateKey='';},
  resetProject(){hydroPresentation?.suspend();cancelHydroStartup();},
  dispose(){hydroPresentation?.dispose();cancelHydroStartup();hydroLoader?.dispose();hydroLoader=null;hydroPresentation=null;}
 });
}
