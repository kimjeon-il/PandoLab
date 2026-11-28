import test from 'node:test';
import assert from 'node:assert/strict';
import {decodePlaceTile} from '../../../src/data/place-codec.js';
import {buildPlaceSpatialPartition} from '../../../tools/build/place-spatial-partition.mjs';
import {createPlaceWorkerStore} from '../../../src/data/place-worker-store.js';

function fixture(count,{sameCoordinate=false}={}) {
 return Array.from({length:count},(_,index)=>({
  source:'fixture',sourceId:String(index+1),name:'City '+String(index+1).padStart(5,'0'),
  nameEn:'City '+String(index+1).padStart(5,'0'),kind:'city',
  coordinates:sameCoordinate?[0,0]:[-179+(index%359),-89+(index%179)],
  priority:99-index%50,population:1_000_000-index,minZoom:1.25,
 }));
}
function pagesFor(partition,stage) {
 return Object.entries(partition.tiles).filter(([key])=>key.startsWith(stage+'/'))
  .flatMap(([,value])=>Array.isArray(value)?value:[value]);
}
function decodePage(partition,descriptor) {
 const shard=partition.shardFiles.find(row=>row.name===partition.shards[descriptor.shard].url);
 assert.ok(shard);
 return decodePlaceTile(shard.bytes.subarray(descriptor.offset,descriptor.offset+descriptor.length));
}

test('city release builds three nested spatial stages and recursively pages coincident dense cells',()=>{
 const records=fixture(2500,{sameCoordinate:true}),partition=buildPlaceSpatialPartition(records);
 assert.deepEqual(partition.stages.map(row=>[row.id,row.minZoom,row.columns,row.rows]),[
  [0,0,8,8],[1,4.5,16,16],[2,7,32,32],
 ]);
 assert.equal(partition.spatialPartition.sourceRecordCount,records.length);
 assert.equal(partition.spatialPartition.stages.length,3);
 assert.ok(partition.shardFiles.length>1);
 for(const stage of partition.stages) {
  const pages=pagesFor(partition,stage.id),ids=pages.flatMap(row=>decodePage(partition,row).map(record=>record.id));
  assert.equal(ids.length,records.length);
  assert.equal(new Set(ids).size,records.length);
  assert.ok(pages.every(row=>row.recordCount>0&&row.recordCount<=512&&row.length<=512*1024));
 }
 const firstCell=partition.tiles['0/4-4'];
 assert.ok(Array.isArray(firstCell)&&firstCell.length>1,'coincident cities must use deterministic overflow pages');
 assert.ok(partition.search.ci.length>0);
 assert.ok(partition.search.ci.every(row=>row.first==='ci'&&row.last==='ci\uffff'));
 for(const shard of partition.shardFiles)assert.ok(shard.bytes.length<=512*1024);
});

test('city viewport worker selects the finest affordable spatial stage and retains search paging',async()=>{
 const records=fixture(700,{sameCoordinate:true}),partition=buildPlaceSpatialPartition(records);
 const store=createPlaceWorkerStore({manifest:{version:1,revision:'fixture-spatial',...partition},
  fetchBytes:async spec=>partition.shardFiles.find(row=>row.name===spec.url).bytes});
 for(const [threshold,stage] of [[4,0],[5,1],[8,2]]) {
  const result=await store.queryViewport({projection:'globe',threshold,width:1280,height:720,bounds:[-10,-10,10,10]});
  assert.equal(result.stageId,stage);
  assert.equal(result.records.length,records.length);
 }
 const search=await store.search('City 0001');
 assert.ok(search.records.some(row=>row.sourceId==='1'));
 store.dispose?.();
});
