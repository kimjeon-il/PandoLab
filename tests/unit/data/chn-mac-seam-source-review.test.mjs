import test from 'node:test';
import assert from 'node:assert/strict';
import {assertChnMacTopology,hasChnMacSeam,chnMacSeamMethod,assertPriorChinaArc} from '../../../tools/gis/chn-mac-seam-source-review.mjs';
const pin='2b609a887919b96783b77b53c5b743d01b8c6183';
const op={polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,raw:{polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,direction:1}};
const a={polygonIndex:0,ringIndex:0,startIndex:4,endIndex:3,direction:-1};
const r={polygonIndex:1,ringIndex:0,startIndex:0};
const peers=['COG','SDS'];
const binding={sourcePin:pin,operation:op,topologyOperation:op,originalCHNWkb:"fixed-original",macArc:a,ringStart:r};
const proof={pin,alreadyExactNoOp:{old:[290,0,4,1],donor:[3,0,72,70,-1],count:3},protectedPrior:{priorKAZExact:true,priorMNGExact:true,priorAFGExact:true,hkgUnchanged:true},CHNOriginal:{wkbSha256:"fixed-original"},operations:[op],ringStarts:[r],MACDonor:{...a,openRingVertexCount:20},
 allArcEdgesExactReciprocal:true,newPairDE9IM:'FF2F11212',newOverlapKm2:0,newPositiveOverlapPolygonCount:0,
 oldCoverageLossKm2:0,oldCoverageLossPolygonCount:0,otherPeers:Object.fromEntries(peers.map(c=>[c,{exactPrePostIntersectionEqual:true,exactPrePostBoundaryShareEqual:true,changeAreaKm2:0,deltaEmpty:true}]))};
test('accepts only the registered local topology with zero overlap and no coverage loss',()=>{
 assert.equal(assertChnMacTopology(proof,binding,peers),true);
 for (const field of ['newOverlapKm2','oldCoverageLossKm2','newPositiveOverlapPolygonCount','oldCoverageLossPolygonCount'])
  assert.throws(()=>assertChnMacTopology({...proof,[field]:1},binding,peers),/topology/);
});
test('rejects a changed or omitted third-party contact and a reselected arc',()=>{
 const {SDS,...withoutSds}=proof.otherPeers;
 assert.throws(()=>assertChnMacTopology({...proof,otherPeers:withoutSds},binding,peers),/topology/);
 assert.throws(()=>assertChnMacTopology({...proof,otherPeers:{...proof.otherPeers,SDS:{...SDS,exactPrePostBoundaryShareEqual:false}}},binding,peers),/topology/);
 assert.throws(()=>assertChnMacTopology({...proof,operations:[{...op,endIndex:7}]},binding,peers),/topology/);
});
test('does not classify another country as an authorized seam',()=>{
 const geometryVersions=[{validTo:null,modernBoundarySupplement:{adoptionMode:chnMacSeamMethod,assertPriorChinaArc}}];
 assert.equal(hasChnMacSeam({entityId:'state:CHN',geometryVersions}),true);
 assert.equal(hasChnMacSeam({entityId:'state:MAC',geometryVersions}),false);
});

test('rejects predecessors and political junction mutations without broadening the MAC-only gate',()=>{
 for(const k of ['priorKAZExact','priorMNGExact','priorAFGExact','hkgUnchanged'])
  assert.throws(()=>assertChnMacTopology({...proof,protectedPrior:{...proof.protectedPrior,[k]:false}},binding,peers),/topology/);
});
test('requires the previous native country arc before and after precise shift',()=>{
 const ring=[[0,0],[1,0],[2,0],[0,0]],donor={coordinates:[[ring]]};
 const old={coordinates:[[[[-1,0],...ring]]]},next={coordinates:[[[[-1,0],[-0.5,0],...ring]]]};
 const ar={polygonIndex:0,ringIndex:0,startIndex:0,endIndex:2,direction:1};
 assert.equal(assertPriorChinaArc(old,next,donor,ar,1,2,3),true);
 assert.throws(()=>assertPriorChinaArc(old,next,donor,ar,1,1,3),/pointwise/);
});
test('rejects making the already-exact component a selected edit',()=>{assert.throws(()=>assertChnMacTopology({...proof,alreadyExactNoOp:{...proof.alreadyExactNoOp,count:5}},binding,peers),/topology/);});
