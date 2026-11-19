import assert from 'node:assert/strict';
import test from 'node:test';
import {hasChnKgzSeam,chnKgzSeamMethod,assertChnKgzSeam,assertChnKgzTopology} from '../../../tools/gis/chn-kgz-seam-source-review.mjs';
const entity=(code,mode=chnKgzSeamMethod,end=null)=>({entityId:'state:'+code,geometryVersions:[{validTo:end,modernBoundarySupplement:{adoptionMode:mode}}]});
test('only explicit current China and Kyrgyzstan markers invoke bilateral review',()=>{
 assert.equal(hasChnKgzSeam(entity('CHN')),true);
 assert.equal(hasChnKgzSeam(entity('KGZ')),true);
 assert.equal(hasChnKgzSeam(entity('TJK')),false);
 assert.equal(hasChnKgzSeam(entity('CHN',chnKgzSeamMethod,'1949-10-01')),false);
 assert.equal(hasChnKgzSeam(entity('KGZ','exact-original-kgz-kaz-readonly-counterpart-seam')),false);
});
test('bilateral gate rejects unbound datastore paths or partial topology',()=>{
 const e=entity('CHN');
 assert.throws(()=>assertChnKgzSeam(e,e,{prefixes:['assets/data/territorial-entities/source/countries/state-CHN.json'],readEvidence:()=>null}),/both exact descriptors and CAS/);
 assert.throws(()=>assertChnKgzTopology({baseline:{newOverlapKm2:0},rebind:{}}),/unbounded topology/);
});
