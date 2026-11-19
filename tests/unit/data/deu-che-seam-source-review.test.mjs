import test from 'node:test';
import assert from 'node:assert/strict';
import {assertDeuCheTopology,assertHistoricalDeuUnchanged,assertPriorDeuPoints,hasDeuCheSeam,deuCheSeamMethod} from '../../../tools/gis/deu-che-seam-source-review.mjs';
const peers=Object.fromEntries(['AUT','BEL','CZE','DNK','FRA','LUX','NLD','POL'].map(c=>[c,{boundaryEqual:true,intersectionEqual:true,deltaType:null}]));
const p={data:'pin',pair:'FF2F11212',newOverlap:0,loss:0,valid:true,maskDeltaEmpty:true,maskInsideEqual:true,priorArcCount:1055,priorInsertedVertices:66342,peers};
test('enforces exact geometric validity, topology and fixed old mask',()=>{
 assert.doesNotThrow(()=>assertDeuCheTopology(p,'pin'));
 for(const k of ['newOverlap','loss','maskDeltaEmpty','maskInsideEqual','priorArcCount','priorInsertedVertices'])assert.throws(()=>assertDeuCheTopology({...p,[k]:-1},'pin'),/topology/);
});
test('rejects changed third-party boundaries and policy peers',()=>{
 assert.throws(()=>assertDeuCheTopology({...p,peers:{...peers,LUX:{...peers.LUX,deltaType:'Point'}}},'pin'),/topology/);
 assert.throws(()=>assertDeuCheTopology({...p,peers:{...peers,FRA:{...peers.FRA,boundaryEqual:false}}},'pin'),/topology/);
 assert.throws(()=>assertPriorDeuPoints({}, {}, {}, {arcCount:1055,addedOriginalVertices:66342,arcs:[]},[]),/1,055/);
});
test('ordinary German/Italian protected batch remains on existing unchanged route',()=>{
 const o=(entityId,adoptionMode)=>({entityId,geometryVersions:[{validTo:null,modernBoundarySupplement:{adoptionMode}}]});
 assert(hasDeuCheSeam(o('state:DEU',deuCheSeamMethod)));assert(!hasDeuCheSeam(o('state:CHE',deuCheSeamMethod)));
 assert(!hasDeuCheSeam(o('state:DEU','exact-original-arcs-outside-fixed-policy-zone')));
});

test('rejects modified or missing incumbent historical marker and geometry',()=>{
 const a={geometryVersions:[{validTo:'1870-12-31',geometry:[1]},{validTo:'1918-11-08',historicalPairedCoastInsertion:{review:'fixed'},geometry:[2]},{validTo:null}]};
 assert.doesNotThrow(()=>assertHistoricalDeuUnchanged(structuredClone(a),a));
 assert.throws(()=>assertHistoricalDeuUnchanged(undefined,a),/historical/);
 const b=structuredClone(a);b.geometryVersions[0].geometry[0]=0;
 const c=structuredClone(a);delete c.geometryVersions[1].historicalPairedCoastInsertion;
 assert.throws(()=>assertHistoricalDeuUnchanged(b,a),/historical/);assert.throws(()=>assertHistoricalDeuUnchanged(c,a),/historical/);
});