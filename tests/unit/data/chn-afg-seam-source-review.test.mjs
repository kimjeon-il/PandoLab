import test from 'node:test';
import assert from 'node:assert/strict';
import {assertChnAfgTopology,hasChnAfgSeam,chnAfgSeamMethod,assertPriorChinaArc} from '../../../tools/gis/chn-afg-seam-source-review.mjs';
const pin='6b26d90d8763c9d925334e7549af64569a8ac352';
const op={polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,raw:{polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,direction:1}};
const a={polygonIndex:0,ringIndex:0,startIndex:4,endIndex:3,direction:-1};
const r={polygonIndex:1,ringIndex:0,startIndex:0};
const peers=['COG','SDS'];
const binding={sourcePin:pin,operation:op,topologyOperation:op,originalCHNWkb:"fixed-original",afgArc:a,ringStart:r};
const proof={pin,protectedPrior:{priorKAZExact:true,priorMNGExact:true,pakTjkTripointsExact:true,kasBoundaryUnchanged:true},CHNOriginal:{wkbSha256:"fixed-original"},operations:[op],ringStarts:[r],AFGDonor:{...a,openRingVertexCount:20},
 allArcEdgesExactReciprocal:true,newPairDE9IM:'FF2F11212',newOverlapKm2:0,newPositiveOverlapPolygonCount:0,
 oldCoverageLossKm2:0,oldCoverageLossPolygonCount:0,otherPeers:Object.fromEntries(peers.map(c=>[c,{exactPrePostIntersectionEqual:true,exactPrePostBoundaryShareEqual:true,changeAreaKm2:0}]))};
test('accepts only the registered local topology with zero overlap and no coverage loss',()=>{
 assert.equal(assertChnAfgTopology(proof,binding,peers),true);
 for (const field of ['newOverlapKm2','oldCoverageLossKm2','newPositiveOverlapPolygonCount','oldCoverageLossPolygonCount'])
  assert.throws(()=>assertChnAfgTopology({...proof,[field]:1},binding,peers),/topology/);
});
test('rejects a changed or omitted third-party contact and a reselected arc',()=>{
 const {SDS,...withoutSds}=proof.otherPeers;
 assert.throws(()=>assertChnAfgTopology({...proof,otherPeers:withoutSds},binding,peers),/topology/);
 assert.throws(()=>assertChnAfgTopology({...proof,otherPeers:{...proof.otherPeers,SDS:{...SDS,exactPrePostBoundaryShareEqual:false}}},binding,peers),/topology/);
 assert.throws(()=>assertChnAfgTopology({...proof,operations:[{...op,endIndex:7}]},binding,peers),/topology/);
});
test('does not classify another country as an authorized seam',()=>{
 const geometryVersions=[{validTo:null,modernBoundarySupplement:{adoptionMode:chnAfgSeamMethod,assertPriorChinaArc}}];
 assert.equal(hasChnAfgSeam({entityId:'state:CHN',geometryVersions}),true);
 assert.equal(hasChnAfgSeam({entityId:'state:AFG',geometryVersions}),false);
});

test('rejects predecessors and political junction mutations without broadening the AFG-only gate',()=>{
 for(const k of ['priorKAZExact','priorMNGExact','pakTjkTripointsExact','kasBoundaryUnchanged'])
  assert.throws(()=>assertChnAfgTopology({...proof,protectedPrior:{...proof.protectedPrior,[k]:false}},binding,peers),/topology/);
});
test('requires the previous native country arc before and after precise shift',()=>{
 const ring=[[0,0],[1,0],[2,0],[0,0]],donor={coordinates:[[ring]]};
 const old={coordinates:[[[[-1,0],...ring]]]},next={coordinates:[[[[-1,0],[-0.5,0],...ring]]]};
 const ar={polygonIndex:0,ringIndex:0,startIndex:0,endIndex:2,direction:1};
 assert.equal(assertPriorChinaArc(old,next,donor,ar,1,2,3),true);
 assert.throws(()=>assertPriorChinaArc(old,next,donor,ar,1,1,3),/pointwise/);
});