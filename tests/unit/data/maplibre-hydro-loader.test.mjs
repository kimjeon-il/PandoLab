import test from 'node:test';
import assert from 'node:assert/strict';
import {createHydroBrowserLoader} from '../../../src/data/maplibre-hydro-loader.js';

test('browser worker delivers only newly visible water packs and can release them',async()=>{
 const sent=[];let worker;
 class FakeWorker {constructor(){worker=this;} postMessage(message){sent.push(message);if(message.type==='init')queueMicrotask(()=>this.onmessage({data:{type:'ready'}}));if(message.type==='view')queueMicrotask(()=>{this.onmessage({data:{type:'pack',revision:message.revision,packId:1,features:[{id:'1:10',properties:{logicalId:'lake',featureId:'1:10'}}]}});this.onmessage({data:{type:'view-ready',revision:message.revision,packIds:[1]}});});}terminate(){}}
 const loader=await createHydroBrowserLoader({manifest:{},createWorker:()=>new FakeWorker(),tilesForView:()=>[{stage:0,x:0,y:0}],baseUrl:'http://example/'});
 const result=await loader.view({knownKey:''});assert.equal(result.addPacks[0].features[0].id,'1:10');
 const reused=await loader.view({knownKey:'1'});assert.deepEqual(reused.addPacks,[]);assert.equal(sent[0].delivery,'geojson');
 loader.dispose();assert.ok(worker);
});
test('cancelling a view rejects its request and informs the worker',async()=>{
 const sent=[];class FakeWorker {postMessage(message){sent.push(message);if(message.type==='init')queueMicrotask(()=>this.onmessage({data:{type:'ready'}}));}terminate(){}}
 const loader=await createHydroBrowserLoader({manifest:{},createWorker:()=>new FakeWorker(),tilesForView:()=>[],baseUrl:'http://example/'});
 const request=loader.view({knownKey:''});loader.cancel();await assert.rejects(request,{name:'AbortError'});
 assert.ok(sent.some(message=>message.type==='cancel-view'));loader.dispose();
});
test('inactive cached packs are released when the cache limit is exceeded',async()=>{
 const sent=[];let next=0;class FakeWorker {postMessage(message){sent.push(message);if(message.type==='init')queueMicrotask(()=>this.onmessage({data:{type:'ready'}}));if(message.type==='view'){const id=++next;queueMicrotask(()=>{this.onmessage({data:{type:'pack',revision:message.revision,packId:id,features:[]}});this.onmessage({data:{type:'view-ready',revision:message.revision,packIds:[id]}});});}}terminate(){}}
 const loader=await createHydroBrowserLoader({manifest:{},createWorker:()=>new FakeWorker(),tilesForView:()=>[],baseUrl:'http://example/',packLimit:1});
 await loader.view({knownKey:''});await loader.view({knownKey:'1'});
 assert.deepEqual(sent.find(message=>message.type==='release').packIds,[1]);assert.equal(loader.stats().cached,1);loader.dispose();
});
