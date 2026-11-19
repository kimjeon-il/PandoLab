import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSdnTcdTopology,hasSdnTcdSeam,sdnTcdSeamMethod,assertExactlyUnselectedSdnPoints} from '../../../tools/gis/sdn-tcd-seam-source-review.mjs';
const pin='57181a14b521b57c33dfa8618866ae22d7568959';
const op={polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,raw:{polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,direction:1}};
const a={polygonIndex:0,ringIndex:0,startIndex:4,endIndex:3,direction:-1};
const r={polygonIndex:1,ringIndex:0,startIndex:0};
const peers=['COG','SDS'];
const binding={sourcePin:pin,operation:op,topologyOperation:op,originalSDNWkb:"fixed-original",tcdArc:a,ringStart:r};
const sequentialPrior={history:[{versionId:'state:sudan:1956-2011-r1',from:'1956-01-01',to:'2011-07-08',resourceSHA:'d6c9d52c96abb4b1ec4e90655c53859fac91db1a01e98009fd32376c22a7193f'}],pointwiseOutsideChosenArc:true,halaibSeparateExcluded:true,sdsBoundaryExact:true,protectedZoneNames:['Abyei','Bir Tawil']};
const proof={pin,sequentialPrior,SDNOriginal:{wkbSha256:"fixed-original"},operations:[op],ringStarts:[r],TCDDonor:{...a,openRingVertexCount:20},
 allArcEdgesExactReciprocal:true,newPairDE9IM:'FF2F11212',newOverlapKm2:0,newPositiveOverlapPolygonCount:0,
 oldCoverageLossKm2:0,oldCoverageLossPolygonCount:0,otherPeers:Object.fromEntries(peers.map(c=>[c,{exactPrePostIntersectionEqual:true,exactPrePostBoundaryShareEqual:true,changeAreaKm2:0}]))};
test('accepts only the registered local topology with zero overlap and no coverage loss',()=>{
 assert.equal(assertSdnTcdTopology(proof,binding,peers),true);
 for (const field of ['newOverlapKm2','oldCoverageLossKm2','newPositiveOverlapPolygonCount','oldCoverageLossPolygonCount'])
  assert.throws(()=>assertSdnTcdTopology({...proof,[field]:1},binding,peers),/topology/);
});
test('rejects a changed or omitted third-party contact and a reselected arc',()=>{
 const {SDS,...withoutSds}=proof.otherPeers;
 assert.throws(()=>assertSdnTcdTopology({...proof,otherPeers:withoutSds},binding,peers),/topology/);
 assert.throws(()=>assertSdnTcdTopology({...proof,otherPeers:{...proof.otherPeers,SDS:{...SDS,exactPrePostBoundaryShareEqual:false}}},binding,peers),/topology/);
 assert.throws(()=>assertSdnTcdTopology({...proof,operations:[{...op,endIndex:7}]},binding,peers),/topology/);
});
test('does not classify another country as an authorized seam',()=>{
 const geometryVersions=[{validTo:null,modernBoundarySupplement:{adoptionMode:sdnTcdSeamMethod,assertExactlyUnselectedSdnPoints}}];
 assert.equal(hasSdnTcdSeam({entityId:'state:SDN',geometryVersions}),true);
 assert.equal(hasSdnTcdSeam({entityId:'state:TCD',geometryVersions}),false);
});

test('rejects a changed prior coast, exact outside-arc vertex, or separate policy scope',()=>{
 const ex=[[0,0],[1,0],[2,0],[2,2],[0,0]], nx=[[0,0],[1,0],[1.5,0.2],[2,0],[2,2],[0,0]];
 const geom=x=>({type:'MultiPolygon',coordinates:[[x],[ex]]});
 const o={polygonIndex:0,ringIndex:0,startIndex:1,endIndex:2};
 assert.equal(assertExactlyUnselectedSdnPoints(geom(ex),geom(nx),o,3),true);
 const modified=nx.slice();modified[4]=[2,3];
 assert.throws(()=>assertExactlyUnselectedSdnPoints(geom(ex),geom(modified),o,3),/outside/);
 for(const altered of [{pointwiseOutsideChosenArc:false},{halaibSeparateExcluded:false},{sdsBoundaryExact:false},{history:[]},{protectedZoneNames:['Abyei']}])
  assert.throws(()=>assertSdnTcdTopology({...proof,sequentialPrior:{...sequentialPrior,...altered}},binding,peers),/topology/);
});