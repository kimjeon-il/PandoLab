import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapLibreFrameController} from '../../../src/rendering/maplibre-frame-controller.js';
import {createMapLibreGeometryClient,createMapGeometryRequester} from '../../../src/rendering/maplibre-geometry-client.js';
import {createGeometryWorkGate,createGeometryWorkActivity} from '../../../src/rendering/geometry-work-gate.js';

function fixture(){
 const listeners=new Map(),layers=new Map([['optional',{id:'optional',source:'custom',layout:{visibility:'visible'}}]]);
 const overlays=new Set(),notices=[],errors=[],invalidations=[];
 const stage={append(element){overlays.add(element);}};
 const makeElement=()=>({dataset:{},style:{},append(){},getContext:()=>({drawImage(){}}),remove(){overlays.delete(this);}});
 const canvas={width:800,height:600,style:{removeProperty(){}}};
 let enabled=true,styleCurrent=true,countryKey='',presented=0,repaints=0;
 let countryGeneration=1,sourcesReady=true,cameraKey='camera',nativeChecks=0,selectionPending=false,vectorPending=false,physicalReady=true,polarPending=false,writesPending=0;
 const map={style:{},getCanvas:()=>canvas,getStyle:()=>({layers:[...layers.values()]}),getLayer:id=>layers.get(id),
  getLayoutProperty:id=>layers.get(id)?.layout.visibility,setLayoutProperty:(id,_key,value)=>{layers.get(id).layout.visibility=value;},
  getSource:id=>id==='territories'?{}:null,isMoving:()=>false,triggerRepaint(){repaints++;},
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
  scene:{requiredSource:id=>id==='territories',requiredSourcesReady:()=>{nativeChecks++;return sourcesReady;},requiredVectorPending:()=>vectorPending,
   syncLabelVisibility:()=>false,hasStyleController:()=>false,applyStyle(){},getStyle:()=>({}),syncVectorGroups(){}},
  selection:{owns:()=>false,onRender(){},selectionPending:()=>selectionPending,onTemporalAdmission(){},reset(){},refresh(){}},
  physicalBase:{syncPhysicalContext(){},resetContext(){}},polarDisplay:{get pending(){return polarPending;},syncPolar(){},syncPolarLines(){},resetContext(){},retry(){},cancelPending(){},cancelCountryPrewarm(){}},
  physicalResources:{physicalContextState:{get ready(){return physicalReady;}}},
  sourceWrites:{pendingCount:()=>writesPending,reset(){},handlesError:()=>false},
  datedSources:{has:()=>false,scheduleRetirement(){},cancelRetirement(){}},
  getExternalBasemap:()=>null,flushStyleChanges(){},feedback:{reportOperationError:cause=>errors.push(cause)},
  rgba:()=>[],getCountryStatus:()=>({generation:countryGeneration,contentKey:countryKey}),createElement:makeElement,isDocumentHidden:()=>false});
 owner.resetForProject({generation:1});owner.attachMap();
 const visual=id=>({frameId:id,viewRevision:id,projectionRevision:id,projectGeneration:1});
 return {owner,map,visual,stats,overlays,errors,notices,enabled:()=>enabled,repaints:()=>repaints,
  setCountryKey:key=>{countryKey=key;},setStyleCurrent:value=>{styleCurrent=value;},
  setCountryGeneration:value=>{countryGeneration=value;},setSourcesReady:value=>{sourcesReady=value;},
  setCameraKey:value=>{cameraKey=value;},setVectorPending:value=>{vectorPending=value;},
  setSelectionPending:value=>{selectionPending=value;},setPhysicalReady:value=>{physicalReady=value;},
  setPolarPending:value=>{polarPending=value;},setWritesPending:value=>{writesPending=value;},nativeChecks:()=>nativeChecks,
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

test('required source and style events revoke approval before publication and coalesce draw invalidation',()=>{
 const f=fixture(),{owner,map,visual}=f;
 try{
  owner.renderFrame(visual(1));map.emit('render');
  const first=visual(2),result=owner.renderFrame(first);
  assert.equal(result.succeeded,true);
  map.emit('sourcedata',{sourceId:'optional',sourceDataType:'content'});
  assert.equal(owner.canPresentVisualFrame(first,result),true);
  const before=owner.sourceRevision,mutation=owner.pickingRevision;
  map.emit('sourcedataloading',{sourceId:'territories',sourceDataType:'content'});
  owner.dirty();owner.dirty();
  map.emit('sourcedata',{sourceId:'territories',sourceDataType:'content'});
  assert.equal(owner.sourceRevision,before+1);
  assert.equal(owner.pickingRevision,mutation+4);
  assert.equal(owner.stats().coalescedDirtyCalls,3);
  assert.equal(owner.commitVisualFrame(first),false);
  const repaints=f.repaints();
  assert.equal(owner.renderFrame(visual(3)).deferred,true);
  assert.equal(owner.renderFrame(visual(4)).deferred,true);
  assert.equal(f.repaints(),repaints+1);
  map.emit('render');
  const second=visual(5);assert.equal(owner.renderFrame(second).succeeded,true);
  map.emit('styledata');
  assert.equal(owner.commitVisualFrame(second),false);
  map.emit('render');
  const third=visual(6);assert.equal(owner.renderFrame(third).succeeded,true);
  map.style={};map.emit('style.load');
  assert.equal(owner.commitVisualFrame(third),false);
  map.emit('render');
  const fourth=visual(7);assert.equal(owner.renderFrame(fourth).succeeded,true);
  map.emit('webglcontextlost');assert.equal(owner.commitVisualFrame(fourth),false);
  map.emit('webglcontextrestored');
  assert.equal(owner.renderFrame(visual(8)).deferred,true);
  map.emit('render');
  const fifth=visual(9);assert.equal(owner.renderFrame(fifth).succeeded,true);
  assert.equal(owner.commitVisualFrame(fifth),true);
 }finally{owner.dispose();assert.equal(f.listenerCount(),0);}
});

test('final publication rechecks native and domain readiness rather than trusting an earlier approval',async()=>{
 const f=fixture(),{owner,map,visual}=f;
 try{
  owner.renderFrame(visual(1));map.emit('render');
  let id=2;
  for(const change of [f.setSourcesReady,f.setPhysicalReady]){
   const frame=visual(id++),result=owner.renderFrame(frame);
   assert.equal(result.succeeded,true);assert.equal(owner.canPresentVisualFrame(frame,result),true);
   change(false);assert.equal(owner.commitVisualFrame(frame),false);
   change(true);map.emit('render');
  }
  for(const change of [f.setVectorPending,f.setPolarPending,f.setWritesPending]){
   const frame=visual(id++),result=owner.renderFrame(frame);
   assert.equal(result.succeeded,true);
   change(true);assert.equal(owner.commitVisualFrame(frame),false);
   change(false);map.emit('render');
  }
  const ticket=owner.beginTemporalViewTransition();owner.preserveTemporalFrame();
  await owner.prepareTemporalCountrySource([]);owner.admitTemporalViewTransition(ticket);
  const frame=visual(id++);assert.equal(owner.renderFrame(frame).succeeded,true);
  f.setSelectionPending(true);assert.equal(owner.commitVisualFrame(frame),false);
  assert.equal(f.overlays.size,1);
  f.setSelectionPending(false);map.emit('render');
  const next=visual(id++);assert.equal(owner.renderFrame(next).succeeded,true);
  const waiting=owner.waitForMapPresentation(1);
  let resolved=false;waiting.then(()=>{resolved=true;});await Promise.resolve();
  assert.equal(resolved,false,'A prepared frame must not resolve a presentation waiter');
  assert.equal(owner.commitVisualFrame(next),true);assert.equal(await waiting,true);
  assert.equal(f.overlays.size,0);
  owner.dirty();map.emit('render');const prepared=visual(id++);
  assert.equal(owner.renderFrame(prepared).succeeded,true);
  const nextWait=owner.waitForMapPresentation(1);let preparedResolved=false;
  nextWait.then(()=>{preparedResolved=true;});await Promise.resolve();
  assert.equal(preparedResolved,false,'A prior generation commit must not admit newly prepared pixels');
  assert.equal(owner.commitVisualFrame(prepared),true);assert.equal(await nextWait,true);
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


test('dated preparation promises are admitted by the frame owner regardless of completion order',async()=>{
 const f=fixture(),{owner,map,visual,overlays}=f;
 let presented=0,id=1;
 try{
  for(const order of ['country','physical']){
   const token=owner.beginTemporalViewTransition(()=>true,()=>presented++);
   owner.preserveTemporalFrame();await owner.prepareTemporalCountrySource([]);
   const releases={};
   const tasks=Object.fromEntries(['country','physical'].map(name=>[name,new Promise(resolve=>{releases[name]=resolve;})]));
   assert.equal(owner.admitTemporalViewTransition(token,tasks),true);
   const waiting=owner.waitForTemporalPresentation(token);
   let completed=false;waiting.then(value=>{completed=value;});
   const blocked=()=>{map.emit('render');assert.equal(owner.renderFrame(visual(id++)).deferred,true);};
   blocked();releases[order](order==='country'?true:null);await Promise.resolve();blocked();
   assert.equal(overlays.size,1);assert.equal(completed,false);
   const other=order==='country'?'physical':'country';releases[other](other==='country'?true:null);
   await Promise.resolve();
   assert.equal(owner.runtimeState().temporalSourceAdmitted,true);
   map.emit('render');const next=visual(id++);
   assert.equal(owner.renderFrame(next,{domainPending:true}).deferred,true);
   const frame=visual(id++);assert.equal(owner.renderFrame(frame).succeeded,true);
   assert.equal(completed,false);
   assert.equal(owner.commitVisualFrame(frame),true);assert.equal(await waiting,true);
   assert.equal(overlays.size,0);owner.finishTemporalViewTransition(token);
  }
  assert.equal(presented,2);
 }finally{owner.dispose();}
});

test('superseded preparation cannot admit or fail a later date and retires its waiter',async()=>{
 const f=fixture(),{owner,map,visual}=f;
 try{
  const old=owner.beginTemporalViewTransition();owner.preserveTemporalFrame();
  let rejectOld;const obsolete=new Promise((_resolve,reject)=>{rejectOld=reject;});
  owner.admitTemporalViewTransition(old,{country:obsolete});
  const waiting=owner.waitForTemporalPresentation(old);
  const current=owner.beginTemporalViewTransition();assert.equal(await waiting,false);
  await owner.prepareTemporalCountrySource([]);
  let finish;const country=new Promise(resolve=>{finish=resolve;});
  owner.admitTemporalViewTransition(current,{country});
  rejectOld(Error('obsolete source error'));await Promise.resolve();
  assert.equal(f.errors.length,0);assert.equal(owner.runtimeState().temporalSourceAdmitted,false);
  finish(true);await Promise.resolve();map.emit('render');
  const next=visual(1);assert.equal(owner.renderFrame(next).succeeded,true);assert.equal(owner.commitVisualFrame(next),true);
  assert.equal(await owner.waitForTemporalPresentation(current),true);
 }finally{owner.dispose();}
});

test('failed registered preparation rejects the current frame wait and keeps old pixels',async()=>{
 const f=fixture(),{owner}=f;
 try{
  const token=owner.beginTemporalViewTransition();owner.preserveTemporalFrame();
  await owner.prepareTemporalCountrySource([]);
  let reject;const physical=new Promise((_resolve,fail)=>{reject=fail;});
  owner.admitTemporalViewTransition(token,{country:Promise.resolve(true),physical});
  const waiting=owner.waitForTemporalPresentation(token);
  const rejection=assert.rejects(waiting,/physical failure/);reject(Error('physical failure'));await rejection;
  assert.equal(f.overlays.size,1);assert.equal(owner.runtimeState().projectRenderBlocked,true);
  assert.equal(owner.runtimeState().temporalSourceAdmitted,false);
  assert.equal(f.errors.length,1);
 }finally{owner.dispose();}
});

test('geometry queue records slot wait and cross-gate async overlap',async()=>{
 let time=0;const now=()=>time,sharedActivity=createGeometryWorkActivity(now);
 const gate=createGeometryWorkGate(2,{now,sharedActivity}),boundaryGate=createGeometryWorkGate(1,{now,sharedActivity});
 const context={priority:1,throwIfCancelled(){}},releases={};
 const run=(owner,kind)=>owner.run(context,()=>new Promise(resolve=>{releases[kind]=resolve;}),kind);
 const one=run(gate,'polar'),two=run(gate,'physical'),three=run(gate,'stroke'),four=run(boundaryGate,'boundary');
 await Promise.resolve();
 assert.equal(Object.keys(releases).length,3);assert.equal(gate.stats().waiting,1);
 time=10;releases.polar();await one;await Promise.resolve();
 assert.equal(typeof releases.stroke,'function');assert.equal(gate.stats().kinds.stroke.queueMs,10);
 time=15;releases.physical();await two;
 time=17;releases.boundary();await four;
 time=20;releases.stroke();await three;
 const result=gate.stats(),combined=sharedActivity.stats();
 assert.equal(result.active,0);assert.equal(result.peakActive,2);
 assert.equal(result.busyMs,20);assert.equal(result.overlapMs,15);
 assert.equal(result.kinds.polar.workMs,10);assert.equal(result.kinds.physical.workMs,15);
 assert.equal(result.kinds.stroke.workMs,10);assert.equal(boundaryGate.stats().kinds.boundary.workMs,17);
 assert.equal(combined.peakActive,3);assert.equal(combined.busyMs,20);assert.equal(combined.overlapMs,17);
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

test('scoped physical work cancels only after its last subscriber leaves and reuses completed geometry',async()=>{
 const requests=[],stats={geometryWorkerRequests:0,physicalLandPreparations:0,physicalLandPreparationMs:0};
 const client=createMapLibreGeometryClient({runtimeAssetUrl:path=>path,getGeneration:()=>1,getStats:()=>stats,
  metrics:{track:(_name,fn)=>fn(),record(){}},createRpc:()=>({request(_operation,_payload,{signal}){
   return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
    requests.push({signal,resolve:value=>{signal.removeEventListener('abort',abort);resolve({result:{geometry:value,durationMs:1}});}});
   });
  },stop(){}})});
 const geometry={type:'Polygon',coordinates:[]};
 const a=new AbortController(),b=new AbortController();
 try{
  const first=client.preparePhysicalDisplay('land',geometry,a.signal),second=client.preparePhysicalDisplay('land',geometry,b.signal);
  assert.equal(requests.length,1);const cancelled=assert.rejects(first,{name:'AbortError'});
  a.abort();await cancelled;await Promise.resolve();assert.equal(requests[0].signal.aborted,false);
  const rejected=assert.rejects(second,{name:'AbortError'});b.abort();await rejected;await Promise.resolve();
  assert.equal(requests[0].signal.aborted,true);
  const next=new AbortController(),third=client.preparePhysicalDisplay('land',geometry,next.signal);
  assert.equal(requests.length,2);requests[1].resolve(geometry);assert.equal(await third,geometry);
  next.abort();assert.equal(await client.preparePhysicalDisplay('land',geometry),geometry);assert.equal(requests.length,2);
 }finally{client.dispose();}
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
