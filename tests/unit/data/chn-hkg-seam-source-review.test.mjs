import test from 'node:test';
import assert from 'node:assert/strict';
import {assertChnHkgTopology,hasChnHkgSeam,chnHkgSeamMethod,assertPriorChinaArc} from '../../../tools/gis/chn-hkg-seam-source-review.mjs';
const pin='90c9222299dde018c34e1d044ac5aca2f35e966f';
const op={polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,raw:{polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,direction:1}};
const a={polygonIndex:0,ringIndex:0,startIndex:4,endIndex:3,direction:-1};
const r={polygonIndex:1,ringIndex:0,startIndex:0};
const peers=['COG','SDS'];
const binding={sourcePin:pin,operation:op,topologyOperation:op,originalCHNWkb:"fixed-original",hkgArc:a,ringStart:r};
const proof={pin,protectedPrior:{priorKAZExact:true,priorMNGExact:true,priorAFGExact:true,macUnchanged:true},CHNOriginal:{wkbSha256:"fixed-original"},operations:[op],ringStarts:[r],HKGDonor:{...a,openRingVertexCount:20},
 allArcEdgesExactReciprocal:true,newPairDE9IM:'FF2F11212',newOverlapKm2:0,newPositiveOverlapPolygonCount:0,
 oldCoverageLossKm2:0,oldCoverageLossPolygonCount:0,otherPeers:Object.fromEntries(peers.map(c=>[c,{exactPrePostIntersectionEqual:true,exactPrePostBoundaryShareEqual:true,changeAreaKm2:0,deltaEmpty:true}]))};
test('accepts only the registered local topology with zero overlap and no coverage loss',()=>{
 assert.equal(assertChnHkgTopology(proof,binding,peers),true);
 for (const field of ['newOverlapKm2','oldCoverageLossKm2','newPositiveOverlapPolygonCount','oldCoverageLossPolygonCount'])
  assert.throws(()=>assertChnHkgTopology({...proof,[field]:1},binding,peers),/topology/);
});
test('rejects a changed or omitted third-party contact and a reselected arc',()=>{
 const {SDS,...withoutSds}=proof.otherPeers;
 assert.throws(()=>assertChnHkgTopology({...proof,otherPeers:withoutSds},binding,peers),/topology/);
 assert.throws(()=>assertChnHkgTopology({...proof,otherPeers:{...proof.otherPeers,SDS:{...SDS,exactPrePostBoundaryShareEqual:false}}},binding,peers),/topology/);
 assert.throws(()=>assertChnHkgTopology({...proof,operations:[{...op,endIndex:7}]},binding,peers),/topology/);
});
test('does not classify another country as an authorized seam',()=>{
 const geometryVersions=[{validTo:null,modernBoundarySupplement:{adoptionMode:chnHkgSeamMethod,assertPriorChinaArc}}];
 assert.equal(hasChnHkgSeam({entityId:'state:CHN',geometryVersions}),true);
 assert.equal(hasChnHkgSeam({entityId:'state:HKG',geometryVersions}),false);
});

test('rejects predecessors and political junction mutations without broadening the HKG-only gate',()=>{
 for(const k of ['priorKAZExact','priorMNGExact','priorAFGExact','macUnchanged'])
  assert.throws(()=>assertChnHkgTopology({...proof,protectedPrior:{...proof.protectedPrior,[k]:false}},binding,peers),/topology/);
});
test('requires the previous native country arc before and after precise shift',()=>{
 const ring=[[0,0],[1,0],[2,0],[0,0]],donor={coordinates:[[ring]]};
 const old={coordinates:[[[[-1,0],...ring]]]},next={coordinates:[[[[-1,0],[-0.5,0],...ring]]]};
 const ar={polygonIndex:0,ringIndex:0,startIndex:0,endIndex:2,direction:1};
 assert.equal(assertPriorChinaArc(old,next,donor,ar,1,2,3),true);
 assert.throws(()=>assertPriorChinaArc(old,next,donor,ar,1,1,3),/pointwise/);
});