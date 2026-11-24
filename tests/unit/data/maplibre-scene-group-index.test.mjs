import test from 'node:test';
import assert from 'node:assert/strict';
import {partitionSceneRows,createSceneGroupIndex} from '../../../src/rendering/maplibre-scene-group-index.js';
test('unchanged group contributions retain array identity after unrelated scene changes',()=>{
 const index=createSceneGroupIndex(),a={group:'a'},b={group:'b'};
 const first=partitionSceneRows([a],row=>row.group),second=partitionSceneRows([b],row=>row.group);
 const before=index.reconcile([first,second]);
 const next=index.reconcile([first,partitionSceneRows([{group:'b'}],row=>row.group)]);
 assert.equal(next.get('a'),before.get('a'));assert.notEqual(next.get('b'),before.get('b'));
 assert.equal(index.reconcile([first]).has('b'),false);
 index.clear();assert.equal(index.reconcile([]).size,0);
});
test('shared groups preserve contribution order and update only affected group membership',()=>{
 const index=createSceneGroupIndex(),a={group:'x'},b={group:'x'};
 const first=partitionSceneRows([a],row=>row.group),second=partitionSceneRows([b],row=>row.group);
 const before=index.reconcile([first,second]);
 assert.equal(index.reconcile([first,second]).get('x'),before.get('x'));
 assert.deepEqual(index.reconcile([second,first]).get('x'),[b,a]);
 assert.deepEqual(index.reconcile([second]).get('x'),[b]);
});
