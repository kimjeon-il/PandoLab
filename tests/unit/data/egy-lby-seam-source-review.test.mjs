import test from 'node:test';
import assert from 'node:assert/strict';
import {assertEgyLbyTopology,hasEgyLbySeam,egyLbySeamMethod,assertExactlyUnselectedEgyPoints,assertExactPreviousCoastPoints} from '../../../tools/gis/egy-lby-seam-source-review.mjs';
const pin='e4a7b3883b9ade9dc921fd4e90b3e15378817b97';
const op={polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,raw:{polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,direction:1}};
const a={polygonIndex:0,ringIndex:0,startIndex:4,endIndex:3,direction:-1};
const r={polygonIndex:1,ringIndex:0,startIndex:0};
const peers=['COG','SDS'];
const binding={sourcePin:pin,operation:op,topologyOperation:op,originalEGYWkb:"fixed-original",lbyArc:a,ringStart:r};
const sequentialPrior={history:[],pointwiseOutsideChosenArc:true,halaibSeparateExcluded:true,sdnBoundaryExact:true,protectedZoneNames:["Hala'ib Triangle",'Bir Tawil'],retainedCoastOperationCount:300,retainedCoastInsertedVertices:3730};
const proof={pin,sequentialPrior,EGYOriginal:{wkbSha256:"fixed-original"},operations:[op],ringStarts:[r],LBYDonor:{...a,openRingVertexCount:20},
 allArcEdgesExactReciprocal:true,newPairDE9IM:'FF2F11212',newOverlapKm2:0,newPositiveOverlapPolygonCount:0,
 oldCoverageLossKm2:0,oldCoverageLossPolygonCount:0,otherPeers:Object.fromEntries(peers.map(c=>[c,{exactPrePostIntersectionEqual:true,exactPrePostBoundaryShareEqual:true,changeAreaKm2:0}]))};
test('accepts only the registered local topology with zero overlap and no coverage loss',()=>{
 assert.equal(assertEgyLbyTopology(proof,binding,peers),true);
 for (const field of ['newOverlapKm2','oldCoverageLossKm2','newPositiveOverlapPolygonCount','oldCoverageLossPolygonCount'])
  assert.throws(()=>assertEgyLbyTopology({...proof,[field]:1},binding,peers),/topology/);
});
test('rejects a changed or omitted third-party contact and a reselected arc',()=>{
 const {SDS,...withoutSds}=proof.otherPeers;
 assert.throws(()=>assertEgyLbyTopology({...proof,otherPeers:withoutSds},binding,peers),/topology/);
 assert.throws(()=>assertEgyLbyTopology({...proof,otherPeers:{...proof.otherPeers,SDS:{...SDS,exactPrePostBoundaryShareEqual:false}}},binding,peers),/topology/);
 assert.throws(()=>assertEgyLbyTopology({...proof,operations:[{...op,endIndex:7}]},binding,peers),/topology/);
});
test('does not classify another country as an authorized seam',()=>{
 const geometryVersions=[{validTo:null,modernBoundarySupplement:{adoptionMode:egyLbySeamMethod,assertExactlyUnselectedEgyPoints,assertExactPreviousCoastPoints}}];
 assert.equal(hasEgyLbySeam({entityId:'state:EGY',geometryVersions}),true);
 assert.equal(hasEgyLbySeam({entityId:'state:LBY',geometryVersions}),false);
});

test('rejects a changed prior coast, exact outside-arc vertex, or separate policy scope',()=>{
 const ex=[[0,0],[1,0],[2,0],[2,2],[0,0]], nx=[[0,0],[1,0],[1.5,0.2],[2,0],[2,2],[0,0]];
 const geom=x=>({type:'MultiPolygon',coordinates:[[x],[ex]]});
 const o={polygonIndex:0,ringIndex:0,startIndex:1,endIndex:2};
 assert.equal(assertExactlyUnselectedEgyPoints(geom(ex),geom(nx),o,3),true);
 const modified=nx.slice();modified[4]=[2,3];
 assert.throws(()=>assertExactlyUnselectedEgyPoints(geom(ex),geom(modified),o,3),/outside/);
 for(const altered of [{pointwiseOutsideChosenArc:false},{halaibSeparateExcluded:false},{sdnBoundaryExact:false},{history:[{}]},{protectedZoneNames:['Bir Tawil']},{retainedCoastOperationCount:299},{retainedCoastInsertedVertices:3729}])
  assert.throws(()=>assertEgyLbyTopology({...proof,sequentialPrior:{...sequentialPrior,...altered}},binding,peers),/topology/);
});
test('checks previous Mediterranean coast pointwise against archived original and prohibits scope intersection',()=>{
 const shaped=ring=>({type:'MultiPolygon',coordinates:[[ring]]});
 const pts=[[0,0],[1,-1],[2,0],[3,0],[3,2],[0,0]];
 const old=shaped(pts),source=shaped(pts),changed=shaped([[0,0],[1,-1],[2,0],[3,0],[3.2,1],[3,2],[0,0]]);
 const op={polygonIndex:0,ringIndex:0,raw:{polygonIndex:0,ringIndex:0,startIndex:0,endIndex:2,direction:1}};
 const adopted={polygonIndex:0,ringIndex:0,startIndex:3};
 assert.equal(assertExactPreviousCoastPoints(old,changed,source,[op],[[0,2]],adopted),1);
 assert.throws(()=>assertExactPreviousCoastPoints(old,changed,source,[op],[[0,2]],{...adopted,startIndex:2}),/clearance/);
 assert.throws(()=>assertExactPreviousCoastPoints(old,shaped([[0,0],[1,-2],...pts.slice(2)]),source,[op],[[0,2]],adopted),/coast changed/);
});