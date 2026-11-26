import test from 'node:test';

import assert from 'node:assert/strict';

import {hydroLakeDisplayMinZoom} from '../../../src/map/map-display-zoom.js';

import {hydroDisplayReview,applyReviewedHydroReaches} from '../../../tools/gis/hydro-display-review.mjs';

test('reviewed Hydro source cuts and traced centerlines preserve unrelated reaches and junctions',()=>{
 const sourceSha256='a'.repeat(64),sources=[{specification:{datasetCode:'af',files:[{file:'af.shp',sha256:sourceSha256}]}}];
 const inside=[[0,0],[0.0005,0.01],[0.01,0.02]];
 const region={datasetCode:'af',sourceSha256,exclusions:[{systemId:'20',reachIds:[2],evidence:['review']}],
  replacements:[{id:3,systemId:'20',evidence:['review'],sourceStart:inside[0],sourceEnd:inside.at(-1),coordinates:inside}]};
 const review=hydroDisplayReview({version:1,regions:[region]},sources).get('af');
 const reaches=[{id:1,next:2,mainRiver:20,endorheic:true},{id:2,next:3,mainRiver:20,endorheic:true},
  {id:3,next:4,mainRiver:20,width:1.1,parts:[[[0,0],[0,0.01],[0.01,0.02]]]},
  {id:4,next:0,mainRiver:20,parts:[[[0.01,0.02],[0.02,0.04]]]}];
 const [first,redrawn,untouched]=applyReviewedHydroReaches(reaches,review);
 assert.equal(first.next,0);assert.equal(redrawn.width,1.1);assert.deepEqual(redrawn.parts,[inside]);
 assert.equal(untouched,reaches[3]);assert.deepEqual(redrawn.parts[0].at(-1),untouched.parts[0][0]);
 assert.throws(()=>applyReviewedHydroReaches([{...reaches[0],endorheic:false},...reaches.slice(1)],review),/outward-draining/);
 assert.throws(()=>applyReviewedHydroReaches([reaches[0],{...reaches[1],mainRiver:99}],review),/another source system/);
 const moved={...region,replacements:[{...region.replacements[0],coordinates:[...inside.slice(0,-1),[0.01,0.03]]}]};
 assert.throws(()=>applyReviewedHydroReaches(reaches,hydroDisplayReview({version:1,regions:[moved]},sources).get('af')),/disconnects its downstream/);
});

test('lake display zoom weighs both surface area and effective width',()=>{
 assert.equal(hydroLakeDisplayMinZoom(82078,53),2,'a broad large lake opens at the first stage');
 assert.equal(hydroLakeDisplayMinZoom(19427,26),2,'a Great Lake remains visible at the first stage');
 assert.equal(hydroLakeDisplayMinZoom(19427,8),4,'equal area does not put a long narrow lake at the same zoom');
 assert.equal(hydroLakeDisplayMinZoom(485,10),4,'a medium lake waits despite sufficient width');
 assert.equal(hydroLakeDisplayMinZoom(1247,5),5,'a narrow lake waits for the finest existing stage');
 assert.equal(hydroLakeDisplayMinZoom(20,2),5,'small lakes retain their finest-stage display');
});
