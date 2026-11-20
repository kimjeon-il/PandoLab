import test from 'node:test';
import assert from 'node:assert/strict';
import {sharedCalculationCore} from '../../../src/document/temporal.js';
import {dissolvePhysicalLand} from '../../../src/rendering/physical-land-display.js';
import {createPhysicalAssetReader} from '../../../src/data/physical-asset-reader.js';
import {createStoredAssetLoader} from '../../../src/data/stored-asset-loader.js';
import {createExternalRuntimeDataFetch} from '../../../src/data/external-runtime-data.js';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';

const union=coordinates=>sharedCalculationCore.polygonOperation('union',[coordinates],false);
const geometry=coordinates=>({type:'MultiPolygon',coordinates});
const square=(x,y,size=1)=>[[[x,y],[x+size,y],[x+size,y+size],[x,y+size],[x,y]]];

test('physical land removes shared administrative edges without changing occupied coverage',async()=>{
 const source=geometry([[[[0,0],[1,0],[1.1,.5],[1,1],[0,1],[0,0]]],[[[1,0],[2,0],[2,1],[1,1],[1.1,.5],[1,0]]]]);
 const before=structuredClone(source),display=await dissolvePhysicalLand(source,{union});
 assert.equal(display.coordinates.length,1);
 assert.deepEqual(sharedCalculationCore.polygonOperation('xor',[source.coordinates,display.coordinates],false),[]);
 assert.deepEqual(source,before);
});

test('physical land preserves lake holes and disconnected islands and keeps polar/dateline singletons untouched',async()=>{
 const withLake=[...square(0,0,4),square(1,1)[0].slice().reverse()];
 const source=geometry([withLake,square(4,0,4),square(20,0),square(179,20),square(-180,20),[[[-180,-90],[180,-90],[180,-85],[-180,-85],[-180,-90]]]]);
 const display=await dissolvePhysicalLand(source,{union});
 assert.equal(display.coordinates.length,5);
 assert.equal(display.coordinates[0].length,2,'Real lake hole must survive');
 for(const polygon of source.coordinates.slice(2))assert.ok(display.coordinates.includes(polygon),'Disjoint original components are reused');
 assert.deepEqual(sharedCalculationCore.polygonOperation('xor',[source.coordinates.slice(0,3),display.coordinates.slice(0,2)],false),[]);
});

test('physical display stops between connected components when its request is superseded',async()=>{
 const source=geometry([square(0,0),square(1,0),square(10,0),square(11,0)]);let calls=0;
 await assert.rejects(dissolvePhysicalLand(source,{union:coordinates=>{calls++;return union(coordinates);},checkpoint:async()=>{if(calls)throw Object.assign(new Error('superseded'),{name:'AbortError'});}}),{name:'AbortError'});
 assert.equal(calls,1);
});

test('prepared display loads in parallel while canonical land remains unchanged',async()=>{
 const original=geometry([square(0,0),square(1,0)]),display=geometry(union(original.coordinates));
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),bytes=value=>new TextEncoder().encode(JSON.stringify(value));
 const raw=bytes(original),decoded=bytes(display),prepared=gzipSync(decoded),sourceHash=hash(raw),displayHash=hash(prepared),calls=[];
 const source={url:'assets/data/test-land.json',sha256:sourceHash,encoding:'identity',compressedBytes:raw.length,decodedBytes:raw.length};
 const spec={url:'assets/data/display-land/sha256-'+displayHash+'.json.gz',sha256:displayHash,encoding:'gzip',compressedBytes:prepared.length,decodedBytes:decoded.length,
  sourceSha256:sourceHash,algorithmVersion:'physical-display-union-v1',algorithmSha256:'a'.repeat(64)};
 const reader=createPhysicalAssetReader({buildMeta:{dataRevision:'fixture',physicalLand:source,physicalLandDisplays:{[sourceHash]:spec}},resolveBaseUrl:()=>new URL('https://fixture.test/assets/data/'),
  createLoader:options=>createStoredAssetLoader({...options,cacheStorage:null,fetchFn:async url=>{calls.push(String(url));return new Response(String(url).includes('display-land')?prepared:raw);}})});
 const canonical=await reader.loadPhysicalLandMask();const result=await reader.loadPhysicalLandDisplay(sourceHash);
 assert.deepEqual(canonical.geometry,original);assert.deepEqual(result,display);
 assert.strictEqual(await reader.loadPhysicalLandDisplay(sourceHash),result);
 assert.equal(calls.length,2);assert.equal(await reader.loadPhysicalLandDisplay('b'.repeat(64)),null);
});

test('external archive routing permits only the explicitly published display asset',async()=>{
 const sha='a'.repeat(64),path='assets/data/display-land/sha256-'+sha+'.json.gz',calls=[];
 const fetchData=createExternalRuntimeDataFetch({meta:{externalRuntimeData:{revision:'b'.repeat(40),files:{}},physicalLandDisplays:{source:{url:path,sha256:sha}}},fetchFn:async url=>{calls.push(String(url));return new Response('display');}});
 await fetchData('https://fixture.test/'+path);
 assert.equal(calls.length,1);assert.ok(calls[0].startsWith('https://fixture.test/'));
 await assert.rejects(fetchData('https://fixture.test/assets/data/display-land/unpublished.json.gz'),/Missing pinned/);
});


test('polar geometry retries a failed manifest and transfers only detached fill arrays',async()=>{
 const {createPreparedPolygonMeshStore}=await import('../../../src/rendering/prepared-polygon-mesh.js');
 const geometry={type:'Polygon',coordinates:square(0,-88)};
 const packet={
  algorithmVersion:6,maxEdgeDegrees:.4,positions:new Float32Array([0,-88,1,-88,0,-87]),
  indices:new Uint32Array([0,1,2]),featureIds:new Uint32Array([0,0,0]),boundaryIndices:new Uint32Array([0,1,1,2,2,0]),
  ringCoordinates:new Float64Array(),ringOffsets:new Uint32Array(),polygonOffsets:new Uint32Array(),
 };
 let manifests=0,builds=0;
 const store=createPreparedPolygonMeshStore({engine:{MESH_ALGORITHM_REVISION:6,buildPolygonGeometryPacket(){builds++;return packet;}},
  loadManifest:async()=>{if(++manifests===1)throw Error('temporary catalog failure');return null;}});
 const job={cacheKey:'first',geometry},context={throwIfCancelled(){}};
 await assert.rejects(store.prepare(job,context),/temporary catalog failure/);
 const first=(await store.prepare(job,context)).packet;
 assert.deepEqual(Object.keys(first).sort(),['indices','maxEdgeDegrees','positions']);
 assert.equal(first.indices.byteLength,first.indices.buffer.byteLength);
 assert.equal(first.positions.byteLength,first.positions.buffer.byteLength);
 structuredClone(first,{transfer:[first.positions.buffer,first.indices.buffer]});
 const again=(await store.prepare({...job,cacheKey:'same-geometry'},context)).packet;
 assert.deepEqual(again.positions,packet.positions);
 assert.deepEqual(again.indices,packet.indices);
 assert.equal(manifests,2);
 assert.equal(builds,1);
});
