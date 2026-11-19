import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {sharedCalculationCore} from '../../../src/document/temporal.js';
import {buildPhysicalLandDisplayAssets} from '../../../scripts/lib/physical-land-display-assets.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const algorithmSha256='a'.repeat(64);
const union=coordinates=>sharedCalculationCore.polygonOperation('union',[coordinates],false);
const geometry=coordinates=>({type:'MultiPolygon',coordinates});
const square=x=>[[[x,0],[x+1,0],[x+1,1],[x,1],[x,0]]];
function fixture(){
 const files=new Map(),reads=new Map();
 const store=(value,name,encoding='gzip')=>{
  const json=Buffer.from(JSON.stringify(value)),bytes=encoding==='gzip'?gzipSync(json):json;
  const url='assets/data/physical-land/v1/'+name;
  files.set(url,bytes);
  return {url,encoding,compressedBytes:bytes.length,decodedBytes:json.length,sha256:hash(bytes)};
 };
 const readPinnedData=path=>{reads.set(path,(reads.get(path)||0)+1);return files.get(path);};
 return {files,reads,store,readPinnedData};
}
function unpack(result,source){
 const spec=result.specs[source.sha256],bytes=result.assets.get(spec.url),json=gunzipSync(bytes);
 assert.ok(bytes,'Receipt asset belongs to the generated publication');
 assert.equal(spec.sourceSha256,source.sha256);
 assert.equal(spec.algorithmVersion,'physical-display-union-v1');
 assert.equal(spec.algorithmSha256,algorithmSha256);
 assert.equal(spec.sha256,hash(bytes));assert.equal(spec.compressedBytes,bytes.length);
 assert.equal(spec.decodedBytes,json.length);assert.equal(spec.encoding,'gzip');
 assert.equal(bytes[9],10);assert.ok(spec.url.endsWith(spec.sha256+'.json.gz'));
 return JSON.parse(json);
}

test('physical display build removes wavy shared edges, preserves source and emits deterministic receipts',async()=>{
 const f=fixture(),source=geometry([[[[0,0],[1,0],[1.1,.5],[1,1],[0,1],[0,0]]],[[[1,0],[2,0],[2,1],[1,1],[1.1,.5],[1,0]]],square(20)]);
 const asset=f.store(source,'land.json.gz'),catalog={asset,waterObjects:{geometries:[{land:asset},{land:{...asset}}]}};
 const before=structuredClone(catalog),sourceBytes=Buffer.from(f.files.get(asset.url));let calls=0;
 const options={catalog,readPinnedData:f.readPinnedData,algorithmSha256,union:coordinates=>{calls++;return union(coordinates);}};
 const result=await buildPhysicalLandDisplayAssets(options),display=unpack(result,asset);
 assert.equal(calls,1);assert.equal(result.assets.size,1);assert.equal(Object.keys(result.specs).length,1);
 assert.equal(f.reads.get(asset.url),1);assert.equal(display.coordinates.length,2);
 assert.deepEqual(sharedCalculationCore.polygonOperation('xor',[source.coordinates,display.coordinates],false),[]);
 assert.deepEqual(display.coordinates[1],source.coordinates[2]);
 assert.deepEqual(catalog,before);assert.deepEqual(f.files.get(asset.url),sourceBytes);
 const again=await buildPhysicalLandDisplayAssets(options);
 assert.deepEqual([...again.assets],[...result.assets]);assert.deepEqual(again.specs,result.specs);
});

test('regional physical display reconstructs its exact patch and shares the decoded base cache',async()=>{
 const f=fixture(),baseGeometry=geometry([square(0),square(20)]),regionalGeometry=geometry([square(0),square(30)]);
 const base=f.store(baseGeometry,'base.json','identity');
 const patch={schema:'pando-physical-land-replacements-v1',basePolygonCount:2,resultPolygonCount:2,
  baseContentSha256:hash(JSON.stringify(baseGeometry)),resultContentSha256:hash(JSON.stringify(regionalGeometry)),
  replacements:[{start:1,deleteCount:1,beforeSha256:hash(JSON.stringify([baseGeometry.coordinates[1]])),
   polygons:[{rings:[[{points:regionalGeometry.coordinates[1][0]}]]}]}],ringReplacements:[]};
 const replacement=f.store(patch,'replacement.json.gz');
 const regional={...base,url:'assets/data/physical-land/v1/unmaterialized-regional.json.gz',sha256:'b'.repeat(64),
  storageLayout:'regional-land-v1',base,replacement,contentSha256:patch.resultContentSha256};
 const catalog={asset:base,waterObjects:{geometries:[{land:regional},{land:{...regional}}]}};
 const before=JSON.stringify(catalog),originals=[...f.files].map(([path,bytes])=>[path,Buffer.from(bytes)]);
 const result=await buildPhysicalLandDisplayAssets({catalog,readPinnedData:f.readPinnedData,algorithmSha256,union});
 assert.deepEqual(unpack(result,regional),regionalGeometry);assert.deepEqual(unpack(result,base),baseGeometry);
 assert.equal(result.assets.size,2);assert.equal(f.reads.get(base.url),1);assert.equal(f.reads.get(replacement.url),1);
 assert.equal(f.reads.has(regional.url),false);assert.equal(JSON.stringify(catalog),before);assert.deepEqual([...f.files],originals);
});

test('physical display build rejects untrusted input hashes, lengths, recipes and malformed kernel output',async()=>{
 const f=fixture(),asset=f.store(geometry([square(0),square(1)]),'land.json.gz');
 const build=(spec,extra={})=>buildPhysicalLandDisplayAssets({catalog:{asset:spec},readPinnedData:f.readPinnedData,algorithmSha256,union,...extra});
 await assert.rejects(build({...asset,sha256:'c'.repeat(64)}),/integrity mismatch/);
 await assert.rejects(build({...asset,compressedBytes:asset.compressedBytes+1}),/integrity mismatch/);
 await assert.rejects(build({...asset,decodedBytes:asset.decodedBytes+1}),/decoded length mismatch/);
 await assert.rejects(build(asset,{algorithmSha256:'wrong'}),/dependencies/);
 await assert.rejects(build(asset,{union:()=>[[[[0,0],[1,0],[NaN,1],[0,0]]]]}),/Invalid physical display geometry/);
});
