import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapLibrePhysicalBase} from '../../../src/rendering/maplibre-physical-base.js';
import {createMapLibreHydroDisplay} from '../../../src/rendering/maplibre-hydro-display.js';
import {createMapLibrePolarDisplay} from '../../../src/rendering/maplibre-polar-display.js';
import {createPolarLayer,polarGeometry} from '../../../src/rendering/maplibre-polar-layer.js';
import {createMapLibreSceneController} from '../../../src/rendering/maplibre-scene-controller.js';

test('physical land and water keep their independent source identities and pending lifecycle',async()=>{
 const sources=new Map([['physical-land',{}],['physical-water',{}]]),records=new Map(),writes=[];
 const map={getSource:id=>sources.get(id)};
 const datedSources={active:kind=>kind,get:id=>records.get(id),set:(id,row)=>records.set(id,row),
  activate(){},reuse:()=>null,reserve:()=>{throw new Error('unexpected reserve');}};
 const stats={physicalLandAssetHits:0,retainedSourceHits:0};
 const base=createMapLibrePhysicalBase({getMap:()=>map,getGeneration:()=>1,isDisposed:()=>false,
  isContextReady:()=>true,isTemporalPending:()=>false,physicalResources:{
   physicalLand:{revision:'land',waterRevision:'water',geometry:{type:'Polygon',coordinates:[]},
    water:{type:'Polygon',coordinates:[]},displayPrepared:true},physicalContextState:{ready:true}},
  datedSources,sourceWrites:{hasNativeWrite:()=>false},setData:async id=>{writes.push(id);return true;},preparePhysicalDisplay:()=>{throw Error('already prepared');},
  orderSceneLayers(){},dirty(){},invalidate(){},failMapPreparation:cause=>{throw cause;},getStats:()=>stats});
 assert.equal(base.syncPhysicalContext(),true);
 assert.equal(base.isPending('physical-land'),true);
 for(let i=0;i<8;i++)await Promise.resolve();
 assert.deepEqual(writes.sort(),['physical-land','physical-water']);
 assert.equal(base.isPending('physical-land'),false);
 assert.equal(base.syncPhysicalContext(),true);
 assert.equal(writes.length,2);
 base.resetContext();
 assert.equal(base.revision,'land|water');
 base.resetProject();
 assert.equal(base.revision,null);
 base.dispose();
});

test('rapid land and water reversal retires obsolete work without failing the returned date',async()=>{
 const A={revision:'A',waterRevision:'water-A',geometry:{type:'Polygon',coordinates:[]},water:{type:'Polygon',coordinates:[]},displayPrepared:true};
 const B={...A,revision:'B',waterRevision:'water-B',displayPrepared:false};
 const active=new Map([['physical-land','physical-land'],['physical-water','physical-water']]);
 const sources=new Map([...active.values(),'physical-land-retained','physical-water-retained'].map(id=>[id,{}]));
 const records=new Map(),writes=[],errors=[],stats={physicalLandAssetHits:0,retainedSourceHits:0};
 const native=new Set(),map={getSource:id=>sources.get(id)};
 const slots={active:kind=>active.get(kind),get:id=>records.get(id),set:(id,row)=>records.set(id,row),
  reuse:(kind,key)=>[...records].find(([id,row])=>row.kind===kind&&row.key===key&&!native.has(row.source)),
  reserve:kind=>kind+'-retained',activate:(kind,id)=>active.set(kind,id)};
 let context=A,failB,landSignal,finishWaterB;
 const base=createMapLibrePhysicalBase({getMap:()=>map,getGeneration:()=>1,isDisposed:()=>false,isContextReady:()=>true,isTemporalPending:()=>true,
  physicalResources:{get physicalLand(){return context;},physicalContextState:{ready:true}},datedSources:slots,
  sourceWrites:{hasNativeWrite:source=>native.has(source)},setData:(id,data,current)=>{
   writes.push(id);
   if(id==='physical-water-retained'){const source=map.getSource(id);native.add(source);return new Promise(resolve=>{finishWaterB=()=>{native.delete(source);resolve(current());};});}
   return Promise.resolve(true);
  },preparePhysicalDisplay:(_key,_geometry,signal)=>{landSignal=signal;return new Promise((_resolve,reject)=>{failB=reject;});},
  orderSceneLayers(){},dirty(){},invalidate(){},failMapPreparation:error=>errors.push(error),getStats:()=>stats});
 const flush=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
 try{
  base.syncPhysicalContext();await flush();
  context=B;base.syncPhysicalContext();await flush();
  assert.equal(base.isPending('physical-land'),true);assert.equal(base.isPending('physical-water'),true);
  context=A;base.syncPhysicalContext();await flush();
  assert.equal(landSignal.aborted,true);
  assert.equal(base.isPending('physical-land'),false);assert.equal(base.isPending('physical-water'),false);
  failB(Error('obsolete B'));finishWaterB();await flush();
  assert.equal(errors.length,0);assert.equal(active.get('physical-land'),'physical-land');assert.equal(active.get('physical-water'),'physical-water');
  assert.equal(writes.length,3,'Returning to acknowledged A requires no native rewrite');
  // Also cover the gap between accepting a new Core cursor and the next
  // render-domain synchronization. B may fail before sync observes A.
  context=B;base.syncPhysicalContext();await flush();
  context=A;failB(Error('obsolete B before sync'));finishWaterB();await flush();
  assert.equal(errors.length,0);
  assert.equal(base.isPending('physical-land'),false);assert.equal(base.isPending('physical-water'),false);
  base.syncPhysicalContext();await flush();
  assert.equal(writes.length,4,'Late failure must not invalidate acknowledged A');
 }finally{base.dispose();}
});

test('hydro visibility and edited-source state belong to the hydro display',()=>{
 const sources=new Map(),layers=new Map();
 const map={style:{},getSource:id=>sources.get(id),addSource:(id,value)=>sources.set(id,value),
  addLayer:row=>layers.set(row.id,row),getLayer:id=>layers.get(id),
  getFilter:()=>null,setFilter(){},getLayoutProperty:()=>undefined,setLayoutProperty(){}};
 const stats={hydroVisibilityScans:0};
 const hydro=createMapLibreHydroDisplay({state:{layerVisibility:{rivers:true,lakes:true},hydroEdits:[],
  hydroFeatureCatalogRevision:1,itemVisibility:{hydro:{}},physicalSettings:{hydroLayers:{}}},
  physicalResources:{hydroDetailEnabled:()=>false,hydroActivityView:()=>null},
  physicalServices:{isHydroFeatureVisible:()=>true},physicalConfig:{DATA_REVISION:'fixture'},
  preferences:{mapPalette:()=>({ocean:'#ffffff'})},platform:{runtimeAssetUrl:row=>row},
  feedback:{reportOperationError(){}},getMap:()=>map,getProjection:()=>({}),getPresentation:()=>({}),
  initialize:async()=>true,styleReady:()=>true,isDisposed:()=>false,isZoomFramePending:()=>false,
  getBasemapRecovery:()=>null,getSelectionSnapshot:()=>null,setSelection(){},
  setData:()=>{},strokeDomain(){},metrics:{track:(_name,callback)=>callback()},
  getStats:()=>stats,invalidate(){}});
 hydro.syncHydroState();
 assert.equal(stats.hydroVisibilityScans,1);
 assert.equal(sources.has('hydro-edits'),true);
 assert.equal(layers.has('hydro-edits-line'),true);
 hydro.syncHydroState();
 assert.equal(stats.hydroVisibilityScans,1);
 hydro.resetStyle();
 hydro.syncHydroState();
 assert.equal(stats.hydroVisibilityScans,2);
 hydro.dispose();
});

test('polar display owns its packet and overlay lifecycle without changing canonical lines',async()=>{
 let updates=0,overlayRows=[],warmRows=[],warmSignal,finishWarm,finishStatic,changed;
 const layer={id:'polar',pending:false,ensure(){},update(token){updates++;finishStatic=()=>{layer.pending=false;changed(token);};layer.pending=true;},setOverlayLines:rows=>{overlayRows=rows;},
  prewarmMeshes:(rows,signal)=>{warmRows=rows;warmSignal=signal;return new Promise(resolve=>{finishWarm=resolve;});},
  cancelStatic(){layer.pending=false;},resetContext(){layer.cancelStatic();},retry(){layer.cancelStatic();},stats:()=>({updates}),dispose(){}};
 const map={getLayer:id=>id==='polar'?{}:null,getLayersOrder:()=>['polar'],moveLayer(){},getZoom:()=>6};
 const river={type:'LineString',coordinates:[[0,86],[1,86.5]]};
 const hydro={features:[{id:'river',geometry:river,
  properties:{category:'river',stage:'base',logicalId:'river',featureId:'fragment',layerId:'rivers'}}],
  visibilityKey:'visible',editsKey:'edits',stageZooms:new Map([['base',4]])};
 const countryDisplay={key:'',rows:new Map(),borders:new Map()};
 const polar=createMapLibrePolarDisplay({createLayer:options=>{changed=options.onChange;return layer;},getMap:()=>map,isStyleReady:()=>true,
  prepareRenderGeometry:async()=>({packets:[{packet:{}}]}),getGeneration:()=>1,
  dirty(){},invalidate(){},failMapPreparation:cause=>{throw cause;},
  getMapStyle:()=>({paint:{'physical-land-fill':{'fill-color':'#eee'},ocean:{'background-color':'#fff'}}}),
  physicalResources:{physicalLand:{revision:'land',geometry:{type:'Polygon',coordinates:[]},water:null},
   physicalContextState:{ready:true}},countryDisplay,
  state:{backgroundSettings:{graticule:false},resourceCapabilities:{graticule:false},layerVisibility:{rivers:true},hydroEdits:[]},
  isColorsEnabled:()=>false,isInitialMapLoading:()=>false,getPalette:()=>({ocean:'#fff',strokes:{river:{width:1}}}),
  hydro,getSceneKey:()=>'',getSceneVectors:()=>[],getPickBounds:()=>[-180,85,180,90],
  resolveObjectKey:()=>null,isHydroFeatureVisible:()=>true,rgba:(_color,alpha)=>[1,1,1,alpha]});
 polar.syncPolar();polar.syncPolarLines();
 assert.equal(updates,1);assert.equal(polar.pending,true);
 finishStatic();assert.equal(polar.pending,false);
 assert.equal(overlayRows.length,1);
 assert.equal(overlayRows[0].geometry,river);
 assert.equal(polar.visibleLines,overlayRows);
 const country={geometry:{type:'Polygon',coordinates:[[[0,85],[2,85],[2,86],[0,85]]]},properties:{color:'#fff',displayAlpha:1}};
 const key=['new-country'],controller=new AbortController();
 polar.prewarmCountryMeshes([country],key,controller.signal);
 assert.equal(warmRows.length,1);
 assert.equal(updates,1,'warming must not publish the upcoming country');
 countryDisplay.key=key;countryDisplay.rows=new Map([['country',country]]);
 assert.equal(polar.pending,true,'Native country acknowledgement alone cannot admit stale polar pixels');
 polar.syncPolar();assert.equal(updates,2,'Static preparation joins rather than waits for the speculative job');
 assert.equal(polar.pending,true);
 finishWarm();for(let i=0;i<5;i++)await Promise.resolve();
 assert.equal(polar.pending,true,'CPU warming does not publish the GPU batch');
 finishStatic();assert.equal(polar.pending,false);
 const obsolete=new AbortController();polar.prewarmCountryMeshes([country],['obsolete'],obsolete.signal);
 const obsoleteSignal=warmSignal;polar.cancelCountryPrewarm();assert.equal(obsoleteSignal.aborted,true);
 finishWarm();await Promise.resolve();
 polar.resetContext();assert.equal(polar.pending,true);polar.dispose();
 assert.equal(polar.visibleLines.length,0);
});

test('polar meshes share in-flight work and cancel only when the last consumer leaves',async()=>{
 const map={getLayer:()=>null,addLayer(){},removeLayer(){},triggerRepaint(){}};
 const requests=[],published=[],errors=[];
 const packet={positions:new Float32Array(),indices:new Uint32Array()};
 const layer=createPolarLayer({map,prepare:(geometry,signal)=>new Promise((resolve,reject)=>{
  const abort=()=>reject(signal.reason);
  signal.addEventListener('abort',abort,{once:true});
  requests.push({geometry,signal,resolve:()=>{signal.removeEventListener('abort',abort);resolve(packet);}});
 }),onChange:key=>published.push(key),onError:error=>errors.push(error)});
 const shape=polarGeometry({type:'Polygon',coordinates:[[[0,85],[2,85],[2,86],[0,85]]]});
 const other=polarGeometry({type:'Polygon',coordinates:[[[3,85],[5,85],[5,86],[3,85]]]});
 const item=geometry=>({geometry,color:[1,1,1,1]});
 const tick=async()=>{for(let i=0;i<32;i++)await Promise.resolve();};
 try{
  const speculative=new AbortController();
  const warm=layer.prewarmMeshes([item(shape)],speculative.signal);
  layer.update('date-a',[item(shape)],[1,1,1,1]);
  const highlight=layer.prepareHighlights([item(shape)]);
  await tick();assert.equal(requests.length,1);
  const aborted=assert.rejects(warm,{name:'AbortError'});speculative.abort();await aborted;
  assert.equal(requests[0].signal.aborted,false,'Static and highlight consumers still own the job');
  requests[0].resolve();await highlight;await tick();
  assert.deepEqual(published,['date-a']);assert.equal(layer.pending,false);
  assert.equal(layer.stats().sharedPreparations,2);
  const obsolete=new AbortController(),orphan=layer.prewarmMeshes([item(other)],obsolete.signal);
  await tick();assert.equal(requests.length,2);
  const rejected=assert.rejects(orphan,{name:'AbortError'});obsolete.abort();await rejected;await tick();
  assert.equal(requests[1].signal.aborted,true);
  const current=new AbortController(),fresh=layer.prewarmMeshes([item(other)],current.signal);
  layer.update('date-b',[item(other)],[1,1,1,1]);layer.update('date-c',[item(other)],[1,1,1,1]);
  await tick();assert.equal(requests.length,3);
  requests[2].resolve();await fresh;await tick();
  assert.deepEqual(published,['date-a','date-c'],'Obsolete static batches must not publish');
  assert.equal(layer.stats().preparations,3);assert.equal(layer.stats().cancelledPreparations,1);
  assert.equal(layer.stats().inFlightMeshes,0);assert.equal(errors.length,0);
 }finally{layer.dispose();}
});

test('scene controller owns style, source readiness and country paint batches',()=>{
 const layers=new Map([['territories',{id:'territories',source:'territories',type:'fill'}],
  ['borders',{id:'borders',source:'territories',type:'line'}],
  ['physical-land-fill',{id:'physical-land-fill',source:'physical-land',type:'fill'}],
  ['physical-water',{id:'physical-water',source:'physical-water',type:'fill'}]]);
 const sources=new Map([['territories',{}],['physical-land',{}],['physical-water',{}]]);
 const painted=[];
 const map={style:{},painter:{},getLayer:id=>layers.get(id),getSource:id=>sources.get(id),
  getLayersOrder:()=>[...layers.keys()],getLayoutProperty:()=>undefined,
  setLayoutProperty(){},getPaintProperty:()=>undefined,setPaintProperty:(id,key)=>painted.push([id,key]),
  getZoom:()=>6,isSourceLoaded:()=>true,triggerRepaint(){},moveLayer(){},
  addLayer:row=>layers.set(row.id,row),removeLayer:id=>layers.delete(id),
  setFeatureState(){},removeFeatureState(){}};
 const scene=createMapLibreSceneController({getMap:()=>map,isLoaded:()=>true,isStyleReady:()=>true,
  isDisposed:()=>false,isTemporalOverlay:()=>false,isInitialMapLoading:()=>false,
  getPolarLayer:()=>null,getHighlight:()=>null,isPhysicalPending:()=>false,
  getPhysicalGeometry:()=>null,getExternalBasemap:()=>null,
  getSelectionSnapshot:()=>null,setSelection(){},invalidatePickingLayers(){},
  preferences:{mapPalette:()=>({})},state:{layerVisibility:{},layerPresentation:{}},
  datedSources:{active:kind=>kind},sourceWrites:{update:async()=>true},
  sourceLayer:id=>id,sourceGroups:{territories:['territories','borders'],
   'physical-land':['physical-land-fill'],'physical-water':['physical-water']},
  dirty(){},invalidate(){},failMapPreparation:cause=>{throw cause;},feedback:{reportOperationError(){}}});
 scene.attachMap();
 scene.setInteractionStyle({antiAlias:false,selection:{primary:{},secondary:{}},hover:{}});
 assert.equal(scene.getStyle().smoothLines,false);
 scene.syncTerritorialFills('territories',[{index:0,blendMode:'normal',ids:['country']}]);
 assert.equal(scene.requiredSourcesReady(),true);
 scene.setSceneDomains(new Map());
 scene.orderSceneLayers();
 scene.removeCountryFillSource('territories');
 assert.equal(scene.requiredVectorPending(),false);
 assert.ok(painted.length>0);
 scene.dispose();
});
