import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapLibreRenderingDomain} from '../../../src/rendering/maplibre-rendering-domain.js';

test('camera frames reuse MapLibre symbols; viewport and quality work are scoped',async()=>{
 const previous={requestAnimationFrame:globalThis.requestAnimationFrame,performance:globalThis.performance,document:globalThis.document};
 const queue=[];let time=0,labelRuns=0,placeQueries=0,contentRuns=0,overlayRuns=0,sceneSubmissions=0,prepared=0;
 globalThis.requestAnimationFrame=callback=>{queue.push(callback);return queue.length;};
 Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>time}});
 globalThis.document={baseURI:'https://fixture.test/',documentElement:{dataset:{}}};
 const sources=new Map(),layers=new Map(),frames=[];
 const map={
  getStyle:()=>({'font-faces':{}}),setFontFaces(){},
  getSource:id=>sources.get(id)||null,
  addSource(id){sources.set(id,{on(){},off(){},async setData(){},async updateData(){}});},
  removeSource:id=>sources.delete(id),
  getLayer:id=>layers.get(id)||null,
  addLayer:layer=>layers.set(layer.id,layer),removeLayer:id=>layers.delete(id),
  setPaintProperty(){},setFeatureState(){},removeFeatureState(){},
  hasImage:()=>false,removeImage(){},
 };
 const state={layerVisibility:{objects:false,genericFeatures:false,distributions:false,labels:true},
  distributionLayers:[],distributionEntries:[],territorialEntities:[],
  distributionSettings:{},countryVisualPhase:'canonical'};
 let preserved=false,placeTask=null;
 const renderer={map,loaded:true,isStyleReady:()=>true,isFramePreserved:()=>preserved,labelZoomVisibility:()=>({country:true,places:true}),getRuntimeState:()=>({webglContextLost:false}),
  syncHydroState(){},setSelection(){},
  renderFrame:()=>({succeeded:true,presentationReady:true}),
  canPresentVisualFrame:()=>true,commitVisualFrame:()=>true,verifyLayout(){},
  failMapPreparation(error){throw error;}};
 const labels={
  getState:()=>state,preparePlaces(){placeQueries++;return placeTask||Promise.resolve(true);},
  beginPlaceInteraction(){},disposePlaces(){},
  mapPalette:()=>({labels:{text:'#111111',halo:'#ffffff',selection:'#ffcc00',point:'#666666',marker:'filled'}}),
  normalizeObjectRef:()=>null,automaticLabelSettings:()=>({}),labelSettings:()=>({}),
  countryLabelAnchors:()=>new Map(),selectionHas:()=>false,
 };
 const layout={pending:false,territorialLabels:[],userLabels:[],
  territorialFlags:new Map(),territorialLabelNames:new Map(),territorialLabelRows:new Map(),
  territorialLabelPriorities:new Map(),userLabelRows:new Map(),userLabelPriorities:new Map()};
 const domain=createMapLibreRenderingDomain({
  gpuMapRenderer:renderer,labelResources:labels,selectionDomain:{snapshot:()=>({selection:{items:[]}})},
  countryResources:{getState:()=>state,mapPalette:()=>({defaultLand:'#ffffff'}),replaceGpuSceneDomain(){},
   syncGpuRenderScene(){sceneSubmissions++;}},
  territorialResources:{getState:()=>state,displayEntities:()=>[],visibleMapObjectCandidates:()=>[],
   entityRepository:{},replaceGpuSceneDomain(){}},
  genericResources:{getState:()=>state,visibleMapObjectCandidates:()=>[],replaceGpuSceneDomain(){overlayRuns++;}},
  distributionResources:{getState:()=>state,visibleMapObjectCandidates:()=>[],replaceGpuSceneDomain(){}},
  territorialBoundaryResources:{getState:()=>state,replaceGpuSceneDomain(){}},
  baseResources:{getState:()=>({resourceCapabilities:{graticule:false}}),
   replaceGpuSceneDomain(){contentRuns++;}},
  renderers:{labelLayout(){labelRuns++;return layout;}},
  prepareView(options){frames.push(options);prepared++;return {frameId:options.frameId,size:{width:800,height:500}};},
  reportDiagnostic(error){throw error;},
 });
 const flush=async()=>{
  for(let i=0;i<12;i++){
   while(queue.length)queue.shift()();
   await new Promise(resolve=>setImmediate(resolve));
   if(queue.length===0)break;
  }
  assert.equal(queue.length,0,'A settled label source must not cause a render loop');
 };
 try{
  domain.invalidateProject('initial');
  await flush();
  assert.equal(labelRuns,1);assert.equal(contentRuns,1);
  assert.equal(frames[0].withBounds,true);
  const baselineQueries=placeQueries;
  for(let i=0;i<25;i++){time+=16;domain.invalidateView('maplibre-camera');await flush();}
  assert.equal(labelRuns,1,'Native camera movement cannot rebuild unchanged labels');
  assert.equal(contentRuns,1,'Native camera movement cannot rebuild the geographic scene');
  for(const event of ['maplibre-presented','vector-ready','physical-source-ready','polar-ready','hydro-ready']){
   domain.invalidateView(event);await flush();
  }
  assert.equal(labelRuns,1,'Native source completion must not recompile the unchanged symbol source');
  assert.equal(contentRuns,1,'Native source completion must not rebuild unrelated geometry');
  assert.ok(frames.slice(1).every(frame=>frame.withBounds===false),'Camera frames must not query geographic bounds');
  assert.ok(placeQueries-baselineQueries>=3&&placeQueries-baselineQueries<=4,'Viewport worker queries are throttled during movement');
  domain.endInteraction('map-move-settled');await flush();
  assert.equal(labelRuns,2,'Settled camera may change the candidate budget and zoom policy');
  assert.equal(overlayRuns,2,'Settled camera still re-evaluates spatial overlays');
  assert.equal(sceneSubmissions,2,'Settled camera submits the updated spatial overlays');
  assert.equal(contentRuns,1,'Settled camera must reuse the geographic base');
  assert.equal(frames.at(-1).withBounds,true);
  domain.invalidateQuality('quality-tier-change');await flush();
  assert.equal(labelRuns,3,'Quality tier changes update label candidates');
  assert.equal(contentRuns,1,'Quality tier changes do not rebuild unrelated geometry');
  domain.invalidateLabels('new-viewport-records');await flush();
  assert.equal(labelRuns,4,'Worker-accepted place data must refresh symbol source');
  assert.ok(prepared>=29);
  const publications=domain.getStats().visualFrameCommittedCount;
  let completePlaces;
  placeTask=new Promise(resolve=>{completePlaces=resolve;});preserved=true;
  domain.endInteraction('rapid-jump-target');await flush();
  assert.equal(domain.getStats().visualFrameCommittedCount,publications,'Target tiles alone cannot release a preserved frame');
  completePlaces(true);await flush();
  assert.equal(domain.getStats().visualFrameCommittedCount,publications+1);
 }finally{
  domain.dispose();globalThis.requestAnimationFrame=previous.requestAnimationFrame;
  Object.defineProperty(globalThis,'performance',{configurable:true,value:previous.performance});
  globalThis.document=previous.document;
 }
});
