import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import test from 'node:test';
import {createStoredAssetLoader} from '../../src/data/stored-asset-loader.js';

const sha256=createHash('sha256').update('globe').digest('hex');
const spec={url:'https://viewer.test/world/lines.bin',sha256,encoding:'identity',compressedBytes:5,decodedBytes:5};
const cacheKey=new URL('/.pandolab-cache/content/'+sha256,spec.url).href;
const decode=bytes=>new TextDecoder().decode(bytes);
const load=(loader,row=spec,signal)=>loader.loadAsset(row,'startup','lines','map lines',decode,signal);

function storageFixture(){
 const values=new Map(),calls={reads:0,writes:0,deletes:0};
 const cache={
  async match(key){if(key===cacheKey)calls.reads++;return values.get(key)?.clone();},
  async put(key,response){calls.writes++;values.set(key,response);},
  async delete(key){calls.deletes++;return values.delete(key);},
 };
 return {values,calls,cacheStorage:{open:async()=>cache}};
}
function loaderFor(deps, dataRevision='pin-a'){
 return createStoredAssetLoader({cachePolicy:'immutable',dataRevision,resolveUrl:row=>row.url,subtle:webcrypto.subtle,...deps});
}

test('concurrent immutable reads share cache lookup, hash, fetch and write across URL aliases',async()=>{
 const storage=storageFixture(),requested=Promise.withResolvers(),response=Promise.withResolvers();
 let downloads=0,hashes=0;
 const deps={cacheStorage:storage.cacheStorage,subtle:{digest(...args){hashes++;return webcrypto.subtle.digest(...args);}},
  fetchFn(){downloads++;requested.resolve();return response.promise;}};
 const first=load(loaderFor(deps)),second=load(loaderFor(deps,'pin-b'),{...spec,url:'https://viewer.test/alternate.bin'});
 await requested.promise;await new Promise(setImmediate);response.resolve(new Response('globe'));
 const results=await Promise.all([first,second]);
 assert.deepEqual(results.map(row=>row.value),['globe','globe']);
 assert.equal(results.reduce((bytes,row)=>bytes+row.transferredBytes,0),5);
 assert.equal(downloads,1);assert.equal(hashes,1);assert.deepEqual(storage.calls,{reads:1,writes:1,deletes:0});
 const revisit=await load(loaderFor(deps,'pin-c'),{...spec,url:'https://viewer.test/revisit.bin'});
 assert.equal(revisit.cacheHit,true);assert.equal(revisit.transferredBytes,0);assert.equal(downloads,1);
});

test('cancelling one immutable consumer preserves the other and cancelling the last stops the fetch',async()=>{
 const started=Promise.withResolvers(),stopped=Promise.withResolvers(),response=Promise.withResolvers();
 let downloads=0,requestSignal;
 const loader=loaderFor({cacheStorage:null,fetchFn(_url,{signal}){
  downloads++;requestSignal=signal;started.resolve();
  return new Promise((resolve,reject)=>{
   signal.addEventListener('abort',()=>{stopped.resolve();reject(signal.reason);},{once:true});
   response.promise.then(resolve,reject);
  });
 }});
 const a=new AbortController(),b=new AbortController();
 const first=load(loader,spec,a.signal),second=load(loader,spec,b.signal);
 const rejected=assert.rejects(first,{name:'AbortError'});
 await started.promise;await new Promise(setImmediate);a.abort();await rejected;
 assert.equal(downloads,1);assert.equal(requestSignal.aborted,false);
 b.abort();await assert.rejects(second,{name:'AbortError'});await stopped.promise;
 response.resolve(new Response('globe'));
 assert.equal((await load(loader)).value,'globe');assert.equal(downloads,2);
});

test('immutable cache-only reads reject corrupt bytes without fetching and normal reads repair the entry',async()=>{
 const storage=storageFixture();let downloads=0;
 storage.values.set(cacheKey,new Response('wrong'));
 const loader=loaderFor({cacheStorage:storage.cacheStorage,fetchFn(){downloads++;return new Response('globe');}});
 assert.equal(await loader.loadCachedAsset(spec,'startup','lines','map lines',decode),null);
 assert.equal(downloads,0);
 storage.values.set(cacheKey,new Response('wrong'));
 const results=await Promise.all([load(loader),load(loader)]);
 assert.deepEqual(results.map(row=>row.value),['globe','globe']);
 assert.equal(downloads,1);assert.equal(storage.calls.deletes,2);assert.equal(storage.calls.writes,1);
});

test('verified immutable data can be consumed before its background cache write completes',async()=>{
 const writing=Promise.withResolvers(),release=Promise.withResolvers(),completed=Promise.withResolvers();
 let downloads=0;
 const cache={
  async match(){return null;},
  async put(){writing.resolve();await release.promise;completed.resolve();},
 };
 const loader=loaderFor({cacheStorage:{open:async()=>cache},deferCacheWrite:true,
  fetchFn(){downloads++;return new Response('globe');}});
 const pending=load(loader);
 await writing.promise;
 try{
  const result=await pending;
  assert.equal(result.value,'globe');assert.equal(result.cacheWriteMs,null);
  assert.equal(downloads,1);
 }finally{release.resolve();}
 await completed.promise;
});

test('immutable reads ignore retired URL-keyed cache entries',async()=>{
 const storage=storageFixture();let downloads=0;
 storage.values.set(spec.url,new Response('globe'));
 const loader=loaderFor({cacheStorage:storage.cacheStorage,fetchFn(){downloads++;return new Response('globe');}});
 assert.equal(await loader.loadCachedAsset(spec,'startup','lines','map lines',decode),null);
 const result=await load(loader);
 assert.equal(result.value,'globe');assert.equal(result.cacheHit,false);assert.equal(downloads,1);
 assert.ok(storage.values.has(cacheKey));
});
