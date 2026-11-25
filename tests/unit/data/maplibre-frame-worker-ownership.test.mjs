import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapLibreFrameController} from '../../../src/rendering/maplibre-frame-controller.js';
import {createMapLibreGeometryClient,createMapGeometryRequester} from '../../../src/rendering/maplibre-geometry-client.js';

function fixture(){
 const listeners=new Map(),layers=new Map([['optional',{id:'optional',source:'custom',layout:{visibility:'visible'}}]]);
 const overlays=new Set(),notices=[],errors=[],invalidations=[];
 const stage={append(element){overlays.add(element);}};
 const makeElement=()=>({dataset:{},style:{},append(){},getContext:()=>({drawImage(){}}),remove(){overlays.delete(this);}});
 const canvas={width:800,height:600,style:{removeProperty(){}}};
 let enabled=true,styleCurrent=true,countryKey='',presented=0,repaints=0;
 let countryGeneration=1,sourcesReady=true,cameraKey='camera',nativeChecks=0;
 const map={getCanvas:()=>canvas,getStyle:()=>({layers:[...layers.values()]}),getLayer:id=>layers.get(id),
  getLayoutProperty:id=>layers.get(id)?.layout.visibility,setLayoutProperty:(id,_key,value)=>{layers.get(id).layout.visibility=value;},
  getSource:()=>null,isMoving:()=>false,triggerRepaint(){repaints++;},
  dragPan:{isEnabled:()=>enabled,enable(){enabled=true;},disable(){enabled=false;}},
  on(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},
  off(name,fn){listeners.get(name)?.delete(fn);},
  once(name,fn){const wrapped=(value)=>{map.off(name,wrapped);fn(value);};map.on(name,wrapped);},
  emit(name,value){for(const fn of [...(listeners.get(name)||[])])fn(value);}
 };
 const stats={sourceUpdates:0,renderedFrames:0,preservedFrameCopies:0,approvalAttempts:0,firstCanonicalFrameMs:null};
 const owner=createMapLibreFrameController({
  getMap:()=>map,getContainer:()=>({parentNode:stage}),isLoaded:()=>true,
  isStyleReady:()=>styleCurrent&&!owner.contextLost&&!owner.basemapRecovery,isStyleCurrent:()=>styleCurrent,
  state:{},metrics:{begin:()=>()=>{},run:(_name,fn)=>fn(),publish(){}},stats,invalidate:reason=>invalidations.push(reason),
  presentMapPreparation:value=>notices.push(value),camera:{cameraKey:()=>cameraKey,hasPresented:()=>presented>0,
   markPresented(){presented++;},resetPresented(){presented=0;}},
  scene:{requiredSource:()=>false,requiredSourcesReady:()=>{nativeChecks++;return sourcesReady;},requiredVectorPending:()=>false,
   syncLabelVisibility:()=>false,hasStyleController:()=>false,applyStyle(){},getStyle:()=>({}),syncVectorGroups(){}},
  selection:{owns:()=>false,onRender(){},selectionPending:()=>false,onTemporalAdmission(){},reset(){},refresh(){}},
  physicalBase:{syncPhysicalContext(){},resetContext(){}},polarDisplay:{pending:false,syncPolar(){},syncPolarLines(){},resetContext(){},retry(){}},
  physicalResources:{physicalContextState:{ready:true}},
  sourceWrites:{pendingCount:()=>0,reset(){},handlesError:()=>false},
  datedSources:{has:()=>false,scheduleRetirement(){},cancelRetirement(){}},
  getExternalBasemap:()=>null,flushStyleChanges(){},feedback:{reportOperationError:cause=>errors.push(cause)},
  rgba:()=>[],getCountryStatus:()=>({generation:countryGeneration,contentKey:countryKey}),createElement:makeElement,isDocumentHidden:()=>false});
 owner.resetForProject({generation:1});owner.attachMap();
 const visual=id=>({frameId:id,viewRevision:id,projectionRevision:id,projectGeneration:1});
 return {owner,map,visual,stats,overlays,errors,notices,enabled:()=>enabled,repaints:()=>repaints,
  setCountryKey:key=>{countryKey=key;},setStyleCurrent:value=>{styleCurrent=value;},
  setCountryGeneration:value=>{countryGeneration=value;},setSourcesReady:value=>{sourcesReady=value;},
  setCameraKey:value=>{cameraKey=value;},nativeChecks:()=>nativeChecks,
  certificateWakeups:()=>invalidations.filter(reason=>reason==='maplibre-presented').length,
  listenerCount:()=>[...listeners.values()].reduce((sum,rows)=>sum+rows.size,0)};
}

test('frame admission rejects a certificate invalidated before publication',async()=>{
 const {owner,map,visual}=fixture();
 assert.equal(owner.renderFrame(visual(1)).deferred,true);
 map.emit('render');
 const first=visual(2),result=owner.renderFrame(first);
 assert.equal(owner.canPresentVisualFrame(first,result),true);
 owner.dirty();
 assert.equal(owner.commitVisualFrame(first),false);
 map.emit('render');
 const next=visual(3),waiting=owner.waitForMapPresentation(1);
 assert.equal(owner.renderFrame(next).succeeded,true);
 assert.equal(owner.commitVisualFrame(next),true);
 assert.equal(await waiting,true);
 assert.equal(owner.runtimeState().mapReady,true);
 assert.equal(owner.commitVisualFrame(next),false);
 owner.dispose();
});


test('unchanged native renders wake approval once and live readiness still gates publication',()=>{
 const f=fixture(),{owner,map,visual}=f;
 try{
  f.setCountryGeneration(0);
  assert.equal(owner.renderFrame(visual(1)).deferred,true);
  map.emit('render');map.emit('render');
  assert.equal(f.certificateWakeups(),0);
  f.setCountryGeneration(1);
  map.emit('render');map.emit('render');
  assert.equal(f.certificateWakeups(),1);
  const frame=visual(2),result=owner.renderFrame(frame);
  assert.equal(result.succeeded,true);
  map.emit('render');map.emit('render');
  assert.equal(f.certificateWakeups(),1);
  assert.equal(owner.commitVisualFrame(frame),true);
  const checks=f.nativeChecks();
  map.emit('render');map.emit('render');
  assert.equal(f.nativeChecks(),checks);
  f.setSourcesReady(false);
  assert.equal(owner.renderFrame(visual(3)).deferred,true);
  f.setSourcesReady(true);
  assert.equal(owner.renderFrame(visual(4)).deferred,true);
  map.emit('render');map.emit('render');
  assert.equal(f.certificateWakeups(),2);
  const recovered=visual(5);assert.equal(owner.renderFrame(recovered).succeeded,true);
  f.setCameraKey('new-camera');
  assert.equal(owner.commitVisualFrame(recovered),false);
  map.emit('render');map.emit('render');
  assert.equal(f.certificateWakeups(),3);
  const next=visual(6);assert.equal(owner.renderFrame(next).succeeded,true);
  owner.dirty();assert.equal(owner.commitVisualFrame(next),false);
  map.emit('render');map.emit('render');
  assert.equal(f.certificateWakeups(),4);
  assert.equal(owner.stats().certificateWakeups,4);
 }finally{owner.dispose();}
});

test('a live temporal ticket retains its old pixels through GPU recovery',async()=>{
 const f=fixture(),{owner,map,visual,overlays,stats}=f;
 let presented=0;
 const ticket=owner.beginTemporalViewTransition(()=>true,()=>presented++);
 owner.preserveTemporalFrame();owner.preserveTemporalFrame();
 assert.equal(stats.preservedFrameCopies,1);
 assert.equal(overlays.size,1);
 assert.equal(f.enabled(),false);
 assert.equal(map.getLayoutProperty('optional'), 'none');
 // An empty dated map is a valid prepared source, not an unprepared source.
 await owner.prepareTemporalCountrySource([]);
 f.setCountryKey('');
 owner.admitTemporalViewTransition(ticket);
 const waiting=owner.waitForTemporalPresentation();
 map.emit('webglcontextlost');
 assert.equal(owner.contextLost,true);
 assert.equal(owner.ticket.context,owner.contextRevision);
 const styleWait=owner.waitForStyle();
 map.emit('webglcontextrestored');
 await styleWait;
 assert.equal(owner.contextLost,false);
 assert.equal(overlays.size,1);
 assert.equal(owner.renderFrame(visual(1)).deferred,true);
 map.emit('render');
 const next=visual(2);
 assert.equal(owner.renderFrame(next).succeeded,true);
 assert.equal(owner.commitVisualFrame(next),true);
 assert.equal(await waiting,true);
 assert.equal(presented,1);
 assert.equal(overlays.size,0);
 assert.equal(f.enabled(),true);
 assert.equal(map.getLayoutProperty('optional'),'visible');
 owner.dispose();assert.equal(f.listenerCount(),0);
});

test('failed dates retain the previous frame and a cancelled style wait releases its listener',async()=>{
 const f=fixture(),{owner,map,visual,overlays}=f;
 const ticket=owner.beginTemporalViewTransition();owner.preserveTemporalFrame();
 const waiting=owner.waitForTemporalPresentation();
 const failure=new Error('source failed');
 owner.failMapPreparation(failure);
 await assert.rejects(waiting,/source failed/);
 assert.equal(overlays.size,1);
 const recovery=owner.beginTemporalViewTransition();
 assert.equal(owner.finishTemporalViewTransition(ticket),false);
 owner.retryMapPreparation();await owner.prepareTemporalCountrySource([]);owner.admitTemporalViewTransition(recovery);
 map.emit('render');
 const next=visual(1);
 assert.equal(owner.renderFrame(next).succeeded,true);assert.equal(owner.commitVisualFrame(next),true);
 assert.equal(overlays.size,0);
 f.setStyleCurrent(false);
 const cancel=new AbortController(),styleWait=owner.waitForStyle(cancel.signal);
 cancel.abort();await assert.rejects(styleWait,{name:'AbortError'});
 owner.dispose();assert.equal(f.listenerCount(),0);
});

test('geometry worker scopes cancel superseded country and frame work without retiring shared land cache',async()=>{
 const requests=[],stats={geometryWorkerRequests:0,geometryWorkerTransferBytes:0,physicalLandPreparations:0,physicalLandPreparationMs:0};
 let stopped=0,created=0;
 const client=createMapLibreGeometryClient({runtimeAssetUrl:path=>path,getGeneration:()=>1,getStats:()=>stats,
  metrics:{track:(_name,fn)=>fn(),record(){}},createWorker:()=>({}),
  createRpc:()=>{created++;return {request(operation,payload,options){
   return new Promise(resolve=>requests.push({operation,payload,options,resolve}));
  },stop(){stopped++;}};}});
 const first=client.startCountryRequest();
 const obsolete=client.prepareRenderGeometry([{kind:'stroke'}],1,undefined,first);
 client.startCountryRequest();assert.equal(first.aborted,true);
 requests[0].resolve({result:{packets:[]}});
 await assert.rejects(obsolete,{name:'AbortError'});
 const pending=client.prepareRenderGeometry([{kind:'fill'}],1);
 const land=client.preparePhysicalDisplay('land',{type:'Polygon',coordinates:[]});
 client.reset();
 assert.equal(requests[1].options.signal.aborted,true);
 assert.equal(requests[2].options.signal.aborted,false);
 requests[1].resolve({result:{packets:[]}});
 await assert.rejects(pending,{name:'AbortError'});
 const geometry={type:'Polygon',coordinates:[]};
 requests[2].resolve({result:{geometry,durationMs:1}});
 assert.equal(await land,geometry);
 assert.equal(client.physicalGeometry('land'),geometry);
 client.dispose();client.dispose();
 assert.equal(stopped,1);assert.equal(client.physicalGeometry('land'),undefined);
 await assert.rejects(client.prepareRenderGeometry([{kind:'fill'}],2),{name:'AbortError'});
 assert.equal(created,1);
});

test('geometry requester retries initialization failure once and does not reopen a disposed client',async()=>{
 const failure=Object.assign(new Error('init'),{code:'PL-MAP-GEOMETRY-INITIALIZATION'});
 let stopped=0,attempts=0,closed=false;
 const first={request:async()=>{attempts++;throw failure;}};
 const second={request:async()=>{attempts++;return {result:'ready'};}};
 let current=first;
 const request=createMapGeometryRequester({getWorker:()=>current,isCurrentWorker:worker=>worker===current,
  restartWorker:()=>{stopped++;current=second;},isDisposed:()=>closed,waitBeforeRetry:async()=>{}});
 assert.equal(await request('geometry.prepare',{},1,new AbortController().signal),'ready');
 assert.equal(attempts,2);assert.equal(stopped,1);
 closed=true;await assert.rejects(request('geometry.prepare',{},1,new AbortController().signal),{name:'AbortError'});
 assert.equal(attempts,2);
});
