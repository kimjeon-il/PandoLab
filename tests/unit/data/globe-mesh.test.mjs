import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeGlobeMesh, packGlobeMesh, decodeGlobeStrokes } from '../../../src/rendering/globe-mesh.js';
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
  assert.deepEqual(strokes.start.subarray(0, 3), mesh.positions.subarray(0, 3));
  assert.deepEqual(strokes.endLow.subarray(0, 3), mesh.residuals.subarray(3, 6));
  assert.deepEqual(strokes.end.subarray(0, 3), strokes.start.subarray(3, 6));
  assert.throws(() => decodeGlobeStrokes(buffer.slice(0, -1)), /Invalid globe stroke/);
});

test('indexed strokes restore endpoints, widths and owner order and reject invalid references', () => {
  const coordinates = [179.999997,89.999923,-179.999991,89.999923,179.999997,89.999957];
  const raw = encodeGlobeStrokes(coordinates, Uint32Array.of(0,1,1,2,2,0), [1.25,2,1.5], Uint16Array.of(1,230,513));
  const packed = globeAssets.packGlobeStrokes(raw);
  assert.equal(new DataView(packed).getUint32(16,true),3);
  assert.deepEqual(decodeGlobeStrokes(packed).start.buffer,raw);
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
  assert.deepEqual([...stroke.start],globeVector([179.9,2]).map(Math.fround));
  assert.equal(selectGlobeRiverChunks(chunks,bounds,4).length,2);
});

test('detail view replaces stale loads and reuses a recently uploaded river chunk', async () => {
  const {createGlobeRiverDetail}=await import('../../../src/rendering/three-globe-rivers.js');
  const pending=new Map(), uploads=[], evicted=[];
  const chunk=id=>({id,spec:{decodedBytes:10}});
  const detail=createGlobeRiverDetail({byteBudget:20,
    load(row,signal){return new Promise(resolve=>pending.set(row.id,{signal,resolve}));},
    attach(row){uploads.push(row.id);return {setVisible(){},dispose(){evicted.push(row.id);}};},
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
    assets.prepare('current'),assets.prepare('dated'),assets.prepare('indexed'),
  ]);
  assert.equal(current.rivers,dated.rivers);
  assert.notEqual(current.waters[0].mesh,dated.waters[0].mesh);
  assert.notEqual(current.waters[0].mesh,indexed.waters[0].mesh);
  assert.equal(dated.waters[0].id,'waterbody:lake');
  assert.deepEqual(calls.sort(),['dated-water','modern-water','modern-water','rivers']);
  assert.equal(await assets.prepare('dated'),dated);
});
