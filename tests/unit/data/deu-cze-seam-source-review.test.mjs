import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCzeProtectedTopology,assertHistoricalDeuUnchanged,hasDeuCzeSeam,deuCzeSeamMethod} from '../../../tools/gis/deu-cze-seam-source-review.mjs';
const raw={coordinates:Array.from({length:301},()=>[[]])};
raw.coordinates[300][0][95103]=[12,50];raw.coordinates[300][0][163811]=[13,49];
const t={baseData:'pin',wholeDE9IM:'FF2F11212',newOverlapKm2:0,coverageLossKm2:0,coverageDifferenceEmpty:true,protectedZoneDisjoint:true,protectedZoneAllocationExact:true,protectedZoneBoundaryExact:true,peerChecks:Object.fromEntries(['AUT','BEL','CHE','DNK','FRA','ITA','LIE','LUX','NLD','POL'].map(c=>[c,{completeIntersectionAndBoundaryExact:true,deltaContact:c==='AUT'?{type:'Point',coordinates:[13,49]}:null}]))};
test('strict zero overlap/loss and exact mask allocation, and only original anchoring',()=>{
 assert.doesNotThrow(()=>assertCzeProtectedTopology(t,'pin',raw));
 for(const k of ['coverageDifferenceEmpty','protectedZoneBoundaryExact','protectedZoneAllocationExact','protectedZoneDisjoint'])assert.throws(()=>assertCzeProtectedTopology({...t,[k]:false},'pin',raw),/coverage/);
 for(const c of ['AUT','FRA'])assert.throws(()=>assertCzeProtectedTopology({...t,peerChecks:{...t.peerChecks,[c]:{...t.peerChecks[c],deltaContact:{type:'Point',coordinates:[9,47]}}}},'pin',raw),/contact/);
});
test('preserves earlier historical descriptors and current admission classifiers',()=>{
 const a={geometryVersions:[{validTo:'1870-12-31',geometry:[1]},{validTo:'1918-11-08',geometry:[2]},{validTo:null}]};
 assert.doesNotThrow(()=>assertHistoricalDeuUnchanged(structuredClone(a),a));
 const b=structuredClone(a);b.geometryVersions[0].geometry[0]=0;assert.throws(()=>assertHistoricalDeuUnchanged(b,a),/historical/);
 const e=(entityId,adoptionMode)=>({entityId,geometryVersions:[{validTo:null,modernBoundarySupplement:{adoptionMode}}]});
 assert(hasDeuCzeSeam(e('state:DEU',deuCzeSeamMethod)));
 for(const k of ['exact-original-arcs-outside-fixed-policy-zone','exact-original-deu-che-readonly-counterpart-seam','exact-original-deu-aut-readonly-counterpart-seam'])assert(!hasDeuCzeSeam(e('state:DEU',k)));
});
