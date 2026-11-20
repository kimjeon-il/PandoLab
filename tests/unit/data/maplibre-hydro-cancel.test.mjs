import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('an obsolete hydro range request is aborted without recovery',async()=>{
 const context=vm.createContext({AbortSignal,DOMException,Uint8Array});context.self=context;
 vm.runInContext(await readFile(new URL('../../../src/rendering/workers/hydro-shard-store.js',import.meta.url),'utf8'),context);
 let started=false;
 const store=context.createHydroShardStore({openCache:async()=>null,resolveUrl:x=>x,gunzip:x=>x,digest:async()=>'',fetchResponse:async(_url,{signal})=>{
  started=true;return new Promise((resolve,reject)=>{if(signal.aborted)return reject(signal.reason);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
 }});
 const controller=new AbortController(),pending=store.read({id:1,url:'hydro.bin',bytes:100},[{id:2,offset:0,length:10}],0,10,controller.signal);
 while(!started)await new Promise(resolve=>setTimeout(resolve,0));controller.abort();await assert.rejects(pending,{name:'AbortError'});
});

test('failed or cancelled hydro recovery does not poison the next viewport',async()=>{
 const context=vm.createContext({AbortSignal,DOMException,Response,Uint8Array});context.self=context;
 vm.runInContext(await readFile(new URL('../../../src/rendering/workers/hydro-shard-store.js',import.meta.url),'utf8'),context);
 let calls=0,recovering,started;
 const recoveryStarted=new Promise(resolve=>{started=resolve;});
 const bytes=new Uint8Array([1,2]),spec={id:1,url:'hydro.bin',bytes:2,sha256:'ok'},rows=[{id:2,offset:0,length:2}];
 const range=correct=>new Response(bytes,{status:206,headers:{'Content-Range':correct?'bytes 0-1/2':'bytes 1-2/2'}});
 const store=context.createHydroShardStore({openCache:async()=>null,resolveUrl:x=>x,gunzip:x=>x,digest:async()=>'ok',fetchResponse:async(_url,{signal})=>{
  calls++;
  if(calls===1||calls===3)return range(false);
  if(calls===2)throw Error('temporary failure');
  if(calls===4){
   recovering=signal;started();
   return new Promise((_,reject)=>signal?.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }
  return range(true);
 }});
 await assert.rejects(store.read(spec,rows,0,2),/temporary/);
 const controller=new AbortController(),old=store.read(spec,rows,0,2,controller.signal);
 await Promise.race([recoveryStarted,old]);
 assert.ok(recovering,'recovery must have an abort signal');
 controller.abort();
 await assert.rejects(old,{name:'AbortError'});
 const result=await store.read(spec,rows,0,2);
 assert.deepEqual([...result[0][1]],[1,2]);assert.equal(calls,5);
});

test('the hydro worker publishes successful ranges and retries failed ranges on the next view',async()=>{
 const messages=[];
 const context=vm.createContext({AbortController,TextDecoder,Uint8Array,clearTimeout,
  importScripts(){},onmessage:null,postMessage:message=>messages.push(structuredClone(message))});
 context.self=context;
 vm.runInContext(await readFile(new URL('../../../src/rendering/workers/hydro-tile-worker.js',import.meta.url),'utf8'),context);
 const run=vm.runInContext(`async()=>{
  rangeSupportPromise=Promise.resolve(true);
  tilePacks.set('0/0-0',[1,2]);
  for(const id of [1,2]){
   packSpecs.set(id,{id,shard:id,offset:0,length:12});
   shardSpecs.set(id,{id});
  }
  const bytes=new Uint8Array([65,87,72,70,4,0,0,0,0,0,0,0]);
  let fail=true;
  shardStore={read:async(spec,rows)=>{
   if(spec.id===2&&fail)throw Error('temporarily unavailable');
   return rows.map(row=>[row.id,bytes]);
  }};
  const tiles=[{stage:0,x:0,y:0}];
  await processView({revision:1,tiles});
  fail=false;
  await processView({revision:2,tiles});
 }`,context);
 await run();
 const ready=messages.filter(row=>row.type==='view-ready');
 assert.deepEqual(ready.map(row=>[row.packIds,row.failedPacks.map(pack=>pack.id)]),[[[1],[2]],[[1,2],[]]]);
 assert.deepEqual(messages,[
  {type:'pack',revision:1,packId:1,features:[]},ready[0],
  {type:'pack',revision:2,packId:2,features:[]},ready[1],
 ]);
});
