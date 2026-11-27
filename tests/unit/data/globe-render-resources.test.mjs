import test from 'node:test';
import assert from 'node:assert/strict';

test('render packet cache retains published inputs, shares pending reads and reloads evicted data', async () => {
  const {createRenderPacketCache}=await import('../../../src/rendering/render-cache-budget.js');
  const cache=createRenderPacketCache({byteBudget:16});
  const reads=[];
  const read=key=>cache.read(key,async()=>{reads.push(key);return {packet:{positions:new Float32Array(2)}};});
  cache.retain(['published']);
  const first=read('published');
  assert.equal(read('published'),first);
  await first;
  await read('old');
  await read('new');
  assert.equal(cache.has('published'),true);
  assert.equal(cache.has('old'),false);
  assert.equal(cache.has('new'),true);
  await read('old');
  assert.deepEqual(reads,['published','old','new','old']);
  cache.retain(['published','old','new']);
  await read('new');
  assert.equal(cache.stats().residentBytes,24);
  await read('new');
  assert.equal(cache.stats().hits,1);
  assert.equal(cache.stats().joinedPending,1);
  assert.equal(cache.stats().misses,5);
  assert.equal(cache.stats().evicted,2);
  cache.retain(['new']);
  assert.equal(cache.stats().residentBytes,16);
  cache.dispose();
  assert.equal(cache.stats().entries,0);
});

test('obsolete packet consumers cancel only their own reads until the final waiter leaves',async()=>{
  const {createRenderPacketCache}=await import('../../../src/rendering/render-cache-budget.js');
  const cache=createRenderPacketCache({byteBudget:64});
  const a=new AbortController(),b=new AbortController();
  let signal,resolve;
  const load=readSignal=>{signal=readSignal;return new Promise(done=>{resolve=done;});};
  const first=cache.read('shared',load,a.signal),second=cache.read('shared',load,b.signal);
  await Promise.resolve();
  a.abort();await assert.rejects(first,{name:'AbortError'});
  assert.equal(signal.aborted,false);
  resolve({positions:new Float32Array(2)});
  await second;
  const c=new AbortController();
  const stale=cache.read('stale',readSignal=>new Promise((_,reject)=>{
    signal=readSignal;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  }),c.signal);
  await Promise.resolve();c.abort();await assert.rejects(stale,{name:'AbortError'});
  await Promise.resolve();
  assert.equal(signal.aborted,true);assert.equal(cache.has('stale'),false);
  cache.dispose();
});

test('global residency counts shared CPU backing stores once and protects published entries',async()=>{
  const {createRenderResidencyBudget}=await import('../../../src/rendering/render-cache-budget.js');
  const shared=new ArrayBuffer(16),standby=new ArrayBuffer(8);
  let evicted=false;
  const budget=createRenderResidencyBudget(24);
  budget.register(()=>[{buffers:new Set([shared]),protected:true,extraBytes:4},{buffers:new Set([shared]),protected:true,extraBytes:4},
    ...(!evicted?[{buffers:new Set([standby]),protected:false,lastUsed:0,evict:()=>{evicted=true;}}]:[])]);
  const stats=budget.trim();
  assert.equal(stats.cpuBytes,16);assert.equal(stats.residentBytes,24);assert.equal(evicted,true);
});

test('load gate bounds queued work and cancels a superseded waiter',async()=>{
  const {createRenderLoadGate}=await import('../../../src/rendering/render-cache-budget.js');
  const gate=createRenderLoadGate({concurrency:2,byteBudget:10});
  const first=Promise.withResolvers(),controller=new AbortController();
  const running=gate.run({bytes:8},()=>first.promise);
  const cancelled=gate.run({bytes:5,signal:controller.signal},()=>assert.fail('cancelled job ran'));
  controller.abort();await assert.rejects(cancelled,{name:'AbortError'});
  const next=gate.run({bytes:3},()=>42);
  assert.equal(gate.stats().active,1);
  first.resolve(true);await running;assert.equal(await next,42);
  assert.equal(gate.stats().peakBytes,8);gate.dispose();
});

test('draw compaction writes only changed destination mappings and merges adjacent ranges',async()=>{
 const {planGlobeCompactionUpdates,mergeGlobeDrawRanges}=await import('../../../src/rendering/globe-draw-compaction.js');
 const old=Uint32Array.of(0,4,8,12),next=Uint32Array.of(0,4,9,12);
 assert.deepEqual(planGlobeCompactionUpdates(next,old),[{first:9,end:12,offset:4}]);
 assert.deepEqual(planGlobeCompactionUpdates(old,old),[]);
 assert.deepEqual(planGlobeCompactionUpdates(Uint32Array.of(0,3),old),[]);
 const merged=mergeGlobeDrawRanges([{ranges:Uint32Array.of(0,4),offset:0},{ranges:Uint32Array.of(0,2),offset:4}]);
 assert.deepEqual([...merged.ranges],[0,6]);assert.equal(merged.count,6);
});

test('residency ledger refreshes only invalidated owners and evicts independent standby chunks',async()=>{
 const {createRenderResidencyBudget}=await import('../../../src/rendering/render-cache-budget.js');
 const ledger=createRenderResidencyBudget(40,{groups:{outlineChunk:{byteBudget:8,entryLimit:1,standbyOnly:true}}});
 const shared=new ArrayBuffer(16),base={},chunk={};
 let reads=0,evictions=0;
 const refresh=ledger.register(()=>{reads++;return [{key:'base',buffers:new Set([shared]),protected:true}]});
 ledger.set(base,{buffers:new Set([shared]),protected:true,extraBytes:4});
 ledger.trim();ledger.trim();assert.equal(reads,1);
 ledger.set(chunk,{buffers:new Set([new ArrayBuffer(12)]),protected:false,groups:['outlineChunk'],lastUsed:0,evict:()=>{evictions++;}});
 assert.equal(ledger.trim().residentBytes,20);assert.equal(evictions,1);
 refresh();ledger.trim();assert.equal(reads,2);ledger.dispose();
});

test('packet worker count and speculative gate preserve foreground capacity',async()=>{
 const {globePacketWorkerCount}=await import('../../../src/rendering/globe-packet-tasks.js');
 const {createRenderLoadGate}=await import('../../../src/rendering/render-cache-budget.js');
 assert.equal(globePacketWorkerCount({deviceMemory:2,hardwareConcurrency:8}),1);
 assert.equal(globePacketWorkerCount({deviceMemory:4,hardwareConcurrency:4}),2);
 assert.equal(globePacketWorkerCount({deviceMemory:8,hardwareConcurrency:8}),3);
 const gate=createRenderLoadGate({concurrency:2,byteBudget:100});
 const running=Promise.withResolvers(),order=[];
 const foreground=gate.run({priority:20,bytes:20},()=>running.promise);
 const speculative=gate.run({priority:-20,bytes:20},()=>{order.push('warm');});
 const next=gate.run({priority:20,bytes:20},()=>{order.push('visible');});
 await next;assert.deepEqual(order,['visible']);
 running.resolve();await foreground;await speculative;
 assert.deepEqual(order,['visible','warm']);gate.dispose();
});

test('shared pending packet consumer promotes queued priority before speculative cancellation',async()=>{
 const {createRenderPacketCache}=await import('../../../src/rendering/render-cache-budget.js');
 const cache=createRenderPacketCache({byteBudget:1024}),hold=Promise.withResolvers(),old=new AbortController(),next=new AbortController();
 let readPriority=null,observed=[];
 const speculative=cache.read('same',async(signal,priority)=>{
  readPriority=priority;priority.subscribe(()=>observed.push(priority()));await hold.promise;
  signal.throwIfAborted();return new Uint8Array(8);
 },old.signal,{priority:-20});
 await Promise.resolve();
 const required=cache.read('same',()=>assert.fail('Common packet was loaded twice'),next.signal,{priority:20});
 old.abort();await assert.rejects(speculative,{name:'AbortError'});
 assert.equal(readPriority(),20);assert.deepEqual(observed,[20]);
 hold.resolve();assert.equal((await required).length,8);cache.dispose();
});

test('globe paint owner keeps accepted visibility snapshots and isolates hydro-only updates',async()=>{
 const {createGlobePaintState}=await import('../../../src/rendering/globe-paint-state.js');
 const state={layerPresentation:{},layerVisibility:{}},refs=[{id:'a',key:'territorial:a'}];
 const features=new Map([['a',{color:'#123456'}]]),activeSlots=new Set([0]),activeSlotByKey=new Map([['territorial:a',0]]);
 let visible=true;
 const calls=[];
 const palette={defaultLand:'#aaa',ocean:'#bbb'};
 const owner=createGlobePaintState({state,refs,hydroSlots:new Map(),readPalette:()=>palette,
  territorialColor:row=>row.color,objectRefVisible:()=>visible,highlightCandidates:()=>[],
  onPickingChanged:()=>{},onOutlineRolesChanged:()=>{}});
 const surface={setPalette(){},setCountryPaint:()=>calls.push('country'),setHydroPaint:()=>calls.push('hydro'),setLayerVisibility(){}};
 const context={activeSlots,activeSlotByKey,features,bordersNeeded:()=>true};
 owner.initializePalette();owner.updatePaint(surface,context);
 const accepted=owner.visibleSlots();
 calls.length=0;owner.markHydroStyle();owner.updatePaint(surface,context);
 assert.deepEqual(calls,['hydro']);assert.equal(owner.stats().countrySlots,1);
 visible=false;owner.markCountrySlot(0);owner.updatePaint(surface,context);
 assert.equal(accepted.has(0),true);assert.equal(owner.visibleSlots().has(0),false);
 assert.equal(owner.stats().countrySlots,2);
});

test('shared worker admission orders live priorities and detaches cancelled queued jobs', async () => {
  const {createWorkerAdmissionQueue} = await import('../../../src/runtime/worker-admission-queue.js');
  const pending = createWorkerAdmissionQueue(() => {});
  const order = [], abort = new AbortController();
  let priority = -10, detached = 0;
  const live = () => priority;
  live.subscribe = () => () => {detached++;};
  const jobs = [pending.enqueue({priority:10}, () => order.push('first')),
    pending.enqueue({priority:live}, () => order.push('promoted')),
    pending.enqueue({priority:100, signal:abort.signal}, () => assert.fail('cancelled work ran'))];
  const cancelled = assert.rejects(jobs[2], {name:'AbortError'});
  abort.abort();
  priority = 20;
  pending.sort();
  while (pending.rows.length) {
    const row = pending.take();
    row.resolve(row.task());
  }
  await Promise.all([jobs[0], jobs[1], cancelled]);
  assert.deepEqual(order, ['promoted', 'first']);
  assert.equal(detached, 1);
});

test('GPU footprint counts shared attributes once and disposal keeps borrowed textures alive', async () => {
  const {gpuResourceFootprint, disposeGlobeGpuResources} = await import('../../../src/rendering/globe-gpu-resources.js');
  const {renderFootprintBytes} = await import('../../../src/rendering/render-cache-budget.js');
  const positions = {array:new Float32Array(3)}, index = {array:new Uint16Array(3)};
  const disposed = [];
  const a = {attributes:{position:positions}, index, dispose:() => disposed.push('a')};
  const b = {attributes:{position:positions}, index:null, dispose:() => disposed.push('b')};
  const material = {dispose:() => disposed.push('material')};
  const texture = {image:{data:new Uint8Array(4)}, dispose:() => disposed.push('texture')};
  const borrowed = {dispose:() => assert.fail('borrowed texture disposed')};
  material.uniforms = {borrowed:{value:borrowed}};
  const meshes = [{geometry:a, material}, {geometry:b, material:[material]}];
  const row = gpuResourceFootprint([a,b], [texture,texture], [positions.array]);
  assert.equal(row.buffers.size, 3);
  assert.equal(row.extraBytes, 22);
  assert.equal(renderFootprintBytes(row), 44);
  disposeGlobeGpuResources({remove:() => {}}, meshes, {textures:[texture,texture]});
  assert.deepEqual(disposed, ['a','b','material','texture']);
});


test('label SDF recovery stops after bounded local failures and resets only for renewed preparation', async () => {
  const {createGlobeLabelSdfRecovery} = await import('../../../src/rendering/three-globe-labels.js');
  const recovery = createGlobeLabelSdfRecovery();
  const workerFailure = Error('worker failed'), localFailure = Error('local failed');
  assert.equal(recovery.fallback, false);
  assert.equal(recovery.fail(workerFailure), 'fallback');
  assert.equal(recovery.fallback, true);
  assert.equal(recovery.fail(localFailure), 'retry');
  recovery.succeed();
  assert.equal(recovery.localFailures, 0);
  assert.equal(recovery.fail(localFailure), 'retry');
  assert.equal(recovery.fail(localFailure), 'terminal');
  assert.equal(recovery.error, localFailure);
  assert.equal(recovery.fail(Error('unexpected later failure')), 'terminal');
  assert.equal(recovery.localFailures, 2);
  assert.equal(recovery.error, localFailure);
  recovery.reset();
  assert.equal(recovery.error, null);
  assert.equal(recovery.fallback, false);
  assert.equal(recovery.localFailures, 0);
});
