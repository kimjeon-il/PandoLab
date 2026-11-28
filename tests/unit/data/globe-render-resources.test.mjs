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


test('optional globe plans retry on recovered headroom without spinning or blocking required coverage', async () => {
  const {createGlobePlanFailures} = await import('../../../src/rendering/globe-view-mesh-assets.js');
  const {createRenderResidencyBudget, createRenderLoadGate} = await import('../../../src/rendering/render-cache-budget.js');
  const residency = createRenderResidencyBudget(20);
  residency.set('visible', {protected:true, extraBytes:5});
  const gate = createRenderLoadGate({concurrency:1, byteBudget:20, residency});
  let wakes = 0;
  const failures = createGlobePlanFailures({residency, onRetry:() => {wakes++;}});
  async function failUnderPressure() {
    const release = residency.reserve(12);
    const cause = await gate.run({priority:5, bytes:8}, () => assert.fail('over-budget work admitted')).catch(error => error);
    assert.equal(cause.memoryPressure, true);
    assert.equal(cause.requestedBytes, 8);
    assert.equal(failures.fail('margin', false, cause), 'temporary');
    assert.equal(failures.allow('margin', false), false);
    return release;
  }
  assert.equal(failures.allow('margin', false), true);
  (await failUnderPressure())();
  await Promise.resolve();
  assert.equal(wakes, 1);
  assert.equal(failures.allow('margin', false), true);
  (await failUnderPressure())();
  await Promise.resolve();
  assert.equal(wakes, 1, 'same headroom must not cause an endless retry loop');
  assert.equal(failures.allow('margin', false), false);
  residency.set('visible', {protected:true, extraBytes:3});
  await Promise.resolve();
  assert.equal(wakes, 2);
  assert.equal(failures.allow('margin', false), true);
  assert.equal(failures.fail('margin', false, Error('corrupt packet')), 'permanent');
  residency.remove('visible');
  await Promise.resolve();
  assert.equal(wakes, 2);
  assert.equal(failures.allow('margin', false), false);
  assert.equal(failures.allow('margin', true), true);
  const oversize = await gate.run({priority:5, bytes:21}, () => assert.fail('oversized optional work admitted')).catch(error => error);
  assert.equal(failures.fail('margin', false, oversize), 'over-budget');
  assert.equal(failures.allow('margin', false), false);
  assert.equal(failures.allow('different-margin', false), true);
  failures.clear(); gate.dispose(); residency.dispose();
});

test('visible margin loads wait for active reservations before being declined', async () => {
  const {createRenderResidencyBudget, createRenderLoadGate} = await import('../../../src/rendering/render-cache-budget.js');
  const residency = createRenderResidencyBudget(10);
  const gate = createRenderLoadGate({concurrency:2, byteBudget:20, residency});
  const hold = Promise.withResolvers(), order = [];
  const first = gate.run({priority:20, bytes:8}, async () => {order.push('required'); await hold.promise;});
  const second = gate.run({priority:5, bytes:5}, () => {order.push('margin');});
  await Promise.resolve(); await Promise.resolve();
  assert.equal(gate.stats().queued, 1);
  assert.equal(gate.stats().pressureSkips, 0);
  hold.resolve(); await Promise.all([first, second]);
  assert.deepEqual(order, ['required', 'margin']);
  gate.dispose(); residency.dispose();
});


test('GPU residency measures only dirty resources and keeps incremental totals and protection', async () => {
  const {createGlobeGpuResidency} = await import('../../../src/rendering/globe-gpu-resources.js');
  const {createRenderResidencyBudget} = await import('../../../src/rendering/render-cache-budget.js');
  const residency = createRenderResidencyBudget(100,{groups:{mesh:{byteBudget:24,entryLimit:2}}});
  const ledger = createGlobeGpuResidency(residency), first = {}, second = {};
  const shared = new ArrayBuffer(8);
  let firstReads = 0, secondReads = 0, extra = 4, evictions = 0;
  ledger.track(first, () => {firstReads++; return {buffers:new Set([shared]),extraBytes:extra};}, {group:'mesh'});
  ledger.track(second, () => {secondReads++; return {buffers:new Set([shared]),extraBytes:4};},
    {group:'mesh',evict:() => {evictions++;ledger.remove(second);}});
  assert.equal(ledger.flush(),true);
  assert.equal(ledger.groupBytes('mesh'),24);
  assert.equal(residency.trim().residentBytes,16);
  assert.equal(ledger.flush(),false);
  ledger.protect(second,false); ledger.flush();
  assert.deepEqual([firstReads,secondReads],[1,1]);
  extra = 8; ledger.mark(first); ledger.flush();
  assert.deepEqual([firstReads,secondReads],[2,1]);
  assert.equal(ledger.groupBytes('mesh'),28);
  residency.trim();
  assert.equal(evictions,1);
  assert.equal(ledger.groupBytes('mesh'),16);
  assert.equal(residency.stats().residentBytes,16);
  ledger.remove(first);
  assert.equal(ledger.stats().bytes,0);
  assert.equal(residency.stats().residentBytes,0);
  residency.dispose();
});


test('GPU mesh standby recency refreshes on reuse and again when a scene is released', async () => {
  const {createGlobeGpuResidency} = await import('../../../src/rendering/globe-gpu-resources.js');
  const {createRenderResidencyBudget} = await import('../../../src/rendering/render-cache-budget.js');
  let clock = 0;
  const residency = createRenderResidencyBudget(8);
  const ledger = createGlobeGpuResidency(residency,{now:() => clock});
  const evicted = [], a = {lastUsed:0}, b = {lastUsed:0};
  const make = (resource,name) => {
    ledger.track(resource,()=>({buffers:new Set([new ArrayBuffer(8)])}));
    ledger.configure(resource,{group:'mesh',evict:()=>{evicted.push(name);ledger.remove(resource);}});
  };
  make(a,'a'); make(b,'b'); ledger.flush();
  clock=10; ledger.protect(a,false);
  clock=20; ledger.protect(b,false); ledger.flush();
  assert.equal(a.lastUsed,10); assert.equal(b.lastUsed,20);
  clock=30; ledger.protect(a,true); ledger.flush();
  clock=40; ledger.protect(a,false); ledger.flush();
  assert.equal(a.lastUsed,40);
  residency.trim();
  assert.deepEqual(evicted,['b']);
  assert.equal(ledger.stats().entries,1);
  assert.equal(residency.stats().residentBytes,8);
  ledger.remove(a); residency.dispose();
});


test('small spatial packet decodes coalesce into bounded Worker batches by priority',async()=>{
 const {createGlobeDecodeBatcher}=await import('../../../src/rendering/globe-packet-tasks.js');
 const queued=[],calls=[];
 const batcher=createGlobeDecodeBatcher(async(rows,{priority})=>{
  calls.push({ids:rows.map(row=>row.id),priority});
  return rows.map(row=>({ok:true,value:row.id}));
 },{schedule:fn=>queued.push(fn),maxItemBytes:32,maxBytes:64,maxDecodedBytes:64,maxItems:4});
 const packet=id=>({id,kind:'mesh',bytes:new Uint8Array(8),spec:{decodedBytes:8}});
 const a=batcher.enqueue(packet('a'),{priority:10}),b=batcher.enqueue(packet('b'),{priority:10}),c=batcher.enqueue(packet('c'),{priority:5});
 assert.equal(queued.length,1);queued.shift()();
 assert.deepEqual(await Promise.all([a,b,c]),['a','b','c']);
 assert.deepEqual(calls,[{ids:['a','b'],priority:10},{ids:['c'],priority:5}]);
 assert.equal(batcher.stats().batches,1);assert.equal(batcher.stats().packets,2);
 batcher.dispose();
});

test('one cancelled small packet does not cancel other members of its Worker batch',async()=>{
 const {createGlobeDecodeBatcher}=await import('../../../src/rendering/globe-packet-tasks.js');
 const queued=[],started=Promise.withResolvers(),finish=Promise.withResolvers();let workerSignal;
 const batcher=createGlobeDecodeBatcher(async(rows,{signal})=>{
  workerSignal=signal;started.resolve();return finish.promise;
 },{schedule:fn=>queued.push(fn),maxItemBytes:32,maxBytes:64,maxDecodedBytes:64});
 const abort=new AbortController(),packet=id=>({id,kind:'stroke',bytes:new Uint8Array(8),spec:{decodedBytes:8}});
 const first=batcher.enqueue(packet('first'),{signal:abort.signal}),second=batcher.enqueue(packet('second'));
 queued.shift()();await started.promise;abort.abort();
 await assert.rejects(first,{name:'AbortError'});assert.equal(workerSignal.aborted,false);
 finish.resolve([{ok:true,value:'ignored'},{ok:true,value:'second'}]);
 assert.equal(await second,'second');batcher.dispose();
});

test('Worker spatial preparation attaches primitive indexes before mesh and stroke packets are published',async()=>{
 const {prepareGlobeSpatialPacket}=await import('../../../src/rendering/globe-spatial-partition.js');
 const mesh=prepareGlobeSpatialPacket({positions:Float32Array.of(0,0,0,1,0,0,0,1,0),
  residuals:new Float32Array(9),indices:Uint32Array.of(0,1,2),slots:new Uint16Array(0)});
 assert.equal(mesh.spatial.count,1);assert.equal(mesh.spatial.nodes.length,3);
 assert.deepEqual([...mesh.spatialBounds],[0,0,0,1,1,0]);
 const stroke=prepareGlobeSpatialPacket({count:1,points:Float32Array.of(0,0,0,0,0,0,1,0,0,0,0,0),
  endpointIndices:Uint32Array.of(0,1),widths:Float32Array.of(1),ownerGroups:new Uint16Array(0)});
 assert.equal(stroke.spatialParts.length,1);assert.equal(stroke.spatialParts[0].index.count,1);
 assert.ok(stroke.spatialParts[0].index.nodes instanceof Uint32Array);
});


test('network admission hands off its concurrency slot while retaining the full memory reservation through Worker decode',async()=>{
 const {createRenderLoadGate}=await import('../../../src/rendering/render-cache-budget.js');
 const gate=createRenderLoadGate({concurrency:1,byteBudget:16});
 const decode=Promise.withResolvers();let workerStarted=false;
 const first=gate.run({bytes:6},async({handoff})=>{
  handoff();workerStarted=true;await decode.promise;return 'decoded';
 });
 await new Promise(setImmediate);
 assert.equal(workerStarted,true);
 assert.equal(gate.stats().active,0);
 assert.equal(gate.stats().reservedBytes,6);
 assert.equal(gate.stats().handoffs,1);
 const next=gate.run({bytes:6},()=> 'downloaded');
 assert.equal(await next,'downloaded');
 assert.equal(gate.stats().reservedBytes,6);
 const blocked=gate.run({bytes:12},()=> 'must wait for the Worker reservation');
 await Promise.resolve();
 assert.equal(gate.stats().queued,1);
 decode.resolve();
 assert.equal(await first,'decoded');
 assert.equal(await blocked,'must wait for the Worker reservation');
 assert.equal(gate.stats().reservedBytes,0);
 gate.dispose();
});


test('same-cell mesh batches reduce GPU geometry count without crossing style, cell or size boundaries',async()=>{
 const {groupGlobeGpuMeshes,combineGlobeDrawMeshes,globeDrawBlockSize,splitGlobeDrawRanges,globeDrawGroups}=await import('../../../src/rendering/globe-draw-compaction.js');
 const row=(key,cell,triangles,vertices,style='country')=>({key,cell,style,mesh:{packet:{
  positions:{length:vertices*3},residuals:{length:vertices*3},indices:{length:triangles*3},slots:{length:vertices},
 }}});
 const rows=[
  row('a','cell-a',20_000,50_000),row('b','cell-a',20_000,50_000),row('c','cell-a',20_000,50_000),
  row('d','cell-a',10_000,20_000),row('e','cell-b',1_000,3_000),row('f','cell-b',1_000,3_000,'lake'),
 ];
 const groups=groupGlobeGpuMeshes(rows,row=>row.style);
 assert.deepEqual(groups.map(group=>group.rows.map(row=>row.key)),[
  ['a','b','c'],['d'],['e'],['f'],
 ]);
 const first=combineGlobeDrawMeshes([
  {mesh:{packet:{positions:Float32Array.of(1,2,3),residuals:Float32Array.of(4,5,6),indices:Uint32Array.of(0,0,0),slots:Uint16Array.of(2),spatial:{count:1}}}},
  {mesh:{packet:{positions:Float32Array.of(7,8,9),residuals:Float32Array.of(10,11,12),indices:Uint32Array.of(0,0,0),slots:Uint16Array.of(3),spatial:{count:1}}}},
 ]);
 assert.deepEqual([...first.indices],[0,0,0,1,1,1]);
 assert.deepEqual([...first.slots],[2,3]);
 assert.equal(first.drawParts.length,2);
 assert.equal(globeDrawBlockSize(65_536),65_536);
 assert.equal(globeDrawBlockSize(131_072),65_536);
 assert.equal(globeDrawBlockSize(262_144),131_072);
 const blocks=splitGlobeDrawRanges(Uint32Array.of(0,131_072),131_072);
 assert.equal(blocks.length,2);
 const positioned=blocks.map((row,index)=>({...row,offset:index*65_536}));
 assert.equal(globeDrawGroups(positioned).length,1);
});


test('active geometry admission chooses one complete affordable LOD across both layers',async()=>{
 const {chooseGlobeActivePlan,emptyGlobeCost,sumGlobeCosts}=await import('../../../src/rendering/globe-active-budget.js');
 const cost=(triangles,segments,bytes)=>({...emptyGlobeCost(),triangles,segments,bytes,drawCalls:4,chunks:2});
 const hard={triangles:200,segments:160,bytes:1000,drawCalls:20,chunks:10};
 const target={...hard,triangles:100,segments:80,bytes:700};
 const visited=[];
 const build=lod=>{
  visited.push(lod);
  const base={lod,cost:cost([30,70,140][lod],10,200)};
  const physical={lod,cost:cost(20,[20,80,150][lod],200)};
  return {base,physical,cost:sumGlobeCosts(base.cost,physical.cost),transitionBytes:400};
 };
 const chosen=chooseGlobeActivePlan({requestedLod:2,limits:{hard,target,transitionBytes:1000},build});
 assert.equal(chosen.lod,0);assert.equal(chosen.base.lod,chosen.physical.lod);
 assert.deepEqual(visited,[2,1,0]);assert.equal(chosen.budgetLimited,true);
 assert.equal(chosen.targetExceeded,false);
 const fallback=chooseGlobeActivePlan({requestedLod:1,limits:{hard,target:{...target,triangles:1}},build});
 assert.equal(fallback.lod,0);assert.equal(fallback.targetExceeded,true);
 assert.throws(()=>chooseGlobeActivePlan({requestedLod:2,minLod:2,limits:{hard:{...hard,triangles:1},target},build}),{code:'PL-THREE-ACTIVE-BUDGET'});
 assert.throws(()=>chooseGlobeActivePlan({requestedLod:1,limits:{hard,target,transitionBytes:399},build}),error=>
  error.code==='PL-THREE-ACTIVE-BUDGET'&&error.exceeded.includes('transitionBytes'));
});

test('active geometry counts whole packet ranges and merged sources before I/O',async()=>{
 const {estimateGlobePlanCost,estimateGlobeTransitionBytes,estimateGlobeChunkCost}=await import('../../../src/rendering/globe-active-budget.js');
 const row=(key,role,count)=>({key,role,first:100,end:100+count,spec:{decodedBytes:count*40}});
 const land=row('land','country',12),water=row('water','water',10),riverA=row('a','river',20),riverB=row('b','river',21);
 const batch={role:'river',key:'batch',sources:[riverA,riverB],spec:{decodedBytes:41*40}};
 const cost=estimateGlobePlanCost([land,water,batch]);
 assert.equal(cost.triangles,22);assert.equal(cost.segments,41);assert.equal(cost.chunks,3);
 assert.equal(estimateGlobeTransitionBytes([land],[land,water]),estimateGlobeChunkCost(land).bytes+estimateGlobeChunkCost(water).bytes);
 assert.equal(estimateGlobeTransitionBytes([land],[{...land,role:'lake'}]),2*estimateGlobeChunkCost(land).bytes);
});

test('outline and detail river admission share the same residual active budget',async()=>{
 const {admitGlobeOptional,emptyGlobeCost,estimateGlobeChunkCost}=await import('../../../src/rendering/globe-active-budget.js');
 const outline={role:'outline',first:0,end:10,spec:{decodedBytes:400}},river={role:'detail',first:0,end:20,spec:{decodedBytes:800}};
 const limits={hard:{triangles:100,segments:100,drawCalls:10,bytes:100000,chunks:10},
  optional:{triangles:0,segments:25,drawCalls:5,bytes:100000,chunks:5}};
 const required={...emptyGlobeCost(),segments:70};
 const first=admitGlobeOptional([outline],{required,limits});
 assert.deepEqual(first.rows,[outline]);
 const second=admitGlobeOptional([river],{required,limits,optionalUsed:first.cost});
 assert.deepEqual(second.rows,[]);assert.equal(second.omitted,1);
 assert.deepEqual(second.cost,estimateGlobeChunkCost(outline));
});

test('protected residency counts shared backing buffers only once and moves them out of active accounting',async()=>{
 const {createRenderResidencyBudget}=await import('../../../src/rendering/render-cache-budget.js');
 const ledger=createRenderResidencyBudget(128),shared=new ArrayBuffer(16),a={},b={};
 ledger.set(a,{buffers:new Set([shared]),extraBytes:8,protected:true});
 ledger.set(b,{buffers:new Set([shared]),extraBytes:4,protected:true});
 assert.equal(ledger.stats().protectedBytes,28);
 assert.equal(ledger.stats().protectedCpuBytes,16);
 ledger.set(a,{buffers:new Set([shared]),extraBytes:8,protected:false});
 assert.equal(ledger.stats().protectedBytes,20);
 ledger.remove(b);
 assert.equal(ledger.stats().protectedBytes,0);
 assert.equal(ledger.stats().residentBytes,24);
 assert.equal(ledger.stats().unprotectedBytes,24);
 ledger.dispose();
});

test('required geometry reservations cannot consume unbounded protected-memory overflow',async()=>{
 const {createRenderResidencyBudget,createRenderLoadGate}=await import('../../../src/rendering/render-cache-budget.js');
 const ledger=createRenderResidencyBudget(100);
 ledger.set('published',{protected:true,extraBytes:90});
 const gate=createRenderLoadGate({concurrency:1,byteBudget:50,residency:ledger,overflowAllowance:20});
 await assert.rejects(gate.run({bytes:31,priority:20},()=>assert.fail('over-limit load ran')),error=>error.memoryPressure===true);
 assert.equal(await gate.run({bytes:20,priority:20},()=>42),42);
 assert.equal(ledger.stats().workingBytes,0);
 assert.equal(ledger.stats().overflowCount,1);
 gate.dispose();ledger.dispose();
});


test('per-frame GPU creation and upload budgets reset without allowing cumulative overflow',async()=>{
 const {createGlobeGpuFrameBudget}=await import('../../../src/rendering/globe-gpu-frame-budget.js');
 const budget=createGlobeGpuFrameBudget({limits:{createBytes:100,createOperations:2,maxSingleCreateBytes:160,
  uploadBytes:80,uploadOperations:2,maxSingleUploadBytes:120,compactionBytes:32}});
 assert.equal(budget.beginFrame(1),true);
 assert.equal(budget.admitCreate(40),true);
 assert.equal(budget.admitCreate(40),true);
 assert.equal(budget.admitCreate(1),false);
 assert.equal(budget.admitUpload(50),true);
 assert.equal(budget.admitUpload(31),false);
 assert.equal(budget.admitCompaction(20),true);
 assert.equal(budget.admitCompaction(20),false);
 const first=budget.stats();
 assert.equal(first.createBytes,80);
 assert.equal(first.uploadBytes,70);
 assert.equal(first.compactionBytes,20);
 assert.deepEqual(first.deferred,{create:1,upload:1,compaction:1});
 assert.equal(budget.beginFrame(1),false);
 assert.equal(budget.beginFrame(2),true);
 assert.equal(budget.admitUpload(120),true,'a bounded oversize resource may run alone');
 assert.equal(budget.admitUpload(1),false,'oversize admission excludes all other uploads that frame');
 assert.equal(budget.stats().uploadBytes,120);
 assert.equal(budget.beginFrame(3),true);
 assert.equal(budget.admitUpload(80),true);
 assert.equal(budget.admitCompaction(32),false,'compaction cannot exceed its independent frame cap');
});

test('GPU frame budget scales with shared render memory and never mutates its limits',async()=>{
 const {globeGpuFrameLimits,createGlobeGpuFrameBudget}=await import('../../../src/rendering/globe-gpu-frame-budget.js');
 const low=globeGpuFrameLimits(96*1024*1024),high=globeGpuFrameLimits(320*1024*1024);
 assert.ok(low.uploadBytes<high.uploadBytes);
 assert.ok(low.createBytes<high.createBytes);
 const budget=createGlobeGpuFrameBudget({totalRenderBytes:96*1024*1024});
 const stats=budget.stats();
 assert.equal(stats.limits.uploadBytes,low.uploadBytes);
 assert.equal(Object.isFrozen(stats.limits),false);
});


test('GPU index growth admits creation, upload and compaction atomically',async()=>{
 const {createGlobeGpuFrameBudget}=await import('../../../src/rendering/globe-gpu-frame-budget.js');
 const budget=createGlobeGpuFrameBudget({limits:{createBytes:100,createOperations:2,maxSingleCreateBytes:160,
  uploadBytes:80,uploadOperations:2,maxSingleUploadBytes:120,compactionBytes:32}});
 budget.beginFrame(1);
 assert.equal(budget.admitIndexGrowth(40,33),false);
 assert.equal(budget.stats().createBytes,0);
 assert.equal(budget.stats().uploadBytes,0);
 assert.equal(budget.admitIndexGrowth(40,20),true);
 assert.equal(budget.stats().compactionBytes,20);
 assert.equal(budget.admitIndexGrowth(40,13),false);
 assert.equal(budget.stats().uploadBytes,40);
 assert.equal(budget.remainingCompactionBytes(),12);
 budget.beginFrame(2);
 assert.equal(budget.admitIndexGrowth(40,32),true);
 assert.equal(budget.stats().uploadBytes,40);
});

test('compaction cursors split large and fragmented writes without loss or overlap',async()=>{
 const {takeGlobeDrawWriteSlice,estimateGlobeDrawWriteBytes}=await import('../../../src/rendering/globe-draw-compaction.js');
 const plan=[{first:10,end:22,offset:0},{first:50,end:54,offset:12},{first:70,end:76,offset:16}];
 let cursor={index:0,offset:0},completed=false,actual=[];
 while(!completed) {
  const slice=takeGlobeDrawWriteSlice(plan,cursor,5,2);
  assert.ok(slice.count>0&&slice.count<=5&&slice.writes.length<=2);
  actual.push(...slice.writes.flatMap(row=>Array.from({length:row.end-row.first},(_,i)=>[row.first+i,row.offset+i])));
  cursor=slice.cursor;completed=slice.complete;
 }
 const expected=plan.flatMap(row=>Array.from({length:row.end-row.first},(_,i)=>[row.first+i,row.offset+i]));
 assert.deepEqual(actual,expected);
 const scattered=Array.from({length:33},(_,i)=>({first:i*10,end:i*10+1,offset:i*10}));
 assert.equal(estimateGlobeDrawWriteBytes(scattered,4),321*4);
 assert.equal(takeGlobeDrawWriteSlice(scattered,{index:0,offset:0},100).writes.length,32);
});
