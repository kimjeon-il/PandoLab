import {countryPaintOnly,countryTileDiff,countryDeltaPreferred} from '../../../src/rendering/maplibre-country-presentation.js';
import {createMapLibreCountryController} from '../../../src/rendering/maplibre-country-controller.js';
import {createGeometryByteEstimator} from '../../../src/rendering/geometry-residency.js';
import {createMapLibreCountryDisplay} from '../../../src/rendering/maplibre-country-display.js';
import {packHydroFeatures,unpackHydroFeatures,encodeStrokeGeometry,decodeStrokeGeometry,geometryTransferBuffers} from '../../../src/rendering/geometry-transfer-codec.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapLibreRenderingDomain} from '../../../src/rendering/maplibre-rendering-domain.js';
import {createMapLibreHighlight,partitionHighlightLines} from '../../../src/rendering/maplibre-highlight.js';
import {createMapLibreSourceWrites,createMapLibreDatedSources} from '../../../src/rendering/maplibre-source-lifecycle.js';

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
  submitHover('hover-C');await tick();draw();
  const beforeClear=writes;
  owner.submit('[]',[],[],'[]','[]');
  assert.equal(owner.selectionPending(),false,'A fresh date with no confirmed selection must not wait for empty highlight tiles');
  await tick();draw();
  assert.equal(writes,beforeClear,'Clearing hover hides the current highlight without writing empty tiles');
  assert.equal(owner.stats().sourceId,null);
  assert.equal(polar,null);
  block=true;submit('E');
  assert.equal(owner.selectionPending(),true,'An actual confirmed selection still gates the dated frame');
 }finally{owner.dispose();}
});

test('camera frames reuse MapLibre symbols; viewport and quality work are scoped',async()=>{
 const previous={requestAnimationFrame:globalThis.requestAnimationFrame,document:globalThis.document};
 const queue=[];let labelRuns=0,placeQueries=0,contentRuns=0,overlayRuns=0,sceneSubmissions=0,prepared=0;
 globalThis.requestAnimationFrame=callback=>{queue.push(callback);return queue.length;};
 globalThis.document={baseURI:'https://fixture.test/',documentElement:{dataset:{}}};
 const sources=new Map(),layers=new Map(),frames=[];
 let moving=false,zoom=4;
 const map={
  getZoom:()=>zoom,isMoving:()=>moving,
  getFontFaces:()=>({}),setFontFaces(){},
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
 let boundaryVisible=true,boundaryRequests=0,boundaryGate,physicalRuns=0;
 const renderer={map,loaded:true,isStyleReady:()=>true,isFramePreserved:()=>preserved,labelZoomVisibility:()=>({country:true,places:true}),getRuntimeState:()=>({webglContextLost:false,temporalPresentationPending:temporal,temporalSourceAdmitted:admitted,projectRenderBlocked:!!failure}),
  syncHydroState(){},syncPhysicalContext(){physicalRuns++;},setSelection(){},
  renderFrame:(_frame,{physicalPrepared}={})=>{assert.equal(physicalPrepared,!failure);return {succeeded:true,presentationReady:true};},
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
   isLayerItemVisible:()=>true,entityRepository:{get:()=>null},replaceSceneDomain(){}},
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
  moving=true;
  domain.beginInteraction();
  zoom=3.2;
  for(let i=0;i<25;i++){domain.invalidateView('maplibre-camera');await flush();}
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
  assert.equal(placeQueries,baselineQueries,'Ordinary motion keeps the current place snapshot');
  domain.invalidateLabels('motion-time-worker-result');await flush();
  assert.equal(labelRuns,1,'A viewport result cannot replace the symbols mid-gesture');
  moving=false;
  domain.endInteraction('map-move-settled');await flush();
  assert.equal(placeQueries,baselineQueries+1,'Only the settled viewport is queried');
  assert.equal(labelRuns,2,'Settled camera may change the candidate budget and zoom policy');
  assert.equal(overlayRuns,1,'Settled camera leaves project overlays installed');
  assert.equal(sceneSubmissions,1,'Settled camera must not resubmit the project scene');
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
  assert.ok(physicalRuns>0,'Physical sources start independently of required outlines');
  state.layerVisibility.objects=false;
  domain.invalidateProject('hide-objects-during-date');await flush();
  assert.equal(visibleRequest.aborted,true);
  assert.ok(domain.getStats().visualFrameCommittedCount>beforeVisible);
  let resolveBoundary;
  boundaryGate=()=>new Promise(resolve=>{resolveBoundary=resolve;});
  state.layerVisibility.objects=true;
  domain.invalidateProject('date-with-ready-outlines');await flush();
  const beforeBoundaryReady=[contentRuns,overlayRuns,labelRuns,placeQueries,sceneSubmissions];
  resolveBoundary({result:{segments:[]}});await flush();
  assert.deepEqual([contentRuns,overlayRuns,labelRuns,placeQueries],beforeBoundaryReady.slice(0,4),'Boundary completion must not rebuild independent scene or symbols');
  assert.equal(sceneSubmissions,beforeBoundaryReady[4]+1);
  // Change geometry identity so the following failure is a new boundary input.
  features=[{...features[0],id:'region-new'}];
  boundaryGate=null;
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
  globalThis.document=previous.document;
 }
});

test('native source writes serialize and reject queued work from an obsolete generation',async()=>{
 let generation=1,release,started,dirty=0;
 const ready=new Promise(resolve=>{started=resolve;});
 const source={on(){},off(){}},map={getSource:()=>source,triggerRepaint(){}};
 const writes=createMapLibreSourceWrites({getMap:()=>map,getGeneration:()=>generation,getContextRevision:()=>0,
  isDisposed:()=>false,requiredSource:()=>true,dirty:()=>{dirty++;},track:(_name,run)=>run(),onError:error=>{throw error;}});
 const first=writes.update(()=>new Promise(resolve=>{release=resolve;started();}),'territories');
 const obsolete=writes.update(()=>{throw Error('obsolete source write ran');},'territories');
 await ready;assert.equal(writes.pendingCount(),2);
 generation++;assert.equal(writes.pendingCount(),0);release();
 assert.equal(await first,true);assert.equal(await obsolete,false);
 assert.equal(dirty,2);
 assert.equal(await writes.update(()=>{},'territories'),true);
 assert.equal(writes.pendingCount(),0);
});

test('prepared stroke packets survive transferable binary round-trip',()=>{
 const geometry={type:'MultiLineString',coordinates:[[[0,1],[2,3]],[],[[4,5],[6,7],[8,9]]]};
 const packed=encodeStrokeGeometry(geometry);
 const received=structuredClone(packed,{transfer:geometryTransferBuffers(packed)});
 assert.equal(packed.coordinates.byteLength,0);
 assert.equal(packed.offsets.byteLength,0);
 assert.deepEqual(decodeStrokeGeometry(received),geometry);
 assert.throws(()=>decodeStrokeGeometry({coordinates:new Float64Array(2),offsets:new Uint32Array([0,2])}),TypeError);
});

test('hydro worker transfers river and multipart lake geometry without coordinate cloning',()=>{
 const features=[
  {type:'Feature',id:'river',properties:{category:'river',stroke_widths:[[1.234,2.345]]},geometry:{type:'LineString',coordinates:[[0,1],[2,3]]}},
  {type:'Feature',id:'lake',properties:{category:'lake'},geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[0,0]],[[2,2],[3,2],[2,2]]]}},
  {type:'Feature',id:'islands',properties:{category:'lake'},geometry:{type:'MultiPolygon',coordinates:[[[[0,0],[1,1],[0,0]]],[[[2,2],[3,3],[2,2]],[[4,4],[5,5],[4,4]]]]}},
 ];
 const packed=packHydroFeatures(features);
 const received=structuredClone(packed,{transfer:geometryTransferBuffers(packed)});
 assert.equal(packed.coordinates.byteLength,0);
 assert.equal(packed.widths.byteLength,0);
 assert.equal(packed.widthOffsets.byteLength,0);
 assert.equal(Object.hasOwn(received.metadata[0].properties,'stroke_widths'),false);
 assert.deepEqual(unpackHydroFeatures(received),features);
});

test('country display owns its published rows, tiles and border caches',()=>{
 const display=createMapLibreCountryDisplay();
 const row={id:'territorial:A',geometry:{type:'Polygon',coordinates:[]},properties:{color:'#ffffff',paintOrder:0}};
 const record={rows:new Map([[row.id,row]]),tiles:new Map([[row.id,row]]),borders:new Map([['border',{paths:{native:{type:'MultiLineString',coordinates:[]}}}]])};
 display.publish(record,'revision');
 assert.equal(display.rows.get(row.id),row);
 assert.equal(display.borders.size,1);
 display.clearTiles();
 assert.equal(display.tiles.size,0);
 assert.equal(display.borders.size,1);
 display.clearSource();
 assert.equal(display.borders.size,0);
 assert.equal(display.key,'');
});

test('country paint-only detection and tile delta preserve unchanged geometry',()=>{
 const geometry={type:'Polygon',coordinates:[]};
 const previous={id:'territorial:A',geometry,properties:{color:'#000000',paintOrder:0}};
 const recolored={id:previous.id,geometry,properties:{...previous.properties,color:'#ffffff'}};
 assert.equal(countryPaintOnly({rows:new Map([[previous.id,previous]])},[recolored]),true);
 const changed={...recolored,properties:{...recolored.properties,paintOrder:1}};
 assert.equal(countryPaintOnly({rows:new Map([[previous.id,previous]])},[changed]),false);
 const delta=countryTileDiff(new Map([[previous.id,previous]]),[recolored]);
 assert.deepEqual(delta.remove,[]);
 assert.deepEqual(delta.add,[]);
 assert.deepEqual(delta.update,[{id:previous.id,addOrUpdateProperties:[{key:'color',value:'#ffffff'}]}]);
 const removed=countryTileDiff(new Map([[previous.id,previous]]),[]);
 assert.deepEqual(removed.remove,[previous.id]);
 const copied={...previous,geometry:structuredClone(geometry)};
 assert.deepEqual(countryTileDiff(new Map([[previous.id,previous]]),[copied]).update,[]);
 assert.equal(countryDeltaPreferred(removed,createGeometryByteEstimator()),false);
});

test('country source replacement preserves mandatory layers and resets owned state',()=>{
 const display=createMapLibreCountryDisplay();
 const sources=new Map([['territories',{}]]),layers=new Map([
  ['territories',{id:'territories',source:'territories',type:'fill'}],
  ['borders',{id:'borders',source:'territories',type:'line'}],
 ]);
 let active='territories',invalidated=0;
 const map={
  getStyle:()=>({layers:[...layers.values()]}),
  getLayer:id=>layers.get(id),
  getSource:id=>sources.get(id),
  addSource:(id,source)=>sources.set(id,source),
  removeSource:id=>sources.delete(id),
  addLayer:layer=>layers.set(layer.id,layer),
  removeLayer:id=>layers.delete(id),
 };
 const datedSources={active:()=>active,replaceActive:(_,id)=>{active=id;}};
 display.publish({rows:new Map(),tiles:new Map(),borders:new Map([['cached',{}]])},'before');
 display.markSourceStale();
 display.replaceObsoleteCountrySource({map,datedSources,sourceLayer:(id,source)=>id,sourceLayers:['territories','borders'],
  countryTileSource:()=>({type:'geojson'}),onCountrySourceRemoved:()=>{},
  onStyleInvalidated:()=>{invalidated++;},dirty:()=>{}});
 assert.equal(active,'territories-generation-1');
 assert.equal(layers.get('territories').source,active);
 assert.equal(layers.get('borders').source,active);
 assert.equal(sources.has('territories'),false);
 assert.equal(display.needsSwap,false);
 assert.equal(display.borders.size,0);
 assert.equal(invalidated,1);
});

test('shared binary geometry rejects malformed offsets and inconsistent width profiles',()=>{
 assert.throws(()=>decodeStrokeGeometry({offsets:Uint32Array.of(1,1),coordinates:Float64Array.of(1,2)}),TypeError);
 assert.throws(()=>decodeStrokeGeometry({offsets:Uint32Array.of(0,2,1),coordinates:Float64Array.of(1,2)}),TypeError);
 const river={type:'Feature',id:'r',properties:{stroke_widths:[[.25,1.125],[]]},geometry:{type:'MultiLineString',coordinates:[[[0,0],[1,1]],[]]}};
 const packed=packHydroFeatures([river]);
 assert.deepEqual(unpackHydroFeatures(packed),[river]);
 assert.throws(()=>packHydroFeatures([{...river,properties:{stroke_widths:[[1],[]]}}]),/does not match/);
 assert.throws(()=>unpackHydroFeatures({...packed,widthOffsets:Uint32Array.of(0,1,2)}),/width sample count/);
 assert.throws(()=>unpackHydroFeatures({...packed,metadata:[]}),/Unused geometry packet parts/);
 assert.deepEqual(unpackHydroFeatures(packHydroFeatures([])),[]);
});

test('dated country standby is initialized without tiles and only the published slot is visible',async()=>{
 const active='territories',standby='territories-retained';
 const sources=new Map([[active,{}]]),layers=new Map([
  ['territories',{id:'territories',type:'fill',source:active}],
  ['borders',{id:'borders',type:'line',source:active}]
 ]);
 let created=0,temporal=false;
 const map={
  getSource:id=>sources.get(id),getLayer:id=>layers.get(id),
  getStyle:()=>({layers:[...layers.values()]}),
  addSource(id,spec){created++;sources.set(id,spec);},
  removeSource:id=>sources.delete(id),
  addLayer:layer=>layers.set(layer.id,layer),removeLayer:id=>layers.delete(id),
  setLayoutProperty(id,name,value){const layer=layers.get(id);layer.layout={...layer.layout,[name]:value};},
  setPaintProperty(id,name,value){const layer=layers.get(id);layer.paint={...layer.paint,[name]:value};}
 };
 const sourceLayer=(id,source)=>source===active?id:id+'--'+source;
 const visible=id=>[...layers.values()].filter(layer=>layer.source===id&&layer.layout?.visibility!=='none').length;
 const owner=createMapLibreDatedSources({getMap:()=>map,sourceLayers:{territories:['territories','borders']},sourceLayer,
  mapSourceLayers:()=>[...layers.values()].map(layer=>({...layer,visible:layer.layout?.visibility!=='none'})),
  createCountrySource:()=>({type:'geojson',promoteId:'objectKey'}),createEmptySource:()=>({type:'geojson'}),
  invalidateLayerIndex(){},dirty(){},canRetire:()=>!temporal,temporalPending:()=>temporal,graceMs:0});
 try{
  owner.set(active,{kind:'territories',source:sources.get(active),key:'old'});
  owner.scheduleRetirement();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(created,1);assert.equal(visible(standby),0);
  temporal=true;
  assert.equal(owner.reserve('territories'),standby);assert.equal(created,1);
  assert.equal(visible(active),2);assert.equal(visible(standby),0);
  owner.set(standby,{kind:'territories',source:sources.get(standby),key:'new'});
  owner.activate('territories',standby);
  assert.equal(visible(active),0);assert.equal(visible(standby),2);
  assert.equal(owner.reuse('territories','old')[0],active);
  owner.activate('territories',active);
  assert.equal(visible(active),2);assert.equal(visible(standby),0);
 }finally{owner.dispose();}
});

test('historical country writes use acknowledged deltas and recover uncertain native data',async()=>{
 const display=createMapLibreCountryDisplay(),sources=new Map([['territories',{}],['territories-retained',{}]]),records=new Map(),native=new Map();
 let active='territories',temporal=false,ticket=null,features=[],failNext=false,holdNext=false,releaseWrite,startedWrite;
 let request,fullWrites=0,deltaWrites=0,reserves=0;
 const writes=[],stats={retainedSourceHits:0},map={getSource:id=>sources.get(id),triggerRepaint(){}};
 const make=(id,x)=>({type:'Feature',id,properties:{entityKind:'general',parentId:null,style:{color:'#336699'}},
  geometry:{type:'Polygon',coordinates:[[[x,0],[x+.5,0],[x+.5,.5],[x,.5],[x,0]]]}});
 const baseline=Array.from({length:12},(_,i)=>make('country-'+String(i).padStart(2,'0'),i));
 const next=baseline.map((row,i)=>i===5?make(row.id,30):row);
 const later=next.map((row,i)=>i===6?make(row.id,40):row);
 const replacement=baseline.map((row,i)=>make('replacement-'+i,50+i));
 const nativeRows=id=>native.get(id)||new Map();
 const setData=async(id,data,current)=>{
  if(!current())return false;
  fullWrites++;writes.push({type:'full',id,count:data.features.length});
  native.set(id,new Map(data.features.map(row=>[row.id,row])));return true;
 };
 const writeDelta=async(id,delta)=>{
  deltaWrites++;writes.push({type:'delta',id,delta});
  const rows=new Map(nativeRows(id));
  for(const key of delta.remove)rows.delete(key);
  for(const row of delta.add)rows.set(row.id,row);
  for(const row of delta.update){
   const before=rows.get(row.id),properties={...before.properties};
   for(const {key,value}of row.addOrUpdateProperties||[])properties[key]=value;
   rows.set(row.id,{...before,geometry:row.newGeometry||before.geometry,properties});
  }
  native.set(id,rows);
  if(failNext){failNext=false;throw Error('native write failed after mutation');}
  if(holdNext){holdNext=false;await new Promise(resolve=>{releaseWrite=resolve;startedWrite();});}
  return true;
 };
 const datedSources={active:()=>active,get:id=>records.get(id),set:(id,record)=>records.set(id,record),
  reuse:(_kind,key,equals)=>[...records].find(([id,record])=>record.source===sources.get(id)&&equals(record.key,key)),
  reserve(){reserves++;return active==='territories'?'territories-retained':'territories';},activate(_kind,id){active=id;}};
 const controller=createMapLibreCountryController({getMap:()=>map,getGeneration:()=>1,isDisposed:()=>false,styleReady:()=>true,
  isFrameBlocked:()=>false,getBasemapRecovery:()=>null,waitForStyle:async()=>{},isTemporalPending:()=>temporal,
  isFramePreserved:()=>temporal,getTemporalTicket:()=>ticket,initialize:async()=>{},getEntityRepository:()=>({list:()=>features}),
  state:{layerVisibility:{objects:true},layerPresentation:{}},layerPresentation:{isLayerItemVisible:()=>true},
  currentMapStyle:()=>({countryStroke:{color:'#fff',width:1},borderAlpha:1}),
  geometryClient:{startCountryRequest(){request?.abort();request=new AbortController();return request.signal;},cancelCountryRequest(){request?.abort();}},
  countryDisplay:display,datedSources,sourceWrites:{hasPendingWrite:()=>false,update:(submit,id,current)=>current()?submit({updateData:delta=>writeDelta(id,delta)}):Promise.resolve(false)},
  setData,scene:{syncCountryPaint(){},syncVectorGroups(){},orderSceneLayers(){},syncTerritorialFills(){}},
  metrics:{run:(_name,fn)=>fn(),track:(_name,fn)=>fn()},stats,dirty(){},prewarmCountryMeshes(){},
  prepareCountryBorders:async rows=>rows.map(row=>({key:'border:'+row.id,feature:{type:'Feature',id:'border:'+row.id,
   properties:{displayRole:'country-border',objectKey:'border:'+row.id},geometry:{type:'MultiLineString',coordinates:[row.geometry.coordinates[0]]}}}))});
 const submit=rows=>{features=rows;return controller.setTerritorialFeatures(rows);};
 const begin=()=>{temporal=true;let live=true;ticket={isCurrent:()=>live};return ()=>{live=false;};};
 const nativeGeometry=(id,key)=>nativeRows(id).get(key)?.geometry.coordinates;
 try{
  assert.equal(await submit(baseline),true);assert.equal(fullWrites,1);
  begin();assert.equal(await submit(next),true);
  assert.equal(active,'territories');assert.equal(fullWrites,1);assert.equal(reserves,0);assert.equal(deltaWrites,1);
  const first=writes.at(-1).delta;
  assert.equal(first.add.length,0);assert.equal(first.remove.length,0);
  assert.equal(first.update.filter(row=>row.newGeometry).length,2);
  assert.equal(first.update.length,2);
  const targetKey=[...display.rows.keys()].find(id=>id.endsWith('country-06'));
  const beforeGeometry=structuredClone(nativeGeometry(active,targetKey));
  begin();failNext=true;
  await assert.rejects(submit(later),/native write failed after mutation/);
  assert.deepEqual(nativeGeometry(active,targetKey),beforeGeometry);
  assert.equal(records.get(active).key,display.key);
  const cancel=begin();holdNext=true;
  const started=new Promise(resolve=>{startedWrite=resolve;});
  const cancelled=submit(later);await started;cancel();releaseWrite();
  assert.equal(await cancelled,false);assert.deepEqual(nativeGeometry(active,targetKey),beforeGeometry);
  begin();assert.equal(await submit(later),true);assert.notDeepEqual(nativeGeometry(active,targetKey),beforeGeometry);
  begin();assert.equal(await submit(replacement),true);
  assert.equal(reserves,1);assert.equal(active,'territories-retained');assert.equal(writes.at(-1).type,'full');
  assert.equal(nativeRows(active).size,replacement.length*2);
 }finally{controller.dispose();}
});
