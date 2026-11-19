import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRusBlrTopology,hasRusBlrSeam,rusBlrSeamMethod,replayRusBlrJoint} from '../../../tools/gis/rus-blr-seam-source-review.mjs';
const box=[[0,0],[4,0],[4,4],[0,4],[0,0]];
const edge=[[0,0],[2,-1],[4,0],[4,4],[0,4],[0,0]];
const island=[[10,10],[12,10],[12,12],[10,12],[10,10]];
const hole=[[10,10],[10,12],[12,12],[12,10],[11,9],[10,10]];
const previous={type:'MultiPolygon',coordinates:[[island],[box],[box]]};
const donor={type:'MultiPolygon',coordinates:[[edge,hole]]};
const arc={polygonIndex:0,ringIndex:0,startIndex:0,endIndex:2,direction:1};
const op={polygonIndex:1,ringIndex:0,startIndex:0,endIndex:1,raw:arc};
const ringStart={polygonIndex:1,ringIndex:0,startIndex:0};
const z={polygonIndex:0,ringIndex:0,previousClosedCount:5,newClosedCount:6,donorPolygonIndex:0,donorRingIndex:1,donorStartIndex:4,donorDirection:-1,first:hole[4]};
const peers=['UKR','LVA','LTU'];
const pin='4257b96429f534bc1e683e1f1df768c0f5fa4495';
const binding={sourcePin:pin,originalRUSWkb:'fixed-original',topologyOperations:[op,z],blrArc:arc,ringStart,enclave:z};
const proof={pin,RUSOriginal:{wkbSha256:'fixed-original'},operations:[op,z],ringStarts:[ringStart],BLRDonor:arc,
 allArcEdgesExactReciprocal:true,newPairDE9IM:'FF2F11212',newOverlapKm2:0,newPositiveOverlapPolygonCount:0,oldCoverageLossKm2:0,oldCoverageLossPolygonCount:0,
 otherPeers:Object.fromEntries(peers.map(c=>[c,{exactPrePostIntersectionEqual:true,exactPrePostBoundaryShareEqual:true,changeAreaKm2:0}]))};
test('replays only the selected mainland and complete reversed enclave',()=>{
 const next=replayRusBlrJoint(previous,donor,op,ringStart,z);
 assert.deepEqual(next.coordinates,[[[hole[4],hole[3],hole[2],hole[1],hole[0],hole[4]]],[edge],[box]]);
 assert.deepEqual(previous.coordinates,[[island],[box],[box]]);
});
test('rejects a non-hole as the enclave, a shortened preimage, and a changed closure',()=>{
 for(const change of [{donorRingIndex:0},{previousClosedCount:4},{newClosedCount:7},{donorDirection:0},{donorStartIndex:5}])
  assert.throws(()=>replayRusBlrJoint(previous,donor,op,ringStart,{...z,...change}),/enclave/);
 assert.throws(()=>replayRusBlrJoint(previous,{...donor,coordinates:[[edge,[...hole.slice(0,-1),[10,11]]]]},op,ringStart,z),/enclave/);
});
test('asserts absence of overlap and lost coverage and rejects omitted or changed partners and enclave',()=>{
 assert.equal(assertRusBlrTopology(proof,binding,peers),true);
 for(const key of ['newOverlapKm2','oldCoverageLossKm2','newPositiveOverlapPolygonCount','oldCoverageLossPolygonCount'])
  assert.throws(()=>assertRusBlrTopology({...proof,[key]:1},binding,peers),/topology/);
 assert.throws(()=>assertRusBlrTopology({...proof,operations:[op,{...z,donorStartIndex:0}]},binding,peers),/topology/);
 const {LTU,...others}=proof.otherPeers;
 assert.throws(()=>assertRusBlrTopology({...proof,otherPeers:others},binding,peers),/topology/);
 assert.throws(()=>assertRusBlrTopology({...proof,otherPeers:{...others,LTU:{...LTU,exactPrePostBoundaryShareEqual:false}}},binding,peers),/topology/);
});
test('authorizes only current Russia and never the frozen Belarus counterpart',()=>{
 const geometryVersions=[{validTo:null,modernBoundarySupplement:{adoptionMode:rusBlrSeamMethod}}];
 assert.equal(hasRusBlrSeam({entityId:'state:RUS',geometryVersions}),true);
 assert.equal(hasRusBlrSeam({entityId:'state:BLR',geometryVersions}),false);
});
