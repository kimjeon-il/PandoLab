import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeGlobeMesh, packGlobeMesh, decodeGlobeStrokes, globeStrokePoint, createGlobeStrokeBatchBuilder, compactGlobeStrokeRange } from '../../../src/rendering/globe-mesh.js';
import { combineGlobeCountryMeshes, encodeGlobeMesh, encodeGlobeStrokes } from '../../../scripts/lib/globe-preview-assets.mjs';
import { globeVector } from '../../../src/rendering/globe-camera.js';
import * as globeAssets from '../../../scripts/lib/globe-preview-assets.mjs';

test('country mesh slots retain the resolved geometry version and scoped index ranges', () => {
  const vertices = Float64Array.of(1, 1, 2, 1, 1, 2);
  const indices = Uint32Array.of(0, 1, 2);
  const geometry = { id: 'shape', version: 5, contentSha256: 'a'.repeat(64) };
  const output = combineGlobeCountryMeshes([
    { id: 'current-owner', geometry, vertices, indices },
    { id: 'territory', geometry, vertices, indices },
  ]);
  assert.deepEqual(output.countrySlots, [
    { id: 'current-owner', geometry, first: 0, count: 3 },
    { id: 'territory', geometry, first: 3, count: 3 },
  ]);
  const mesh = decodeGlobeMesh(output.buffer);
  assert.deepEqual([...mesh.indices], [0, 1, 2, 3, 4, 5]);
  assert.deepEqual([...mesh.slots], [0, 0, 0, 1, 1, 1]);
});

test('prepared surface retains triangle slots and reconstructs the input vertices without camera work', () => {
  const coordinates = [179.999997, 42.000003, -179.999991, 42.000003, 179.999997, 42.000035];
  const indices = Uint32Array.of(0, 1, 2);
  const slots = Uint16Array.of(7, 7, 7);
  const buffer = encodeGlobeMesh({ coordinates, indices, slots });
  const mesh = decodeGlobeMesh(buffer);
  assert.equal(mesh.positions.buffer, buffer);
  assert.equal(mesh.residuals.buffer, buffer);
  assert.deepEqual(mesh.indices, indices);
  assert.deepEqual(mesh.slots, slots);
  for (let i = 0; i < coordinates.length / 2; i++) {
    const expected = globeVector(coordinates.slice(i * 2, i * 2 + 2));
    for (let axis = 0; axis < 3; axis++) {
      const offset = i * 3 + axis;
      assert.ok(Math.abs(mesh.positions[offset] + mesh.residuals[offset] - expected[axis]) < 1e-14);
    }
  }
  assert.throws(() => decodeGlobeMesh(buffer.slice(0, -1)), /Invalid globe mesh/);
  assert.throws(() => encodeGlobeMesh({ coordinates, indices: Uint32Array.of(0, 1, 3), slots }), /Invalid globe mesh/);
});

test('packed land and territory restore the original buffer and reject invalid indices', () => {
  const coordinates=Float64Array.from({length:520},(_,i)=>i%2?89.999957:(i%4?179.999997:-179.999991)+i*1e-9);
  const indices=Uint32Array.of(0,259,2,259,256,0);
  for(const slots of [new Uint16Array(),Uint16Array.from({length:260},(_,i)=>i+256)]){
    const raw=encodeGlobeMesh({coordinates,indices,slots});
    const packed=packGlobeMesh(raw);
    assert.notDeepEqual(packed,raw);
    assert.deepEqual(decodeGlobeMesh(packed).positions.buffer,raw);
    assert.throws(()=>decodeGlobeMesh(packed.slice(0,-1)),/Invalid globe mesh/);

    // First encoded index is a delta from zero. Set it to the vertex count.
    const packedIndices=new Uint8Array(packed,16+coordinates.length/2*24,indices.length*4);
    const invalidDelta=coordinates.length;
    packedIndices[0]=invalidDelta&255;
    packedIndices[indices.length]=invalidDelta>>>8;
    assert.throws(()=>decodeGlobeMesh(packed),/Invalid globe mesh/);
  }
});

test('stroke endpoints reuse surface vertex precision and expose one instance per segment', () => {
  const coordinates = [179.999997, 42.000003, -179.999991, 42.000003, 179.999997, 42.000035];
  const mesh = decodeGlobeMesh(encodeGlobeMesh({ coordinates, indices: Uint32Array.of(0, 1, 2) }));
  const buffer = encodeGlobeStrokes(coordinates, Uint32Array.of(0, 1, 1, 2));
  const strokes = decodeGlobeStrokes(buffer);
  assert.equal(strokes.count, 2);
  assert.deepEqual(strokes.points.subarray(0,3),mesh.positions.subarray(0,3));
  assert.deepEqual(strokes.points.subarray(9,12),mesh.residuals.subarray(3,6));
  assert.deepEqual(strokes.endpointIndices,Uint32Array.of(0,1,1,2));
  assert.equal(strokes.points.length/6,3);
  assert.equal(strokes.points.buffer,buffer);
  assert.equal(strokes.endpointIndices.buffer,buffer);
  assert.throws(() => decodeGlobeStrokes(buffer.slice(0, -1)), /Invalid globe stroke/);
});

test('indexed strokes restore endpoints, widths and owner order and reject invalid references', () => {
  const coordinates = [179.999997,89.999923,-179.999991,89.999923,179.999997,89.999957];
  const packed=encodeGlobeStrokes(coordinates,Uint32Array.of(0,1,1,2,2,0),[1.25,2,1.5],Uint16Array.of(1,230,513));
  assert.equal(new DataView(packed).getUint32(16,true),3);
  const decoded=decodeGlobeStrokes(packed);
  assert.equal(decoded.points.buffer,packed);
  assert.deepEqual([...decoded.endpointIndices],[0,1,1,2,2,0]);
  assert.deepEqual([...decoded.widths],[1.25,2,1.5]);
  assert.deepEqual([...decoded.ownerGroups],[1,230,513]);
  assert.throws(()=>decodeGlobeStrokes(packed.slice(0,-1)),/Invalid globe stroke/);
  new DataView(packed).setUint32(20+3*24,3,true);
  assert.throws(()=>decodeGlobeStrokes(packed),/Invalid globe stroke/);
});

test('outlines store the shared border once with both country slots and retain hole and island edges', () => {
  const square = (x,y,size) => [[x,y],[x+size,y],[x+size,y+size],[x,y+size],[x,y]];
  const { buffer, owners } = globeAssets.buildGlobeOutlineStrokes([
    {type:'MultiPolygon',coordinates:[[square(0,0,.2),square(.05,.05,.05)],[square(1,1,.1)]]},
    {type:'Polygon',coordinates:[square(.2,0,.2)]},
  ]);
  const outline = decodeGlobeStrokes(buffer);
  assert.equal(outline.count,15);
  const ownerSlots = [...outline.ownerGroups].map(group=>owners[group]);
  assert.equal(ownerSlots.filter(slots=>slots.length===2).length,1);
  assert.deepEqual(ownerSlots.find(slots=>slots.length===2),[0,1]);
  assert.equal(ownerSlots.filter(slots=>slots.length===1&&slots[0]===0).length,11);
  assert.equal(ownerSlots.filter(slots=>slots.length===1&&slots[0]===1).length,3);
});

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
    attach(row){uploads.push(row.id);return {residentBytes:10,setVisible(){},dispose(){evicted.push(row.id);}};},
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
  const {createGlobePhysicalAssets}=await import('../../../src/rendering/three-globe-physical.js');
  const calls=[];
  const load=async spec=>{calls.push(spec.url);return {bytes:spec.url};};
  const asset=(url,sha256=url)=>({url,sha256});
  const chunk=spec=>({spec,bounds:[-1,-1,-1,1,1,1]});
  const context=(identity,water,rivers=asset('rivers'))=>({identity,riverChunks:[chunk(rivers)],
    waters:[{id:'waterbody:lake',chunks:[chunk(water)]}],lakes:[],riverDetail:[],riverMinZoom:2});
  const modern=asset('modern-water'),datedWater=asset('dated-water');
  const indexedWater=asset('modern-water-alias',modern.sha256);
  const assets=createGlobePhysicalAssets([
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
});

test('outline selection submits only active owner ranges in original segment order', async () => {
  const {indexGlobeOutlineRanges,selectGlobeOutlineGroups,globeOutlineRanges}=await import('../../../src/rendering/three-globe-surface.js');
  const packet={count:6,ownerGroups:Uint16Array.of(0,0,1,2,1,0)};
  const index=indexGlobeOutlineRanges(packet,[[5],[5,8],[8]]);
  const styles=[{width:0,alpha:0},{width:1,alpha:1},{width:2,alpha:1}];
  const groups=selectGlobeOutlineGroups(index,new Map([[5,1],[8,2]]),styles);
  assert.deepEqual(globeOutlineRanges(index,groups),[
    {first:0,end:2,code:1},{first:2,end:3,code:2},{first:3,end:4,code:2},
    {first:4,end:5,code:2},{first:5,end:6,code:1},
  ]);
  assert.deepEqual(globeOutlineRanges(index,selectGlobeOutlineGroups(index,new Map([[8,2]]),styles)),[
    {first:2,end:3,code:2},{first:3,end:4,code:2},{first:4,end:5,code:2},
  ]);
  assert.equal(selectGlobeOutlineGroups(index,new Map([[8,0]]),styles).size,0);
});

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

test('dated physical cache drops inactive contexts without releasing a shared active river', async () => {
  const {createGlobePhysicalAssets}=await import('../../../src/rendering/three-globe-physical.js');
  const reads=[];
  const load=async spec=>{reads.push(spec.sha256);return {positions:new Float32Array(2)};};
  const chunk=sha256=>({spec:{sha256},bounds:[-1,-1,-1,1,1,1]});
  const context=identity=>({identity,riverChunks:[chunk('river')],waters:[{id:'water',chunks:[chunk(identity)]}],lakes:[],riverDetail:[],riverMinZoom:2});
  const assets=createGlobePhysicalAssets([context('old'),context('current')],{loadMesh:load,loadStroke:load,byteBudget:16});
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

test('sparse spatial leaves separate alternating hemispheres and preserve draw order',async()=>{
  const {buildGlobeSpatialIndex,createGlobeSpatialSelection,prepareGlobeSpatialPacket}=await import('../../../src/rendering/globe-spatial-partition.js');
  const coordinates=[],owners=[],widths=[];
  for(let i=0;i<1000;i++){
    const lon=i%2?180:0;coordinates.push(lon,0,lon+.1,0);owners.push(i%3);widths.push(1);
  }
  const stroke=decodeGlobeStrokes(encodeGlobeStrokes(coordinates,null,widths,Uint16Array.from(owners)));
  const index=buildGlobeSpatialIndex(stroke),selection=createGlobeSpatialSelection(stroke,index);
  assert.deepEqual([...index.order].sort((a,b)=>a-b),Array.from({length:1000},(_,i)=>i));
  const near=(bounds,at)=>bounds[at+3]>0;
  const selected=selection.select(near,0);
  assert.equal(selected.count,500);
  assert.deepEqual([...selected.ranges],Array.from({length:500},(_,i)=>[2*i,2*i+1]).flat());
  assert.equal(selection.select(near,0).changed,false);
  assert.equal(selection.select(near,1,owner=>owner===0).count,167);
  const prepared=prepareGlobeSpatialPacket(stroke);
  assert.equal(prepared.spatialParts[0].packet.points,stroke.points);
  const country=(id,lon)=>({id,geometry:{id,version:1},vertices:Float64Array.of(lon,0,lon+.1,0,lon,.1),indices:Uint32Array.of(0,1,2)});
  const mesh=prepareGlobeSpatialPacket(decodeGlobeMesh(combineGlobeCountryMeshes([country('a',0),country('b',90),country('c',-90)]).buffer));
  const fill=createGlobeSpatialSelection(mesh,mesh.spatial);
  assert.deepEqual([...fill.select(()=>true,0,slot=>slot!==1).ranges],[0,1,2,3]);
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

test('physical plans defer hidden and higher-zoom lake and river packets',async()=>{
  const {createGlobePhysicalAssets}=await import('../../../src/rendering/three-globe-physical.js');
  const reads=[],load=async spec=>{reads.push(spec.sha256);return {positions:new Float32Array(2)};};
  const chunk=sha256=>({spec:{sha256},bounds:[-1,-1,-1,1,1,1]});
  const assets=createGlobePhysicalAssets([{identity:'world',riverChunks:[chunk('river')],riverMinZoom:3,
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

test('historical stroke batches deduplicate point words without changing primitive and owner order',()=>{
  const a=decodeGlobeStrokes(encodeGlobeStrokes([0,0,1,0,1,0,2,0],null,[1,2],Uint16Array.of(7,8)));
  const b=decodeGlobeStrokes(encodeGlobeStrokes([2,0,1,0,1,0,3,0],null,[3,4],Uint16Array.of(9,10)));
  const builder=createGlobeStrokeBatchBuilder((a.points.length+b.points.length)/6);
  builder.append(a);builder.append(b);
  const batch=builder.finish();
  assert.equal(batch.points.length/6,4);
  assert.equal(batch.count,4);
  assert.deepEqual([...batch.endpointIndices],[0,1,1,2,2,1,1,3]);
  assert.deepEqual([...batch.widths],[1,2,3,4]);
  assert.deepEqual([...batch.ownerGroups],[7,8,9,10]);
  const source=[a,b].flatMap(packet=>Array.from({length:packet.count},(_,i)=>[globeStrokePoint(packet,i,0),globeStrokePoint(packet,i,1)]));
  const endpoints=packet=>Array.from({length:packet.count},(_,i)=>[globeStrokePoint(packet,i,0),globeStrokePoint(packet,i,1)]);
  assert.deepEqual(endpoints(batch),source);
  const compact=compactGlobeStrokeRange(batch,2,4);
  assert.deepEqual(endpoints(compact),source.slice(2));
  assert.deepEqual([...compact.ownerGroups],[9,10]);
  assert.equal(compact.points.length/6,3);
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

test('indexed point texture keeps six coordinate words per point and pads only the last row',async()=>{
  const {createGlobeStrokePointTexture}=await import('../../../src/rendering/three-globe-strokes.js');
  class DataTexture{constructor(data,width,height){this.image={data,width,height};}}
  const points=Float32Array.of(1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18);
  const resource=createGlobeStrokePointTexture({DataTexture,RGBAFormat:1,FloatType:2,NearestFilter:3},points,16);
  assert.deepEqual([...resource.texture.image.data.subarray(0,points.length)],[...points]);
  assert.equal(resource.uniforms.pointTextureWidth.value,resource.texture.image.width);
  assert.equal(resource.bytes,resource.texture.image.data.byteLength);
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


test('outline chunks index owner memberships and retain only selected point words',async()=>{
  const {indexGlobeOutlineChunks,buildGlobeOutlinePointSubset,outlineInstanceCapacity}=await import('../../../src/rendering/globe-outline-cache.js');
  const {globeStrokeRange}=await import('../../../src/rendering/globe-spatial-partition.js');
  const source=decodeGlobeStrokes(encodeGlobeStrokes([0,0,1,0,1,0,2,0,2,0,3,0,3,0,4,0],null,[],Uint16Array.of(0,1,0,2)));
  const packet={...source,spatialParts:[{packet:globeStrokeRange(source,0,2)},{packet:globeStrokeRange(source,2,4)}]};
  const index=indexGlobeOutlineChunks(packet,[[0,1],[1],[2]]);
  assert.deepEqual(index.groupsBySlot.get(1),[0,1]);
  assert.deepEqual(index.chunksByGroup[0].map(row=>[row.chunkId,row.count,row.ranges]),[[0,1,[[0,1]]],[1,1,[[0,1]]]]);
  assert.equal(index.chunksByGroup[2][0].chunkId,1);
  const subset=buildGlobeOutlinePointSubset(source,[[0,1],[2,3]]);
  assert.equal(subset.count,2);
  assert.deepEqual([...subset.segmentOffsets],[0,-1,1,-1]);
  assert.deepEqual([...subset.endpointIndices],[0,1,2,3]);
  const originalWords=new Uint32Array(source.points.buffer,source.points.byteOffset,source.points.length);
  const subsetWords=new Uint32Array(subset.points.buffer);
  for(const [offset,sourceId] of [0,1,2,3].entries()){
    assert.deepEqual(subsetWords.subarray(offset*6,offset*6+6),originalWords.subarray(sourceId*6,sourceId*6+6));
  }
  assert.equal(outlineInstanceCapacity(0,70,8192),128);
  assert.equal(outlineInstanceCapacity(1024,400,8192),1024);
  assert.equal(outlineInstanceCapacity(1024,200,8192),256);
});


test('incremental stroke merge consumes packets in exact source order',async()=>{
 const {createGlobeStrokeBatchBuilder}=await import('../../../src/rendering/globe-mesh.js');
 const a=decodeGlobeStrokes(encodeGlobeStrokes([0,0,1,0],null,[1],Uint16Array.of(7)));
 const b=decodeGlobeStrokes(encodeGlobeStrokes([1,0,2,0],null,[2],Uint16Array.of(8)));
 const builder=createGlobeStrokeBatchBuilder(4);
 builder.append(a);builder.append(b);
 const batch=builder.finish();
 assert.equal(batch.count,2);assert.equal(batch.points.length/6,3);
 assert.deepEqual([...batch.endpointIndices],[0,1,1,2]);
 assert.deepEqual([...batch.widths],[1,2]);assert.deepEqual([...batch.ownerGroups],[7,8]);
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


test('view mesh chunks preserve all primitive coordinate bits, owners and source order',async()=>{
 const {globeMeshChunks}=await import('../../../scripts/lib/globe-preview-assets.mjs');
 const {createGlobeChunkCatalog,globeChunkSetContains}=await import('../../../src/rendering/globe-view-mesh-assets.js');
 const rows=[0,180].map((lon,i)=>({id:String(i),geometry:{id:String(i),version:1},
  vertices:Float64Array.of(lon,0,lon+.1,0,lon,.1),indices:Uint32Array.of(0,1,2)}));
 const source=combineGlobeCountryMeshes(rows).buffer;
 const chunks=[...globeMeshChunks(source,{minTriangles:1,maxTriangles:1})];
 assert.equal(chunks.length,2);
 const bits=mesh=>{
  const high=new Uint32Array(mesh.positions.buffer,mesh.positions.byteOffset,mesh.positions.length);
  const low=new Uint32Array(mesh.residuals.buffer,mesh.residuals.byteOffset,mesh.residuals.length);
  return [...mesh.indices].map(id=>[...high.subarray(id*3,id*3+3),...low.subarray(id*3,id*3+3),mesh.slots[id]]);
 };
 assert.deepEqual(chunks.flatMap(row=>bits(decodeGlobeMesh(row.buffer))),bits(decodeGlobeMesh(source)));
 assert.deepEqual(chunks.map(row=>row.slots),[[0],[1]]);
 const descriptors=chunks.map((row,index)=>({...row,key:String(index)}));
 const catalog=createGlobeChunkCatalog(descriptors);
 assert.deepEqual(catalog.select(bounds=>bounds[3]>0,row=>row.slots.includes(0)).map(row=>row.key),['0']);
 assert.deepEqual(catalog.select(bounds=>bounds[3]>0,row=>row.slots.includes(1)),[]);
 assert.equal(globeChunkSetContains(descriptors,[descriptors[0]]),true);
 assert.equal(globeChunkSetContains([descriptors[0]],descriptors),false);
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
 const {createGlobePhysicalAssets}=await import('../../../src/rendering/three-globe-physical.js');
 const reads=[],load=async row=>{reads.push(row.sha256);return {positions:new Float32Array(1)};};
 const assets=createGlobePhysicalAssets([{identity:'world',waters:[{id:'sea',chunks:[
  {spec:{sha256:'near'},bounds:[.8,0,0,1,.1,.1]},{spec:{sha256:'far'},bounds:[-1,0,0,-.8,.1,.1]},
 ]}],riverChunks:[{spec:{sha256:'river'},bounds:[-1,-1,-1,1,1,1]}],riverMinZoom:8,lakes:[],riverDetail:[]}],{loadMesh:load,loadStroke:load});
 const near=assets.plan('world',{zoom:2,cull:box=>box[3]>0});
 assets.retain([near]);const prepared=await assets.prepare(near);
 assert.deepEqual(reads,['near']);assert.equal(prepared.waters[0].id,'sea');
 const far=assets.plan('world',{zoom:2,cull:box=>box[0]<0});
 assert.equal(assets.coversWaters(near,far),false);
 assets.dispose();
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


test('spatial download chunks isolate alternating hemispheres without losing exact primitives',async()=>{
 const {globeMeshChunks,globeStrokeChunks}=await import('../../../scripts/lib/globe-preview-assets.mjs');
 const {globeSpatialPrimitiveOrder}=await import('../../../src/rendering/globe-spatial-partition.js');
 const coordinates=[],indices=[];
 for(let i=0;i<20;i++){
  const lon=i%2?180:0;coordinates.push(lon,0,lon+.01,0,lon,.01);indices.push(i*3,i*3+1,i*3+2);
 }
 const source=encodeGlobeMesh({coordinates,indices:Uint32Array.from(indices)});
 const chunks=[...globeMeshChunks(source,{span:.45})];
 assert.equal(chunks.length,2);assert.equal(chunks.reduce((n,row)=>n+row.end-row.first,0),20);
 assert.ok(chunks.every(row=>row.bounds[3]-row.bounds[0]<.45));
 const slots=Uint16Array.from({length:coordinates.length/2},(_,i)=>i<30?0:1);
 const owned=decodeGlobeMesh(encodeGlobeMesh({coordinates,indices:Uint32Array.from(indices),slots}));
 const order=globeSpatialPrimitiveOrder(owned);
 assert.ok(order.subarray(0,10).every(id=>id<10));assert.ok(order.subarray(10).every(id=>id>=10));
 const lines=Array.from({length:20},(_,i)=>[i%2?180:0,0,i%2?180.01:.01,0]).flat();
 const strokes=[...globeStrokeChunks(encodeGlobeStrokes(lines),{preserveOwnerOrder:false})];
 assert.equal(strokes.length,2);assert.equal(strokes.reduce((n,row)=>n+decodeGlobeStrokes(row.buffer).count,0),20);
});

test('optional spatial preparation failure cannot blacklist required coverage',async()=>{
 const {createGlobePlanFailures,createGlobeChunkCatalog}=await import('../../../src/rendering/globe-view-mesh-assets.js');
 const failures=createGlobePlanFailures();
 failures.fail('view',false);assert.equal(failures.allow('view',false),false);
 assert.equal(failures.allow('view',true),true);
 failures.clear();assert.equal(failures.allow('view',false),true);
 const index=createGlobeChunkCatalog([
  {key:'far',bounds:[-1,0,0,-.9,.1,.1],spec:{sha256:'a'}},
  {key:'near',bounds:[.9,0,0,1,.1,.1],spec:{sha256:'b'}},
 ]);
 assert.deepEqual(index.select(box=>box[0]>0).map(row=>row.key),['near']);
 assert.throws(()=>createGlobeChunkCatalog([{spec:{sha256:'unbounded'}}]),/Cartesian globe chunk bounds/);
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

test('physical catalog selects lake and base/detail river chunks through Cartesian coverage',async()=>{
 const {createGlobePhysicalAssets}=await import('../../../src/rendering/three-globe-physical.js');
 const near=[.8,0,0,1,.1,.1],far=[-1,0,0,-.8,.1,.1],chunk=(id,bounds)=>({spec:{sha256:id},bounds});
 const reads=[],load=async spec=>{reads.push(spec.sha256);return {points:new Float32Array(6)};};
 const assets=createGlobePhysicalAssets([{identity:'world',waters:[],lakes:[{minZoom:3,chunks:[chunk('lake-near',near),chunk('lake-far',far)]}],
  riverMinZoom:3,riverChunks:[chunk('river-near',near),chunk('river-far',far)],riverDetail:[
   {...chunk('detail-near',near),id:'d1',minZoom:5},{...chunk('detail-far',far),id:'d2',minZoom:5},
  ]}],{loadMesh:load,loadStroke:load});
 const cull=box=>box[0]>0,plan=assets.plan('world',{zoom:5,cull,strokeCull:cull});
 assets.retain([plan]);const prepared=await assets.prepare(plan);
 assert.equal(prepared.lakes.length,1);assert.equal(prepared.riverChunks.length,1);
 assert.deepEqual(reads.sort(),['lake-near','river-near']);
 assert.deepEqual(assets.detailPlan('world',{zoom:5,strokeCull:cull}).map(row=>row.id),['d1']);
 assets.dispose();
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
