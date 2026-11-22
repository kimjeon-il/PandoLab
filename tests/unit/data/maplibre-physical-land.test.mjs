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

test('verified display replaces the raw land download and falls back when unavailable',async()=>{
 const original=geometry([square(0,0),square(1,0)]),display=geometry(union(original.coordinates));
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),bytes=value=>new TextEncoder().encode(JSON.stringify(value));
 const raw=bytes(original),decoded=bytes(display),prepared=gzipSync(decoded),sourceHash=hash(raw),displayHash=hash(prepared),calls=[];
 const source={url:'assets/data/test-land.json',sha256:sourceHash,encoding:'identity',compressedBytes:raw.length,decodedBytes:raw.length};
 const spec={url:'assets/data/display-land/sha256-'+displayHash+'.json.gz',sha256:displayHash,encoding:'gzip',compressedBytes:prepared.length,decodedBytes:decoded.length,
  sourceSha256:sourceHash,algorithmVersion:'physical-display-union-v1',algorithmSha256:'a'.repeat(64)};
 let notifications=0;
 const createReader=(preparedBytes=prepared)=>createPhysicalAssetReader({buildMeta:{dataRevision:'fixture',physicalLand:source,physicalLandDisplays:{[sourceHash]:spec}},
  onLandReady:()=>notifications++,resolveBaseUrl:()=>new URL('https://fixture.test/assets/data/'),
  createLoader:options=>createStoredAssetLoader({...options,cacheStorage:null,fetchFn:async url=>{calls.push(String(url));return new Response(String(url).includes('display-land')?preparedBytes:raw);}})});
 const reader=createReader();
 const [first,second]=await Promise.all([reader.loadPhysicalLand(),reader.loadPhysicalLand(source)]);
 assert.deepEqual(first,{geometry:display,revision:sourceHash,displayPrepared:true});
 assert.strictEqual(second,first);assert.strictEqual(reader.physicalLand,first);
 assert.deepEqual(calls,['https://fixture.test/assets/data/'+spec.url.slice('assets/data/'.length)]);
 assert.equal(notifications,1);
 const fallback=await createReader(Buffer.alloc(prepared.length)).loadPhysicalLand();
 assert.deepEqual(fallback,{geometry:original,revision:sourceHash,displayPrepared:false});
 assert.equal(calls.at(-1),'https://fixture.test/assets/data/test-land.json');
 assert.equal(calls.filter(url=>url.endsWith('/test-land.json')).length,1);
});

test('external archive routing permits only the explicitly published display asset',async()=>{
 const sha='a'.repeat(64),path='assets/data/display-land/sha256-'+sha+'.json.gz',calls=[];
 const fetchData=createExternalRuntimeDataFetch({meta:{externalRuntimeData:{revision:'b'.repeat(40),files:{}},physicalLandDisplays:{source:{url:path,sha256:sha}}},fetchFn:async url=>{calls.push(String(url));return new Response('display');}});
 await fetchData('https://fixture.test/'+path);
 assert.equal(calls.length,1);assert.ok(calls[0].startsWith('https://fixture.test/'));
 await assert.rejects(fetchData('https://fixture.test/assets/data/display-land/unpublished.json.gz'),/Missing pinned/);
});

test('geometry Worker initialization recovery resubmits concurrent live requests', async () => {
 const {createMapGeometryRequester}=await import('../../../src/rendering/maplibre-viewer-renderer.js');
 const {createWorkerRpcClient}=await import('../../../src/runtime/worker-rpc.js');
 const requests=[];
 let rpc=null, workers=0;
 const createWorker=()=>{
  const index=workers++;
  return {postMessage(message){
   if(message.type!=='request')return;
   requests.push([index,message.operation]);
   if(index===0&&message.operation==='geometry.prepare')return;
   queueMicrotask(()=>this.onmessage?.({data:{...message,type:'result',ok:index>0,
    ...(index===0?{error:{code:'PL-MAP-GEOMETRY-INITIALIZATION',message:'Core unavailable'}}:{result:message.operation}),
   }}));
  }};
 };
 const prepare=createMapGeometryRequester({
  getWorker:()=>rpc ||= createWorkerRpcClient({createWorker}),
  restartWorker:worker=>{if(worker===rpc){rpc=null;worker.stop();}},
  waitBeforeRetry:()=>Promise.resolve(),
 });
 const signal=new AbortController().signal;
 assert.deepEqual(await Promise.all([
  prepare('geometry.physical-land',{},0,signal), prepare('geometry.prepare',{},0,signal),
 ]),['geometry.physical-land','geometry.prepare']);
 assert.deepEqual(requests,[[0,'geometry.physical-land'],[0,'geometry.prepare'],[1,'geometry.physical-land'],[1,'geometry.prepare']]);
 rpc.stop();
});

test('prepared country topology reuses an existing snapshot and deltas while a seed is unavailable',async()=>{
 const {createCountryBoundaryPreparation}=await import('../../../src/rendering/country-shared-boundary-state.js');
 let attempts=0;
 const preparation=createCountryBoundaryPreparation({
  loadSeed:signal=>{attempts++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},
  seedWaitMs:1,
 });
 const feature=(id,x)=>({id,geometry:{type:'Polygon',coordinates:square(x,0)}});
 const context={throwIfCancelled(){}};
 const result=await preparation.prepare({key:'A',baseKey:null,upserts:[feature('left',0),feature('right',1)]},context);
 assert.ok(result.segments.length>0);
 assert.strictEqual((await preparation.prepare({key:'A',baseKey:'A'},context)).segments,result.segments);
 const updated=await preparation.prepare({key:'B',baseKey:'A',upserts:[feature('right',3)],remove:[]},context);
 assert.deepEqual(updated.segments,[]);
 assert.equal(attempts,1);
 assert.match(preparation.stats().boundarySeedFailure,/timed out/);
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

test('geometry Worker transfers compact cap rows and complete full-extent highlight rows',async t=>{
 const names=['self','location','importScripts','PANDOLAB_BUILD_META','PandoLabWorkerRpc','PandoLabPolygonMeshCore'];
 const previous=Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
 t.after(()=>{for(const name of names){if(previous[name])Object.defineProperty(globalThis,name,previous[name]);else delete globalThis[name];}});
 const catalog='assets/data/fixture/catalog.json';
 const roles=['world','territorial','rivers','lakes','places','placeLifetimes','physicalLand','preparedMeshes'];
 globalThis.PANDOLAB_BUILD_META={assetRevision:'fixture',dataRevision:'fixture',resourceProfile:'test-fixture',
  mapProject:{format:'pandolab-map-project-manifest',schemaVersion:1,projectId:'fixture',name:'Fixture map',documentFormat:'pandolab-project-state',
   resources:Object.fromEntries(roles.map(role=>[role,{catalog}]))},
  projectCatalogs:{preparedMeshes:{catalog,bytes:2,sha256:'a'.repeat(64),current:false}}};
 globalThis.importScripts=()=>{};
 const positions=new Float32Array([0,0,1,0,0,1,0,-86,1,-86,0,-87,0,85,1,85,0,86]);
 const indices=new Uint32Array([0,1,2,3,4,5,6,7,8]);
 let prepare;
 globalThis.self=globalThis;
 globalThis.location=new URL('https://fixture.test/geometry.js?v=fixture&dataRevision=fixture');
 globalThis.PandoLabWorkerRpc={install({handlers}){prepare=handlers['geometry.prepare'];},transferResult:(result,buffers)=>structuredClone(result,{transfer:buffers})};
 globalThis.PandoLabPolygonMeshCore={setSharedCore(){},MESH_ALGORITHM_REVISION:6,buildPolygonGeometryPacket:()=>({
   algorithmVersion:6,maxEdgeDegrees:.4,positions,indices,featureIds:new Uint32Array(9),boundaryIndices:new Uint32Array(),
   ringCoordinates:new Float64Array(),ringOffsets:new Uint32Array(),polygonOffsets:new Uint32Array(),
  })};
 await import('../../../src/rendering/workers/map-geometry-worker.js');
 const geometry={type:'Polygon',coordinates:square(0,-88)},context={throwIfCancelled(){}};
 const cap=await prepare({items:[{kind:'fill',cacheKey:'cap',geometry,polarCapOnly:true}]},context);
 assert.deepEqual([...cap.packets[0].packet.positions],[...positions.slice(6)]);
 assert.deepEqual([...cap.packets[0].packet.indices],[0,1,2,3,4,5]);
 assert.deepEqual(cap.packets[0].packet.ranges.map(({offset,count})=>[offset,count]),[[0,3],[3,3]]);
 assert.equal(cap.stats.transferBytes,72);
 const full=await prepare({items:[{kind:'fill',cacheKey:'full',geometry,polarCapOnly:false}]},context);
 assert.deepEqual(full.packets[0].packet.positions,positions);
 assert.deepEqual(full.packets[0].packet.indices,indices);
 assert.equal(full.stats.transferBytes,108);
});
