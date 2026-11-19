import test from 'node:test';
import assert from 'node:assert/strict';
import {assertPakIrnTopology,hasPakIrnSeam,pakIrnSeamMethod,assertPriorPakCoastPoints,assertOrderedOriginalCorridor} from '../../../tools/gis/pak-irn-seam-source-review.mjs';
const pin='476ce3e6a33622e6b3af381ffe5a70a49a101219', raw={polygonIndex:0,ringIndex:0,startIndex:0,endIndex:2,direction:1};
const op={polygonIndex:0,ringIndex:0,startIndex:0,endIndex:1,raw}, starts={polygonIndex:0,ringIndex:0,startIndex:0};
const coast={polygonIndex:1,ringIndex:0,raw,points:3};
const prepared=[[0,0],[2,0],[2,2],[0,0]],full=[[0,0],[1,-1],[2,0],[2,2],[0,0]];
const source=x=>({type:'MultiPolygon',coordinates:[[x],[full]]});
test('requires both raw counterparts, selected frozen Iran original arc and every old Pakistan point in order',()=>{
 const old=source(prepared),next=source(full),donor=source(full);
 assert.equal(assertOrderedOriginalCorridor(old,next,donor,donor,donor,op,raw,3),true);
 assert.throws(()=>assertOrderedOriginalCorridor(source([[0,0],[2,.1],...prepared.slice(2)]),next,donor,donor,donor,op,raw,3),/ordered points/);
 assert.throws(()=>assertOrderedOriginalCorridor(old,next,donor,donor,source([[0,0],[1,-.9],...full.slice(2)]),op,raw,3),/arcs/);
});
test('pins every old coast vertex and prevents land gate from borrowing coastal scope',()=>{
 const before=source(prepared),after=source(full),donor=source(full);
 const r={polygon:1,ring:0,oldStart:0,candidateStart:0,pointCount:3};
 assert.equal(assertPriorPakCoastPoints(before,after,donor,[coast],[r],op),1);
 assert.throws(()=>assertPriorPakCoastPoints(before,after,donor,[coast],[{...r,candidateStart:1}],op),/interval/);
 assert.throws(()=>assertPriorPakCoastPoints(before,after,donor,[coast],[r],{...op,polygonIndex:1}),/interval/);
});
test('rejects changed old Afghanistan–Pakistan relation or Iran or coast preservation',()=>{
 const peers=['AFG','KAS'],binding={sourcePin:pin,topologyOperation:op,ringStart:starts,irnArc:raw,originalPAKWkb:'digest'};
 const sequentialPrior={history:[],afgWholeIntersectionExact:true,afgFullSharedBoundaryExact:true,afgRelation:'212111212',iranCoastAndAuthorityUntouched:true,retainedCoastOperationCount:36,retainedCoastPoints:2226};
 const proof={pin,PAKOriginal:{wkbSha256:'digest'},operations:[op],ringStarts:[starts],IRNDonor:raw,
  sequentialPrior,newPairDE9IM:'FF2F11212',newOverlapKm2:0,newPositiveOverlapPolygonCount:0,oldCoverageLossKm2:0,oldCoverageLossPolygonCount:0,allArcEdgesExactReciprocal:true,
  otherPeers:Object.fromEntries(peers.map(c=>[c,{exactPrePostIntersectionEqual:true,exactPrePostBoundaryShareEqual:true,changeAreaKm2:0}]))};
 assert.equal(assertPakIrnTopology(proof,binding,peers),true);
 for(const z of [{afgWholeIntersectionExact:false},{afgFullSharedBoundaryExact:false},{afgRelation:'FF2F11212'},{iranCoastAndAuthorityUntouched:false},{retainedCoastOperationCount:35},{retainedCoastPoints:2225}])
  assert.throws(()=>assertPakIrnTopology({...proof,sequentialPrior:{...sequentialPrior,...z}},binding,peers),/topology/);
 const versions=[{validTo:null,modernBoundarySupplement:{adoptionMode:pakIrnSeamMethod}}];
 assert.equal(hasPakIrnSeam({entityId:'state:PAK',geometryVersions:versions}),true);
 assert.equal(hasPakIrnSeam({entityId:'state:IRN',geometryVersions:versions}),false);
});
