import test from 'node:test';
import assert from 'node:assert/strict';
import {assertBirTawilLocalProof,hasEgyBrtSeam,egyBrtSeamMethod} from '../../../tools/gis/egy-brt-seam-source-review.mjs';
const east=[34.08062140000004,22.000008000000037],west=[33.17240820000006,22.000000100000022];
const protectedPeers=Object.fromEntries(['HALAIB_NATIVE','ISR','JOR','LBY','PSX','SAU','SDN'].map(c=>[c,{exactIntersectionAndSharedBoundaryUnchanged:true,deltaContact:null}]));
protectedPeers.SDN.deltaContact={type:'MultiPoint',coordinates:[west,east]};
protectedPeers.HALAIB_NATIVE.deltaContact={type:'Point',coordinates:east};
const t={newOverlapKm2:0,newPositiveArea:0,newPairDE9IM:'FF2F11212',oldLandLossSqDegrees:0,newLandGainSqDegrees:0,allOtherPolygonsUnchanged:74,archivedEgyptMedCoastArcsUnchanged:300,archivedEgyptMedCoastPositionsUnchanged:4330,archivedEgyptLibyaPositionsUnchanged:1252,protectedPeers};
test('permits exact registered anchors only with zero overlap, loss and gain',()=>{
 assert.doesNotThrow(()=>assertBirTawilLocalProof(t));
 for(const k of ['newOverlapKm2','newPositiveArea','oldLandLossSqDegrees','newLandGainSqDegrees'])assert.throws(()=>assertBirTawilLocalProof({...t,[k]:1}),/topology/);
});
test('rejects extra or missing SDN and Halaib contacts and incomplete prior proofs',()=>{
 for(const c of ['SDN','HALAIB_NATIVE'])assert.throws(()=>assertBirTawilLocalProof({...t,protectedPeers:{...protectedPeers,[c]:{...protectedPeers[c],deltaContact:null}}}),/topology/);
 for(const k of ['archivedEgyptMedCoastArcsUnchanged','archivedEgyptMedCoastPositionsUnchanged','archivedEgyptLibyaPositionsUnchanged'])assert.throws(()=>assertBirTawilLocalProof({...t,[k]:0}),/topology/);
});
test('keeps earlier Libya method and fixed territory outside this dispatcher',()=>{
 const o=(entityId,adoptionMode)=>({entityId,geometryVersions:[{validTo:null,modernBoundarySupplement:{adoptionMode}}]});
 assert(hasEgyBrtSeam(o('state:EGY',egyBrtSeamMethod)));assert(!hasEgyBrtSeam(o('state:BRT',egyBrtSeamMethod)));assert(!hasEgyBrtSeam(o('state:EGY','exact-original-egy-lby-readonly-counterpart-seam')));
});
