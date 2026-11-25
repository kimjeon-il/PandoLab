import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapLibrePhysicalBase} from '../../../src/rendering/maplibre-physical-base.js';
import {createMapLibreHydroDisplay} from '../../../src/rendering/maplibre-hydro-display.js';
import {createMapLibrePolarDisplay} from '../../../src/rendering/maplibre-polar-display.js';
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
  datedSources,setData:async id=>{writes.push(id);return true;},preparePhysicalDisplay:()=>{throw Error('already prepared');},
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
 let updates=0,overlayRows=[],warmRows=[],finishWarm;
 const layer={id:'polar',pending:false,ensure(){},update(){updates++;},setOverlayLines:rows=>{overlayRows=rows;},
  prewarmMeshes:rows=>{warmRows=rows;return new Promise(resolve=>{finishWarm=resolve;});},
  resetContext(){},retry(){},stats:()=>({updates}),dispose(){}};
 const map={getLayer:id=>id==='polar'?{}:null,getLayersOrder:()=>['polar'],moveLayer(){},getZoom:()=>6};
 const river={type:'LineString',coordinates:[[0,86],[1,86.5]]};
 const hydro={features:[{id:'river',geometry:river,
  properties:{category:'river',stage:'base',logicalId:'river',featureId:'fragment',layerId:'rivers'}}],
  visibilityKey:'visible',editsKey:'edits',stageZooms:new Map([['base',4]])};
 const countryDisplay={key:'',rows:new Map(),borders:new Map()};
 const polar=createMapLibrePolarDisplay({createLayer:()=>layer,getMap:()=>map,isStyleReady:()=>true,
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
 assert.equal(updates,1);
 assert.equal(overlayRows.length,1);
 assert.equal(overlayRows[0].geometry,river);
 assert.equal(polar.visibleLines,overlayRows);
 const country={geometry:{type:'Polygon',coordinates:[[[0,85],[2,85],[2,86],[0,85]]]},properties:{color:'#fff',displayAlpha:1}};
 const key=['new-country'],controller=new AbortController();
 polar.prewarmCountryMeshes([country],key,controller.signal);
 assert.equal(warmRows.length,1);
 assert.equal(updates,1,'warming must not publish the upcoming country');
 countryDisplay.key=key;countryDisplay.rows=new Map([['country',country]]);
 polar.syncPolar();assert.equal(updates,1);assert.equal(polar.pending,true);
 finishWarm();for(let i=0;i<5;i++)await Promise.resolve();
 polar.syncPolar();assert.equal(updates,2);assert.equal(polar.pending,false);
 polar.resetContext();polar.dispose();
 assert.equal(polar.visibleLines.length,0);
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
