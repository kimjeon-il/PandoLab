import test from 'node:test';
import assert from 'node:assert/strict';
import {createCoreDocumentClient} from '../../../src/document/core-document-client.js';
import {createProjectDomain} from '../../../src/document/project-domain.js';

test('builtin source transfer moves only owned bytes and keeps stale inputs intact',async()=>{
 const received=[];
 const worker={postMessage(message,transfer=[]){
  const {operation,payload}=structuredClone(message,{transfer});
  let result={state:{epoch:1}};
  if(operation==='core.document-temporal-source-prepare'){
   received.push([...payload.source.sourceBytes]);
   result={sourceId:received.length};
  }
  queueMicrotask(()=>worker.onmessage({data:{...message,type:'result',ok:true,result}}));
 },terminate(){}};
 const client=createCoreDocumentClient({createWorker:()=>worker});
 try{
  await client.load('{}');
  const owned={sourceBytes:Uint8Array.of(1,2,3)};
  await client.temporalSourcePrepare(owned,{transferSource:true});
  assert.equal(owned.sourceBytes.byteLength,0);
  const reusable={sourceBytes:Uint8Array.of(4,5)};
  await client.temporalSourcePrepare(reusable);
  assert.deepEqual([...reusable.sourceBytes],[4,5]);
  await assert.rejects(client.temporalSourcePrepare(reusable,{transferSource:true,isCurrent:()=>false}),{code:'PL-CORE-STALE'});
  assert.deepEqual([...reusable.sourceBytes],[4,5]);
  assert.deepEqual(received,[[1,2,3],[4,5]]);
 }finally{client.dispose();}
});

test('timeline geometry can be prepared without changing the displayed cursor',async()=>{
 const calls=[];
 const required=[{id:'fixture',version:2,contentSha256:'a'.repeat(64)}];
 const resources=[{id:'fixture',version:2,source:'{}'}];
 const requests=[],verifiedResources=[];
 const state={epoch:1,timelineCursor:'2026-12'};
 const worker={postMessage(message){
  calls.push(message.operation);
  if(message.operation==='core.document-geometry-admit')requests.push(message.payload);
  const result=message.operation==='core.document-load'?{state}:
   message.operation==='core.document-geometry-requirements'?{sourceEpoch:1,resources:required}:
   message.operation==='core.document-geometry-admit'?{state}:
   message.operation==='core.document-timeline-cursor'?{state:{epoch:2,timelineCursor:message.payload.month}}:null;
  queueMicrotask(()=>worker.onmessage({data:{rpc:message.rpc,protocolVersion:message.protocolVersion,
   type:'result',requestId:message.requestId,operation:message.operation,projectRevision:message.projectRevision,ok:true,result}}));
 },terminate(){}};
 const client=createCoreDocumentClient({createWorker:()=>worker,onTransition:(_result,operation,_payload,verified)=>{
  if(operation==='core.document-geometry-admit')verifiedResources.push(verified);
 }});
 try{
  await client.load('{}');let loaded=false;
  client.setGeometryLoader(async()=>{loaded=true;return resources;});
  const geometryPreparation=await client.prepareTimelineGeometry('1922-12');
  assert.equal(loaded,true);
  assert.deepEqual(requests,[{resources,month:'1922-12',expectedEpoch:1}]);
  assert.deepEqual(verifiedResources,[{resources,descriptors:required}]);
  assert.equal(client.state().timelineCursor,'2026-12');
  assert.deepEqual(calls,['core.document-load','core.document-geometry-requirements','core.document-geometry-admit']);
  await client.setTimelineCursor('1922-12',{geometryPreparation});
  assert.equal(client.state().timelineCursor,'1922-12');
  assert.equal(calls.filter(operation=>operation==='core.document-geometry-requirements').length,1);
  await client.load('{}'); // Same numeric epoch as the receipt, a different document.
  await client.setTimelineCursor('1922-12',{geometryPreparation});
  assert.equal(calls.filter(operation=>operation==='core.document-geometry-requirements').length,2);
 }finally{client.dispose();}
});

test('superseded timeline preparation does not admit stale geometry',async()=>{
 let release,started;const waiting=new Promise(resolve=>{started=resolve;});const calls=[];
 const worker={postMessage(message){
  calls.push(message.operation);
  const result=message.operation==='core.document-load'?{state:{epoch:1,timelineCursor:'2026-12'}}:
   message.operation==='core.document-geometry-requirements'?{sourceEpoch:1,resources:[{id:'fixture'}]}:null;
  queueMicrotask(()=>worker.onmessage({data:{rpc:message.rpc,protocolVersion:message.protocolVersion,
   type:'result',requestId:message.requestId,operation:message.operation,projectRevision:message.projectRevision,ok:true,result}}));
 },terminate(){}};
 const client=createCoreDocumentClient({createWorker:()=>worker});let current=true;
 try{
  await client.load('{}');client.setGeometryLoader(()=>new Promise(resolve=>{release=resolve;started();}));
  const pending=client.prepareTimelineGeometry('1922-12',{isCurrent:()=>current});await waiting;
  current=false;release([{id:'fixture'}]);await assert.rejects(pending,{name:'AbortError'});
  assert.equal(calls.includes('core.document-geometry-admit'),false);
  assert.equal(client.state().timelineCursor,'2026-12');
 }finally{client.dispose();}
});

test('timeline preparation retries when another operation advances the Core epoch',async()=>{
 let release,started,epoch=1,loads=0;const waiting=new Promise(resolve=>{started=resolve;});const admissions=[];
 const worker={postMessage(message){
  const state={epoch,timelineCursor:'2026-12'};
  let result;
  if(message.operation==='core.document-load')result={state};
  else if(message.operation==='core.document-geometry-requirements')result={sourceEpoch:epoch,resources:[{id:'fixture'}]};
  else if(message.operation==='core.document-presentation-catalog'){epoch++;result={state:{epoch,timelineCursor:'2026-12'}};}
  else if(message.operation==='core.document-geometry-admit'){admissions.push(message.payload.expectedEpoch);result={state};}
  queueMicrotask(()=>worker.onmessage({data:{rpc:message.rpc,protocolVersion:message.protocolVersion,
   type:'result',requestId:message.requestId,operation:message.operation,projectRevision:message.projectRevision,ok:true,result}}));
 },terminate(){}};
 const client=createCoreDocumentClient({createWorker:()=>worker});
 try{
  await client.load('{}');client.setGeometryLoader((_requirements,{isCurrent})=>++loads===1?new Promise((resolve,reject)=>{release=()=>isCurrent()?resolve([{id:'fixture'}]):reject(Object.assign(new Error('superseded'),{name:'AbortError'}));started();}):Promise.resolve([{id:'fixture'}]));
  const pending=client.prepareTimelineGeometry('1922-12');await waiting;
  await client.presentationCatalogLoad({});release();await pending;
  assert.equal(loads,2);assert.deepEqual(admissions,[2]);assert.equal(client.state().timelineCursor,'2026-12');
 }finally{client.dispose();}
});

test('unchanged builtin water identities do not re-enter Core until the project changes',async()=>{
 const calls=[];
 const project=createProjectDomain({
  commandOwner:{async selectionCatalogLoad(domain,refs){calls.push({domain,refs});return {accepted:true};}},
  publishCommand:async()=>{}});
 const river={domain:'hydroBuiltin',id:'river:1',logicalId:'river:1',type:'river',sourceIds:['hydro:1']};
 const lake={...river,id:'lake:2',logicalId:'lake:2',type:'lake'};
 try{
  await project.admitSelectionCatalog('hydroBuiltin',[river,lake]);
  await project.admitSelectionCatalog('hydroBuiltin',()=>[{...lake},{...river}]);
  assert.equal(calls.length,1);
  await project.admitSelectionCatalog('hydroBuiltin',[river]);
  assert.equal(calls.length,2);
  await project.resetRenderGeneration('fixture-replacement');
  await project.admitSelectionCatalog('hydroBuiltin',[river]);
  assert.equal(calls.length,3);
 }finally{project.dispose();}
});

test('failed project replacement restores the prior accepted owner and retires its generation',async()=>{
 const before=Object.freeze({documentId:'original',mapProjectIdentity:{projectId:'world'}});
 const first=Object.freeze({documentId:'accepted',mapProjectIdentity:{projectId:'world'}});
 const rejected=Object.freeze({documentId:'rejected',mapProjectIdentity:{projectId:'world'}});
 let snapshot=before,checkpoint=null,id=0;
 const state=[],published=[],restored=[],released=[],resets=[];
 const project=createProjectDomain({
  commandOwner:{
   async captureReplacement(){checkpoint=snapshot;return ++id;},
   async loadBaseline(baselineId){snapshot=baselineId===1?first:rejected;},
   async selectionCatalogLoad(){},
   async rollbackReplacement(){snapshot=checkpoint;},
   async releaseReplacement(replacementId){released.push(replacementId);},
  },
  documentModel:{snapshot:()=>snapshot},
  readBuiltinSelectionCatalogs:()=>[{domain:'hydroBuiltin',refs:[]}],
  replaceSnapshot:async value=>value!==rejected,
  restoreReplacement:async(value,generation,active)=>{restored.push({value,generation,active});},
  onProjectReset:event=>resets.push(event.generation),
  onReplacementState:(value)=>state.push(value),
  onReplacementCommitted:()=>published.push(snapshot.documentId),
 });
 try{
  assert.equal(await project.open(async()=>({baselineId:1,setup:{}})),true);
  const accepted=project.activeProject();
  assert.equal(accepted.documentId,'accepted');
  await assert.rejects(project.open(async()=>({baselineId:2,setup:{}})),/Project replacement was rejected/);
  assert.equal(project.snapshot(),first);
  assert.equal(project.activeProject().documentId,'accepted');
  assert.equal(project.getGeneration(),3);
  assert.deepEqual(resets,[1,2,3]);
  assert.deepEqual(state,[true,false,true,false]);
  assert.deepEqual(published,['accepted']);
  assert.deepEqual(released,[1,2]);
  assert.equal(restored.length,1);
  assert.equal(restored[0].value,first);
  assert.equal(restored[0].generation,3);
  assert.equal(restored[0].active.documentId,accepted.documentId);
  assert.equal(project.isReplacing(),false);
  assert.equal(project.isOpening(),false);
 }finally{project.dispose();}
});


test('dated Viewer and Core geometry preparations run concurrently and preserve the Core receipt', async () => {
  const {prepareGlobeTimelineSources} = await import('../../../src/rendering/globe-temporal-presentation.js');
  const started = [], gates = Array.from({length:3},()=>Promise.withResolvers()), receipt = Object.freeze({});
  const run = index => async isCurrent => {started.push(index); assert.equal(isCurrent(),true); await gates[index].promise; return index===2?receipt:true;};
  const result = prepareGlobeTimelineSources({preparePhysical:run(0),prepareTerritories:run(1),prepareCore:run(2)});
  await Promise.resolve();
  assert.deepEqual(started,[0,1,2]);
  gates[2].resolve(); gates[0].resolve(); gates[1].resolve();
  assert.equal(await result,receipt);
});

test('a failed dated preparation makes sibling preparations obsolete without committing a cursor', async () => {
  const {prepareGlobeTimelineSources} = await import('../../../src/rendering/globe-temporal-presentation.js');
  const gate = Promise.withResolvers(), failure = Error('physical failure');
  let siblingCurrent;
  const result = prepareGlobeTimelineSources({preparePhysical:()=>{throw failure;},
    prepareTerritories:async isCurrent=>{siblingCurrent=isCurrent;await gate.promise;assert.equal(isCurrent(),false);},
    prepareCore:()=>gate.promise});
  await assert.rejects(result,error=>error===failure);
  assert.equal(siblingCurrent(),false);
  gate.resolve();
});


test('initial Core candidate and required geometry preparation run concurrently with rollback on geometry failure',async()=>{
 const {prepareProjectCandidateWithGeometry}=await import('../../../src/document/project-source-runtime.js');
 const started=[],coreGate=Promise.withResolvers(),geometryGate=Promise.withResolvers(),discarded=[];
 const candidate={kind:'temporal-candidate'};
 const pending=prepareProjectCandidateWithGeometry({
  prepareCandidate:async()=>{started.push('core');await coreGate.promise;return candidate;},
  prepareGeometry:async()=>{started.push('geometry');await geometryGate.promise;},
  discardCandidate:async value=>discarded.push(value),
 });
 await Promise.resolve();assert.deepEqual(started,['core','geometry']);
 coreGate.resolve();geometryGate.reject(Error('initial geometry failed'));
 await assert.rejects(pending,/initial geometry failed/);
 assert.deepEqual(discarded,[candidate]);
});

test('initial geometry failure waits for Core candidate settlement before discarding it',async()=>{
 const {prepareProjectCandidateWithGeometry}=await import('../../../src/document/project-source-runtime.js');
 const coreGate=Promise.withResolvers(),geometryGate=Promise.withResolvers(),discarded=[];
 const pending=prepareProjectCandidateWithGeometry({
  prepareCandidate:()=>coreGate.promise,prepareGeometry:()=>geometryGate.promise,
  discardCandidate:async value=>discarded.push(value),
 });
 geometryGate.reject(Error('packet failure'));await Promise.resolve();
 assert.deepEqual(discarded,[]);
 const candidate={kind:'temporal-candidate'};coreGate.resolve(candidate);
 await assert.rejects(pending,/packet failure/);
 assert.deepEqual(discarded,[candidate]);
});
