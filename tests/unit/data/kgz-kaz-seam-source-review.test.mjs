import test from 'node:test';
import assert from 'node:assert/strict';
import {assertKgzKazTopology,assertKgzKazSeam,hasKgzKazSeam,kgzKazSeamMethod} from '../../../tools/gis/kgz-kaz-seam-source-review.mjs';
const synthetic={"baseApp":"7f61cd0d4272b783f645721bd556d5abed73e0b1","baseData":"9e5a22831fbb2660c65a2c185486bbd4c610069f","valid":true,"DE9IM":"FF2F11212","newOverlapKm2":0,"lossIsEmpty":true,"newGapLossKm2":0,"old":[0,0,2788,4685],"raw":[1,0,56118,70807,1],"fixedKAZ":[7,0,58836,44147,-1],"count":14690,"protected":{"archive":"reports/borders/validation/modern-raw-source-20261110/protected-final-five-contract-20261113/KGZ-protected-zone.json","sha256":"3a3412584d9ce764d3334e668090038a1f0d595410b7a983bd392e5cc3aa8f1b","deltaEmpty":true,"allocationExact":true,"boundaryExact":true},"peers":{"UZB":{"deltaContact":null,"intersectionExact":true,"boundaryExact":true},"TJK":{"deltaContact":null,"intersectionExact":true,"boundaryExact":true},"CHN":{"deltaContact":{"type":"Point","coordinates":[80.17485780000004,42.210843200000056]},"intersectionExact":true,"boundaryExact":true,"retainedCommonAnchor":true},"RUS":{"deltaContact":null,"intersectionExact":true,"boundaryExact":true}}};
test('KGZ/KAZ requires literal zero coverage loss, unchanged protection and the exact third-country point',()=>{
 assert.equal(assertKgzKazTopology(structuredClone(synthetic)),true);
 for(const mutate of [p=>p.newOverlapKm2=1e-20,p=>p.lossIsEmpty=false,p=>p.protected.deltaEmpty=false,p=>p.peers.CHN.deltaContact=null,p=>p.fixedKAZ[2]+=1,p=>delete p.peers.RUS,p=>p.peers.UZB.boundaryExact=false,p=>p.peers.CHE={},p=>p.baseData='a'.repeat(40)]) {
  const p=structuredClone(synthetic);mutate(p);assert.throws(()=>assertKgzKazTopology(p),/KGZ\/KAZ/);
 }
});
test('only dedicated current KGZ is selected, stale or missing data pin fails before an archive read',()=>{
 const v={validTo:null,modernBoundarySupplement:{adoptionMode:kgzKazSeamMethod}};
 const e={entityId:'state:KGZ',geometryVersions:[v]};
 assert.equal(hasKgzKazSeam(e),true);
 assert.equal(hasKgzKazSeam({entityId:'state:KAZ',geometryVersions:[v]}),false);
 assert.equal(hasKgzKazSeam({entityId:'state:KGZ',geometryVersions:[{...v,validTo:'2000-01-01'}]}),false);
 const prefixes=["assets/data/territorial-entities/source/countries/state-KGZ.json","assets/data/territorial-entities/source/geometries/sha256-5f3e38cc2c5674529dc7898670ae7023a64a6f571eae0983351ff065698ff2bf.json"];let reads=0;
 const readEvidence=()=>{reads++;throw Error('unexpected archive read');};
 for(const sourceDataRevision of [undefined,'0'.repeat(40)])assert.throws(()=>assertKgzKazSeam(e,e,{prefixes,sourceDataRevision,readEvidence}),/KGZ\/KAZ/);
 assert.equal(reads,0);
});