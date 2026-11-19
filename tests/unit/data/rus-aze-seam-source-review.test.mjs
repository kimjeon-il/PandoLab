import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRusAzeTopology,hasRusAzeSeam,rusAzeSeamMethod,assertUnselectedRussia} from '../../../tools/gis/rus-aze-seam-source-review.mjs';
const pin='69a331f011401edc5b782aca9a505e5918781b1c';
const op={polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,raw:{polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,direction:1}};
const a={polygonIndex:0,ringIndex:0,startIndex:4,endIndex:3,direction:-1};
const r={polygonIndex:1,ringIndex:0,startIndex:0};
const peers=['COG','SDS'];
const binding={sourcePin:pin,operation:op,topologyOperation:op,originalRUSWkb:"fixed-original",azeArc:a,ringStart:r};
const sequentialPrior={history:[{versionId:'state:RUS:post-soviet-existing-coordinates',from:'1991-12-25',to:'2014-03-17',resourceSHA:'dcb6476f67e6d76306d64d5233f73daecb6dd9793651c0e5c4af6cff1350d7a5'}],pointwiseOutsideChosenArc:true,priorBordersExact:true,geoTripointExact:true};
const proof={pin,sequentialPrior,RUSOriginal:{wkbSha256:"fixed-original"},operations:[op],ringStarts:[r],AZEDonor:{...a,openRingVertexCount:20},
 allArcEdgesExactReciprocal:true,newPairDE9IM:'FF2F11212',newOverlapKm2:0,newPositiveOverlapPolygonCount:0,
 oldCoverageLossKm2:0,oldCoverageLossPolygonCount:0,otherPeers:Object.fromEntries(peers.map(c=>[c,{exactPrePostIntersectionEqual:true,exactPrePostBoundaryShareEqual:true,changeAreaKm2:0}]))};
test('accepts only the registered local topology with zero overlap and no coverage loss',()=>{
 assert.equal(assertRusAzeTopology(proof,binding,peers),true);
 for (const field of ['newOverlapKm2','oldCoverageLossKm2','newPositiveOverlapPolygonCount','oldCoverageLossPolygonCount'])
  assert.throws(()=>assertRusAzeTopology({...proof,[field]:1},binding,peers),/topology/);
});
test('rejects a changed or omitted third-party contact and a reselected arc',()=>{
 const {SDS,...withoutSds}=proof.otherPeers;
 assert.throws(()=>assertRusAzeTopology({...proof,otherPeers:withoutSds},binding,peers),/topology/);
 assert.throws(()=>assertRusAzeTopology({...proof,otherPeers:{...proof.otherPeers,SDS:{...SDS,exactPrePostBoundaryShareEqual:false}}},binding,peers),/topology/);
 assert.throws(()=>assertRusAzeTopology({...proof,operations:[{...op,endIndex:7}]},binding,peers),/topology/);
});
test('does not classify another country as an authorized seam',()=>{
 const geometryVersions=[{validTo:null,modernBoundarySupplement:{adoptionMode:rusAzeSeamMethod,assertUnselectedRussia}}];
 assert.equal(hasRusAzeSeam({entityId:'state:RUS',geometryVersions}),true);
 assert.equal(hasRusAzeSeam({entityId:'state:AZE',geometryVersions}),false);
});

test('rejects changed prior seam, historic version or Georgia tripoint and enforces all unselected rings',()=>{
 const ex=[[0,0],[1,0],[2,0],[2,2],[0,0]], nx=[[0,0],[1,0],[1.5,0.2],[2,0],[2,2],[0,0]];
 const geom=x=>({type:'MultiPolygon',coordinates:[[x],[ex]]});
 const o={polygonIndex:0,ringIndex:0,startIndex:1,endIndex:2};
 assert.equal(assertUnselectedRussia(geom(ex),geom(nx),o,3),true);
 const modified=nx.slice();modified[4]=[2,3];
 assert.throws(()=>assertUnselectedRussia(geom(ex),geom(modified),o,3),/unselected/);
 for(const altered of [{pointwiseOutsideChosenArc:false},{geoTripointExact:false},{priorBordersExact:false},{history:[]}])
  assert.throws(()=>assertRusAzeTopology({...proof,sequentialPrior:{...sequentialPrior,...altered}},binding,peers),/topology/);
});