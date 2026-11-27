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

test('indexed point texture keeps six coordinate words per point and pads only the last row',async()=>{
  const {createGlobeStrokePointTexture}=await import('../../../src/rendering/three-globe-strokes.js');
  class DataTexture{constructor(data,width,height){this.image={data,width,height};}}
  const points=Float32Array.of(1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18);
  const resource=createGlobeStrokePointTexture({DataTexture,RGBAFormat:1,FloatType:2,NearestFilter:3},points,16);
  assert.deepEqual([...resource.texture.image.data.subarray(0,points.length)],[...points]);
  assert.equal(resource.uniforms.pointTextureWidth.value,resource.texture.image.width);
  assert.equal(resource.bytes,resource.texture.image.data.byteLength);
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
 const {createRenderResidencyBudget}=await import('../../../src/rendering/render-cache-budget.js');
 const residency=createRenderResidencyBudget(1024);
 const failures=createGlobePlanFailures({residency,onRetry:()=>assert.fail('permanent failure should not retry')});
 failures.fail('view',false,Error('invalid packet'));assert.equal(failures.allow('view',false),false);
 assert.equal(failures.allow('view',true),true);
 failures.clear();assert.equal(failures.allow('view',false),true);residency.dispose();
 const index=createGlobeChunkCatalog([
  {key:'far',bounds:[-1,0,0,-.9,.1,.1],spec:{sha256:'a'}},
  {key:'near',bounds:[.9,0,0,1,.1,.1],spec:{sha256:'b'}},
 ]);
 assert.deepEqual(index.select(box=>box[3]>0).map(row=>row.key),['near']);
 assert.throws(()=>createGlobeChunkCatalog([{spec:{sha256:'unbounded'}}]),/Cartesian globe chunk bounds/);
});


test('globe LOD selects progressively finer geometry with zoom, DPR and hysteresis', async () => {
  const {GLOBE_LODS,GLOBE_FINE_LOD,selectGlobeLod,validateGlobeLodChunks}=await import('../../../src/rendering/globe-lod.js');
  assert.deepEqual(GLOBE_LODS.map(row=>row.maxEdgeDegrees),[4,1.5,.499]);
  assert.equal(selectGlobeLod({zoom:2,dpr:1}),0);
  assert.equal(selectGlobeLod({zoom:4,dpr:1}),1);
  assert.equal(selectGlobeLod({zoom:9,dpr:1}),GLOBE_FINE_LOD);
  assert.equal(selectGlobeLod({zoom:3,dpr:2}),1);
  assert.equal(selectGlobeLod({zoom:2,enabled:false}),GLOBE_FINE_LOD);
  assert.equal(selectGlobeLod({zoom:3.5,dpr:1}),0);
  assert.equal(selectGlobeLod({zoom:3.5,dpr:1,previous:1}),1);
  assert.equal(selectGlobeLod({zoom:3,dpr:1,previous:1}),0);
  assert.throws(()=>validateGlobeLodChunks([{lod:0},{lod:2}],1),/Incomplete/);
  assert.throws(()=>validateGlobeLodChunks([{lod:0,slots:[1]},{lod:1,slots:[1]},{lod:2,slots:[1,2]}],1),/owner coverage/);
  assert.deepEqual(validateGlobeLodChunks([{slots:[1]}],undefined),[{slots:[1]}]);
});

test('display LOD retains exact river endpoint bits and protects junctions and owner changes', async () => {
  const {GLOBE_LODS}=await import('../../../src/rendering/globe-lod.js');
  const {createGlobeRiverJunctionGuard,simplifyGlobeRiverPacket}=await import('../../../scripts/lib/globe-lod-assets.mjs');
  const line=decodeGlobeStrokes(encodeGlobeStrokes([0,0,.001,0,.001,0,.002,0,.002,0,.003,0,.003,0,.004,0],null,[1,1,1,1],Uint16Array.of(7,7,7,8)));
  const branch=decodeGlobeStrokes(encodeGlobeStrokes([.002,0,.002,.001],null,[1],Uint16Array.of(9)));
  const guard=createGlobeRiverJunctionGuard([line,branch],{filterBytes:8192});
  const coarse=simplifyGlobeRiverPacket(line,GLOBE_LODS[0],guard);
  assert.equal(coarse.count,3);
  assert.deepEqual([...coarse.ownerGroups],[7,7,8]);
  assert.deepEqual(globeStrokePoint(coarse,0,0),globeStrokePoint(line,0,0));
  assert.deepEqual(globeStrokePoint(coarse,0,1),globeStrokePoint(line,1,1));
  assert.deepEqual(globeStrokePoint(coarse,1,1),globeStrokePoint(line,2,1));
  assert.deepEqual(globeStrokePoint(coarse,2,1),globeStrokePoint(line,3,1));
  assert.equal(simplifyGlobeRiverPacket(line,GLOBE_LODS[2],guard),line);
  const bend=decodeGlobeStrokes(encodeGlobeStrokes([0,0,.01,.03,.01,.03,.02,0],null,[1,1]));
  assert.equal(simplifyGlobeRiverPacket(bend,GLOBE_LODS[0]).count,2);
});

test('globe spatial chunk levels keep exact primitive bits and choose only their own descriptor index', async () => {
  const {GLOBE_LODS}=await import('../../../src/rendering/globe-lod.js');
  const {createGlobeChunkCatalog}=await import('../../../src/rendering/globe-view-mesh-assets.js');
  const buffer=encodeGlobeMesh({coordinates:[0,0,.1,0,0,.1],indices:Uint32Array.of(0,1,2),slots:Uint16Array.of(1,1,1)});
  const rows=GLOBE_LODS.flatMap(lod=>[...globeAssets.globeMeshChunks(buffer,{span:lod.span,cellDivisions:lod.cellDivisions})]
    .map((row,index)=>({...row,lod:lod.id,key:lod.id+':'+index})));
  const catalog=createGlobeChunkCatalog(rows);
  for (const lod of GLOBE_LODS) {
    const selected=catalog.select(()=>true,()=>true,lod.id);
    assert.equal(selected.length,1);
    assert.equal(selected[0].lod,lod.id);
    assert.deepEqual(decodeGlobeMesh(selected[0].buffer).indices,Uint32Array.of(0,1,2));
  }
});
