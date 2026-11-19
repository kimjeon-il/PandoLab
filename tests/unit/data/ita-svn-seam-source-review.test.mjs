import test from 'node:test';
import assert from 'node:assert/strict';
import {assertItaSvnTopology,bindItaSvnArc,hasItaSvnSeam,itaSvnSeamMethod} from '../../../tools/gis/ita-svn-seam-source-review.mjs';
const app='cc36381825c87b07fc06288a38c59ffa6f18a438',pin='5b090caae2e03405adafa34f5b142dc6b6d4148d';
const p=()=>({baseApp:app,baseData:pin,wholeDE9IM:'FF2F11212',wholeNewOverlapKm2:0,coverageLossEmpty:true,changesOnlyExistingSingleRing:true,
 protected:{file:'reports/borders/validation/modern-raw-source-20261110/protected-deu-ita-contract-20261113/ITA-protected-zone.json',deltaDisjoint:true,sameAllocationExact:true,sameBoundaryExact:true},
 peers:Object.fromEntries(['ALB','AUT','BIH','CHE','DEU','DZA','FRA','GRC','HRV','LIE','MLT','MNE','SMR','TUN','VAT'].map(c=>[c,{verification:'exact full delta envelope disjoint',deltaContact:c==='AUT'?{type:'Point',coordinates:[13.714085700000055,46.52299510000006]}:null}]))});
test('accept only literal zero, validated mask, exact Austria endpoint and all other peers disjoint',()=>{
 assert.doesNotThrow(()=>assertItaSvnTopology(p()));
 for(const alter of [x=>{x.wholeNewOverlapKm2=1e-14},x=>{x.coverageLossEmpty=false},x=>{x.protected.deltaDisjoint=false},x=>{x.peers.AUT.deltaContact=null},x=>{x.peers.HRV.deltaContact=x.peers.AUT.deltaContact},x=>{delete x.peers.SMR}]){
  const x=p();alter(x);assert.throws(()=>assertItaSvnTopology(x),/ITA\/SVN/);
 }
});
test('only current Italy recognized: broad or inaccurate arc contract must fail',()=>{
 const v={validTo:null,modernBoundarySupplement:{adoptionMode:itaSvnSeamMethod}};
 assert.equal(hasItaSvnSeam({entityId:'state:ITA',geometryVersions:[v]}),true);
 assert.equal(hasItaSvnSeam({entityId:'state:SVN',geometryVersions:[v]}),false);
 assert.throws(()=>bindItaSvnArc(null,null,null,{count:8894,old:[41,0,752,889]}),/exact one/);
});