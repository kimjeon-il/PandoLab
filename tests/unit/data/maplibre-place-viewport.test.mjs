import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {encodePlaceTile} from '../../../src/data/place-codec.js';
import {createPlaceWorkerStore} from '../../../src/data/place-worker-store.js';
import {createHydroTileWindow,hydroTileSpecsForWindow} from '../../../src/data/hydro-tile-window.js';
import {resolvePlaceLabelRows} from '../../../src/data/place-name-policy.js';

test('city names mark modern fallback only before the current year',()=>{
 const place={name:'런던',nameNative:'London',nameTimeline:[]};
 const languages={ko:true,native:true},referenceDate='2026-11-21';
 const resolve=(record,date)=>resolvePlaceLabelRows(record,languages,date,referenceDate);
 for(const date of ['2026-01-31','2026-10-31','2026-11-30']){
  assert.deepEqual(resolve(place,date).map(row=>[row.text,row.modernName]),[
   ['런던',false],['London',false],
  ]);
 }
 assert.deepEqual(resolve(place,'2025-12-31').map(row=>[row.text,row.modernName]),[
  ['(현)런던',true],['(현)London',true],
 ]);
 const historical={...place,nameTimeline:[{fromYear:100,ko:'론디니움',native:'Londinium'},{fromYear:600,ko:'런던',native:'London'}]};
 assert.deepEqual(resolve(historical,'0200-12-31').map(row=>[row.text,row.modernName]),[
  ['론디니움',false],['Londinium',false],
 ]);
});

test('city tiles carry capital periods through viewport reads without changing rank or zoom',async()=>{
 const capitalPeriods=[{countryId:'historical-country:fixture',fromDate:'1922-02-28',untilDateExclusive:'1922-04-01',source:'Fixture record'}];
 const cities=[
  {source:'fixture',sourceId:'ordinary',name:'Ordinary',kind:'city',coordinates:[0,0],priority:70,minZoom:1.25},
  {source:'fixture',sourceId:'capital',name:'Capital',kind:'city',coordinates:[1,1],priority:70,minZoom:1.25,capitalPeriods},
 ];
 const bytes=new Uint8Array(encodePlaceTile(cities));
 const row={shard:'cities',offset:0,length:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 const store=createPlaceWorkerStore({manifest:{version:1,revision:'fixture',search:{},
  stages:[{id:0,minZoom:0,columns:1,rows:1}],tiles:{'0/0-0':row},
  shards:{cities:{url:'cities.bin',bytes:bytes.length}}},fetchBytes:async()=>bytes});
 const {records}=await store.queryViewport({projection:'globe',threshold:4,bounds:[-5,-5,5,5]});
 assert.deepEqual(records.map(({sourceId,capitalPeriods,priority,minZoom})=>({sourceId,capitalPeriods,priority,minZoom})),[
  {sourceId:'capital',capitalPeriods,priority:70,minZoom:1.25},
  {sourceId:'ordinary',capitalPeriods:[],priority:70,minZoom:1.25},
 ]);
 for(const threshold of [3.499999,3.5,3.500001]){
  const {records:visible}=await store.queryViewport({projection:'globe',threshold,bounds:[-5,-5,5,5]});
  assert.equal(visible.length,threshold<3.5?0:2);
 }
 assert.throws(()=>encodePlaceTile([{...cities[1],capitalPeriods:[{...capitalPeriods[0],fromDate:'1922-02-29'}]}]),/capital/i);
});

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

test('slow place Worker startup leaves a fresh query budget for the latest viewport', async t => {
 const {createPlaceRuntime}=await import('../../../src/data/place-runtime.js');
 t.mock.timers.enable({apis:['setTimeout']});
 const requests=[],errors=[];
 const worker={postMessage(message){requests.push(message);},terminate(){}};
 const runtime=createPlaceRuntime({manifestUrl:'https://fixture.test/places.json',
  urbanLifetimes:{schema:'pando-place-urban-lifetimes-v1',schemaVersion:1,sourceReviewRevision:'a'.repeat(40),entries:[]},
  createWorker:()=>worker,admitReferences:async()=>{},onError:error=>errors.push(error)});
 const drain=()=>new Promise(resolve=>setImmediate(resolve));
 const reply=(request,result)=>worker.onmessage({data:{...request,type:'result',ok:true,result}});
 try {
  const first=runtime.prepare({bounds:[0,0,1,1]});
  await drain();
  assert.deepEqual(requests.map(message=>message.operation),['place.prepare']);
  t.mock.timers.tick(16_000);
  await drain();
  assert.deepEqual(errors,[]);
  runtime.resetProject();
  const latestView={bounds:[2,2,3,3]};
  const latest=runtime.prepare(latestView);
  await drain();
  assert.equal(requests.length,1,'a newer project can still use the immutable startup result');
  reply(requests[0],null);
  await drain();
  assert.deepEqual(requests.map(message=>message.operation),['place.prepare','place.viewport']);
  assert.deepEqual(requests[1].payload.view,latestView);
  t.mock.timers.tick(14_000);
  reply(requests[1],{records:[],signature:'latest'});
  assert.equal(await first,false);
  assert.equal(await latest,true);
  assert.equal(runtime.snapshot().signature,'latest');
  assert.deepEqual(errors,[]);
 } finally {
  runtime.dispose();
 }
});
