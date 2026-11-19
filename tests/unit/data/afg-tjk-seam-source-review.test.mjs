import test from 'node:test';
import assert from 'node:assert/strict';
import {assertAfgTjkTopology,assertAfgTjkSeam,hasAfgTjkSeam,afgTjkSeamMethod} from '../../../tools/gis/afg-tjk-seam-source-review.mjs';
const synthetic={"baseApp":"c65e53c35ef3d5c304ba3c98c84fdac695c2b54b","baseData":"3a5d505ff9e33de9c74dccfc0b0cb143c6c2f9aa","valid":true,"DE9IM":"FF2F11212","newOverlapKm2":0,"lossIsEmpty":true,"newGapLossKm2":0,"old":[0,0,7093,2181],"raw":[0,0,40245,9504,1],"fixedAFG":[0,0,0,72624,-1],"count":9507,"protected":{"archive":"reports/borders/validation/modern-raw-source-20261110/protected-final-five-contract-20261113/TJK-protected-zone.json","sha256":"3a3412584d9ce764d3334e668090038a1f0d595410b7a983bd392e5cc3aa8f1b","deltaEmpty":true,"allocationExact":true,"boundaryExact":true},"wrapRotationToExistingOrigin":79,"eastAndWestOldTripointsExact":true,"peers":{"UZB":{"deltaContact":null,"intersectionExact":true,"boundaryExact":true,"retainedCommonAnchor":null},"CHN":{"deltaContact":{"type":"Point","coordinates":[74.88986200000005,37.23408990000007]},"intersectionExact":true,"boundaryExact":true,"retainedCommonAnchor":true},"KGZ":{"deltaContact":null,"intersectionExact":true,"boundaryExact":true,"retainedCommonAnchor":null},"PAK":{"deltaContact":null,"intersectionExact":true,"boundaryExact":true,"retainedCommonAnchor":null},"IND":{"deltaContact":null,"intersectionExact":true,"boundaryExact":true,"retainedCommonAnchor":null},"KAS":{"deltaContact":null,"intersectionExact":true,"boundaryExact":true,"retainedCommonAnchor":null}}};
test('TJK/AFG requires literal zero coverage loss, unchanged protection and the exact third-country point',()=>{
 assert.equal(assertAfgTjkTopology(structuredClone(synthetic)),true);
 for(const mutate of [p=>p.newOverlapKm2=1e-20,p=>p.lossIsEmpty=false,p=>p.protected.deltaEmpty=false,p=>p.peers.CHN.deltaContact=null,p=>p.fixedAFG[2]+=1,p=>p.wrapRotationToExistingOrigin=78,p=>p.eastAndWestOldTripointsExact=false,p=>delete p.peers.KAS,p=>p.peers.UZB.boundaryExact=false,p=>p.peers.CHE={},p=>p.baseData='a'.repeat(40)]) {
  const p=structuredClone(synthetic);mutate(p);assert.throws(()=>assertAfgTjkTopology(p),/TJK\/AFG/);
 }
});
test('only dedicated current TJK is selected, stale or missing data pin fails before an archive read',()=>{
 const v={validTo:null,modernBoundarySupplement:{adoptionMode:afgTjkSeamMethod}};
 const e={entityId:'state:TJK',geometryVersions:[v]};
 assert.equal(hasAfgTjkSeam(e),true);
 assert.equal(hasAfgTjkSeam({entityId:'state:AFG',geometryVersions:[v]}),false);
 assert.equal(hasAfgTjkSeam({entityId:'state:TJK',geometryVersions:[{...v,validTo:'2000-01-01'}]}),false);
 const prefixes=["assets/data/territorial-entities/source/countries/state-TJK.json","assets/data/territorial-entities/source/geometries/sha256-5a10179f2a61430ca473f71ea4dc41bab4ce2b4a4455a8b52ef04014b2d82666.json"];let reads=0;
 const readEvidence=()=>{reads++;throw Error('unexpected archive read');};
 for(const sourceDataRevision of [undefined,'0'.repeat(40)])assert.throws(()=>assertAfgTjkSeam(e,e,{prefixes,sourceDataRevision,readEvidence}),/TJK\/AFG/);
 assert.equal(reads,0);
});