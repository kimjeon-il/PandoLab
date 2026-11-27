import test from 'node:test';
import assert from 'node:assert/strict';
import {assertHistoricalSourceStorageChanges} from '../../../tools/gis/historical-display-review.mjs';

// Each registered scope must reject a changed geometry without its own immutable witness.
// Keep the exact dated scope, original marker, mutation, and diagnostic for every case.
const cases = [
  {
    name:'the fixed Ryukyu scope cannot be stored without its archived original witness',
    entityId:'state:JPN',versionId:'state:JPN:natural-earth-5.1.1',validFrom:null,
    ring:[[125,25],[125.1,25],[125.1,25.1],[125,25]],
    supplement:{adoptionMode:'fixed-existing-approved-JPN-scope-restoration'},
    marker:'exact-jpn-current-ryukyu-original-islands-preserving-fixed-scope',
    added:[125.04,25.01],error:/JPN Ryukyu original: fixed archived proof required/,
  },
  {
    name:'the registered southwest Korea scope requires the exact archived island proof',
    entityId:'state:KOR',versionId:'state:KOR:armistice-1953',validFrom:'1953-07-27',
    ring:[[125.8,34.3],[125.9,34.3],[125.9,34.4],[125.8,34.3]],
    supplement:{adoptionMode:'exact-original-retained-coast-arcs-current-batch'},
    marker:'exact-kor-current-southwest-original-islands',
    added:[125.85,34.31],error:/KOR southwest islands: fixed archived proof required/,
  },
  {
    name:'current PRK offshore island replacement requires its immutable source evidence',
    entityId:'state:PRK',versionId:'state:PRK:sino-korean-protocol-1964',validFrom:'1964-03-20',
    ring:[[125,39],[125.1,39],[125.1,39.1],[125,39]],
    marker:'exact-prk-current-offshore-original-islands',
    added:[125.04,39.01],error:/PRK offshore islands: fixed archived evidence required/,
  },
  {
    name:'only immutable local evidence can admit the South Sudan paired-border update',
    entityId:'state:SDS',versionId:'state:SDS:2011-07-09-independence-r1',validFrom:'2011-07-09',
    ring:[[25,4],[26,4],[26,5],[25,4]],
    supplement:{scope:'preserve'},
    marker:'exact-sds-current-western-paired-original-arcs',
    added:[25.5,4.1],error:/SDS paired arcs: fixed archived evidence required/,
  },
];

for (const {name,entityId,versionId,validFrom,ring,supplement,marker,added,error} of cases) test(name,()=>{
  const before={entityId,geometryVersions:[{versionId,validFrom,validTo:null,
    geometry:{type:'MultiPolygon',coordinates:[[structuredClone(ring)]]},
    ...(supplement?{modernBoundarySupplement:structuredClone(supplement)}:{})}]};
  const next=structuredClone(before),version=next.geometryVersions[0];
  version.modernBoundarySupplement={...version.modernBoundarySupplement,adoptionMode:marker};
  version.geometry.coordinates[0][0].splice(1,0,added);
  assert.throws(()=>assertHistoricalSourceStorageChanges(next,before,{prefixes:[],readEvidence:()=>null}),error);
});
