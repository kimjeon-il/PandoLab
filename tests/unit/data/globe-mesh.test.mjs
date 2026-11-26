import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeGlobeMesh, packGlobeMesh, decodeGlobeStrokes, globeStrokePoint, combineGlobeStrokePackets, compactGlobeStrokeRange } from '../../../src/rendering/globe-mesh.js';
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
  const {selectGlobeRiverChunks}=await import('../../../src/rendering/three-globe-rivers.js');
  const river=(stage,coordinates)=>({geometry:{type:'LineString',coordinates},properties:{stage,stroke_width:1,stroke_widths:[[1,2]]}});
  const output=globeAssets.buildGlobeRiverPackets([
    river(0,[[5,1],[6,1]]),river(1,[[179.9,2],[-179.9,2]]),river(1,[[30,2],[31,2]]),river(2,[[179.91,3],[-179.91,3]]),
  ],[{id:0,minZoom:2},{id:1,minZoom:3},{id:2,minZoom:4}]);
  assert.equal(decodeGlobeStrokes(output.base).count,1);
  const chunks=output.detail;
  const bounds=[-180.125,1.5,-179.75,3.5];
  assert.equal(selectGlobeRiverChunks(chunks,bounds,2.99).length,0);
  const selected=selectGlobeRiverChunks(chunks,bounds,3);
  assert.equal(selected.length,1);
  const stroke=decodeGlobeStrokes(selected[0].buffer);
  assert.equal(stroke.count,1);
  assert.equal(stroke.widths[0],1.5);
  assert.deepEqual([...stroke.points.subarray(0,3)],globeVector([179.9,2]).map(Math.fround));
  assert.equal(selectGlobeRiverChunks(chunks,bounds,4).length,2);
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
  const context=(identity,water,rivers=asset('rivers'))=>({identity,rivers,
    waters:[{id:'waterbody:lake',spec:water}],lakes:[],riverDetail:[],riverMinZoom:2});
  const modern=asset('modern-water'),datedWater=asset('dated-water');
  const indexedWater={...modern,pickGrid:asset('water-pick')};
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
  assert.equal(current.rivers,dated.rivers);
  assert.notEqual(current.waters[0].mesh,dated.waters[0].mesh);
  assert.notEqual(current.waters[0].mesh,indexed.waters[0].mesh);
  assert.equal(dated.waters[0].id,'waterbody:lake');
  assert.deepEqual(calls.sort(),['dated-water','modern-water','modern-water','rivers']);
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
  cache.retain(['new']);
  assert.equal(cache.stats().residentBytes,16);
  cache.dispose();
  assert.equal(cache.stats().entries,0);
});

test('dated physical cache drops inactive contexts without releasing a shared active river', async () => {
  const {createGlobePhysicalAssets}=await import('../../../src/rendering/three-globe-physical.js');
  const reads=[];
  const load=async spec=>{reads.push(spec.sha256);return {positions:new Float32Array(2)};};
  const context=identity=>({identity,rivers:{sha256:'river'},waters:[{id:'water',spec:{sha256:identity}}],lakes:[],riverMinZoom:2});
  const assets=createGlobePhysicalAssets([context('old'),context('current')],{loadMesh:load,loadStroke:load,byteBudget:16});
  assets.retain([assets.plan('old')]);
  const old=await assets.prepare(assets.plan('old'));
  assets.retain([assets.plan('current')]);
  const current=await assets.prepare(assets.plan('current'));
  assert.equal(old.rivers,current.rivers);
  assert.equal(assets.stats().contexts,1);
  assets.retain([assets.plan('old')]);
  const restored=await assets.prepare(assets.plan('old'));
  assert.equal(restored.rivers,current.rivers);
  assert.notEqual(restored.waters[0].mesh,old.waters[0].mesh);
  assert.deepEqual(reads,['river','old','current','old']);
  assets.dispose();
});

test('spatial mesh and stroke ranges preserve every primitive and original owner order', async () => {
  const {partitionGlobeMesh,partitionGlobeStrokes,globeStrokeRange,visibleGlobeMeshRanges}=await import('../../../src/rendering/globe-spatial-partition.js');
  const options={minPrimitives:1,maxRanges:16,span:.1};
  const country=(id,lon)=>({id,geometry:{id,version:1},vertices:Float64Array.of(lon,0,lon+.1,0,lon,.1),indices:Uint32Array.of(0,1,2)});
  const mesh=decodeGlobeMesh(combineGlobeCountryMeshes([country('a',0),country('b',90),country('c',-90)]).buffer);
  const ranges=partitionGlobeMesh(mesh,options);
  assert.deepEqual(ranges.map(({first,end})=>[first,end]),[[0,1],[1,2],[2,3]]);
  assert.deepEqual(visibleGlobeMeshRanges(ranges,()=>true),[{first:0,end:3}]);
  assert.deepEqual(visibleGlobeMeshRanges(ranges,bounds=>bounds[1]<.5),[{first:0,end:1},{first:2,end:3}]);
  const stroke=decodeGlobeStrokes(encodeGlobeStrokes([0,0,.1,0,90,0,90.1,0,-90,0,-89.9,0],null,[1,2,3],Uint16Array.of(4,5,6)));
  const pieces=partitionGlobeStrokes(stroke,options).map(({first,end})=>globeStrokeRange(stroke,first,end));
  assert.deepEqual(pieces.flatMap(piece=>[...piece.ownerGroups]),[4,5,6]);
  assert.deepEqual(pieces.flatMap(piece=>[...piece.widths]),[1,2,3]);
  assert.deepEqual(pieces.flatMap(piece=>[...piece.endpointIndices]),[...stroke.endpointIndices]);
  assert.ok(pieces.every(piece=>piece.points===stroke.points&&piece.endpointIndices.buffer===stroke.endpointIndices.buffer));
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
  const assets=createGlobePhysicalAssets([{identity:'world',rivers:{sha256:'river'},riverMinZoom:3,
    waters:[{id:'sea',spec:{sha256:'sea'}}],
    lakes:[{minZoom:2,spec:{sha256:'large'}},{minZoom:5,spec:{sha256:'small'}}],
  }],{loadMesh:load,loadStroke:load});
  const low=assets.plan('world',{zoom:1});
  assets.retain([low]);
  const first=await assets.prepare(low);
  assert.deepEqual(reads,['sea']);assert.equal(first.rivers,null);assert.equal(first.lakes.length,0);
  const high=assets.plan('world',{zoom:4});
  assets.retain([low,high]);
  const next=await assets.prepare(high);
  assert.equal(next.waters[0].mesh,first.waters[0].mesh);
  assert.deepEqual(reads,['sea','river','large']);assert.equal(next.lakes.length,1);
  const hidden=assets.plan('world',{zoom:8,lakesVisible:false,riversVisible:false});
  assert.equal(hidden.key,low.key);assets.dispose();
});

test('historical stroke batches deduplicate point words without changing primitive and owner order',()=>{
  const a=decodeGlobeStrokes(encodeGlobeStrokes([0,0,1,0,1,0,2,0],null,[1,2],Uint16Array.of(7,8)));
  const b=decodeGlobeStrokes(encodeGlobeStrokes([2,0,1,0,1,0,3,0],null,[3,4],Uint16Array.of(9,10)));
  const batch=combineGlobeStrokePackets([a,b]);
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
