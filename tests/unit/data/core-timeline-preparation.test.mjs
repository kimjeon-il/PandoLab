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
 const project=createProjectDomain({productMode:'viewer',readOnly:true,
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
