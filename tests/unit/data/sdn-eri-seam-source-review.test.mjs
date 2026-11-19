import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSdnEriTopology,hasSdnEriSeam,sdnEriSeamMethod,assertExactlyUnselectedSdnPoints,assertPriorChadArc} from '../../../tools/gis/sdn-eri-seam-source-review.mjs';
const pin='ff7316dfabedacaa5b882dee6b9911b3f53ea0b6';
const op={polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,raw:{polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,direction:1}};
const a={polygonIndex:0,ringIndex:0,startIndex:4,endIndex:3,direction:-1};
const r={polygonIndex:1,ringIndex:0,startIndex:0};
const peers=['COG','SDS'];
const binding={sourcePin:pin,operation:op,topologyOperation:op,originalSDNWkb:"fixed-original",eriArc:a,ringStart:r};
const sequentialPrior={history:[{versionId:'state:sudan:1956-2011-r1',from:'1956-01-01',to:'2011-07-08',resourceSHA:'d6c9d52c96abb4b1ec4e90655c53859fac91db1a01e98009fd32376c22a7193f'}],pointwiseOutsideChosenArc:true,halaibSeparateExcluded:true,sdsBoundaryExact:true,protectedZoneNames:['Abyei','Bir Tawil'],chadArcExact:true,chadOverlapKm2:0,chadSharedKm:1410.175376092946,ethTripointExact:true};
const proof={pin,sequentialPrior,SDNOriginal:{wkbSha256:"fixed-original"},operations:[op],ringStarts:[r],ERIDonor:{...a,openRingVertexCount:20},
 allArcEdgesExactReciprocal:true,newPairDE9IM:'FF2F11212',newOverlapKm2:0,newPositiveOverlapPolygonCount:0,
 oldCoverageLossKm2:0,oldCoverageLossPolygonCount:0,otherPeers:Object.fromEntries(peers.map(c=>[c,{exactPrePostIntersectionEqual:true,exactPrePostBoundaryShareEqual:true,changeAreaKm2:0}]))};
test('accepts only the registered local topology with zero overlap and no coverage loss',()=>{
 assert.equal(assertSdnEriTopology(proof,binding,peers),true);
 for (const field of ['newOverlapKm2','oldCoverageLossKm2','newPositiveOverlapPolygonCount','oldCoverageLossPolygonCount'])
  assert.throws(()=>assertSdnEriTopology({...proof,[field]:1},binding,peers),/topology/);
});
test('rejects a changed or omitted third-party contact and a reselected arc',()=>{
 const {SDS,...withoutSds}=proof.otherPeers;
 assert.throws(()=>assertSdnEriTopology({...proof,otherPeers:withoutSds},binding,peers),/topology/);
 assert.throws(()=>assertSdnEriTopology({...proof,otherPeers:{...proof.otherPeers,SDS:{...SDS,exactPrePostBoundaryShareEqual:false}}},binding,peers),/topology/);
 assert.throws(()=>assertSdnEriTopology({...proof,operations:[{...op,endIndex:7}]},binding,peers),/topology/);
});
test('does not classify another country as an authorized seam',()=>{
 const geometryVersions=[{validTo:null,modernBoundarySupplement:{adoptionMode:sdnEriSeamMethod,assertExactlyUnselectedSdnPoints,assertPriorChadArc}}];
 assert.equal(hasSdnEriSeam({entityId:'state:SDN',geometryVersions}),true);
 assert.equal(hasSdnEriSeam({entityId:'state:ERI',geometryVersions}),false);
});

test('rejects a changed prior coast, exact outside-arc vertex, or separate policy scope',()=>{
 const ex=[[0,0],[1,0],[2,0],[2,2],[0,0]], nx=[[0,0],[1,0],[1.5,0.2],[2,0],[2,2],[0,0]];
 const geom=x=>({type:'MultiPolygon',coordinates:[[x],[ex]]});
 const o={polygonIndex:0,ringIndex:0,startIndex:1,endIndex:2};
 assert.equal(assertExactlyUnselectedSdnPoints(geom(ex),geom(nx),o,3),true);
 const modified=nx.slice();modified[4]=[2,3];
 assert.throws(()=>assertExactlyUnselectedSdnPoints(geom(ex),geom(modified),o,3),/outside/);
 for(const altered of [{pointwiseOutsideChosenArc:false},{halaibSeparateExcluded:false},{sdsBoundaryExact:false},{history:[]},{protectedZoneNames:['Abyei']},{chadArcExact:false},{chadOverlapKm2:0.001},{chadSharedKm:1410},{ethTripointExact:false}])
  assert.throws(()=>assertSdnEriTopology({...proof,sequentialPrior:{...sequentialPrior,...altered}},binding,peers),/topology/);
});
test('requires every previously approved Chad point in the old and new Sudan source',()=>{
 const donor={type:'MultiPolygon',coordinates:[[[[0,0],[0,4],[4,4],[4,0],[0,0]]]]};
 const p=[[1,1],[4,0],[4,4],[0,4],[1,1]];
 const geom=(points)=>({type:'MultiPolygon',coordinates:[[points]]});
 const arc={polygonIndex:0,ringIndex:0,startIndex:3,endIndex:1,direction:-1},scope={polygonIndex:0,ringIndex:0,start:1,length:3};
 assert.equal(assertPriorChadArc(geom(p),geom(p),donor,arc,scope),true);
 const pp=p.slice();pp[2]=[4.01,4];
 assert.throws(()=>assertPriorChadArc(geom(p),geom(pp),donor,arc,scope),/Chad arc/);
 assert.throws(()=>assertPriorChadArc(geom(pp),geom(p),donor,arc,scope),/Chad arc/);
});