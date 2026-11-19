import test from 'node:test';
import assert from 'node:assert/strict';
import {assertPolTopology,bindPolCurrent,hasDeuPolSeam,deuPolSeamMethod} from '../../../tools/gis/deu-pol-seam-source-review.mjs';
const app='cf4c7d2e914bcf1196693491ea62875abdde1453',pin='cf28d85f06ef93673eab8907f57ab5c4fe74271a';
const native={coordinates:[]};native.coordinates[300]=[[]];native.coordinates[300][0][95103]=[1,2];
const testTopology=()=>({baseData:pin,baseApp:app,pairDE9IM:'FF2F11212',newOverlapKm2:0,oldLandLossKm2:0,valid:true,
 protectedFixedPolicyZoneEqualAndDisjoint:true,all1055PriorApprovedOperationsExact:true,
 peerChecks:Object.fromEntries(['AUT','BEL','CHE','CZE','DNK','FRA','ITA','LIE','LUX','NLD','SWE'].map(c=>[c,{unchangedExactIntersectionBoundaryDE9IM:true,deltaContact:null}]))});
test('POL route requires the exact pin, peer inventory, no land loss and exact protected topology',()=>{
 const t=testTopology();assert.doesNotThrow(()=>assertPolTopology(t,pin,native));
 t.peerChecks.CZE.deltaContact={type:'Point',coordinates:[1,2]};assert.doesNotThrow(()=>assertPolTopology(t,pin,native));
 for(const change of [q=>{q.oldLandLossKm2=1e-12},q=>{q.newOverlapKm2=1e-12},q=>{q.protectedFixedPolicyZoneEqualAndDisjoint=false},q=>{q.peerChecks.CZE.deltaContact={type:'Point',coordinates:[2,1]}},q=>{delete q.peerChecks.SWE}]){
  const x=testTopology();change(x);assert.throws(()=>assertPolTopology(x,pin,native),/DEU\/POL/);
 }
});
test('only current DEU marker recognizes the POL seam and exactly two reviewed operations are required',()=>{
 const v={validTo:null,modernBoundarySupplement:{adoptionMode:deuPolSeamMethod}};
 assert.equal(hasDeuPolSeam({entityId:'state:DEU',geometryVersions:[v]}),true);
 assert.equal(hasDeuPolSeam({entityId:'state:POL',geometryVersions:[v]}),false);
 assert.equal(hasDeuPolSeam({entityId:'state:DEU',geometryVersions:[{...v,validTo:'1989-01-01'}]}),false);
 assert.throws(()=>bindPolCurrent(null,null,null,[{}]),/exactly two/);
});
