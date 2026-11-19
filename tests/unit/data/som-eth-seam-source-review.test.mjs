import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSomEthTopology,hasSomEthSeam,somEthSeamMethod,assertSomOrderedOriginal} from '../../../tools/gis/som-eth-seam-source-review.mjs';
const pin='2a4253a43cdc244efc16be8f9970ae5441bd91a6';
const op={polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,raw:{polygonIndex:1,ringIndex:0,startIndex:2,endIndex:3,direction:1}};
const a={polygonIndex:0,ringIndex:0,startIndex:4,endIndex:3,direction:-1};
const r={polygonIndex:1,ringIndex:0,startIndex:0};
const peers=['COG','SDS'];
const binding={sourcePin:pin,operation:op,topologyOperation:op,originalSOMWkb:"fixed-original",ethArc:a,ringStart:r};
const proof={pin,partitionPrior:{solPartitionExact:true,kenPriorTripointExact:true,newSdsPreimageConfirmed:true},SOMOriginal:{wkbSha256:"fixed-original"},operations:[op],ringStarts:[r],ETHDonor:{...a,openRingVertexCount:20},
 allArcEdgesExactReciprocal:true,newPairDE9IM:'FF2F11212',newOverlapKm2:0,newPositiveOverlapPolygonCount:0,
 oldCoverageLossKm2:0,oldCoverageLossPolygonCount:0,otherPeers:Object.fromEntries(peers.map(c=>[c,{exactPrePostIntersectionEqual:true,exactPrePostBoundaryShareEqual:true,changeAreaKm2:0}]))};
test('accepts only the registered local topology with zero overlap and no coverage loss',()=>{
 assert.equal(assertSomEthTopology(proof,binding,peers),true);
 for (const field of ['newOverlapKm2','oldCoverageLossKm2','newPositiveOverlapPolygonCount','oldCoverageLossPolygonCount'])
  assert.throws(()=>assertSomEthTopology({...proof,[field]:1},binding,peers),/topology/);
});
test('rejects a changed or omitted third-party contact and a reselected arc',()=>{
 const {SDS,...withoutSds}=proof.otherPeers;
 assert.throws(()=>assertSomEthTopology({...proof,otherPeers:withoutSds},binding,peers),/topology/);
 assert.throws(()=>assertSomEthTopology({...proof,otherPeers:{...proof.otherPeers,SDS:{...SDS,exactPrePostBoundaryShareEqual:false}}},binding,peers),/topology/);
 assert.throws(()=>assertSomEthTopology({...proof,operations:[{...op,endIndex:7}]},binding,peers),/topology/);
});
test('does not classify another country as an authorized seam',()=>{
 const geometryVersions=[{validTo:null,modernBoundarySupplement:{adoptionMode:somEthSeamMethod,assertSomOrderedOriginal}}];
 assert.equal(hasSomEthSeam({entityId:'state:SOM',geometryVersions}),true);
 assert.equal(hasSomEthSeam({entityId:'state:ETH',geometryVersions}),false);
});

test('pins prior unchanged Somaliland allocation, Kenya point, and newer SDS actual preimage',()=>{
 for(const k of ['solPartitionExact','kenPriorTripointExact','newSdsPreimageConfirmed'])
  assert.throws(()=>assertSomEthTopology({...proof,partitionPrior:{...proof.partitionPrior,[k]:false}},binding,peers),/topology/);
});
test('preserves the prior Kenyan exact arc sharing the western anchor and every current old arc point',()=>{
 const ox=[[0,0],[1,0],[2,0],[4,0],[4,4],[0,0]];
 const nx=[[0,0],[1,0],[2,0],[3,-1],[4,0],[4,4],[0,0]];
 const geom=r=>({type:'MultiPolygon',coordinates:[[r]]});
 const a={polygonIndex:0,ringIndex:0,startIndex:2,endIndex:4,direction:1};
 const op={polygonIndex:0,ringIndex:0,startIndex:2,endIndex:3,raw:a};
 const ken={lo:0,hi:2,source:{polygonIndex:0,ringIndex:0,startIndex:0,endIndex:2,direction:1},size:3};
 assert.equal(assertSomOrderedOriginal(geom(ox),geom(nx),geom(nx),geom(nx),op,a,3,ken),true);
 assert.throws(()=>assertSomOrderedOriginal(geom(ox),geom([[0,0],[1,.1],...nx.slice(2)]),geom(nx),geom(nx),op,a,3,ken),/Kenya frontier/);
});