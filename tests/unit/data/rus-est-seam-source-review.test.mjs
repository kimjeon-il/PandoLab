import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRusEstTopology,hasRusEstSeam,rusEstSeamMethod,assertUnselectedRussia,assertPriorAzeArc} from '../../../tools/gis/rus-est-seam-source-review.mjs';
const pin='4d9f23cf6a7b7a5ca26c3ac6ad19e80aaa66f4b8';
const op={polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,raw:{polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,direction:1}};
const a={polygonIndex:0,ringIndex:0,startIndex:4,endIndex:3,direction:-1};
const r={polygonIndex:1,ringIndex:0,startIndex:0};
const peers=['COG','SDS'];
const binding={sourcePin:pin,operation:op,topologyOperation:op,originalRUSWkb:"fixed-original",estArc:a,ringStart:r};
const sequentialPrior={history:[{versionId:'state:RUS:post-soviet-existing-coordinates',from:'1991-12-25',to:'2014-03-17',resourceSHA:'dcb6476f67e6d76306d64d5233f73daecb6dd9793651c0e5c4af6cff1350d7a5'}],pointwiseOutsideChosenArc:true,priorBordersExact:true,lvaTripointExact:true,azeExact:true,azeOverlapKm2:0};
const proof={pin,sequentialPrior,RUSOriginal:{wkbSha256:"fixed-original"},operations:[op],ringStarts:[r],ESTDonor:{...a,openRingVertexCount:20},
 allArcEdgesExactReciprocal:true,newPairDE9IM:'FF2F11212',newOverlapKm2:0,newPositiveOverlapPolygonCount:0,
 oldCoverageLossKm2:0,oldCoverageLossPolygonCount:0,otherPeers:Object.fromEntries(peers.map(c=>[c,{exactPrePostIntersectionEqual:true,exactPrePostBoundaryShareEqual:true,changeAreaKm2:0}]))};
test('accepts only the registered local topology with zero overlap and no coverage loss',()=>{
 assert.equal(assertRusEstTopology(proof,binding,peers),true);
 for (const field of ['newOverlapKm2','oldCoverageLossKm2','newPositiveOverlapPolygonCount','oldCoverageLossPolygonCount'])
  assert.throws(()=>assertRusEstTopology({...proof,[field]:1},binding,peers),/topology/);
});
test('rejects a changed or omitted third-party contact and a reselected arc',()=>{
 const {SDS,...withoutSds}=proof.otherPeers;
 assert.throws(()=>assertRusEstTopology({...proof,otherPeers:withoutSds},binding,peers),/topology/);
 assert.throws(()=>assertRusEstTopology({...proof,otherPeers:{...proof.otherPeers,SDS:{...SDS,exactPrePostBoundaryShareEqual:false}}},binding,peers),/topology/);
 assert.throws(()=>assertRusEstTopology({...proof,operations:[{...op,endIndex:7}]},binding,peers),/topology/);
});
test('does not classify another country as an authorized seam',()=>{
 const geometryVersions=[{validTo:null,modernBoundarySupplement:{adoptionMode:rusEstSeamMethod,assertUnselectedRussia,assertPriorAzeArc}}];
 assert.equal(hasRusEstSeam({entityId:'state:RUS',geometryVersions}),true);
 assert.equal(hasRusEstSeam({entityId:'state:EST',geometryVersions}),false);
});

test('rejects changed prior seam, historic version or Latvia tripoint and enforces all unselected rings',()=>{
 const ex=[[0,0],[1,0],[2,0],[2,2],[0,0]], nx=[[0,0],[1,0],[1.5,0.2],[2,0],[2,2],[0,0]];
 const geom=x=>({type:'MultiPolygon',coordinates:[[x],[ex]]});
 const o={polygonIndex:0,ringIndex:0,startIndex:1,endIndex:2};
 assert.equal(assertUnselectedRussia(geom(ex),geom(nx),o,3),true);
 const modified=nx.slice();modified[4]=[2,3];
 assert.throws(()=>assertUnselectedRussia(geom(ex),geom(modified),o,3),/unselected/);
 for(const altered of [{pointwiseOutsideChosenArc:false},{lvaTripointExact:false},{azeExact:false},{azeOverlapKm2:1},{priorBordersExact:false},{history:[]}])
  assert.throws(()=>assertRusEstTopology({...proof,sequentialPrior:{...sequentialPrior,...altered}},binding,peers),/topology/);
});
test('checks every saved Azerbaijan point against fixed donor before and after Baltic replacement',()=>{
 const donor={type:'MultiPolygon',coordinates:[[[[0,0],[0,4],[4,4],[4,0],[0,0]]]]};
 const points=[[1,1],[4,0],[4,4],[0,4],[1,1]];
 const geom=(p)=>({type:'MultiPolygon',coordinates:[[p]]});
 const arc={polygonIndex:0,ringIndex:0,startIndex:3,endIndex:1,direction:-1},scope={polygonIndex:0,ringIndex:0,start:1,length:3};
 assert.equal(assertPriorAzeArc(geom(points),geom(points),donor,arc,scope),true);
 const q=points.slice();q[2]=[4.01,4];
 assert.throws(()=>assertPriorAzeArc(geom(points),geom(q),donor,arc,scope),/Azerbaijan arc/);
 assert.throws(()=>assertPriorAzeArc(geom(q),geom(points),donor,arc,scope),/Azerbaijan arc/);
});