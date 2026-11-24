import test from 'node:test';
import assert from 'node:assert/strict';
import {createCountryBoundaryOutput} from '../../../src/rendering/country-boundary-output.js';
import {createCoreRequestQueue} from '../../../src/document/core-request-queue.js';
import {sameRenderIdentity,changedRenderProperties} from '../../../src/rendering/render-identity.js';
import {mapLibreGeoJsonSource,mapLibreVectorSourceKind} from '../../../src/rendering/maplibre-source-spec.js';

test('border output only regenerates changed owner partitions',()=>{
 const output=createCountryBoundaryOutput(edge=>edge.id);
 const edge=(id,ownerIds,start,end)=>({id,ownerIds,start,end});
 const first=edge('ab',['B','A'],[0,0],[1,0]),other=edge('cd',['C','D'],[5,0],[6,0]);
 assert.equal(output.replace([first,other],1),2);
 const initial=output.select(['A','B','C'],[]);
 assert.equal(initial.changed.length,2);
 const known=initial.manifest.map(row=>[row.id,row.revision]);
 assert.equal(output.patch([['ab',{...first,start:first.end,end:first.start}]],2),0);
 assert.equal(output.select(['A','B','C'],known).changed.length,0);
 output.patch([['ab',{...first,end:[2,0]}]],3);
 const changed=output.select(['A','B','C'],known);
 assert.equal(changed.changed.length,1);
 assert.deepEqual(changed.changed[0].ownerIds,['A','B']);
 assert.equal(changed.manifest.find(row=>row.ownerIds.includes('C')).revision,1);
 output.patch([['ab',{...first,ownerIds:['A','B','E']}]],4);
 const moved=output.select(['A','B','C'],known);
 assert.equal(moved.changed.length,1);
 assert.deepEqual(moved.changed[0].ownerIds,['A','B','E']);
 output.patch([['ab',null]],5);
 assert.equal(output.select(['A','B'],known).manifest.length,0);
});

test('Core FIFO removes cancelled pending work and acknowledges dispatched work',async()=>{
 const queue=createCoreRequestQueue(()=>new Error('cancelled'));
 const active=new AbortController(),pending=new AbortController();
 const order=[];let release,started;
 const startedPromise=new Promise(resolve=>{started=resolve;});
 const first=queue.submit(async()=>{order.push('active');started();await new Promise(resolve=>{release=resolve;});return 'ack';},active.signal);
 await startedPromise;
 const obsolete=queue.submit(()=>{order.push('obsolete');},pending.signal);
 const rejected=assert.rejects(obsolete,/cancelled/);
 const latest=queue.submit(()=>{order.push('latest');return 'new';});
 active.abort();pending.abort();await rejected;
 assert.deepEqual(order,['active']);
 release();
 assert.equal(await first,'ack');
 assert.equal(await latest,'new');
 assert.deepEqual(order,['active','latest']);
 queue.close();
 await assert.rejects(queue.submit(()=>{}),/cancelled/);
});

test('render identity compares exact structured rows without delimiter collisions',()=>{
 assert.equal(sameRenderIdentity([['a:b','c']],[['a','b:c']]),false);
 assert.equal(sameRenderIdentity({a:[1,2],b:'x'},{b:'x',a:[1,2]}),true);
 assert.equal(sameRenderIdentity([['id',1]],[['id',2]]),false);
});

test('native tile generalization protects topology and selected geometry',()=>{
 for(const kind of ['territories','physical-land','physical-water','hydro-edits','highlight','overlay']){
  assert.equal(mapLibreGeoJsonSource(kind).tolerance,0);
 }
 assert.equal(mapLibreGeoJsonSource('hydro').tolerance,0.5);
 assert.equal(mapLibreGeoJsonSource('derived-line').tolerance,0.5);
 assert.equal(mapLibreVectorSourceKind([{kind:'line',role:'graticule'}]),'derived-line');
 assert.equal(mapLibreVectorSourceKind([{kind:'line',role:'graticule',objectKey:'country'}]),'overlay');
});


test('property diffs emit only modified fields and preserve explicit false, zero and null',()=>{
 const previous={color:'#fff',alpha:1,visible:true,other:'old'};
 assert.deepEqual(changedRenderProperties(previous,previous),[]);
 assert.deepEqual(changedRenderProperties(previous,{color:'#fff',alpha:0,visible:false,other:null}),
  [{key:'alpha',value:0},{key:'visible',value:false},{key:'other',value:null}]);
 assert.deepEqual(changedRenderProperties(previous,{...previous}),[]);
});
