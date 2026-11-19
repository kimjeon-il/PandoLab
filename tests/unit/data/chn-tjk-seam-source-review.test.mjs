import assert from 'node:assert/strict';
import test from 'node:test';
import {hasChnTjkSeam,chnTjkSeamMethod,assertChnTjkSeam,assertChnTjkTopology} from '../../../tools/gis/chn-tjk-seam-source-review.mjs';
const entity=(code,mode=chnTjkSeamMethod,end=null)=>({entityId:'state:'+code,geometryVersions:[{validTo:end,modernBoundarySupplement:{adoptionMode:mode}}]});
test('only explicit current China and Tajikistan markers invoke bilateral review',()=>{
 assert.equal(hasChnTjkSeam(entity('CHN')),true);
 assert.equal(hasChnTjkSeam(entity('TJK')),true);
 assert.equal(hasChnTjkSeam(entity('KGZ')),false);
 assert.equal(hasChnTjkSeam(entity('CHN',chnTjkSeamMethod,'1949-10-01')),false);
 assert.equal(hasChnTjkSeam(entity('TJK','exact-original-kgz-kaz-readonly-counterpart-seam')),false);
});
test('bilateral gate rejects unbound datastore paths or partial topology',()=>{
 const e=entity('CHN');
 assert.throws(()=>assertChnTjkSeam(e,e,{prefixes:['assets/data/territorial-entities/source/countries/state-CHN.json'],readEvidence:()=>null}),/both countries/);
 assert.throws(()=>assertChnTjkTopology({baseline:{newOverlapKm2:0},rebind:{}}),/whole pair/);
});

