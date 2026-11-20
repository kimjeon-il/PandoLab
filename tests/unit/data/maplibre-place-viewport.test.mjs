import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {encodePlaceTile} from '../../../src/data/place-codec.js';
import {createPlaceWorkerStore} from '../../../src/data/place-worker-store.js';
import {createHydroTileWindow,hydroTileSpecsForWindow} from '../../../src/data/hydro-tile-window.js';

test('native camera bounds admit the centered city and reuse only overlapping place tiles',async()=>{
 const bytes=new Uint8Array(encodePlaceTile([
  {source:'fixture',sourceId:'center',name:'Centered city',kind:'capital',coordinates:[3.4,6.45],minZoom:1},
  {source:'fixture',sourceId:'outside',name:'Outside city',kind:'capital',coordinates:[9,9],minZoom:1},
 ]));
 const stage={id:0,minZoom:1,columns:36,rows:18};let requests=0;
 const store=createPlaceWorkerStore({manifest:{version:1,revision:'fixture',stages:[stage],search:{},
  shards:{local:{url:'local.bin',bytes:bytes.length}},
  tiles:{'0/18-8':{shard:'local',offset:0,length:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}}},
  fetchBytes:async()=>{requests++;return bytes;}});
 const view={projection:'globe',threshold:4,width:1280,height:752,bounds:[2,2,7,8]};
 for(let i=0;i<2;i++)assert.deepEqual((await store.queryViewport(view)).records.map(record=>record.sourceId),['center']);
 assert.equal(requests,1);
 const wrapped=hydroTileSpecsForWindow(createHydroTileWindow({manifest:{stages:[stage]},projection:'globe',threshold:4,bounds:[175,-19,185,-11]}));
 assert.deepEqual(wrapped,[{stage:0,x:0,y:10},{stage:0,x:35,y:10}]);
 const world=hydroTileSpecsForWindow(createHydroTileWindow({manifest:{stages:[stage]},projection:'globe',threshold:4,bounds:[-200,-19,200,-11]}));
 assert.equal(world.length,36);
 const crossed=hydroTileSpecsForWindow(createHydroTileWindow({manifest:{stages:[stage]},projection:'globe',threshold:4,bounds:[175,-19,-175,-11]}));
 assert.deepEqual(crossed,wrapped);
});

test('parallel place tiles share whole shards and request distinct ranges independently',async(t)=>{
 const encode=(sourceId,coordinates)=>new Uint8Array(encodePlaceTile([
  {source:'fixture',sourceId,name:'City '+sourceId,kind:'capital',coordinates,minZoom:1},
 ]));
 const left=encode('left',[-2,2]),right=encode('right',[2,2]);
 const bytes=Buffer.concat([left,right]);
 const row=(offset,tile)=>({shard:'local',offset,length:tile.length,
  sha256:createHash('sha256').update(tile).digest('hex')});
 const view={projection:'globe',threshold:4,width:1280,height:752,bounds:[-3,1,3,3]};
 for(const transport of ['full fetch','HTTP 200','HTTP 206'])await t.test(transport,async t=>{
  let requests=0,bodiesRead=0,bodiesCancelled=0,releaseFirstRange;
  const fetchBytes=transport==='full fetch'?async()=>{requests++;return bytes;}:null;
  if(!fetchBytes)t.mock.method(globalThis,'fetch',async(_url,{headers})=>{
   const request=++requests;
   if(transport==='HTTP 200')return new Response(new ReadableStream({
    pull(controller){bodiesRead++;controller.enqueue(bytes);controller.close();},
    cancel(){bodiesCancelled++;},
   },{highWaterMark:0}));
   if(request===1)await new Promise(resolve=>{releaseFirstRange=resolve;});
   const [,start,end]=/^bytes=(\d+)-(\d+)$/.exec(headers.Range);
   return new Response(bytes.subarray(Number(start),Number(end)+1),{status:206,
    headers:{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}});
  });
  const store=createPlaceWorkerStore({manifest:{version:1,revision:'fixture',search:{},
   stages:[{id:0,minZoom:1,columns:36,rows:18}],shards:{local:{url:'local.bin',bytes:bytes.length}},
   tiles:{'0/17-8':row(0,left),'0/18-8':row(left.length,right)}},fetchBytes,cacheBytes:0});
  const viewport=store.queryViewport(view);
  let requestsBeforeFirstHeaders;
  if(transport==='HTTP 206'){
   await new Promise(resolve=>setImmediate(resolve));
   requestsBeforeFirstHeaders=requests;
   releaseFirstRange();
  }
  const {records}=await viewport;
  assert.deepEqual(records.map(record=>record.sourceId).sort(),['left','right']);
  if(transport==='HTTP 206')assert.equal(requestsBeforeFirstHeaders,2);
  else if(transport==='HTTP 200'){
   assert.equal(bodiesRead,1);
   assert.equal(bodiesCancelled,requests-1);
  }else assert.equal(requests,1);
 });
});
