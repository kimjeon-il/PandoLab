import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapLibreRenderingDomain} from '../../../src/rendering/maplibre-rendering-domain.js';
import {createMapLibreHighlight,partitionHighlightLines} from '../../../src/rendering/maplibre-highlight.js';

test('long highlights share their split endpoints and preserve every original segment',()=>{
 const long=Array.from({length:18000},(_,index)=>[index/1000,(index%3)/1000]);
 const short=[[0,0],[4,5]];
 const {coordinates}=partitionHighlightLines({type:'MultiLineString',coordinates:[long,short]});
 const pieces=coordinates.slice(0,-1);
 assert.ok(pieces.length>1);
 assert.ok(pieces.every(piece=>piece.length<6000));
 assert.deepEqual(pieces.flatMap((piece,index)=>index?piece.slice(1):piece),long);
 for(let index=1;index<pieces.length;index++)assert.equal(pieces[index][0],pieces[index-1].at(-1));
 assert.equal(coordinates.at(-1),short);
});

test('a highlight retries only the stalled phase and waits for the settled camera',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const flush=async()=>{for(let pass=0;pass<8;pass++)await Promise.resolve();};
 for(const phase of ['source-write','polar-prepare','tile-render']){
  const sources=new Map(),layers=new Map(),errors=[];
  let moving=false,writes=0,preparations=0,removed=0;
  const map={style:{},isMoving:()=>moving,isSourceLoaded:()=>phase!=='tile-render',getSource:id=>sources.get(id),getLayer:id=>layers.get(id),
   addSource:(id,row)=>sources.set(id,row),addLayer:row=>layers.set(row.id,row),removeSource:id=>{removed++;sources.delete(id);},
   removeLayer:id=>layers.delete(id),setPaintProperty(){},setLayoutProperty(){},triggerRepaint(){}};
  const stall=()=>new Promise(()=>{});
  const owner=createMapLibreHighlight({map,write:()=>{writes++;return phase==='source-write'?stall():Promise.resolve(true);},
   preparePolar:()=>{preparations++;return phase==='polar-prepare'?stall():Promise.resolve(()=>true);},
   clearPolar(){},onShown(){},onError:error=>errors.push(error),onRestoreSelection(){}});
  try{
   owner.submit('discarded',[],[],'[]');owner.reset();await flush();
   assert.equal(writes+preparations,0,'A discarded request cannot start new source or polar preparation');
   owner.submit('selection',[{properties:{objectKey:'object-A'}}],[],'selection');await flush();
   if(phase==='tile-render'){
    context.mock.timers.tick(9000);moving=true;owner.onCameraChange();
    context.mock.timers.tick(30000);assert.equal(owner.stats().pending,true);assert.equal(writes,1);
    moving=false;owner.onCameraChange();
   }
   context.mock.timers.tick(10000);context.mock.timers.tick(125);await flush();
   context.mock.timers.tick(10000);
   assert.equal(writes,phase==='polar-prepare'?1:2);
   assert.equal(preparations,phase==='polar-prepare'?2:1);
   assert.equal(removed,phase==='polar-prepare'?0:1);
   assert.equal(owner.stats().pending,false);
   assert.deepEqual(errors.map(error=>[error.phase,error.sourceId,error.objectKeys,error.attempts]),[[phase,'interaction',['object-A'],2]]);
  }finally{owner.dispose();}
 }
});

test('highlight preserves the complete previous frame until native and polar work are both ready', async () => {
 const sources=new Map(),layers=new Map(),shown=[],errors=[],restored=[];
 const map={style:{},isMoving:()=>false,getSource:id=>sources.get(id),getLayer:id=>layers.get(id),
  addSource:(id,source)=>sources.set(id,source),addLayer:layer=>layers.set(layer.id,layer),
  setPaintProperty:(id,key,value)=>{layers.get(id).paint[key]=value;},
  setLayoutProperty:(id,key,value)=>{layers.get(id).layout[key]=value;},
  isSourceLoaded:id=>!!sources.get(id)?.ready,triggerRepaint(){}};
 let deferredNative,deferredPolar,polar=null,block=false,failedWrites=0,writes=0;
 const owner=createMapLibreHighlight({map,
  write:async(id,data)=>{
   writes++;
   if(failedWrites>0){failedWrites--;throw Error('source write failure');}
   if(block)await new Promise(resolve=>{deferredNative=resolve;});
   Object.assign(sources.get(id),{ready:true,data});return true;
  },
  preparePolar:async items=>{
   if(block)await new Promise(resolve=>{deferredPolar=resolve;});
   return ()=>{polar=items[0];return true;};
  },
  clearPolar:()=>{polar=null;},onShown:value=>shown.push(value),onError:error=>errors.push(error.cause.message),
  onRestoreSelection:key=>{restored.push(key);submit(key);}});
 const feature=(key,type)=>({type:'Feature',geometry:{type,coordinates:[]},properties:{objectKey:key}});
 const submit=key=>owner.submit(key,[feature(key,'Polygon'),feature(key,'LineString')],[key],key);
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 const draw=()=>{owner.onRender();owner.onRender();};
 try{
  submit('A');await tick();draw();
  assert.equal(polar,'A');assert.equal(shown.at(-1).key,'A');
  block=true;submit('B');await tick();deferredNative();await tick();draw();
  assert.equal(polar,'A');assert.equal(shown.length,1);
  assert.equal(layers.get('interaction-fill-standby').paint['fill-layer-opacity'],0);
  assert.equal(layers.get('interaction-line-standby').paint['line-layer-opacity'],0);
  deferredPolar();await tick();draw();
  assert.equal(polar,'B');assert.equal(shown.at(-1).key,'B');
  assert.equal(layers.get('interaction-fill-standby').paint['fill-layer-opacity'],1);
  assert.equal(layers.get('interaction-line-standby').paint['line-layer-opacity'],1);
  assert.equal(layers.get('interaction-fill').layout.visibility,'none');
  block=false;failedWrites=1;submit('C');await tick();draw();
  assert.equal(shown.at(-1).key,'B');
  await new Promise(resolve=>setTimeout(resolve,160));draw();
  assert.equal(polar,'C');assert.equal(shown.at(-1).key,'C');
  const beforePolarOnly=writes;
  owner.submit('D',[feature('C','Polygon'),feature('C','LineString')],['D'],'C','C');
  await tick();draw();
  assert.equal(polar,'D');
  assert.equal(shown.at(-1).sourceId,shown.at(-2).sourceId);
  assert.equal(writes,beforePolarOnly,'A polar-only change must not retile unchanged native geometry');
  assert.deepEqual(errors,[],'A recovered attempt must not report a terminal failure');
  failedWrites=2;submit('F');await tick();draw();
  assert.equal(polar,'D','Keep the old complete frame while the new selection can still recover');
  await new Promise(resolve=>setTimeout(resolve,160));draw();
  assert.deepEqual(errors,['source write failure']);
  assert.equal(owner.stats().pending,false);
  assert.equal(owner.stats().sourceId,null);
  assert.equal(polar,null,'Do not leave an obsolete selection highlighted after both attempts failed');
  assert.ok([...layers.values()].every(layer=>layer.layout.visibility==='none'));
  submit('F');await tick();draw();
  assert.equal(shown.at(-1).key,'F','The same selection can be submitted again after failure');
  assert.equal(polar,'F');
  const submitHover=(key,selectionKey='[]')=>owner.submit(key,[feature(key,'Polygon'),feature(key,'LineString')],[key],selectionKey);
  const failBoth=async submitRequest=>{
   failedWrites=2;submitRequest();await new Promise(resolve=>setTimeout(resolve,160));draw();
  };
  submitHover('F+hover-A','F');await tick();draw();
  await failBoth(()=>submitHover('F+hover-B','F'));
  assert.deepEqual(restored,['F'],'Recover the confirmed selection without the stale hover');
  assert.equal(polar,'F');
  assert.equal(shown.at(-1).key,'F');
  const selectionSource=owner.stats().sourceId;
  await failBoth(()=>submitHover('F+hover-B','F'));
  assert.equal(owner.stats().sourceId,selectionSource,'A failed hover must keep an already clean selection');
  assert.deepEqual(restored,['F']);
  submitHover('hover-A');await tick();draw();
  await failBoth(()=>submitHover('hover-B'));
  assert.equal(owner.stats().sourceId,null,'Clear a superseded hover when there is no confirmed selection');
  assert.equal(polar,null);
  assert.deepEqual(restored,['F']);
  owner.reset();
  owner.submit('[]',[],[],'[]','[]');
  assert.equal(owner.selectionPending(),false,'A fresh date with no confirmed selection must not wait for empty highlight tiles');
  await tick();draw();
  block=true;submit('E');
  assert.equal(owner.selectionPending(),true,'An actual confirmed selection still gates the dated frame');
 }finally{owner.dispose();}
});

test('camera frames reuse MapLibre symbols; viewport and quality work are scoped',async()=>{
 const previous={requestAnimationFrame:globalThis.requestAnimationFrame,performance:globalThis.performance,document:globalThis.document};
 const queue=[];let time=0,labelRuns=0,placeQueries=0,contentRuns=0,overlayRuns=0,sceneSubmissions=0,prepared=0;
 globalThis.requestAnimationFrame=callback=>{queue.push(callback);return queue.length;};
 Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>time}});
 globalThis.document={baseURI:'https://fixture.test/',documentElement:{dataset:{}}};
 const sources=new Map(),layers=new Map(),frames=[];
 const map={
  getZoom:()=>4,
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
 let preserved=false,placeTask=null,temporal=false,admitted=true,features=[],failure=null,afterBoundaryFailures=null;
 let boundaryVisible=true,boundaryRequests=0,boundaryGate;
 const renderer={map,loaded:true,isStyleReady:()=>true,isFramePreserved:()=>preserved,labelZoomVisibility:()=>({country:true,places:true}),getRuntimeState:()=>({webglContextLost:false,temporalPresentationPending:temporal,temporalSourceAdmitted:admitted,projectRenderBlocked:!!failure}),
  syncHydroState(){},setSelection(){},
  renderFrame:()=>({succeeded:true,presentationReady:true}),
  canPresentVisualFrame:()=>true,commitVisualFrame:()=>true,verifyLayout(){},
  failMapPreparation(error){if(!features.length)throw error;failure=error;}};
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
  mapRenderer:renderer,labelResources:labels,selectionDomain:{snapshot:()=>({selection:{items:[]}})},
  mapPalette:()=>({defaultLand:'#ffffff'}),syncMapScene(){sceneSubmissions++;},
  territorialResources:{getState:()=>state,displayEntities:()=>features,visibleMapObjectCandidates:()=>[],
   isLayerItemVisible:()=>true,entityRepository:{},replaceSceneDomain(){}},
  genericResources:{getState:()=>state,visibleMapObjectCandidates:()=>[],replaceSceneDomain(){overlayRuns++;}},
  distributionResources:{getState:()=>state,visibleMapObjectCandidates:()=>[],replaceSceneDomain(){}},
  territorialBoundaryResources:{getState:()=>state,geometryToken:()=> 'region-v1',
   layerStyle:()=>({boundaryVisible,blendMode:'normal'}),replaceSceneDomain(){}},
  baseResources:{getState:()=>({resourceCapabilities:{graticule:false}}),
   replaceSceneDomain(){contentRuns++;}},
  renderers:{labelLayout(){labelRuns++;return layout;}},
  prepareView(options){frames.push(options);prepared++;return {frameId:options.frameId,size:{width:800,height:500}};},
  prepareMapDisplay:async(_inputs,{signal})=>{
   boundaryRequests++;
   if(boundaryGate)return boundaryGate(signal);
   throw Error('boundary worker failed');
  },
  reportDiagnostic(error){if(!afterBoundaryFailures)throw error;afterBoundaryFailures();},
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
  const baselineQueries=placeQueries,baselineFrames=prepared;
  for(let i=0;i<25;i++){time+=16;domain.invalidateView('maplibre-camera');await flush();}
  assert.equal(labelRuns,1,'Native camera movement cannot rebuild unchanged labels');
  assert.equal(contentRuns,1,'Native camera movement cannot rebuild the geographic scene');
  assert.equal(prepared,baselineFrames,'Unchanged camera display bands do not schedule application frames');
  for(const event of ['maplibre-presented','vector-ready','physical-source-ready','polar-ready','hydro-ready','country-paint']){
   domain.invalidateView(event);await flush();
  }
  domain.invalidateSelection('selection-hover');await flush();
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
  const publications=domain.getStats().visualFrameCommittedCount;
  let completePlaces;
  placeTask=new Promise(resolve=>{completePlaces=resolve;});preserved=true;
  domain.endInteraction('rapid-jump-target');await flush();
  assert.equal(domain.getStats().visualFrameCommittedCount,publications,'Target tiles alone cannot release a preserved frame');
  completePlaces(true);await flush();
  assert.equal(domain.getStats().visualFrameCommittedCount,publications+1);
  features=[{id:'region',properties:{entityKind:'regional'},geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[0,1],[0,0]]]}}];
  temporal=true;
  const beforeHidden=domain.getStats().visualFrameCommittedCount;
  domain.invalidateProject('date-with-hidden-objects');await flush();
  assert.equal(boundaryRequests,0,'Hidden objects must not start topology work for the dated frame');
  assert.ok(domain.getStats().visualFrameCommittedCount>beforeHidden);
  state.layerVisibility.objects=true;
  boundaryVisible=false;
  domain.invalidateProject('date-with-hidden-outlines');await flush();
  assert.equal(boundaryRequests,0,'Disabled outlines must not start topology work for the dated frame');
  assert.equal(failure,null);
  let visibleRequest;
  boundaryGate=signal=>{visibleRequest=signal;return new Promise(()=>{});};
  boundaryVisible=true;
  const beforeVisible=domain.getStats().visualFrameCommittedCount;
  domain.invalidateProject('date-with-visible-outlines');await flush();
  assert.equal(boundaryRequests,1);
  assert.equal(domain.getStats().visualFrameCommittedCount,beforeVisible,'Dates must still wait for required outlines');
  state.layerVisibility.objects=false;
  domain.invalidateProject('hide-objects-during-date');await flush();
  assert.equal(visibleRequest.aborted,true);
  assert.ok(domain.getStats().visualFrameCommittedCount>beforeVisible);
  boundaryGate=null;
  state.layerVisibility.objects=true;
  temporal=false;
  preserved=false;
  const terminal=new Promise(resolve=>{let failures=0;afterBoundaryFailures=()=>{if(++failures===2)resolve();};});
  domain.invalidateProject('boundary-fault');
  await flush();await terminal;await flush();
  const beforeZoom=domain.getStats().visualFrameCommittedCount;
  preserved=true;
  domain.invalidateView('maplibre-camera');await flush();
  assert.ok(domain.getStats().visualFrameCommittedCount>beforeZoom,'A prior background failure must not lock a preserved zoom');
  assert.equal(failure,null);
  temporal=true;
  admitted=false;
  domain.invalidateProject('date-restore-before-admission');await flush();
  assert.equal(failure,null,'The failed date must not reject a recovery whose sources are not yet admitted');
  admitted=true;
  domain.invalidateProject('date-with-unchanged-boundaries');await flush();
  assert.equal(failure?.message,'boundary worker failed','The same failed boundary input must reject a later dated transition');
 }finally{
  domain.dispose();globalThis.requestAnimationFrame=previous.requestAnimationFrame;
  Object.defineProperty(globalThis,'performance',{configurable:true,value:previous.performance});
  globalThis.document=previous.document;
 }
});
