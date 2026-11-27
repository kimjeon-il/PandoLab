import {viewerPolicy} from '../../src/app/viewer-policy.js';



import {createMapPresentationSession} from '../../src/rendering/map-presentation-session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {loadNodeCore} from '../../tools/build/load-node-core.mjs';
import {createWorkerRpcClient, WORKER_RPC_PROTOCOL, WORKER_RPC_PROTOCOL_VERSION} from '../../src/runtime/worker-rpc.js';
import {mapProjectCatalogSpec} from '../../src/data/map-project-runtime.js';
import {createStoredAssetLoader} from '../../src/data/stored-asset-loader.js';
import {loadVerifiedCore} from '../../src/runtime/core-wasm-loader.js';
import {decodeCountryMesh, encodeCountryMesh} from '../../src/rendering/country-mesh-codec.js';
import {createApplicationLifecycle} from '../../src/app/application-lifecycle.js';

import {createAdaptiveRenderQualityController, renderQualityProfile, resolveInitialRenderQuality} from '../../src/rendering/adaptive-render-quality.js';

import {boundaryEdgeBoxesInBatches} from '../../src/geometry/boundary-topology.js';

import {hashFileInChunks,loadBoundedCurrentWorld} from '../../tools/data/current-world-bounded-loader.mjs';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('Viewer policy is a fixed read-only globe contract',()=>{
  assert.equal(viewerPolicy.projection,'globe');
  assert.throws(()=>viewerPolicy.assertProjection('flat'));
  assert.throws(()=>viewerPolicy.assertOperation('core.document-edit'));
  assert.doesNotThrow(()=>viewerPolicy.assertOperation('core.document-load'));
});

test('frame admission rejects mismatched and deferred render certificates',()=>{
  const session=createMapPresentationSession({
    getGeneration:()=>3,getContextRevision:()=>8,isDisposed:()=>false,
    getReadiness:()=>({mapReady:true}),invalidateFrame:()=>{},
    prepareContentKey:async()=>null,isProjectBlocked:()=>false,
    isRecoveryFrameAdmissible:()=>true,waitForCanonicalFrame:async()=>true,
  });
  const frame={frameId:21,viewRevision:12,projectionRevision:4,projectGeneration:3};
  const drawn={succeeded:true,frameId:21,viewRevision:12,projectionRevision:4};
  assert.equal(session.canPresentVisualFrame(frame,drawn),true);
  assert.equal(session.canPresentVisualFrame(frame,{...drawn,presentationReady:false}),false,
    'a rendered frame may still lack mandatory visible resources');
  assert.equal(session.canPresentVisualFrame(frame,{...drawn,frameId:20}),false);
  assert.equal(session.canPresentVisualFrame(frame,{...drawn,viewRevision:11}),false);
  assert.equal(session.canPresentVisualFrame(frame,{...drawn,projectionRevision:3}),false);
  assert.equal(session.canPresentVisualFrame(frame,{...drawn,deferred:true}),false);
  assert.equal(session.canPresentVisualFrame(frame,{...drawn,succeeded:false}),false);
  assert.equal(session.canPresentVisualFrame({...frame,projectGeneration:2}),false);
  session.dispose();
});

test('render quality preserves native DPR and responds only to sustained active-frame evidence',()=>{
  assert.equal(resolveInitialRenderQuality({}), 'medium');
  assert.equal(resolveInitialRenderQuality({deviceMemory:4}), 'coarse');
  assert.equal(resolveInitialRenderQuality({mobile:true}), 'medium');
  assert.equal(resolveInitialRenderQuality({mobile:true,deviceMemory:8,hardwareConcurrency:8}), 'high');
  assert.equal(resolveInitialRenderQuality({mobile:true,deviceMemory:4,hardwareConcurrency:8}), 'coarse');
  const low=renderQualityProfile('coarse',{devicePixelRatio:2.625}),
    normal=renderQualityProfile('medium',{devicePixelRatio:2.625}),
    high=renderQualityProfile('high',{devicePixelRatio:2.625});
  assert.deepEqual([low.dprCap,normal.dprCap,high.dprCap],[2.625,2.625,2.625]);
  assert.equal(renderQualityProfile('medium',{phase:'interaction',devicePixelRatio:2.625}).dprCap,2.625);
  assert.deepEqual([low.labelCandidateLimit,normal.labelCandidateLimit,high.labelCandidateLimit],[128,256,512]);
  for(const obsolete of ['geometryErrorPx','activeEditLod','selectedLod','backgroundLod','gpuCacheBudgetBytes','cpuCacheBudgetBytes','uploadBudgetBytes','renderPacketCacheBudgetBytes'])
    assert.equal(Object.hasOwn(normal,obsolete),false,'Retired GPU quality budget should not be exposed: '+obsolete);
  assert.deepEqual(normal.metrics,{p95FrameMs:0,p99FrameMs:0,longFrameCount:0});
  let clock=0;
  const quality=createAdaptiveRenderQualityController({now:()=>clock,devicePixelRatio:2.625,mobile:true});
  assert.equal(quality.profile().dprCap,2.625,'mobile startup has no artificial backing cap');
  quality.beginInteraction();
  assert.equal(quality.profile().dprCap,2.625,'a gesture alone does not lower DPR');
  for(let i=0;i<40;i++){clock+=50;quality.recordFrame(3,{frameIntervalMs:50});}
  assert.equal(quality.profile().tier,'coarse','slow GPU cadence matters even when CPU submission is cheap');
  assert.equal(quality.profile().dprCap,2.625,'slow frames must not reduce map resolution');
  for(let i=0;i<80;i++){clock+=50;quality.recordFrame(3,{frameIntervalMs:50});}
  assert.equal(quality.profile().dprCap,2.625,'sustained slow frames retain native resolution');
  const activeFrameMetrics=quality.profile().metrics;
  for(let i=0;i<120;i++){clock+=16;quality.recordFrame(3,{frameIntervalMs:16,suspended:true});}
  assert.equal(quality.stats().sampleCount,60,'hidden or waiting frames do not influence quality');
  assert.deepEqual(quality.profile().metrics,activeFrameMetrics,'suspended samples must not replace the full active-frame window');
  quality.endInteraction();
  clock+=16000;
  for(let i=0;i<180;i++){clock+=16;quality.recordFrame(3,{frameIntervalMs:16,memoryPressure:true});}
  assert.equal(quality.profile().tier,'coarse','cache pressure prevents promotion');
  for(let i=0;i<180;i++){clock+=16;quality.recordFrame(3,{frameIntervalMs:16});}
  assert.equal(quality.profile().tier,'coarse','promotion needs fifteen seconds of continuously stable evidence');
  clock+=16000;
  for(let i=0;i<20;i++){clock+=16;quality.recordFrame(3,{frameIntervalMs:16});}
  assert.equal(quality.profile().tier,'coarse','idle time cannot qualify promotion');
  for(let i=0;i<1000;i++){clock+=16;quality.recordFrame(3,{frameIntervalMs:16});}
  assert.equal(quality.profile().tier,'medium');
  assert.equal(quality.profile().dprCap,2.625,'tier changes keep native resolution');
  quality.beginInteraction();
  for(let i=0;i<1000;i++){clock+=16;quality.recordFrame(3,{frameIntervalMs:16});}
  assert.equal(quality.profile().tier,'medium','promotion waits for interaction to end');
  quality.endInteraction();
  assert.equal(quality.profile().tier,'high','settling uses existing stable evidence without idle benchmark frames');
  assert.equal(quality.profile().dprCap,2.625,'settling keeps native resolution');
});

test('quality samples retain slow active display cadence and exclude suspended stability',()=>{
  const previous={performance:globalThis.performance,window:globalThis.window,document:globalThis.document};let clock=0;
  Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>clock}});globalThis.window={};globalThis.document={hidden:false};
  try {
    for(const interval of [100,1200]){
      const q=createAdaptiveRenderQualityController({now:()=>clock});
      for(let i=0;i<60;i++){clock+=interval;q.recordFrame(2,{frameIntervalMs:interval,suspended:false});}
      assert.equal(q.profile().tier,'coarse','slow display must degrade even beyond one second');
    }
    const q=createAdaptiveRenderQualityController({now:()=>clock});q.beginInteraction();
    for(let i=0;i<120;i++){clock+=16;q.recordFrame(2,{frameIntervalMs:16});}
    clock+=20000;q.recordFrame(2,{suspended:true});q.endInteraction();
    assert.equal(q.profile().tier,'medium','hidden time must not qualify a promotion');
  } finally {Object.defineProperty(globalThis,'performance',{configurable:true,value:previous.performance});globalThis.window=previous.window;globalThis.document=previous.document;}
});

// A small synthetic document exercises dated Core queries without a mounted catalog.
const fixture = new URL('../fixtures/timeline-exchange/complex.json', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let corePromise;
const core = () => corePromise ||= loadNodeCore();
const readFixture = () => JSON.parse(readFileSync(fixture,'utf8'));
async function sessionFor(project) {
  const session = new (await core()).DocumentSession({validateFlagDataUrl(){}});
  try { session.documentLoad(JSON.stringify(project),'1914-07'); return session; }
  catch(error) { session.delete(); throw error; }
}
function workerPort() {
  return {messages:[], postMessage(value){this.messages.push(value);}, terminate(){this.terminated=true;}};
}
function reply(request,result,extra={}) {
  return {rpc:WORKER_RPC_PROTOCOL,protocolVersion:WORKER_RPC_PROTOCOL_VERSION,type:'result',
    requestId:request.requestId,operation:request.operation,projectRevision:request.projectRevision,
    ok:true,result,...extra};
}
async function wasmFixture() {
  const js = new TextEncoder().encode('verified factory bytes');
  const wasm = new Uint8Array([0,97,115,109]);
  const manifest = {schema:'pandoeditor-core-wasm',abiVersion:1,sourceSha256:'a'.repeat(64),
    compiler:{name:'emscripten',version:'6.0.3'},inputs:[],assets:{
      js:{file:'pandoeditor-core.js',sha256:hash(js)},wasm:{file:'pandoeditor-core.wasm',sha256:hash(wasm)}}};
  let factories=0;
  const options = {baseUrl:new URL('https://fixture.invalid/wasm/'),subtle:webcrypto.subtle,
    fetchAsset:async url => String(url).endsWith('manifest.json') ? Response.json(manifest)
      : new Response(String(url).includes('.wasm') ? wasm : js),
    createModuleUrl:()=> 'blob:verified-core',revokeModuleUrl(){},
    importModule:async()=>({default:async()=>{factories++;return {coreAbiVersion:1,
      coreSourceSha256:'b'.repeat(64),coreCompilerVersion:'6.0.3',DocumentSession:class {}};}})};
  return {options,factories:()=>factories};
}

test('Core preserves month/date precision across BCE and CE without a year zero', async()=>{
  const engine=await core();
  assert.deepEqual(engine.temporalParse('-0001-12').endKey,[-1,12,31]);
  assert.equal(engine.temporalParse('-0001-12').precision,'month');
  assert.equal(engine.temporalParse('0001-01-01').precision,'date');
  assert.deepEqual(engine.temporalParse('0001-01-01').startKey,[1,1,1]);
  assert.equal(engine.temporalShiftMonth('-0001-12',1),'0001-01');
  assert.deepEqual(engine.temporalFollowingDay([-1,12,31]),[1,1,1]);
  assert.equal(engine.temporalMonthEnd('2000-02').canonical,'2000-02-29');
  assert.throws(()=>engine.temporalParse('0000-01'),{code:'PL-TEMPORAL-001'});
});

test('Core time selection resolves the active lifetime, geometry, name and parent together', async()=>{
  const project=readFixture();
  project.timelineRecords.propertyBindings=[
    {id:'name:old',objectRef:{domain:'territorial',id:'B'},validFrom:'1910-01-02',validTo:'1915',
      property:'name',value:{name:'Earlier territory',nameExplicit:true}},
    {id:'name:new',objectRef:{domain:'territorial',id:'B'},validFrom:'1916',validTo:'1920-03',
      property:'name',value:{name:'Later territory',nameExplicit:true}},
  ];
  const session=await sessionFor(project);
  try {
    const world=month=>session.resolveWorld(month,session.projectState().epoch).entities;
    const a=month=>world(month).find(row=>row.objectRef.id==='A');
    const b=month=>world(month).find(row=>row.objectRef.id==='B');
    assert.equal(a('1914-06').geometryRef.version,1);
    assert.equal(a('1914-07').geometryRef.version,2);
    assert.equal(b('1915-12').parentId,'A');
    assert.equal(b('1915-12').properties.name.name,'Earlier territory');
    assert.equal(b('1916-01').parentId,'C');
    assert.equal(b('1916-01').properties.name.name,'Later territory');
    assert.equal(b('1920-03').validTo,'1920-03');
    assert.equal(b('1920-04'),undefined);
  } finally {session.delete();}
});

test('Core timeline geometry catalog rejects incompatible and missing territory geometry', async()=>{
  const engine=await core();
  const project=readFixture();
  const entities=project.territorialEntities.map(row=>({
    objectRef:{domain:'territorial',id:row.id}, entityKind:row.properties.entityKind,
  }));
  const geometryTypes=new Map(project.geometries.map(({id,version,geojson})=>[JSON.stringify([id,version]),geojson.type]));
  const context={entities,geometryType:ref=>geometryTypes.get(JSON.stringify([ref.id,ref.version])) ?? ''};
  const world=engine.timelineResolveWorld(project.timelineRecords,context,'1914-07');
  assert.equal(world.entities.find(row=>row.objectRef.id==='A').geometryRef.version,2);

  const boundRef=project.timelineRecords.geometryBindings[0].geometryRef;
  const boundKey=JSON.stringify([boundRef.id,boundRef.version]);
  geometryTypes.set(boundKey,'LineString');
  assert.throws(()=>engine.timelineNormalizeRecords(project.timelineRecords,context),{code:'TIMELINE_GEOMETRY_TYPE'});
  geometryTypes.delete(boundKey);
  assert.throws(()=>engine.timelineNormalizeRecords(project.timelineRecords,context),{code:'TIMELINE_GEOMETRY'});
});

test('Core replacement rollback restores the document and timeline cursor', async()=>{
  const session=await sessionFor(readFixture());
  try {
    const before=session.projectState(),stored=session.storageSnapshot();
    const replacement=session.captureReplacement(before.epoch);
    session.setTimelineCursor('1916-01',before.epoch);
    assert.equal(session.projectState().timelineCursor,'1916-01');
    const restored=session.rollbackReplacement(replacement,session.projectState().epoch);
    assert.equal(restored.timelineCursor,before.timelineCursor);
    assert.equal(session.storageSnapshot(),stored);
  } finally {session.delete();}
});

test('Core preserves document identity, coordinates, time and provenance', async()=>{
  const project=readFixture(),session=await sessionFor(project);
  try {
    const stored=JSON.parse(session.storageSnapshot());
    assert.equal(stored.documentId,'ac86aaa8-4f4a-5a94-bb06-912bf7851f74');
    assert.deepEqual(stored.territorialEntities.map(row=>row.id),['A','B','C','R']);
    assert.equal(stored.geometries.find(row=>row.id==='shape'&&row.version===2).geojson.coordinates[0][2][0],1.2345678901234567);
    assert.deepEqual(stored.timelineRecords.lifetimes.find(row=>row.id==='B:ancient'),
      {id:'B:ancient',objectRef:{domain:'territorial',id:'B'},validFrom:'-0001',validTo:'0001'});
    assert.deepEqual(stored.territorialEntities[0].properties.metadata.source,
      {provider:'T2-2 exchange corpus',sourceId:'A'});
    assert.equal(stored.territorialEntities[0].properties.sourceEntityId,'timeline-test');
    assert.deepEqual(stored.geometries,project.geometries);
    assert.deepEqual(stored.timelineRecords,project.timelineRecords);
  } finally {session.delete();}
});

test('failed Worker request settles with its operation error and releases pending work', async()=>{
  const worker=workerPort(),client=createWorkerRpcClient({createWorker:()=>worker});
  try {
    const pending=client.request('geometry.mesh',{});
    worker.onmessage({data:reply(worker.messages[0],null,{ok:false,
      error:{message:'mesh preparation failed',code:'MESH_FAILURE',category:'OPERATION',stack:'worker:mesh'}})});
    await assert.rejects(pending,error=>error.code==='MESH_FAILURE' && error.message==='mesh preparation failed'
      && error.category==='OPERATION' && error.cause.stack==='worker:mesh');
    assert.equal(client.stats().pendingCount,0);
  } finally {client.stop();}
});

test('Worker RPC messageerror rejects every pending request as outcome unknown and does not replay', async()=>{
  const workers=[];
  const client=createWorkerRpcClient({createWorker:()=>{const worker=workerPort();workers.push(worker);return worker;}});
  try {
    const first=client.request('first', null, {timeoutMs:0});
    const second=client.request('second', null, {timeoutMs:0});
    const pending=Promise.allSettled([first,second]);
    const discarded=workers[0].onmessage;
    workers[0].onmessageerror(new Event('messageerror'));
    const failure=await pending;
    assert.deepEqual(failure.map(({status,reason})=>[status,reason.code,reason.operation,reason.requestId,reason.outcomeUnknown]),
      [['rejected','PL-WORKER-RPC-MESSAGEERROR','first',1,true],['rejected','PL-WORKER-RPC-MESSAGEERROR','second',2,true]]);
    assert.equal(workers[0].terminated,true);
    assert.equal(client.stats().pendingCount,0);
    const third=client.request('third',null,{timeoutMs:0});
    assert.deepEqual(workers[1].messages.map(({operation})=>operation),['third']);
    const response={data:reply(workers[1].messages[0],'fresh')};
    discarded(response);
    assert.equal(client.stats().pendingCount,1);
    workers[1].onmessage(response);
    assert.equal((await third).result,'fresh');
    assert.equal(client.stats().restarted,1);
  } finally {client.stop();}
});

test('Worker RPC honors restartOnCrash false after retiring a crashed worker',async()=>{
  let instances=0;
  const worker=workerPort();
  const client=createWorkerRpcClient({restartOnCrash:false,createWorker:()=>{instances++;return worker;}});
  try {
    const pending=client.request('write',null,{timeoutMs:0});
    const rejection=assert.rejects(pending,{code:'PL-WORKER-RPC-CRASH',outcomeUnknown:true});
    worker.onerror(new Event('error'));
    await rejection;
    await assert.rejects(client.request('read',null,{timeoutMs:0}),{code:'PL-WORKER-RPC-RESTART-DISABLED'});
    assert.equal(instances,1);
  } finally {client.stop();}
});

test('Worker RPC host reports an uncloneable reply and preserves synchronous event errors',async()=>{
  const worker=workerPort(),events=[];
  const scope={AbortController,postMessage(data,transfer){
    const message=structuredClone(data,{transfer:transfer??[]});
    queueMicrotask(()=>worker.onmessage?.({data:message}));
  }};
  scope.self=scope;
  vm.runInNewContext(readFileSync(new URL('../../src/runtime/workers/worker-rpc-host.js',import.meta.url),'utf8'),scope);
  scope.PandoLabWorkerRpc.install({handlers:{write(){return ()=>{};}},onEvent(){throw new Error('event failed');}});
  worker.postMessage=data=>scope.onmessage({data});
  const client=createWorkerRpcClient({createWorker:()=>worker,onEvent:event=>events.push(event)});
  try {
    assert.doesNotThrow(()=>client.notify('test-event'));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(events[0].operation,'worker-rpc.event-error');
    assert.equal(events[0].payload.error.message,'event failed');
    await assert.rejects(client.request('write',null,{timeoutMs:100}),
      {code:'PL-WORKER-RPC-MESSAGEERROR',operation:'write',outcomeUnknown:true});
    assert.equal(worker.terminated,true);
  } finally {client.stop();}
});

test('late Worker result cannot overwrite a newer accepted project state', async()=>{
  const worker=workerPort();let revision=1,accepted;
  const client=createWorkerRpcClient({createWorker:()=>worker,getProjectRevision:()=>revision});
  try {
    const old=client.request('geometry.mesh',{}).then(value=>{accepted=value.result;});
    const rejected=assert.rejects(old,{category:'STALE_RESULT'});
    revision=2;
    const current=client.request('geometry.mesh',{}).then(value=>{accepted=value.result;});
    worker.onmessage({data:reply(worker.messages[1],{geometry:'current'})});await current;
    worker.onmessage({data:reply(worker.messages[0],{geometry:'obsolete'})});await rejected;
    assert.deepEqual(accepted,{geometry:'current'});
    assert.equal(client.stats().pendingCount,0);
    assert.equal(client.stats().staleDiscarded,1);
  } finally {client.stop();}
});

test('selected project catalog rejects a receipt for a different pinned catalog path',()=>{
  const mapProject=JSON.parse(readFileSync(new URL('../../projects/default-world/manifest.json',import.meta.url)));
  const catalog=mapProject.resources.physicalLand.catalog;
  const meta={mapProject,projectCatalogs:{physicalLand:{catalog,sha256:'a'.repeat(64),bytes:16}}};
  assert.equal(mapProjectCatalogSpec(meta,'physicalLand').url,catalog);
  meta.projectCatalogs.physicalLand.catalog='assets/data/physical-land/other-pin/manifest.json';
  assert.throws(()=>mapProjectCatalogSpec(meta,'physicalLand'),/verified project catalog receipt/);
});

test('stored resource hash rejects corrupt bytes before decoded data is admitted', async()=>{
  let decoded=0;
  const loader=createStoredAssetLoader({dataRevision:'fixture-pin',resolveUrl:()=> 'https://fixture.invalid/catalog',
    cacheStorage:null,subtle:webcrypto.subtle,fetchFn:async()=>new Response('bad!')});
  await assert.rejects(loader.loadAsset({encoding:'identity',compressedBytes:4,decodedBytes:4,sha256:hash('good')},
    'background','catalog','catalog',()=>{decoded++;return {}; }),/무결성/);
  assert.equal(decoded,0);
});

test('Core loader rejects stale compiled source identity despite valid paired byte hashes', async()=>{
  const fixture=await wasmFixture();
  await assert.rejects(loadVerifiedCore(fixture.options),{code:'PL-CORE-WASM-ABI'});
  assert.equal(fixture.factories(),1);
});

test('mesh decoder rejects corrupt range metadata from an otherwise valid packed mesh',()=>{
  const mesh={positions:new Int32Array([0,0,1,0,0,1]),countryIndices:new Uint16Array([0,0,0]),
    triangleIndices:new Uint32Array([0,1,2]),lineIndices:new Uint32Array([0,1]),
    countryTriangleRanges:new Uint32Array([0,3]),countryBoundaryRanges:new Uint32Array([0,2]),
    countryBounds:new Int32Array([0,0,1,1]),countryBoundsFlags:new Uint32Array([1])};
  const packed=encodeCountryMesh(mesh,['A'],3);
  assert.deepEqual([...decodeCountryMesh(packed,['A']).mesh.triangleIndices],[0,1,2]);
  new Uint32Array(packed,0,12)[8]=0;
  assert.throws(()=>decodeCountryMesh(packed,['A']),/메타데이터가 손상/);
});

test('required physical resource failure ends startup loading with an error and releases resources', async()=>{
  const network=Promise.withResolvers(),requested=Promise.withResolvers();
  const errors=[],events=[];let disposed=0,ready=0;
  const window=new EventTarget();window.CustomEvent=CustomEvent;
  window.addEventListener('pandolab:ready',()=>events.push('ready'));
  window.addEventListener('pandolab:error',event=>events.push(event.detail));
  const spec={url:'https://fixture.invalid/globe/water.bin',encoding:'identity',sha256:hash('{}'),compressedBytes:2};
  const loader=createStoredAssetLoader({dataRevision:'selected-pin',cachePolicy:'immutable',resolveUrl:asset=>asset.url,
    cacheStorage:null,subtle:webcrypto.subtle,fetchFn:()=>{requested.resolve();return network.promise;}});
  let admitted=false;
  const lifecycle=createApplicationLifecycle({window,startup:async()=>{
    await loader.loadAsset(spec,'startup','water','Water surface',bytes=>bytes);
    admitted=true;
  },
    onReady:()=>{ready++;},onError:error=>errors.push(error),
    getDisposables:()=>[{dispose(){disposed++;}}]});
  try {
    const completion=lifecycle.start();
    await requested.promise;
    assert.equal(ready,0);assert.equal(disposed,0);assert.equal(admitted,false);
    network.resolve(new Response('missing',{status:404}));
    assert.equal(await completion,false,'required resource rejection settles the startup attempt');
    assert.equal(errors.length,1);assert.match(errors[0].message,/404/);
    assert.deepEqual(events,[errors[0].message],'error event replaces the ready event');
    assert.equal(ready,0);assert.equal(disposed,1);assert.equal(admitted,false);
    assert.equal(await lifecycle.start(),false,'a failed disposed startup cannot remain pending');
  } finally {lifecycle.dispose();}
});

test('bounded current-world loader hashes bytes without a whole-file string and preserves ordinary project sources',()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'pando-current-world-'));
  try {
    const filename=path.join(folder,'source.geojson');
    const source={type:'FeatureCollection',features:[{type:'Feature',id:'A',
      geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]},
      properties:{name:'Fixture'}}],bbox:[0,0,1,1]};
    const bytes=Buffer.from(JSON.stringify(source)+'\n','utf8');
    writeFileSync(filename,bytes);
    assert.deepEqual(loadBoundedCurrentWorld(filename),source);
    const result=hashFileInChunks(filename,{chunkBytes:7});
    assert.deepEqual(result,{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
    assert.throws(()=>hashFileInChunks(filename,{chunkBytes:0}),/Invalid file hash chunk size/);
  } finally {rmSync(folder,{recursive:true,force:true});}
});

test('native boundary edge boxes are chunked without deleting or reordering GIS edges',()=>{
  const rows=Array.from({length:7},(_,n)=>({a:[n,0],b:[n+1,1]})),sizes=[];
  const result=boundaryEdgeBoxesInBatches(rows,{batchSize:3,calculate:batch=>{
    sizes.push(batch.length);
    return batch.map(([a,b])=>[[a[0],a[1],b[0],b[1]]]);
  }});
  assert.deepEqual(sizes,[3,3,1]);
  assert.deepEqual(result,rows.map(({a,b})=>[[...a,...b]]));
  assert.throws(()=>boundaryEdgeBoxesInBatches(rows,{batchSize:1_000_001,calculate:()=>[]}),/Invalid native boundary edge batch size/);
  assert.throws(()=>boundaryEdgeBoxesInBatches(rows,{batchSize:2,calculate:()=>[]}),/Native boundary edge box count mismatch/);
});

test('Viewer view storage keeps the revision-scoped view and project-scoped camera separate',async()=>{
 const {createViewerViewStorage}=await import('../../src/data/browser-project-storage.js');
 const written=[];
 let camera={projection:'globe',center:[20,100],zoom:3,bearing:0,pitch:0,roll:0};
 const storage={writeView:v=>written.push(['view',v]),writeCamera:(id,v)=>written.push(['camera',id,v]),
  readView:id=>({documentId:id}),readCamera:()=>camera};
 const owner=createViewerViewStorage({storage,projectId:'world',dataRevision:'rev',now:()=> 'date'});
 await owner.writeView({x:1},camera);
 assert.deepEqual(written[0],['view',{documentId:'map-project:world:rev',viewingPresentation:{x:1},savedAt:'date'}]);
 assert.deepEqual(written[1],['camera','world',camera]);
 assert.deepEqual(await owner.readView(),{documentId:'map-project:world:rev'});
 assert.deepEqual(await owner.readCamera(),{globeRotation:[-20,-90,0],zoom:3,bearing:0,pitch:0,roll:0});
 camera={projection:'flat',center:[20,20],zoom:3};
 assert.equal(await owner.readCamera(),null);
});

test('Viewer loading notice owns one accessible retry button',async()=>{
 const {presentViewerLoadStatus}=await import('../../src/app/viewer-load-status.js');
 const attributes={},children=[];let retries=0;
 const element={ownerDocument:{createElement:()=>({addEventListener:(type,fn)=>{assert.equal(type,'click');children.push(fn);}})},
  setAttribute:(key,value)=>{attributes[key]=value;},appendChild:button=>{assert.equal(button.type,'button');}};
 presentViewerLoadStatus(element,'retry',{error:true,retry:()=>retries++});
 assert.equal(attributes.role,'alert');assert.equal(children.length,1);
 children[0]();assert.equal(retries,1);
 presentViewerLoadStatus(element,'loading');
 assert.equal(attributes.role,'status');
});

test('distribution hierarchy normalization shares the compiled Core reference graph',async()=>{
 const {normalizeDistributionLayers}=await import('../../src/document/distribution-model.js');
 const layer=(id,parentId='')=>({id,parentId,schemaVersion:3});
 assert.deepEqual(normalizeDistributionLayers([layer('root'),layer('leaf','root')]).map(row=>row.id),['root','leaf']);
 assert.throws(()=>normalizeDistributionLayers([layer('leaf','missing')]),/leaf의 상위 분포 레이어가 존재하지 않거나/);
 assert.throws(()=>normalizeDistributionLayers([layer('self','self')]),/self의 상위 분포 레이어가 존재하지 않거나/);
 assert.throws(()=>normalizeDistributionLayers([layer('a','b'),layer('b','a')]),/a의 상위 분포 레이어 관계가 순환/);
 assert.throws(()=>normalizeDistributionLayers([layer('a','b'),layer('b','missing')]),/b의 상위 분포 레이어가 존재하지 않거나/);
});

test('Viewer resource capabilities are fixed and cannot be overridden by platform modes',async()=>{
 const {VIEWER_RESOURCE_CAPABILITIES}=await import('../../src/runtime/resource-capabilities.js');
 assert.equal(VIEWER_RESOURCE_CAPABILITIES.eagerBuiltinHydro,true);
 assert.equal(VIEWER_RESOURCE_CAPABILITIES.eagerBuiltinPlaces,true);
 assert.equal(VIEWER_RESOURCE_CAPABILITIES.builtinHydro,true);
 assert.equal(VIEWER_RESOURCE_CAPABILITIES.builtinPlaces,true);
 assert.equal(Object.isFrozen(VIEWER_RESOURCE_CAPABILITIES),true);
});

test('reference graph diagnostics share the compiled chain kernel for authoring and distribution validation',async()=>{
 const {graphDiagnostics}=await import('../../src/document/reference-graph-diagnostics.js');
 const rows=[{id:' a ',parent:'b'},{id:'b',parent:'a'},{id:'c',parent:'missing'}];
 const result=graphDiagnostics(rows,row=>row.id,row=>row.parent);
 assert.equal(result[0].cycle,true);assert.equal(result[1].cycle,true);
 assert.equal(result[2].missing,true);
});

test('current document calculation and external Toolkit bindings retain the compiled public ABI',async()=>{
  const {sharedCalculationCore:core}=await import('../../src/document/temporal.js');
  for(const name of ["sphericalRingSignedArea","validateTerritorialRing","validateClippedTerritorialRing","referenceGraphDiagnostics","planGisCountryMerge","planGisCountryGeometry","gisCountryMergeCanCommit","resolveTerritorialRoot","sphericalRingSignedAreas","temporalParse","temporalMonthEnd","temporalCompare","temporalNormalizeInterval","temporalContains","temporalIntervalsOverlap","temporalShiftMonth","temporalCompareKeys","temporalFollowingDay","normalizePolygonGeometry","normalizePolygonRing","hasCanonicalPolygonWinding","hasCanonicalClippedPolygonWinding"])assert.equal(typeof core[name],'function',name);
  assert.equal(typeof core.DocumentSession,'function');
  for(const name of ['referenceImageCalculate','referenceImagePlacement','referenceGradientField','referenceSnapAnchor',
    'referenceTraceTree','referenceTracePath','referenceSimplifyTrace','referenceRefineTrace','referenceBoundaryGraph','PreparedReferenceImageWarp'])
    assert.equal(typeof core[name],'function',name);
  for(const name of ['timelineInitialMonth','distributionReferenceDiagnostics'])assert.equal(core[name],undefined,name);
  assert.equal(core.DocumentSession.prototype.admitExternalBaseline,undefined);
  assert.equal(core.coreAbiVersion,1);
  assert.equal(core.temporalCompareKeys([2020,1,1],[2020,1,2]),-1);
  assert.equal(core.referenceGraphDiagnostics(['a','b'],['b','a'])[0].cycle,true);
});

test('the actual WASM runtime publishes immutable dated read models with epoch-pinned receipts',async()=>{
 const {createDocumentSessionRuntime}=await import('../../src/document/core-document-runtime.js');
 const {createCoreDocumentReadModel}=await import('../../src/document/core-document-read-model.js');
 const fixture=readFixture(),model=createCoreDocumentReadModel(fixture);
 const runtime=createDocumentSessionRuntime({loadModule:core,validateFlagDataUrl(){},currentMonth:()=> '2026-10'});
 const context={throwIfCancelled(){}};
 try{
  const loaded=await runtime.load({storageJson:JSON.stringify(fixture)},context);
  model.acceptTransition(loaded,'core.document-load');
  const move=async month=>{
   const result=await runtime.setTimelineCursor({month,expectedEpoch:model.world().sourceEpoch},context);
   model.acceptTransition(result,'core.document-timeline-cursor');
   assert.equal(model.world().month,month);
   assert.equal(model.world().sourceEpoch,result.state.epoch);
   return result;
  };
  await move('1914-07');
  const previous=model.world(),snapshot=model.snapshot(),geometry=model.geometry({id:'shape',version:2});
  assert.equal(previous.byId.get('B').parentId,'A');
  const result=await move('1916-01');
  const accepted=model.world();
  assert.equal(accepted.byId.get('B').parentId,'C');
  assert.equal(previous.byId.get('B').parentId,'A');
  assert.equal(previous.month,'1914-07');
  assert.ok(Object.isFrozen(previous.entities));
  assert.equal(model.geometry({id:'shape',version:2}),geometry);
  assert.equal(model.snapshot().documentId,snapshot.documentId);
  assert.throws(()=>model.projectWorld(loaded.world,result.state.epoch),{code:'PL-CORE-STALE'});
  assert.equal(model.world(),accepted);
 }finally{await runtime.dispose();}
});

test('retiring a stateless Worker lane cannot cancel the replacement owner',async()=>{
 const {createStatelessWorkerLane}=await import('../../src/runtime/stateless-worker-lane.js');
 const workers=[];
 const lane=createStatelessWorkerLane(()=>{const worker=workerPort();workers.push(worker);return worker;},1000);
 try{
  const first=lane.acquire();
  const retired=first.request('packet.old',null,{timeoutMs:0});
  const rejected=assert.rejects(retired,{code:'PL-WORKER-RPC-CANCELLED'});
  lane.retire(first,'superseded');await rejected;
  assert.equal(workers[0].terminated,true);
  const next=lane.acquire();
  assert.notEqual(next,first);
  const current=next.request('packet.current',null,{timeoutMs:0});
  lane.retire(first,'late cleanup');
  assert.equal(lane.acquire(),next);
  assert.equal(workers[1].terminated,undefined);
  workers[1].onmessage({data:reply(workers[1].messages[0],'accepted')});
  assert.equal((await current).result,'accepted');
  assert.equal(next.stats().pendingCount,0);
 }finally{lane.dispose('test-complete');}
 assert.equal(lane.active,false);assert.equal(workers[1].terminated,true);
});

test('retired pending requests and cancelled consumers cannot remove a newer shared request',async()=>{
 const {trackPending,waitForConsumer}=await import('../../src/runtime/async-request.js');
 const entries=new Map(),old=Promise.withResolvers(),next=Promise.withResolvers();
 const first=trackPending(entries,'resource',old.promise);
 const current=trackPending(entries,'resource',next.promise);
 const cancelled=new AbortController();
 const detached=waitForConsumer(current,cancelled.signal);
 const rejected=assert.rejects(detached,{name:'AbortError'});
 cancelled.abort();await rejected;
 old.resolve('obsolete');assert.equal(await first,'obsolete');
 assert.equal(entries.get('resource'),current);
 next.resolve('accepted');assert.equal(await current,'accepted');
 assert.equal(entries.has('resource'),false);
});

test('shared LRU trimming preserves leased resources and disposes only the actual victims',async()=>{
 const {setLruEntry,touchLruEntry,trimLruEntries}=await import('../../src/runtime/lru-cache.js');
 const entries=new Map(),disposed=[];
 for(const key of ['published','recent','old'])setLruEntry(entries,key,{bytes:8});
 touchLruEntry(entries,'recent');
 const bytes=trimLruEntries(entries,new Set(['published']),16,entry=>entry.bytes,key=>disposed.push(key));
 assert.equal(bytes,16);
 assert.deepEqual([...entries.keys()],['published','recent']);
 assert.deepEqual(disposed,['old']);
});
