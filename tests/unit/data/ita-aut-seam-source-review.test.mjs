import test from 'node:test';
import assert from 'node:assert/strict';
import {assertItaAutTopology,bindItaAutArc,hasItaAutSeam,itaAutSeamMethod} from '../../../tools/gis/ita-aut-seam-source-review.mjs';
const app='4624e155328c914acbb8cf7f4512443b2b55fe31',pin='c04c6de44a0cf0732c87d709f4da07e7d10350a1';
const contacts={CHE:[10.469652800000063,46.85490760000005],SVN:[13.714085700000055,46.52299510000006]};
const p=()=>({baseApp:app,baseData:pin,wholeDE9IM:'FF2F11212',wholeNewOverlapKm2:0,coverageLossEmpty:true,changesOnlyExistingSingleRing:true,
 protected:{file:'reports/borders/validation/modern-raw-source-20261110/protected-deu-ita-contract-20261113/ITA-protected-zone.json',deltaDisjoint:true,sameAllocationExact:true,sameBoundaryExact:true},
 peers:Object.fromEntries(['ALB','BIH','CHE','DEU','DZA','FRA','GRC','HRV','LIE','MLT','MNE','SMR','SVN','TUN','VAT'].map(c=>[c,{verification:'exact full delta envelope disjoint',deltaContact:contacts[c]?{type:'Point',coordinates:contacts[c]}:null}]))});
test('only strict zero topology and the two exact protected endpoints allow the Austrian arc',()=>{
 assert.doesNotThrow(()=>assertItaAutTopology(p()));
 for(const alter of [x=>{x.wholeNewOverlapKm2=1e-14},x=>{x.coverageLossEmpty=false},x=>{x.protected.deltaDisjoint=false},x=>{x.peers.SVN.deltaContact=null},x=>{x.peers.CHE.deltaContact=x.peers.SVN.deltaContact},x=>{x.peers.HRV.deltaContact=x.peers.CHE.deltaContact},x=>{delete x.peers.SMR}]){
  const x=p();alter(x);assert.throws(()=>assertItaAutTopology(x),/ITA\/AUT/);
 }
});
test('only current Italy recognized, source range cannot be broadened',()=>{
 const v={validTo:null,modernBoundarySupplement:{adoptionMode:itaAutSeamMethod}};
 assert.equal(hasItaAutSeam({entityId:'state:ITA',geometryVersions:[v]}),true);
 assert.equal(hasItaAutSeam({entityId:'state:AUT',geometryVersions:[v]}),false);
 assert.throws(()=>bindItaAutArc(null,null,null,{count:36956,old:[41,0,499,753]}),/exact one/);
});
