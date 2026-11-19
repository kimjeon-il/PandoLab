import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSdsUgaTopology,hasSdsUgaSeam,sdsUgaSeamMethod,assertPriorWesternWithNine,assertNewUgandaNine} from '../../../tools/gis/sds-uga-seam-source-review.mjs';
const pin='5a8bda140835ef997627a4f4e377b92606cf4083', r={polygonIndex:0,ringIndex:0,startIndex:0,endIndex:2,direction:1};
const starts=[{polygonIndex:1,ringIndex:0,startIndex:0}];
test('allows an anchor shared with the new adjacent old edge, rejecting reapplication of an existing west edge',()=>{
 const g=x=>({type:'MultiPolygon',coordinates:[[[[0,0],[1,0],[2,0],[0,0]]],[x]]});
 const old=g([[-1,0],[0,0],[1,0],[2,0],[-1,0]]),next=g([[-1,0],[-.5,.1],[0,0],[1,0],[2,0],[-1,0]]);
 const raw={coordinates:[[[[0,0],[1,0],[2,0],[0,0]]]]};
 const ops=[{polygonIndex:1,ringIndex:0,raw:r,inserted:1,peer:'CAF'}];
 const row={old:[1,3],candidate:[2,4],source:[0,2],peer:'CAF'},allowed=[{startIndex:0,endIndex:1}];
 assert.deepEqual(assertPriorWesternWithNine(old,next,raw,ops,[row],allowed,[3]),{by:{CAF:1,UGA:0},inserted:1});
 assert.throws(()=>assertPriorWesternWithNine(old,next,raw,ops,[row],[{startIndex:1,endIndex:2}],[3]),/pointwise/);
 assert.throws(()=>assertPriorWesternWithNine(old,next,raw,ops,[{...row,candidate:[1,3]}],allowed,[3]),/pointwise/);
});
test('rejects a shortened/reselected new tranche and protected Ethiopia or Kafia changes',()=>{
 const op={polygonIndex:1,ringIndex:0,startIndex:0,endIndex:1,raw:r};
 const binding={sourcePin:pin,topologyOperations:[op],ringStarts:starts,ugaArcs:[r],originalSDSWkb:'digest'};
 const sequentialPrior={history:[],outsideExact:true,protectedIlemiKafia:true,originalSdnKenTripoints:true,westernOperationCount:325,westernInserted:8900,ethFullPreserved:true,ethOldOverlapKm2:0,noNewContact:true};
 const proof={pin,SDSOriginal:{wkbSha256:'digest'},operations:[op],ringStarts:starts,UGADonors:[r],
  newPairDE9IM:'FF2F11212',newOverlapKm2:0,newPositiveOverlapPolygonCount:0,oldCoverageLossKm2:0,oldCoverageLossPolygonCount:0,allArcEdgesExactReciprocal:true,sequentialPrior,
  otherPeers:{ETH:{exactPrePostIntersectionEqual:true,exactPrePostBoundaryShareEqual:true,changeAreaKm2:0}}};
 assert.equal(assertSdsUgaTopology(proof,binding,['ETH']),true);
 for(const z of [{protectedIlemiKafia:false},{outsideExact:false},{ethFullPreserved:false},{ethOldOverlapKm2:1},{noNewContact:false},{westernOperationCount:324}])
  assert.throws(()=>assertSdsUgaTopology({...proof,sequentialPrior:{...sequentialPrior,...z}},binding,['ETH']),/topology/);
 assert.throws(()=>assertNewUgandaNine(null,null,null,null,[op],[op],starts,[3]),/nine fixed/);
});
test('only accepts current South Sudan',()=>{
 const g=[{validTo:null,modernBoundarySupplement:{adoptionMode:sdsUgaSeamMethod}}];
 assert.equal(hasSdsUgaSeam({entityId:'state:SDS',geometryVersions:g}),true);
 assert.equal(hasSdsUgaSeam({entityId:'state:UGA',geometryVersions:g}),false);
});
