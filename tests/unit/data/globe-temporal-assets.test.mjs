import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeGlobeMesh, decodeGlobeStrokes } from '../../../src/rendering/globe-mesh.js';
import { combineGlobeCountryMeshes } from '../../../scripts/lib/globe-preview-assets.mjs';
import { globeVector } from '../../../src/rendering/globe-camera.js';
import * as globeAssets from '../../../scripts/lib/globe-preview-assets.mjs';

test('river derivation keeps the basic stage global and admits detail across the date line once', async () => {
  const {createGlobeChunkCatalog}=await import('../../../src/rendering/globe-view-mesh-assets.js');
  const river=(stage,coordinates)=>({geometry:{type:'LineString',coordinates},properties:{stage,stroke_width:1,stroke_widths:[[1,2]]}});
  const output=globeAssets.buildGlobeRiverPackets([
    river(0,[[5,1],[6,1]]),river(1,[[179.9,2],[-179.9,2]]),river(1,[[30,2],[31,2]]),river(2,[[179.91,3],[-179.91,3]]),
  ],[{id:0,minZoom:2},{id:1,minZoom:3},{id:2,minZoom:4}]);
  assert.equal(decodeGlobeStrokes(output.base).count,1);
  const chunks=output.detail.flatMap(({buffer,...row})=>[...globeAssets.globeStrokeChunks(buffer)].map((chunk,index)=>({...row,...chunk,spec:{sha256:row.id+':'+index}})));
  const catalog=createGlobeChunkCatalog(chunks);
  const direction=globeVector([180,2]),axis=direction.map(Math.abs).indexOf(Math.max(...direction.map(Math.abs)));
  const cull=box=>direction[axis]>0?box[axis+3]>0:box[axis]<0;
  const select=zoom=>catalog.select(cull,row=>zoom>=row.minZoom);
  assert.equal(select(2.99).length,0);
  const selected=select(3);
  assert.equal(selected.length,1);
  const stroke=decodeGlobeStrokes(selected[0].buffer);
  assert.equal(stroke.count,1);
  assert.equal(stroke.widths[0],1.5);
  assert.deepEqual([...stroke.points.subarray(0,3)],globeVector([179.9,2]).map(Math.fround));
  assert.equal(select(4).length,2);
});

test('detail view replaces stale loads and reuses a recently uploaded river chunk', async () => {
  const {createGlobeRiverDetail}=await import('../../../src/rendering/three-globe-rivers.js');
  const pending=new Map(), uploads=[], evicted=[];
  const chunk=id=>({id,spec:{decodedBytes:10}});
  const detail=createGlobeRiverDetail({byteBudget:20,
    load(row,signal){return new Promise(resolve=>pending.set(row.id,{signal,resolve}));},
    attach(row){uploads.push(row.id);return {residentBytes:10,setVisible(){},setResidency(){},setProtected(){},dispose(){evicted.push(row.id);}};},
    invalidate(){},onError:assert.fail,
  });
  detail.update([chunk('a'),chunk('stale')]);
  pending.get('a').resolve({count:4});
  await new Promise(setImmediate);
  detail.update([chunk('b')]);
  assert.equal(pending.get('stale').signal.aborted,true);
  pending.get('stale').resolve({count:8});
  pending.get('b').resolve({count:3});
  await new Promise(setImmediate);
  detail.update([chunk('a')]);
  assert.deepEqual(uploads,['a','b']);
  assert.equal(detail.stats().activeSegments,4);
  detail.update([chunk('c')]);
  pending.get('c').resolve({count:2});
  await new Promise(setImmediate);
  assert.deepEqual(evicted,['b']);
  detail.dispose();
  assert.deepEqual(evicted,['b','a','c']);
});

test('historical country layers reserve slots for changed shapes and retain unchanged base ranges', () => {
  const vertices=Float64Array.of(1,1,2,1,1,2),indices=Uint32Array.of(0,1,2);
  const shape=(id,version)=>({id,geometry:{id,version},vertices,indices});
  const base=combineGlobeCountryMeshes([shape('same',1),shape('changed',2),shape('removed',1)]);
  const changed=combineGlobeCountryMeshes([shape('changed',1)],{slotOffset:base.countrySlots.length});
  const added=combineGlobeCountryMeshes([shape('added',1)],{slotOffset:base.countrySlots.length+1});
  assert.deepEqual([...decodeGlobeMesh(changed.buffer).slots],[3,3,3]);
  assert.deepEqual([...decodeGlobeMesh(added.buffer).slots],[4,4,4]);
  assert.deepEqual([...decodeGlobeMesh(base.buffer).slots],[0,0,0,1,1,1,2,2,2]);
});

test('historical globe enumerates month-end changes including calendar era and unbounded intervals', () => {
  const lifetimes=[{validFrom:null,validTo:'-0001-12-31'}, {validFrom:'1900-01-20',validTo:'1900-02-27'},
    {validFrom:'2000',validTo:'+999999-12-31'}];
  const geometryBindings=[{validFrom:'2020-02-29',validTo:'2020-03'}];
  assert.deepEqual(globeAssets.globeHistoryMonths('2026-11',{lifetimes,geometryBindings}),
    ['-999999-01','0001-01','1900-01','1900-02','2000-01','2020-02','2020-04','2026-11']);
});

test('dated physical contexts reuse unchanged river packets while changing water identity', async () => {
  const calls=[];
  const load=async spec=>{calls.push(spec.url);return {bytes:spec.url};};
  const asset=(url,sha256=url)=>({url,sha256});
  const chunk=spec=>({spec,bounds:[-1,-1,-1,1,1,1]});
  const context=(identity,water,rivers=asset('rivers'))=>({identity,riverChunks:[chunk(rivers)],
    waters:[{id:'waterbody:lake',chunks:[chunk(water)]}],lakes:[],riverDetail:[],riverMinZoom:2});
  const modern=asset('modern-water'),datedWater=asset('dated-water');
  const indexedWater=asset('modern-water-alias',modern.sha256);
  const assets=await createPhysicalFixture([
    context('current',modern),
    context('dated',datedWater,asset('river-alias','rivers')),
    context('indexed',indexedWater),
  ],{
    loadMesh:load,loadStroke:load,
  });
  const [current,dated,indexed]=await Promise.all([
    assets.prepare(assets.plan('current')),assets.prepare(assets.plan('dated')),assets.prepare(assets.plan('indexed')),
  ]);
  assert.equal(current.riverChunks[0].packet,dated.riverChunks[0].packet);
  assert.notEqual(current.waters[0].mesh,dated.waters[0].mesh);
  assert.equal(current.waters[0].mesh,indexed.waters[0].mesh);
  assert.equal(dated.waters[0].id,'waterbody:lake');
  assert.deepEqual(calls.sort(),['dated-water','modern-water','rivers']);
  assert.equal(await assets.prepare(assets.plan('dated')),dated);
  const full = assets.plan('current',{lakesVisible:true,riversVisible:true});
  const hidden = assets.plan('current',{lakesVisible:false,riversVisible:false});
  assert.equal(assets.covers(full,hidden),true);
  assert.equal(assets.covers(hidden,full),false);
});

test('dated physical cache drops inactive contexts without releasing a shared active river', async () => {
  const reads=[];
  const load=async spec=>{reads.push(spec.sha256);return {positions:new Float32Array(2)};};
  const chunk=sha256=>({spec:{sha256},bounds:[-1,-1,-1,1,1,1]});
  const context=identity=>({identity,riverChunks:[chunk('river')],waters:[{id:'water',chunks:[chunk(identity)]}],lakes:[],riverDetail:[],riverMinZoom:2});
  const assets=await createPhysicalFixture([context('old'),context('current')],{loadMesh:load,loadStroke:load,byteBudget:16});
  assets.retain([assets.plan('old')]);
  const old=await assets.prepare(assets.plan('old'));
  assets.retain([assets.plan('current')]);
  const current=await assets.prepare(assets.plan('current'));
  assert.equal(old.riverChunks[0].packet,current.riverChunks[0].packet);
  assert.equal(assets.stats().contexts,1);
  assets.retain([assets.plan('old')]);
  const restored=await assets.prepare(assets.plan('old'));
  assert.equal(restored.riverChunks[0].packet,current.riverChunks[0].packet);
  assert.notEqual(restored.waters[0].mesh,old.waters[0].mesh);
  assert.deepEqual(reads,['old','river','current','old']);
  assets.dispose();
});

test('physical plans defer hidden and higher-zoom lake and river packets',async()=>{
  const reads=[],load=async spec=>{reads.push(spec.sha256);return {positions:new Float32Array(2)};};
  const chunk=sha256=>({spec:{sha256},bounds:[-1,-1,-1,1,1,1]});
  const assets=await createPhysicalFixture([{identity:'world',riverChunks:[chunk('river')],riverMinZoom:3,
    waters:[{id:'sea',chunks:[chunk('sea')]}],
    lakes:[{minZoom:2,chunks:[chunk('large')]},{minZoom:5,chunks:[chunk('small')]}],riverDetail:[],
  }],{loadMesh:load,loadStroke:load});
  const low=assets.plan('world',{zoom:1});
  assets.retain([low]);
  const first=await assets.prepare(low);
  assert.deepEqual(reads,['sea']);assert.equal(first.riverChunks.length,0);assert.equal(first.lakes.length,0);
  const high=assets.plan('world',{zoom:4});
  assets.retain([low,high]);
  const next=await assets.prepare(high);
  assert.equal(next.waters[0].mesh,first.waters[0].mesh);
  assert.deepEqual(reads,['sea','large','river']);assert.equal(next.lakes.length,1);
  const hidden=assets.plan('world',{zoom:8,lakesVisible:false,riversVisible:false});
  assert.equal(hidden.key,low.key);assets.dispose();
});

test('historical view metadata restores exact ordered lists from bounded checkpoints',async()=>{
  const {encodeGlobeHistoricalViews,createGlobeHistoryIndex,encodeGlobeHistoryList,decodeGlobeHistoryList}=await import('../../../src/rendering/globe-history-index.js');
  const baseCount=80;
  const views=Array.from({length:70},(_,index)=>({
    slots:[...Array.from({length:79},(_,i)=>i),80+index],
    hiddenBorders:[index,index+1],borders:[100+index,5,8],
  }));
  const history=encodeGlobeHistoricalViews(views);
  assert.equal(history.stride,32);
  assert.equal(history.rows[0][1][0],0);
  assert.equal(history.rows[1][1][0],1);
  assert.equal(history.rows[32][1][0],0);
  assert.ok(JSON.stringify(history).length<JSON.stringify(views).length);
  const index=createGlobeHistoryIndex(history,baseCount);
  assert.equal(index.find(Array.from({length:80},(_,i)=>i)).view,null);
  for(const i of [69,32,1,60,33,0,48,22,51,41,5]){
    const found=index.find(views[i].slots);
    assert.deepEqual(found.slots,views[i].slots);
    assert.deepEqual(found.view.hiddenBorders,views[i].hiddenBorders);
    assert.deepEqual(found.view.borders,views[i].borders);
    assert.equal(found.key,'history:'+i);
  }
  assert.equal(index.find([999]),null);
  assert.ok(index.stats().decodedViews<=8);
  assert.deepEqual(decodeGlobeHistoryList([1,2,3],encodeGlobeHistoryList([1,2,3],[3,1,2])),[3,1,2]);
});

test('accepted temporal receipts resolve changed objects and dated labels without comparing unchanged rows',async()=>{
 const {createGlobeTemporalPresentation}=await import('../../../src/rendering/globe-temporal-presentation.js');
 const {rememberWorldViewChange}=await import('../../../src/document/world-view-change.js');
 const row=(id,properties)=>({id,properties:{entityKind:'general',...properties}});
 const parent=row('parent',{style:{color:'#123456'}});
 const child=row('child',{parentId:'parent',metadata:{nativeNames:[{text:'new',validFrom:'1901-02'}]}});
 const other=row('other',{}),first=[parent,child,other];
 const index=createGlobeTemporalPresentation();index.advance(first,'1901-01');
 const second=[row('parent',{style:{color:'#654321'}}),child,other];
 rememberWorldViewChange(first,second,[0]);
 const changed=index.advance(second,'1901-01');
 assert.equal(changed.examined,1);
 assert.deepEqual([...changed.dirtyIds].sort(),['child','parent']);
 const dated=index.advance(second,'1901-02');
 assert.equal(dated.examined,0);assert.deepEqual([...dated.dirtyIds],['child']);
});

test('history prefetch neighbors use ordered transition dates rather than unique view ordering',async()=>{
 const {encodeGlobeHistoricalViews,createGlobeHistoryIndex,globeHistoryMonthKey}=await import('../../../src/rendering/globe-history-index.js');
 const history=encodeGlobeHistoricalViews([{slots:[1],hiddenBorders:[],borders:[]},{slots:[2],hiddenBorders:[],borders:[]}]);
 const index=createGlobeHistoryIndex(history,1,{physicalIdentities:['modern','old'],timeline:[
  ['-0001-12',0,1],['0001-01',1,1],['1801-01',0,0],['2026-11',-1,0],
 ]});
 assert.equal(globeHistoryMonthKey('0001-01')-globeHistoryMonthKey('-0001-12'),1);
 const neighbors=index.neighbors('1900-01',-1);
 assert.deepEqual(neighbors.map(row=>[row.month,row.territories.key,row.physicalIdentity]),[
  ['0001-01','history:1','old'],['2026-11','base','modern'],
 ]);
});

test('physical view plans only read visible exact water chunks',async()=>{
 const reads=[],load=async row=>{reads.push(row.sha256);return {positions:new Float32Array(1)};};
 const assets=await createPhysicalFixture([{identity:'world',waters:[{id:'sea',chunks:[
  {spec:{sha256:'near'},bounds:[.8,0,0,1,.1,.1]},{spec:{sha256:'far'},bounds:[-1,0,0,-.8,.1,.1]},
 ]}],riverChunks:[{spec:{sha256:'river'},bounds:[-1,-1,-1,1,1,1]}],riverMinZoom:8,lakes:[],riverDetail:[]}],{loadMesh:load,loadStroke:load});
 const near=assets.plan('world',{zoom:2,cull:box=>box[3]>0});
 assets.retain([near]);const prepared=await assets.prepare(near);
 assert.deepEqual(reads,['near']);assert.equal(prepared.waters[0].id,'sea');
 const far=assets.plan('world',{zoom:2,cull:box=>box[0]<0});
 assert.equal(assets.coversWaters(near,far),false);
 assets.dispose();
});

test('physical catalog selects lake and base/detail river chunks through Cartesian coverage',async()=>{
 const near=[.8,0,0,1,.1,.1],far=[-1,0,0,-.8,.1,.1],chunk=(id,bounds)=>({spec:{sha256:id},bounds});
 const reads=[],load=async spec=>{reads.push(spec.sha256);return {points:new Float32Array(6)};};
 const assets=await createPhysicalFixture([{identity:'world',waters:[],lakes:[{minZoom:3,chunks:[chunk('lake-near',near),chunk('lake-far',far)]}],
  riverMinZoom:3,riverChunks:[chunk('river-near',near),chunk('river-far',far)],riverDetail:[
   {...chunk('detail-near',near),id:'d1',minZoom:5},{...chunk('detail-far',far),id:'d2',minZoom:5},
  ]}],{loadMesh:load,loadStroke:load});
 const cull=box=>box[3]>0,plan=assets.plan('world',{zoom:5,cull,strokeCull:cull});
 assets.retain([plan]);const prepared=await assets.prepare(plan);
 assert.equal(prepared.lakes.length,1);assert.equal(prepared.riverChunks.length,1);
 assert.deepEqual(reads.sort(),['lake-near','river-near']);
 assert.deepEqual(assets.detailPlan('world',{zoom:5,strokeCull:cull}).map(row=>row.id),['d1']);
 assets.dispose();
});


test('detail river retries wake a stationary viewport, back off and stop at exhaustion', async () => {
  const {createGlobeRiverDetail} = await import('../../../src/rendering/three-globe-rivers.js');
  const row = {id:'river'};
  let clock = 0, timer = null, attempts = 0, wakes = 0, errors = 0, succeed = false;
  const detail = createGlobeRiverDetail({
    byteBudget:20, now:() => clock,
    setTimer(fn, delay) {assert.equal(timer, null); return timer = {fn, at:clock+delay};},
    clearTimer(handle) {assert.equal(timer, handle); timer = null;},
    load:async () => {attempts++; if (!succeed)throw Error('river unavailable'); return {count:7};},
    attach:() => ({residentBytes:10, setVisible(){}, setResidency(){}, setProtected(){}, dispose(){}}),
    invalidate:() => {wakes++;}, onError:() => {errors++;},
  });
  async function settle() {await new Promise(setImmediate);}
  async function advance(delay) {
    assert.ok(timer); assert.equal(timer.at-clock, delay);
    clock = timer.at;
    const fn = timer.fn; timer = null; fn();
    assert.equal(detail.retryDue(), true);
    // Renderer reuses the same plan without a camera movement.
    detail.update([row]); await settle();
  }
  detail.update([row]); await settle();
  assert.equal(detail.retryDue(), false);
  for (const delay of [1500,3000,6000])await advance(delay);
  assert.equal(attempts,4); assert.equal(wakes,3); assert.equal(errors,1);
  assert.equal(timer,null); assert.equal(detail.stats().retryExhausted,1);
  assert.equal(detail.update([row]),false);
  detail.update([]); detail.update([row]); await settle();
  assert.ok(timer);
  detail.update([]); assert.equal(timer,null);
  succeed = true; detail.update([row]); await settle();
  assert.equal(detail.stats().activeSegments,7); assert.equal(detail.stats().retryExhausted,0);
  detail.dispose(); assert.equal(timer,null);
});

test('detail river retry timer is cancelled when the owner is disposed', async () => {
  const {createGlobeRiverDetail} = await import('../../../src/rendering/three-globe-rivers.js');
  let timer = null;
  const detail = createGlobeRiverDetail({
    byteBudget:20, now:() => 0, setTimer(fn) {return timer = {fn};},
    clearTimer(handle) {assert.equal(timer, handle); timer = null;},
    load:async () => {throw Error('offline');}, attach:assert.fail,
    invalidate:assert.fail, onError:assert.fail,
  });
  detail.update([{id:'river'}]); await new Promise(setImmediate);
  assert.ok(timer); detail.dispose(); assert.equal(timer,null);
  assert.equal(detail.retryDue(),false);
});


test('failed neighbor prefetch releases the same interval without overwriting a newer claim', async () => {
  const {createGlobeNeighborPrefetchKey} = await import('../../../src/rendering/globe-history-index.js');
  const key = createGlobeNeighborPrefetchKey(), first = key.claim('catalog');
  key.clear(first);
  assert.equal(key.has('catalog'),false);
  const second = key.claim('catalog');
  key.clear(first);
  key.complete(first,'wrong');
  assert.equal(key.has('catalog'),true);
  assert.equal(key.has('wrong'),false);
  key.complete(second,'interval-42');
  assert.equal(key.has('interval-42'),true);
  const next = key.claim('interval-43');
  key.clear(next);
  assert.equal(key.has('interval-43'),false);
  key.claim('interval-43');
  assert.equal(key.has('interval-43'),true);
});


test('detail river residency updates only the altered resource and releases obsolete buffers', async () => {
  const {createGlobeRiverDetail} = await import('../../../src/rendering/three-globe-rivers.js');
  const policies = new Map(), evicted = [];
  const detail = createGlobeRiverDetail({byteBudget:20,load:async()=>({count:1}),
    attach:row=>({residentBytes:8,setVisible(){},setResidency:policy=>policies.set(row.id,policy),
      setProtected:value=>{policies.get(row.id).protected=value;},dispose:()=>evicted.push(row.id)}),
    invalidate(){},onError:assert.fail});
  detail.update([{id:'a'},{id:'b'}]); await new Promise(setImmediate);
  detail.commit(detail.activeEntries());
  detail.update([{id:'a'}]); detail.commit(detail.activeEntries());
  assert.equal(policies.get('a').protected,true);
  assert.equal(policies.get('b').protected,false);
  policies.get('a').onBytesChanged(16);
  assert.equal(detail.stats().residentBytes,24);
  assert.equal(detail.trim(),true);
  assert.deepEqual(evicted,['b']);
  assert.equal(detail.stats().residentBytes,16);
  detail.dispose();
});


test('unchanged dated shapes reuse the published padded coverage but reject changed identity and missing chunks', async () => {
  const {reuseGlobeTerritorialCoverage,reuseGlobePhysicalCoverage,globeChunkSetContains} = await import('../../../src/rendering/globe-view-mesh-assets.js');
  const row = key => ({key});
  const required = [row('country-a'),row('border-a')];
  const published = {context:'base|1|1',plan:[...required,row('margin')],parts:[{}]};
  const prepared = {context:published.context,plan:required,parts:[{}]};
  assert.equal(reuseGlobeTerritorialCoverage(published.context,required,published,prepared),published);
  assert.equal(reuseGlobeTerritorialCoverage('history:1|1|1',required,published),null);
  assert.equal(reuseGlobeTerritorialCoverage('base|1|0',required,published),null);
  assert.equal(reuseGlobeTerritorialCoverage(published.context,[row('new-border')],published),null);
  const target = {spec:{identity:'water-a'},rivers:true,waters:[row('water-a')],lakes:[row('lake-a')],riverChunks:[row('river-a')]};
  const physical = {plan:{...target,waters:[...target.waters,row('margin-water')]}};
  const covers = (have,need) => have.spec.identity===need.spec.identity&&have.rivers===need.rivers&&
    ['waters','lakes','riverChunks'].every(key=>globeChunkSetContains(have[key],need[key]));
  assert.equal(reuseGlobePhysicalCoverage(target,covers,physical),physical);
  assert.equal(reuseGlobePhysicalCoverage({...target,spec:{identity:'water-b'}},covers,physical),null);
  assert.equal(reuseGlobePhysicalCoverage({...target,lakes:[row('new-lake')]},covers,physical),null);
  assert.equal(reuseGlobePhysicalCoverage({...target,rivers:false},covers,physical),null);
});


test('physical river packets are combined by spatial cell before GPU preparation',async()=>{
 const reads=[],chunk=(id,cell,bounds)=>({cell,bounds,spec:{sha256:id,compressedBytes:10,decodedBytes:24}});
 const assets=await createPhysicalFixture([{identity:'world',waters:[],lakes:[],riverMinZoom:2,riverDetail:[],
  riverChunks:[
   chunk('river-a','cell-a',[-1,-1,-1,0,0,0]),
   chunk('river-b','cell-a',[-.5,-1,-1,.2,0,0]),
   chunk('river-c','cell-b',[0,-1,-1,1,0,0]),
  ],
 }],{
  loadMesh:async spec=>({mesh:spec.sha256}),
  loadStroke:async(spec,signal,priority,descriptor)=>{
   reads.push(descriptor);
   return {sourceKeys:descriptor.sources?.map(row=>row.spec.sha256)??[spec.sha256]};
  },
 });
 const plan=assets.plan('world',{zoom:3});
 assert.equal(plan.riverChunks.length,2);
 const grouped=plan.riverChunks.find(row=>row.sources);
 assert.deepEqual(grouped.sources.map(row=>row.spec.sha256),['river-a','river-b']);
 assert.deepEqual(grouped.bounds,[-1,-1,-1,.2,0,0]);
 assert.equal(grouped.spec.decodedBytes,48);
 const prepared=await assets.prepare(plan);
 assert.deepEqual(prepared.riverChunks.map(row=>row.packet.sourceKeys),[['river-a','river-b'],['river-c']]);
 assert.equal(reads.length,2);
 assets.dispose();
});

test('base border chunks combine by cell while retaining owner slots and base-border identity',async()=>{
 const {createGlobeTerritorialAssets}=await import('../../../src/rendering/globe-view-mesh-assets.js');
 const border=(id,cell,slots,bounds)=>({cell,slots,bounds,spec:{sha256:id,compressedBytes:10,decodedBytes:24}});
 const assets=createGlobeTerritorialAssets({
  countryChunks:[],outlineChunks:[],borderGroupCount:4,
  borderChunks:[
   border('border-a','cell-a',[0],[-1,-1,-1,0,0,0]),
   border('border-b','cell-a',[1],[-.5,-1,-1,.2,0,0]),
   border('border-c','cell-b',[3],[0,-1,-1,1,0,0]),
  ],
 },{
  baseSlots:[],cacheBudget:{historicalCpuBytes:1024*1024,borderBatchBytes:1024*1024},
  loadMesh:async()=>({}),loadStroke:async()=>({}),load:async()=>({}),slotCount:()=>4,
 });
 const {describeGlobeTerritorialChunks}=await import('../../../src/rendering/globe-spatial-catalog.js');
 const selection=assets.createSelection(Object.values(describeGlobeTerritorialChunks({countryChunks:[],outlineChunks:[],borderChunks:[
  border('border-a','cell-a',[0],[-1,-1,-1,0,0,0]),border('border-b','cell-a',[1],[-.5,-1,-1,.2,0,0]),
  border('border-c','cell-b',[3],[0,-1,-1,1,0,0]),
 ]},undefined)).flat());
 const rows=assets.plan(()=>true,()=>true,undefined,selection);
 assert.equal(rows.length,2);
 const grouped=rows.find(row=>row.sources);
 assert.equal(grouped.baseBorder,true);
 assert.deepEqual(grouped.slots,[0,1]);
 assert.equal(grouped.sources.length,2);
 assert.deepEqual(grouped.bounds,[-1,-1,-1,.2,0,0]);
 assets.dispose();
});


test('physical LOD plans retain zoom thresholds and never admit other geometry tiers', async () => {
  const reads=[];
  const variants=(id,extra={})=>[0,1,2].map(lod=>({lod,bounds:[-1,-1,-1,1,1,1],cell:'0:0:0',
    spec:{sha256:id+'-'+lod,decodedBytes:24},...extra}));
  const assets=await createPhysicalFixture([{identity:'world',waters:[{id:'sea',chunks:variants('sea')}],
    lakes:[{minZoom:4,chunks:variants('lake')}],riverMinZoom:2,riverChunks:variants('river'),
    riverDetail:variants('detail',{id:'detail',minZoom:5})}],{
    lodVersion:1,loadMesh:async spec=>{reads.push(spec.sha256);return {};},
    loadStroke:async spec=>{reads.push(spec.sha256);return {};},
  });
  const coarse=assets.plan('world',{zoom:3,lod:0}),fine=assets.plan('world',{zoom:6,lod:2});
  assert.ok(coarse.rows.every(row=>row.lod===0));
  assert.equal(coarse.lakes.length,0);
  assert.equal(fine.lakes.length,1);
  assert.equal(assets.covers(coarse,fine),false);
  assert.equal(assets.covers(fine,coarse),false);
  await assets.prepare(coarse);
  assert.deepEqual(reads.sort(),['river-0','sea-0']);
  assert.deepEqual(assets.detailPlan('world',{zoom:6,lod:1}).map(row=>row.spec.sha256),['detail-1']);
  assets.dispose();
});

test('historical border and outline selections do not mix LODs or lose owner membership',async()=>{
  const {createGlobeTerritorialAssets}=await import('../../../src/rendering/globe-view-mesh-assets.js');
  const variants=(id,slots=[])=>[0,1,2].map(lod=>({lod,slots,ownerSlots:slots,bounds:[-1,-1,-1,1,1,1],cell:'0:0:0',spec:{sha256:id+'-'+lod,decodedBytes:24}}));
  const assets=createGlobeTerritorialAssets({lodVersion:1,countryChunks:variants('base',[0]),borderChunks:variants('border',[0]),outlineChunks:variants('outline',[0])},{
    baseSlots:[{}],cacheBudget:{historicalCpuBytes:1024,borderBatchBytes:1024},loadMesh:async()=>({}),loadStroke:async()=>({}),load:async()=>({}),slotCount:()=>2,
  });
  const {describeGlobeTerritorialChunks}=await import('../../../src/rendering/globe-spatial-catalog.js');
  const base=Object.values(describeGlobeTerritorialChunks({countryChunks:variants('base',[0]),borderChunks:variants('border',[0]),outlineChunks:variants('outline',[0])},1)).flat();
  const history=assets.createSelection(base,{lodVersion:1,historicalCountries:[{countryChunks:variants('historical',[1]),outlineChunks:variants('historical-outline',[1])}],
    historicalBorders:[{chunks:variants('historical-border')}]});
  const view={borders:[0]};
  for (const lod of [0,1,2]) {
    assert.ok(assets.plan(()=>true,()=>true,lod,history).every(row=>row.lod===lod));
    assert.deepEqual(assets.planHistoryBorders(view,()=>true,lod,history).map(row=>row.spec.sha256),['historical-border-'+lod]);
    assert.deepEqual(assets.outlineDescriptors(1,lod,history).map(row=>row.spec.sha256),['historical-outline-'+lod]);
  }
  assert.throws(()=>assets.createSelection(base,{historicalCountries:[],historicalBorders:[]}),/LOD version mismatch/);
  assets.dispose();
});

async function createPhysicalFixture(specs,options) {
 const {createGlobePhysicalAssets}=await import('../../../src/rendering/three-globe-physical.js');
 const {describeGlobePhysicalChunks}=await import('../../../src/rendering/globe-physical-catalog.js');
 const assets=createGlobePhysicalAssets(options),contexts=new Map(),details=new Map();
 for(const spec of specs) {
  const roles=describeGlobePhysicalChunks(spec,options.lodVersion);
  contexts.set(spec.identity,assets.createDescriptor(spec,[...roles.water,...roles.lake,...roles.river]));
  details.set(spec.identity,assets.createDetailDescriptor(roles.detail));
 }
 return {...assets,plan:(identity,options)=>assets.plan(contexts.get(identity),options),
  detailPlan:(identity,options)=>assets.detailPlan(details.get(identity),options)};
}


test('stroke descriptor batches aggregate consecutive neighboring cells within source and byte caps',async()=>{
 const {batchGlobeStrokeDescriptors}=await import('../../../src/rendering/globe-spatial-aggregate.js');
 const rows=Array.from({length:70},(_,i)=>({role:'river',kind:'stroke',lod:0,minZoom:2,
   cell:(i<18?0:i<35?1:i<53?2:3)+':0:0',key:'r'+i,bounds:[i,0,0,i+1,1,1],slots:[i%3],
   spec:{sha256:'r'+i,decodedBytes:100,compressedBytes:20}}));
 const batches=batchGlobeStrokeDescriptors(rows,{prefix:'river',byteBudget:100000,maxSources:32,
   groupKey:row=>'supercell:'+Math.floor(Number(row.cell.split(':')[0])/2),
   aggregate:sources=>({aggregateErrorScale:16,aggregateReductionEstimate:4,force:true})});
 assert.ok(batches.length<rows.length);
 assert.ok(batches.every(row=>row.sources.length<=32&&row.aggregateErrorScale===16));
 assert.deepEqual(batches.flatMap(row=>row.sources.map(source=>source.key)),rows.map(row=>row.key));
 assert.ok(batches.every(row=>row.bounds.every(Number.isFinite)));
});


test('physical river plans expose progressively coarser spatial aggregation without changing water identity',async()=>{
 const {createGlobePhysicalAssets}=await import('../../../src/rendering/three-globe-physical.js');
 const rows=Array.from({length:70},(_,i)=>({role:'river',kind:'stroke',lod:0,minZoom:2,cell:(i<35?0:1)+':0:0',
  key:'river-'+i,bounds:[-.8,-.1,-.1,.8,.1,.1],first:0,end:320,
  spec:{sha256:'river-'+i,decodedBytes:320*24,compressedBytes:128}}));
 const assets=createGlobePhysicalAssets({loadMesh:async()=>({}),loadStroke:async(spec,signal,priority,descriptor)=>({
  count:2,points:new Float32Array(18),endpointIndices:Uint32Array.of(0,1,1,2),widths:new Float32Array(2),ownerGroups:new Uint16Array(0),
 })});
 const source=assets.createDescriptor({identity:'world',waters:[],riverMinZoom:2},rows);
 const normal=assets.plan(source,{zoom:3,lod:0,aggregationLevel:0});
 const medium=assets.plan(source,{zoom:3,lod:0,aggregationLevel:1});
 const coarse=assets.plan(source,{zoom:3,lod:0,aggregationLevel:2});
 const emergency=assets.plan(source,{zoom:3,lod:0,aggregationLevel:3});
 assert.equal(normal.aggregationLevel,0);assert.equal(medium.aggregationLevel,1);
 assert.ok(medium.riverChunks.every(row=>row.aggregateGridDivisions===128&&row.aggregatePreserveOwners));
 assert.ok(coarse.riverChunks.every(row=>row.aggregateGridDivisions===64&&row.pickable===false));
 assert.ok(emergency.riverChunks.every(row=>row.aggregateGridDivisions===20&&row.pickable===false));
 assert.ok(emergency.riverChunks.every(row=>row.sources.length<=128));
 const prepared=await assets.prepare(emergency);
 assert.equal(prepared.plan.aggregationLevel,3);
 assert.ok(prepared.plan.riverChunks.every(row=>row.end===2&&!row.sources));
 assert.equal(assets.covers(prepared.plan,normal),false);
 assets.dispose();
});


test('dense base and historical borders use the same bounded aggregation tiers while retaining owner groups',async()=>{
 const {createGlobeTerritorialAssets}=await import('../../../src/rendering/globe-view-mesh-assets.js');
 const {renderCacheBudget}=await import('../../../src/rendering/render-cache-budget.js');
 const budget=renderCacheBudget(8),rows=[];
 for(let lod=0;lod<3;lod++)for(let i=0;i<70;i++)rows.push({role:'border',kind:'stroke',baseBorder:true,lod,
  key:'border-'+lod+'-'+i,slots:[i%4],bounds:[-.8,-.1,-.1,.8,.1,.1],first:0,end:320,
  spec:{sha256:'border-'+lod+'-'+i,decodedBytes:320*24,compressedBytes:128}});
 const assets=createGlobeTerritorialAssets({lodVersion:1},{baseSlots:[],cacheBudget:budget,loadMesh:async()=>({}),loadStroke:async()=>({})});
 const selection=assets.createSelection(rows);
 for(const [level,grid] of [[1,128],[2,64],[3,20]]) {
  const plan=assets.plan(()=>true,()=>true,0,selection,level);
  assert.ok(plan.length<70);
  assert.ok(plan.every(row=>row.aggregateGridDivisions===grid&&row.aggregatePreserveOwners===true));
  assert.ok(plan.every(row=>row.sources.length<=128));
 }
 assets.dispose();
});
