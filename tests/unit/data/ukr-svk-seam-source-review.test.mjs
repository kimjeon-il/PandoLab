import test from 'node:test';
import assert from 'node:assert/strict';
import {assertUkrSvkTopology,hasUkrSvkSeam,ukrSvkSeamMethod,assertPriorBlrArc} from '../../../tools/gis/ukr-svk-seam-source-review.mjs';
const pin='cc080962c65ab77545c2e9a557133c76f91f80ec';
const op={polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,raw:{polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,direction:1}};
const a={polygonIndex:0,ringIndex:0,startIndex:4,endIndex:3,direction:-1};
const r={polygonIndex:1,ringIndex:0,startIndex:0};
const peers=['COG','SDS'];
const binding={sourcePin:pin,operation:op,topologyOperation:op,originalUKRWkb:"fixed-original",svkArc:a,ringStart:r};
const sequentialPrior={history:[{versionId:'state:ukraine:1991-2014-r1',from:'1991-08-24',to:'2014-03-17',resourceSHA:'c2ba09faefaa062e0fbb947109d01e5ade145e49a151a82a134e0049a7a8ca0a'}],blrOverlapKm2:0,blrBoundaryExact:true,mdaOverlapKm2:0,mdaBoundaryExact:true,blrShareKm:1100.2778006725011,mdaShareKm:1223.0725269960208,tripointsExact:true,polBoundaryExact:true,polOverlapKm2:0,hunBoundaryExact:true,hunOverlapKm2:0,rouFrozenExact:true,pointwiseOutsideChosenArc:true};
const proof={pin,sequentialPrior,UKROriginal:{wkbSha256:"fixed-original"},operations:[op],ringStarts:[r],SVKDonor:{...a,openRingVertexCount:20},
 allArcEdgesExactReciprocal:true,newPairDE9IM:'FF2F11212',newOverlapKm2:0,newPositiveOverlapPolygonCount:0,
 oldCoverageLossKm2:0,oldCoverageLossPolygonCount:0,otherPeers:Object.fromEntries(peers.map(c=>[c,{exactPrePostIntersectionEqual:true,exactPrePostBoundaryShareEqual:true,changeAreaKm2:0}]))};
test('accepts only the registered local topology with zero overlap and no coverage loss',()=>{
 assert.equal(assertUkrSvkTopology(proof,binding,peers),true);
 for (const field of ['newOverlapKm2','oldCoverageLossKm2','newPositiveOverlapPolygonCount','oldCoverageLossPolygonCount'])
  assert.throws(()=>assertUkrSvkTopology({...proof,[field]:1},binding,peers),/topology/);
});
test('rejects a changed or omitted third-party contact and a reselected arc',()=>{
 const {SDS,...withoutSds}=proof.otherPeers;
 assert.throws(()=>assertUkrSvkTopology({...proof,otherPeers:withoutSds},binding,peers),/topology/);
 assert.throws(()=>assertUkrSvkTopology({...proof,otherPeers:{...proof.otherPeers,SDS:{...SDS,exactPrePostBoundaryShareEqual:false}}},binding,peers),/topology/);
 assert.throws(()=>assertUkrSvkTopology({...proof,operations:[{...op,endIndex:7}]},binding,peers),/topology/);
});
test('does not classify another country as an authorized seam',()=>{
 const geometryVersions=[{validTo:null,modernBoundarySupplement:{adoptionMode:ukrSvkSeamMethod,assertPriorBlrArc}}];
 assert.equal(hasUkrSvkSeam({entityId:'state:UKR',geometryVersions}),true);
 assert.equal(hasUkrSvkSeam({entityId:'state:SVK',geometryVersions}),false);
});

test('preserves every existing Belarus seam point after earlier arc insertion and rejects either change',()=>{
 const donor={coordinates:[[[[0,0],[0,4],[4,4],[4,0],[0,0]]]]};
 const chain=[[4,0],[4,4],[0,4]];
 const mk=(prefix,c=chain)=>({coordinates:[[prefix.concat(c)]]});
 const old=mk([[1,1]]),next=mk([[1,1],[2,2]]);
 const a={polygonIndex:0,ringIndex:0,startIndex:3,endIndex:1,direction:-1};
 const scope={polygonIndex:0,ringIndex:0,beforeStart:1,afterStart:2,length:3};
 assert.equal(assertPriorBlrArc(old,next,donor,a,scope),true);
 const altered=[[4,0],[4,4.01],[0,4]];
 assert.throws(()=>assertPriorBlrArc(mk([[1,1]],altered),next,donor,a,scope),/Belarus seam/);
 assert.throws(()=>assertPriorBlrArc(old,mk([[1,1],[2,2]],altered),donor,a,scope),/Belarus seam/);
});
test('rejects a changed Belarus, Moldova, Poland, or Hungary frontier, inherited zero-overlap, junctions or historical CAS',()=>{
 for(const altered of [{blrOverlapKm2:1},{blrBoundaryExact:false},{mdaOverlapKm2:1},{mdaBoundaryExact:false},{mdaShareKm:1223},{tripointsExact:false},{polBoundaryExact:false},{polOverlapKm2:1},{hunOverlapKm2:1},{hunBoundaryExact:false},{rouFrozenExact:false},{pointwiseOutsideChosenArc:false},{history:[]}])
  assert.throws(()=>assertUkrSvkTopology({...proof,sequentialPrior:{...sequentialPrior,...altered}},binding,peers),/topology/);
});