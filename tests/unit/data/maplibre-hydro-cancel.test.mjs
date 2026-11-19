import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('an obsolete hydro range request is aborted without recovery',async()=>{
 const context=vm.createContext({DOMException,Uint8Array});context.self=context;
 vm.runInContext(await readFile(new URL('../../../src/rendering/workers/hydro-shard-store.js',import.meta.url),'utf8'),context);
 let started=false;
 const store=context.createHydroShardStore({openCache:async()=>null,resolveUrl:x=>x,gunzip:x=>x,digest:async()=>'',fetchResponse:async(_url,{signal})=>{
  started=true;return new Promise((resolve,reject)=>{if(signal.aborted)return reject(signal.reason);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
 }});
 const controller=new AbortController(),pending=store.read({id:1,url:'hydro.bin',bytes:100},[{id:2,offset:0,length:10}],0,10,controller.signal);
 while(!started)await new Promise(resolve=>setTimeout(resolve,0));controller.abort();await assert.rejects(pending,{name:'AbortError'});
});
