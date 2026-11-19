import test from 'node:test';
import assert from 'node:assert/strict';
import {assertUkrBlrTopology,hasUkrBlrSeam,ukrBlrSeamMethod} from '../../../tools/gis/ukr-blr-seam-source-review.mjs';
const pin='1de55927ed43ef195f6b9742e426892b27a21727';
const op={polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,raw:{polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,direction:1}};
const a={polygonIndex:0,ringIndex:0,startIndex:4,endIndex:3,direction:-1};
const r={polygonIndex:1,ringIndex:0,startIndex:0};
const peers=['COG','SDS'];
const binding={sourcePin:pin,operation:op,topologyOperation:op,originalUKRWkb:"fixed-original",blrArc:a,ringStart:r};
const proof={pin,UKROriginal:{wkbSha256:"fixed-original"},operations:[op],ringStarts:[r],BLRDonor:{...a,openRingVertexCount:20},
 allArcEdgesExactReciprocal:true,newPairDE9IM:'FF2F11212',newOverlapKm2:0,newPositiveOverlapPolygonCount:0,
 oldCoverageLossKm2:0,oldCoverageLossPolygonCount:0,otherPeers:Object.fromEntries(peers.map(c=>[c,{exactPrePostIntersectionEqual:true,exactPrePostBoundaryShareEqual:true,changeAreaKm2:0}]))};
test('accepts only the registered local topology with zero overlap and no coverage loss',()=>{
 assert.equal(assertUkrBlrTopology(proof,binding,peers),true);
 for (const field of ['newOverlapKm2','oldCoverageLossKm2','newPositiveOverlapPolygonCount','oldCoverageLossPolygonCount'])
  assert.throws(()=>assertUkrBlrTopology({...proof,[field]:1},binding,peers),/topology/);
});
test('rejects a changed or omitted third-party contact and a reselected arc',()=>{
 const {SDS,...withoutSds}=proof.otherPeers;
 assert.throws(()=>assertUkrBlrTopology({...proof,otherPeers:withoutSds},binding,peers),/topology/);
 assert.throws(()=>assertUkrBlrTopology({...proof,otherPeers:{...proof.otherPeers,SDS:{...SDS,exactPrePostBoundaryShareEqual:false}}},binding,peers),/topology/);
 assert.throws(()=>assertUkrBlrTopology({...proof,operations:[{...op,endIndex:7}]},binding,peers),/topology/);
});
test('does not classify another country as an authorized seam',()=>{
 const geometryVersions=[{validTo:null,modernBoundarySupplement:{adoptionMode:ukrBlrSeamMethod}}];
 assert.equal(hasUkrBlrSeam({entityId:'state:UKR',geometryVersions}),true);
 assert.equal(hasUkrBlrSeam({entityId:'state:BLR',geometryVersions}),false);
});
