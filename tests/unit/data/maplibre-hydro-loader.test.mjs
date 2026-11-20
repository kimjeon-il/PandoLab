import test from 'node:test';
import assert from 'node:assert/strict';
import {createHydroBrowserLoader} from '../../../src/data/maplibre-hydro-loader.js';
import {createHydroService} from '../../../src/data/physical-layer-service.js';

test('browser worker delivers only newly visible water packs and can release them',async()=>{
 const sent=[];let worker;
 class FakeWorker {constructor(){worker=this;} postMessage(message){sent.push(message);if(message.type==='init')queueMicrotask(()=>this.onmessage({data:{type:'ready'}}));if(message.type==='view')queueMicrotask(()=>{this.onmessage({data:{type:'pack',revision:message.revision,packId:1,features:[{id:'1:10',properties:{logicalId:'lake',featureId:'1:10'}}]}});this.onmessage({data:{type:'view-ready',revision:message.revision,packIds:[1]}});});}terminate(){}}
 const loader=await createHydroBrowserLoader({manifest:{},createWorker:()=>new FakeWorker(),tilesForView:()=>[{stage:0,x:0,y:0}],baseUrl:'http://example/'});
 const result=await loader.view({knownKey:''});assert.equal(result.addPacks[0].features[0].id,'1:10');
 const reused=await loader.view({knownKey:'1'});assert.deepEqual(reused.addPacks,[]);
 assert.deepEqual(sent[0],{type:'init',manifest:{},baseUrl:'http://example/',dataRevision:undefined});
 loader.dispose();assert.ok(worker);
});
test('cancelling a view rejects its request and informs the worker',async()=>{
 const sent=[];class FakeWorker {postMessage(message){sent.push(message);if(message.type==='init')queueMicrotask(()=>this.onmessage({data:{type:'ready'}}));}terminate(){}}
 const loader=await createHydroBrowserLoader({manifest:{},createWorker:()=>new FakeWorker(),tilesForView:()=>[],baseUrl:'http://example/'});
 const request=loader.view({knownKey:''});loader.cancel();await assert.rejects(request,{name:'AbortError'});
 assert.ok(sent.some(message=>message.type==='cancel-view'));loader.dispose();
});

test('complete tile windows reuse decoded packs and emit live progress for misses',async()=>{
 const sent=[], progress=[];let worker;
 class FakeWorker {
  constructor(){worker=this;}
  postMessage(message){sent.push(message);if(message.type==='init')queueMicrotask(()=>this.onmessage({data:{type:'ready'}}));}
  terminate(){}
 }
 const loader=await createHydroBrowserLoader({manifest:{stages:[{id:0,columns:4,rows:2}]},createWorker:()=>new FakeWorker(),
  tilesForView:view=>view.tiles,baseUrl:'http://example/',packLimit:1});
 const tile=x=>({stage:0,x,y:0});
 const deliver=(revision,type,payload)=>worker.onmessage({data:{type,revision,...payload}});
 const options={onProgress:value=>progress.push(value)};
 try{
  const first=loader.view({center:[100,30],knownKey:'',tiles:[tile(0),tile(3)]},options);
  const sentFirst=sent.at(-1);
  assert.deepEqual(sentFirst.tiles,[tile(3),tile(0)]);
  const features=[{id:'1:1'}];
  deliver(sentFirst.revision,'pack',{packId:1,features});
  assert.deepEqual(progress,[{packs:[{id:1,features}]}]);
  deliver(sentFirst.revision,'view-ready',{packIds:[1],stats:{rangeRequests:1,queueMs:.1,fetchMs:5,parseMs:1}});
  assert.deepEqual((await first).packs,[{id:1,features}]);
  const cacheHit=await loader.view({center:[-130,30],knownKey:'',tiles:[tile(3),tile(0)]},options);
  assert.deepEqual(cacheHit.addPacks,[{id:1,features}]);
  assert.deepEqual(cacheHit.packIds,[1]);
  assert.equal(sent.filter(message=>message.type==='view').length,1);
  assert.equal(progress.length,1);
  assert.deepEqual(loader.stats(),{cached:1,viewRequests:1,windowHits:1,rangeRequests:1,queueMs:.1,fetchMs:5,parseMs:1});

  const second=loader.view({knownKey:'1',tiles:[tile(2)]});
  const secondRevision=sent.at(-1).revision;
  deliver(secondRevision,'pack',{packId:2,features:[]});
  deliver(secondRevision,'view-ready',{packIds:[2]});
  await second;
  const revisited=loader.view({knownKey:'2',tiles:[tile(0),tile(3)]},options);
  assert.equal(sent.filter(message=>message.type==='view').length,3);
  const revisitRevision=sent.at(-1).revision;
  deliver(revisitRevision,'pack',{packId:1,features});
  deliver(revisitRevision,'view-ready',{packIds:[1]});
  assert.deepEqual((await revisited).removePacks,[2]);
 }finally{loader.dispose();}
});
test('inactive cached packs are released when the cache limit is exceeded',async()=>{
 const sent=[];let next=0;class FakeWorker {postMessage(message){sent.push(message);if(message.type==='init')queueMicrotask(()=>this.onmessage({data:{type:'ready'}}));if(message.type==='view'){const id=++next;queueMicrotask(()=>{this.onmessage({data:{type:'pack',revision:message.revision,packId:id,features:[]}});this.onmessage({data:{type:'view-ready',revision:message.revision,packIds:[id]}});});}}terminate(){}}
 const loader=await createHydroBrowserLoader({manifest:{},createWorker:()=>new FakeWorker(),
  tilesForView:({knownKey})=>[{stage:0,x:Number(knownKey),y:0}],baseUrl:'http://example/',packLimit:1});
 await loader.view({knownKey:''});await loader.view({knownKey:'1'});
 assert.deepEqual(sent.find(message=>message.type==='release').packIds,[1]);assert.equal(loader.stats().cached,1);loader.dispose();
});

test('partial and failed views keep the applied viewport and release inactive packs',async()=>{
 const releases=[];let next=0;
 class FakeWorker {
  postMessage(message){
   if(message.type==='release')releases.push(...message.packIds);
   if(message.type==='init')queueMicrotask(()=>this.onmessage({data:{type:'ready'}}));
   if(message.type!=='view')return;
   const revision=message.revision,id=++next;
   queueMicrotask(()=>{
    this.onmessage({data:{type:'pack',revision,packId:id,features:[]}});
    this.onmessage({data:id===1?{type:'view-ready',revision,packIds:[1],failedPacks:[{id:8,message:'offline'}]}:
     {type:'view-error',revision,message:'transport failed'}});
   });
  }
  terminate(){}
 }
 const loader=await createHydroBrowserLoader({manifest:{},baseUrl:'http://example/',tilesForView:()=>[],packLimit:1,createWorker:()=>new FakeWorker()});
 try{
  const first=await loader.view({knownKey:''});assert.equal(first.key,'1');assert.equal(first.failedPacks[0].id,8);
  for(let n=0;n<4;n++)await assert.rejects(loader.view({knownKey:'1'}),/transport failed/);
  assert.equal(loader.stats().cached,1);assert.deepEqual(releases,[2,3,4,5]);
 }finally{loader.dispose();}
});

test('a view with no reply times out and retires the stalled worker',async()=>{
 let stopped=false;
 class FakeWorker {
  postMessage(message){if(message.type==='init')queueMicrotask(()=>this.onmessage({data:{type:'ready'}}));}
  terminate(){stopped=true;}
 }
 const loader=await createHydroBrowserLoader({manifest:{},baseUrl:'http://example/',tilesForView:()=>[],viewTimeoutMs:10,createWorker:()=>new FakeWorker()});
 await assert.rejects(loader.view({}),{name:'TimeoutError'});
 assert.equal(stopped,true);assert.equal(loader.disposed,true);
});

test('disabled hydro cancels a manifest request and reuses an accepted manifest',async()=>{
 let enabled=false,status='idle',requests=0,aborted,accepts=0;
 const service=createHydroService({
  manifestUrl:()=>new URL('https://fixture.test/manifest.json'),dataVersion:'1',getLoadState:()=>status,isLoadCurrent:()=>enabled,
  onLoading:()=>{status='loading';},onRetry:assert.fail,onFailure:assert.fail,
  fetchWithRetry:async(_url,{signal},{consume})=>{
   requests++;
   if(requests===1)return new Promise((_,reject)=>{aborted=()=>reject(signal.reason);signal.addEventListener('abort',aborted,{once:true});});
   return consume(new Response(JSON.stringify({version:'1',schema:'pandolab-water-shards-v5'})));
  },
  acceptManifest:async()=>{accepts++;status='ready';return true;},
 });
 assert.equal(await service.load(),false);assert.equal(requests,0);
 enabled=true;const first=service.load();await Promise.resolve();assert.equal(typeof aborted,'function');
 enabled=false;service.cancel();assert.equal(await first,false);
 enabled=true;assert.equal(await service.load(),true);
 enabled=false;service.cancel();enabled=true;assert.equal(await service.load(),true);
 assert.equal(requests,2);assert.equal(accepts,1);
});
