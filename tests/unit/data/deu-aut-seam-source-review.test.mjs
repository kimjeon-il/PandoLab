import test from 'node:test';
import assert from 'node:assert/strict';
import {assertAutTopology,assertHistoricalDeuUnchanged,hasDeuAutSeam,deuAutSeamMethod} from '../../../tools/gis/deu-aut-seam-source-review.mjs';
const anchor=[9.561825500000054,47.50455850000003];
const p={baseData:'pin',newDE9IM:'FF2F11212',newOverlapKm2:0,coverageLossKm2:0,currentGeometryOnly:true,outsideProtectedZoneExact:true,protectedArchiveFileHashes:{'DEU-protected-zone.json':'24aea3f7acf71fbdef719e5de76e0a21888ebbe12fa5bbe9436054f755e3595d'},peerChecks:Object.fromEntries(['BEL','CHE','CZE','DNK','FRA','ITA','LIE','LUX','NLD','POL'].map(c=>[c,{boundaryExact:true,intersectionExact:true,deltaContact:c==='CHE'?{type:'Point',coordinates:anchor}:null}]))};
test('accepts only the existing exact Swiss tripoint with no loss and policy retained',()=>{
 assert.doesNotThrow(()=>assertAutTopology(p,'pin'));
 for(const k of ['newOverlapKm2','coverageLossKm2','currentGeometryOnly','outsideProtectedZoneExact'])assert.throws(()=>assertAutTopology({...p,[k]:1},'pin'),/coverage/);
 for(const c of ['CHE','FRA'])assert.throws(()=>assertAutTopology({...p,peerChecks:{...p.peerChecks,[c]:{...p.peerChecks[c],deltaContact:{type:'Point',coordinates:[9,47]}}}},'pin'),/coverage/);
});
test('preserves previous DEU historical feature marker and actual geometry',()=>{
 const a={geometryVersions:[{validTo:'1870-12-31',geometry:[1]},{validTo:'1918-11-08',historicalPairedCoastInsertion:{review:'fixed'},geometry:[2]},{validTo:null}]};
 assert.doesNotThrow(()=>assertHistoricalDeuUnchanged(structuredClone(a),a));
 const b=structuredClone(a);b.geometryVersions[0].geometry[0]=0;
 const c=structuredClone(a);delete c.geometryVersions[1].historicalPairedCoastInsertion;
 assert.throws(()=>assertHistoricalDeuUnchanged(b,a),/historical/);assert.throws(()=>assertHistoricalDeuUnchanged(c,a),/historical/);
});
test('existing Swiss and German protected methods are not sent to Austrian admission',()=>{
 const o=(entityId,adoptionMode)=>({entityId,geometryVersions:[{validTo:null,modernBoundarySupplement:{adoptionMode}}]});
 assert(hasDeuAutSeam(o('state:DEU',deuAutSeamMethod)));assert(!hasDeuAutSeam(o('state:AUT',deuAutSeamMethod)));
 for(const k of ['exact-original-arcs-outside-fixed-policy-zone','exact-original-deu-che-readonly-counterpart-seam'])assert(!hasDeuAutSeam(o('state:DEU',k)));
});
