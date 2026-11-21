import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('independent hydro ranges use two same-shard lanes and share equal ranges across consumers',async()=>{
 const context=vm.createContext({AbortController,AbortSignal,DOMException,Response,Uint8Array});context.self=context;
 vm.runInContext(await readFile(new URL('../../../src/rendering/workers/hydro-shard-store.js',import.meta.url),'utf8'),context);
 const started=[];
 const store=context.createHydroShardStore({openCache:async()=>null,resolveUrl:x=>x,gunzip:x=>x,digest:async()=>'',fetchResponse:async(_url,{signal,headers})=>{
  const [,start,end]=headers.Range.match(/bytes=(\d+)-(\d+)/);
  return new Promise((resolve,reject)=>{
   const finish=()=>resolve(new Response(new Uint8Array(Number(end)-Number(start)+1),{
    status:206,headers:{'Content-Range':`bytes ${start}-${end}/100`},
   }));
   started.push({start:Number(start),signal,finish});signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  });
 }});
 const read=(id,offset,signal)=>store.read({id,url:'shard-'+id,bytes:100},[{id:offset,offset,length:10}],offset,offset+10,signal);
 const quit=new AbortController();
 const abandoned=read(1,0,quit.signal),shared=read(1,0),second=read(1,10),third=read(1,20);
 const other1=read(2,30),other2=read(2,40),queued=read(3,50);
 const settled=Promise.allSettled([abandoned,shared,second,third,other1,other2,queued]);
 try{
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(started.map(row=>row.start),[0,10,30,40]);
  quit.abort();
  await assert.rejects(abandoned,{name:'AbortError'});
  assert.equal(started[0].signal.aborted,false);
  started[0].finish();await shared;
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(started.map(row=>row.start),[0,10,30,40,20]);
 }finally{
  for(let index=0;index<started.length;index++){started[index].finish();await new Promise(resolve=>setImmediate(resolve));}
  await settled;
 }
});

test('an HTTP 200 fallback shares one verified body across shards despite a cancelled consumer',async()=>{
 const context=vm.createContext({AbortController,AbortSignal,DOMException,Response,Uint8Array});context.self=context;
 vm.runInContext(await readFile(new URL('../../../src/rendering/workers/hydro-shard-store.js',import.meta.url),'utf8'),context);
 const bytes=new Uint8Array([1,2,3,4]);
 let fetches=0,bodies=0,cancelled=0,verified=0,finish,networkSignal;
 const store=context.createHydroShardStore({openCache:async()=>null,resolveUrl:x=>x,gunzip:x=>x,digest:async()=>'ok',
  fetchResponse:async(_url,{signal})=>{
   const first=++fetches===1;
   return {ok:true,status:200,headers:new Response().headers,body:{async cancel(){cancelled++;}},
    arrayBuffer(){bodies++;
     if(!first)return Promise.resolve(bytes.buffer);
     networkSignal=signal;
     return new Promise((resolve,reject)=>{
      finish=()=>resolve(bytes.buffer);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
     });
    },
   };
  },
  onWholeBundle:async raw=>{assert.deepEqual(raw,bytes);verified++;},
 });
 const read=(id,offset,signal)=>store.read({id,url:'hydro.bin',offset,fileBytes:4,bytes:2,sha256:'ok'},
  [{id,offset:0,length:2}],0,2,signal);
 const controller=new AbortController(), first=read(1,0,controller.signal), second=read(2,2);
 const settled=Promise.allSettled([first,second]);
 try{
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual([fetches,bodies,cancelled],[2,1,1]);
  controller.abort();
  await assert.rejects(first,{name:'AbortError'});
  assert.equal(networkSignal.aborted,false);
  finish();
  assert.deepEqual([...(await second)[0][1]],[3,4]);
  assert.equal(verified,1);
 }finally{finish?.();await settled;}
});

test('later hydro ranges subscribe to an active whole body before issuing another request',async()=>{
 const context=vm.createContext({AbortController,AbortSignal,DOMException,Response,Uint8Array});context.self=context;
 vm.runInContext(await readFile(new URL('../../../src/rendering/workers/hydro-shard-store.js',import.meta.url),'utf8'),context);
 const bytes=new Uint8Array([1,2,3,4,5,6]);
 const started=[];
 const finishes=[];
 let verified=0;
 const store=context.createHydroShardStore({openCache:async()=>null,resolveUrl:x=>x,gunzip:x=>x,digest:async()=>'ok',
  fetchResponse:async(_url,{signal,headers})=>{
   started.push({signal,range:headers.Range});
   return {ok:true,status:200,headers:new Response().headers,body:{async cancel(){}},
    arrayBuffer:()=>new Promise((resolve,reject)=>{
     finishes.push(()=>resolve(bytes.buffer));
     signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    }),
   };
  },
  onWholeBundle:async raw=>{assert.deepEqual(raw,bytes);verified++;},
 });
 const read=(id,containerOffset,offset,signal)=>store.read({id,url:'hydro.bin',offset:containerOffset,
  fileBytes:6,bytes:id===1?4:2,sha256:'ok'},[{id,offset,length:2}],offset,offset+2,signal);
 const initial=new AbortController(),next=new AbortController();
 const first=read(1,0,0,initial.signal);
 let nextSameShard,nextOtherShard;
 try{
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(started.map(({range})=>range),['bytes=0-1']);
  nextSameShard=read(1,0,2,next.signal);
  nextOtherShard=read(2,4,0,next.signal);
  const cancelled=assert.rejects(first,{name:'AbortError'});
  queueMicrotask(()=>initial.abort());
  await cancelled;
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(started.map(({range})=>range),['bytes=0-1']);
  assert.equal(started[0].signal.aborted,false);
  finishes[0]();
  assert.deepEqual([...(await nextSameShard)[0][1]],[3,4]);
  assert.deepEqual([...(await nextOtherShard)[0][1]],[5,6]);
  assert.equal(verified,1);
 }finally{
  initial.abort();
  next.abort();
  finishes.forEach(finish=>finish());
  await Promise.allSettled([first,nextSameShard,nextOtherShard]);
 }
});

test('concurrent bad ranges share one verified shard recovery',async()=>{
 const context=vm.createContext({AbortController,AbortSignal,DOMException,Response,Uint8Array});context.self=context;
 vm.runInContext(await readFile(new URL('../../../src/rendering/workers/hydro-shard-store.js',import.meta.url),'utf8'),context);
 const bytes=new Uint8Array([1,2,3,4]);
 let ranged=0,recovered=0;
 const store=context.createHydroShardStore({openCache:async()=>null,resolveUrl:x=>x,gunzip:x=>x,digest:async()=>'ok',
  fetchResponse:async(_url,options)=>{
   if(options.cache==='no-store'){
    recovered++;
    await new Promise(resolve=>setImmediate(resolve));
    return new Response(bytes);
   }
   ranged++;
   return new Response(bytes.subarray(0,2),{status:206,headers:{'Content-Range':'bad'}});
  },
 });
 const spec={id:1,url:'shard.bin',bytes:4,sha256:'ok'};
 const result=await Promise.all([0,2].map(offset=>store.read(spec,[{id:offset,offset,length:2}],offset,offset+2)));
 assert.deepEqual(result.map(rows=>[...rows[0][1]]),[[1,2],[3,4]]);
 assert.deepEqual([ranged,recovered],[2,1]);
});

test('an obsolete hydro range request is aborted without recovery',async()=>{
 const context=vm.createContext({AbortController,AbortSignal,DOMException,Uint8Array});context.self=context;
 vm.runInContext(await readFile(new URL('../../../src/rendering/workers/hydro-shard-store.js',import.meta.url),'utf8'),context);
 let started=false;
 const store=context.createHydroShardStore({openCache:async()=>null,resolveUrl:x=>x,gunzip:x=>x,digest:async()=>'',fetchResponse:async(_url,{signal})=>{
  started=true;return new Promise((resolve,reject)=>{if(signal.aborted)return reject(signal.reason);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
 }});
 const controller=new AbortController(),pending=store.read({id:1,url:'hydro.bin',bytes:100},[{id:2,offset:0,length:10}],0,10,controller.signal);
 while(!started)await new Promise(resolve=>setTimeout(resolve,0));controller.abort();await assert.rejects(pending,{name:'AbortError'});
});

test('failed or cancelled hydro recovery does not poison the next viewport',async()=>{
 const context=vm.createContext({AbortController,AbortSignal,DOMException,Response,Uint8Array});context.self=context;
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

test('a shifted viewport keeps its overlapping pack in the already active coalesced range',async()=>{
 const messages=[];
 const context=vm.createContext({AbortController,AbortSignal,DOMException,Response,TextDecoder,Uint8Array,
  queueMicrotask,importScripts(){},onmessage:null,postMessage:message=>messages.push(structuredClone(message))});
 context.self=context;
 for(const file of ['hydro-shard-store.js','hydro-tile-worker.js'])
  vm.runInContext(await readFile(new URL('../../../src/rendering/workers/'+file,import.meta.url),'utf8'),context);
 const start=vm.runInContext(`()=>{
  const pack=[65,87,72,70,4,0,0,0,0,0,0,0],bytes=new Uint8Array([...pack,...pack,...pack]);
  const reads=[];
  rangeSupportPromise=Promise.resolve(true);
  tilePacks.set('0/0-0',[1,2]);tilePacks.set('0/1-0',[2,3]);
  for(const id of [1,2,3])packSpecs.set(id,{id,shard:1,offset:(id-1)*12,length:12});
  shardSpecs.set(1,{id:1,url:'shard.bin',bytes:bytes.length});
  shardStore=createHydroShardStore({openCache:async()=>null,resolveUrl:x=>x,gunzip:x=>x,digest:async()=>'',fetchResponse:(_url,{signal,headers})=>{
   const endPoints=headers.Range.slice(6).split('-').map(Number),[start,end]=endPoints;
   return new Promise((resolve,reject)=>{
    const finish=()=>resolve(new Response(bytes.subarray(start,end+1),{status:206,
     headers:{'Content-Range':'bytes '+start+'-'+end+'/'+bytes.length}}));
    reads.push({range:headers.Range,signal,finish});
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
   });
  }});
  return {view:(revision,x)=>startView({revision,tiles:[{stage:0,x,y:0}]}),
    ranges:()=>reads.map(row=>row.range),aborted:()=>reads[0].signal.aborted,finish:()=>reads.forEach(row=>row.finish())};
 }`,context)();
 const old=start.view(1,0);
 let current;
 try{
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual([...start.ranges()],['bytes=0-23']);
  current=start.view(2,1);
  await old;
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual([...start.ranges()],['bytes=0-23','bytes=24-35']);
  assert.equal(start.aborted(),false);
 }finally{start.finish();await current;}
 assert.equal(messages.every(({revision})=>revision===2),true);
 assert.deepEqual(messages.filter(({type})=>type==='pack').map(({packId})=>packId).sort(),[2,3]);
 assert.deepEqual(messages.at(-1).packIds,[2,3]);
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
  {type:'view-progress',revision:2,packIds:[1]},
  {type:'pack',revision:2,packId:2,features:[]},ready[1],
 ]);
});
