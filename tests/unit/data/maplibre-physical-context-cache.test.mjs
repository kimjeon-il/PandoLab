import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhysicalContextCache} from '../../../src/rendering/physical-context-cache.js';
test('physical contexts evict inactive entries under count and byte budgets but pin current and target',()=>{
 const cache=createPhysicalContextCache({byteBudget:1,entryLimit:2});
 const entry=()=>({status:'ready',value:{geometry:{coordinates:[[[[0,0],[1,0],[0,0]]]]},waters:[]},activation:{}});
 for(const id of ['old','current','target']){const item=entry();cache.set(id,item);cache.measure(item);}
 const old=cache.get('old');cache.trim(['current','target']);
 assert.equal(cache.has('old'),false);assert.equal(old.activation,null);
 assert.equal(cache.stats().entries,2);assert.ok(cache.stats().estimatedBytes>1);
 cache.trim(['target']);assert.equal(cache.has('current'),false);assert.equal(cache.has('target'),true);
 cache.clear();assert.equal(cache.stats().estimatedBytes,0);
});
test('cache clearing aborts pending reads and releases their activation references',()=>{
 const cache=createPhysicalContextCache(),controller=new AbortController(),entry={status:'loading',controller,activation:{}};
 cache.set('pending',entry);cache.trim([]);
 assert.equal(cache.get('pending'),entry);
 cache.clear();assert.equal(controller.signal.aborted,true);assert.equal(entry.activation,null);
 assert.equal(cache.stats().entries,0);
});
