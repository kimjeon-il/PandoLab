import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRusPolTopology,hasRusPolSeam,rusPolSeamMethod,assertKaliningradReplay} from '../../../tools/gis/rus-pol-seam-source-review.mjs';
const synthetic=()=>{
 const loop=[[0,0],[4,0],[4,4],[0,4],[0,0]];
 const qs=[5,646].map(n=>[...Array.from({length:n},(_,i)=>[4*i/(n-1),i>0&&i<n-1?-0.1:0]),...loop.slice(2)]);
 const old={coordinates:Array.from({length:3290},()=>[loop]),type:'MultiPolygon'},donor={coordinates:qs.map(r=>[r]),type:'MultiPolygon'};
 const counts=[5,646],arcs=counts.map((count,i)=>({polygonIndex:i,ringIndex:0,startIndex:0,endIndex:count-1,direction:1}));
 const operations=[1,11].map((polygonIndex,i)=>({polygonIndex,ringIndex:0,startIndex:0,endIndex:1,raw:arcs[i]}));
 const starts=operations.map(o=>({polygonIndex:o.polygonIndex,ringIndex:0,startIndex:0}));
 const next={coordinates:old.coordinates.slice(),type:'MultiPolygon'}; next.coordinates[1]=[qs[0]];next.coordinates[11]=[qs[1]];
 return {old,next,donor,operations,starts,arcs,counts};
};
test('allows only exact raw replay on the two present-day Kaliningrad circuits',()=>{
 const f=synthetic();const {old,next,donor,operations,starts,arcs,counts}=f;
 assert.equal(assertKaliningradReplay(old,next,donor,operations,starts,arcs,counts),true);
 assert.throws(()=>assertKaliningradReplay(old,next,donor,operations.slice(1),starts,arcs,counts),/two existing/);
 assert.throws(()=>assertKaliningradReplay(old,next,donor,operations,starts,arcs,[5,647]),/two existing/);
 const sub=structuredClone(next);sub.coordinates[1][0][1][1]=-0.3;
 assert.throws(()=>assertKaliningradReplay(old,sub,donor,operations,starts,arcs,counts),/replay/);
 const main=structuredClone(next);main.coordinates[3289][0][1]=[.1,1];
 assert.throws(()=>assertKaliningradReplay(old,main,donor,operations,starts,arcs,counts),/Russian mainland/);
});
test('rejects changed Lithuania tripoint, earlier overlap/coverage or historical CAS',()=>{
 const {operations,starts,arcs}=synthetic(),pin='affe90dfcfd5ff783da8a270c7622bafc74fb5ed';
 const peers=['LTU'],history=[{versionId:'state:RUS:post-soviet-existing-coordinates',from:'1991-12-25',to:'2014-03-17',resourceSHA:'dcb6476f67e6d76306d64d5233f73daecb6dd9793651c0e5c4af6cff1350d7a5'}];
 const sequentialPrior={history,mainlandUntouched:true,priorBordersExact:true,pointwiseOutsideChosenArc:true,ltuTripointExact:true,azeExact:true,azeOverlapKm2:0,estExact:true,estOverlapKm2:0,lvaExact:true,lvaOverlapKm2:0};
 const binding={sourcePin:pin,originalRUSWkb:'wkb',topologyOperations:operations,ringStarts:starts,polArcs:arcs};
 const proof={pin,operations,ringStarts:starts,POLDonors:arcs,RUSOriginal:{wkbSha256:'wkb'},
  newPairDE9IM:'FF2F11212',newOverlapKm2:0,newPositiveOverlapPolygonCount:0,oldCoverageLossKm2:0,oldCoverageLossPolygonCount:0,allArcEdgesExactReciprocal:true,sequentialPrior,
  otherPeers:{LTU:{exactPrePostIntersectionEqual:true,exactPrePostBoundaryShareEqual:true,changeAreaKm2:0}}};
 assert.equal(assertRusPolTopology(proof,binding,peers),true);
 for(const z of [{mainlandUntouched:false},{ltuTripointExact:false},{lvaOverlapKm2:1},{estOverlapKm2:1},{history:[]}])
  assert.throws(()=>assertRusPolTopology({...proof,sequentialPrior:{...sequentialPrior,...z}},binding,peers),/topology/);
 assert.throws(()=>assertRusPolTopology({...proof,oldCoverageLossKm2:1},binding,peers),/topology/);
});
test('excludes Poland counterpart and expired Russia phases',()=>{
 let geometryVersions=[{validTo:null,modernBoundarySupplement:{adoptionMode:rusPolSeamMethod}}];
 assert.equal(hasRusPolSeam({entityId:'state:RUS',geometryVersions}),true);
 assert.equal(hasRusPolSeam({entityId:'state:POL',geometryVersions}),false);
 geometryVersions=[{...geometryVersions[0],validTo:'2014-03-17'}];
 assert.equal(hasRusPolSeam({entityId:'state:RUS',geometryVersions}),false);
});
