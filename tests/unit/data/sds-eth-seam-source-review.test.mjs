import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSdsEthTopology,hasSdsEthSeam,sdsEthSeamMethod,assertOutsideSdsReplay,assertWesternSdsPoints} from '../../../tools/gis/sds-eth-seam-source-review.mjs';
const pin='f0b32b21b533ddf770dc1e7ed5eb5409040d4595', raw={polygonIndex:0,ringIndex:0,startIndex:0,endIndex:2,direction:1};
const op={polygonIndex:1,ringIndex:0,startIndex:4,endIndex:5,raw};
const starts={polygonIndex:1,ringIndex:0,startIndex:0};
const ring=[[0,0],[1,0],[2,0],[3,0],[4,0],[5,0],[5,2],[0,0]];
const shape=x=>({type:'MultiPolygon',coordinates:[[ring],[x]]});
const selected=[[0,0],[1,0],[2,0],[3,0],[4,0],[4.5,-.1],[5,0],[5,2],[0,0]];
test('proves previous CAF/UGA raw slice and rejects unsafe moved original edges',()=>{
 const old=shape(ring),next=shape(selected),donor={coordinates:[[ring]]};
 const ops=[{polygonIndex:1,ringIndex:0,raw,inserted:1,peer:'CAF'}],ranges=[{peer:'CAF',old:0,new:0,pointCount:3,raw:[0,2,1]}];
 assert.deepEqual(assertWesternSdsPoints(old,next,donor,ops,ranges,op,3),{counts:{CAF:1,UGA:0},inserted:1});
 assert.equal(assertOutsideSdsReplay(old,next,op,3),true);
 const mutate=selected.slice();mutate[1]=[1,.1];
 assert.throws(()=>assertWesternSdsPoints(old,shape(mutate),donor,ops,ranges,op,3),/pointwise/);
 assert.throws(()=>assertOutsideSdsReplay(old,shape(mutate),op,3),/outside/);
 assert.throws(()=>assertWesternSdsPoints(old,next,donor,ops,[{...ranges[0],new:1}],op,3),/invariants/);
});
test('requires preserved old western receipts, both exact tripoints and separately protected areas',()=>{
 const peers=['SDN','KEN'];
 const binding={sourcePin:pin,topologyOperation:op,ringStart:starts,ethArc:raw,originalSDSWkb:'digest'};
 const sequentialPrior={history:[],outsideExact:true,protectedIlemiKafia:true,originalSdnKenTripoints:true,westernOperationCount:325,westernInserted:8900};
 const proof={pin,SDSOriginal:{wkbSha256:'digest'},operations:[op],ringStarts:[starts],ETHDonor:raw,
  newPairDE9IM:'FF2F11212',newOverlapKm2:0,newPositiveOverlapPolygonCount:0,oldCoverageLossKm2:0,oldCoverageLossPolygonCount:0,allArcEdgesExactReciprocal:true,
  sequentialPrior,otherPeers:Object.fromEntries(peers.map(c=>[c,{exactPrePostIntersectionEqual:true,exactPrePostBoundaryShareEqual:true,changeAreaKm2:0}]))};
 assert.equal(assertSdsEthTopology(proof,binding,peers),true);
 for(const z of [{history:[0]},{outsideExact:false},{protectedIlemiKafia:false},{originalSdnKenTripoints:false},{westernOperationCount:324},{westernInserted:8899}])
  assert.throws(()=>assertSdsEthTopology({...proof,sequentialPrior:{...sequentialPrior,...z}},binding,peers),/topology/);
 assert.throws(()=>assertSdsEthTopology({...proof,oldCoverageLossKm2:1},binding,peers),/topology/);
});
test('only accepts current South Sudan, never Ethiopia, Sudan or expired slots',()=>{
 const g=[{validTo:null,modernBoundarySupplement:{adoptionMode:sdsEthSeamMethod}}];
 assert.equal(hasSdsEthSeam({entityId:'state:SDS',geometryVersions:g}),true);
 for(const c of ['ETH','SDN','KEN'])assert.equal(hasSdsEthSeam({entityId:'state:'+c,geometryVersions:g}),false);
 assert.equal(hasSdsEthSeam({entityId:'state:SDS',geometryVersions:[{...g[0],validTo:'2011-07-08'}]}),false);
});
