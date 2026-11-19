import test from 'node:test';
import assert from 'node:assert/strict';
import {assertUkrMdaTopology,hasUkrMdaSeam,ukrMdaSeamMethod,assertPriorBlrArc} from '../../../tools/gis/ukr-mda-seam-source-review.mjs';
const pin='8ae278ebaf17f05531de0f07e5a3dcd1385ef2ee';
const op={polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,raw:{polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,direction:1}};
const a={polygonIndex:0,ringIndex:0,startIndex:4,endIndex:3,direction:-1};
const r={polygonIndex:1,ringIndex:0,startIndex:0};
const peers=['COG','SDS'];
const binding={sourcePin:pin,operation:op,topologyOperation:op,originalUKRWkb:"fixed-original",mdaArc:a,ringStart:r};
const sequentialPrior={history:[{versionId:'state:ukraine:1991-2014-r1',from:'1991-08-24',to:'2014-03-17',resourceSHA:'c2ba09faefaa062e0fbb947109d01e5ade145e49a151a82a134e0049a7a8ca0a'}],blrOverlapKm2:0,blrBoundaryExact:true,pointwiseOutsideChosenArc:true};
const proof={pin,sequentialPrior,UKROriginal:{wkbSha256:"fixed-original"},operations:[op],ringStarts:[r],MDADonor:{...a,openRingVertexCount:20},
 allArcEdgesExactReciprocal:true,newPairDE9IM:'FF2F11212',newOverlapKm2:0,newPositiveOverlapPolygonCount:0,
 oldCoverageLossKm2:0,oldCoverageLossPolygonCount:0,otherPeers:Object.fromEntries(peers.map(c=>[c,{exactPrePostIntersectionEqual:true,exactPrePostBoundaryShareEqual:true,changeAreaKm2:0}]))};
test('accepts only the registered local topology with zero overlap and no coverage loss',()=>{
 assert.equal(assertUkrMdaTopology(proof,binding,peers),true);
 for (const field of ['newOverlapKm2','oldCoverageLossKm2','newPositiveOverlapPolygonCount','oldCoverageLossPolygonCount'])
  assert.throws(()=>assertUkrMdaTopology({...proof,[field]:1},binding,peers),/topology/);
});
test('rejects a changed or omitted third-party contact and a reselected arc',()=>{
 const {SDS,...withoutSds}=proof.otherPeers;
 assert.throws(()=>assertUkrMdaTopology({...proof,otherPeers:withoutSds},binding,peers),/topology/);
 assert.throws(()=>assertUkrMdaTopology({...proof,otherPeers:{...proof.otherPeers,SDS:{...SDS,exactPrePostBoundaryShareEqual:false}}},binding,peers),/topology/);
 assert.throws(()=>assertUkrMdaTopology({...proof,operations:[{...op,endIndex:7}]},binding,peers),/topology/);
});
test('does not classify another country as an authorized seam',()=>{
 const geometryVersions=[{validTo:null,modernBoundarySupplement:{adoptionMode:ukrMdaSeamMethod,assertPriorBlrArc}}];
 assert.equal(hasUkrMdaSeam({entityId:'state:UKR',geometryVersions}),true);
 assert.equal(hasUkrMdaSeam({entityId:'state:MDA',geometryVersions}),false);
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
test('rejects nonzero prior Belarus overlap, lost seam and a changed historical CAS',()=>{
 for(const altered of [{blrOverlapKm2:1},{blrBoundaryExact:false},{pointwiseOutsideChosenArc:false},{history:[]}])
  assert.throws(()=>assertUkrMdaTopology({...proof,sequentialPrior:{...sequentialPrior,...altered}},binding,peers),/topology/);
});