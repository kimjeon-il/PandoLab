import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreMarketOrigin,assertPreservedFinIslands,assertFinSweTopology,operations,hasFinSweSeam,finSweSeamMethod} from '../../../tools/gis/fin-swe-seam-source-review.mjs';
test('restores original cyclic ring origin and rejects missing or duplicate origin',()=>{
 const a=[0,0],b=[1,0],c=[2,0],d=[3,1],e=[4,1];
 assert.deepEqual(restoreMarketOrigin([a,b,c,d,e,a],d),[d,e,a,b,c,d]);
 assert.throws(()=>restoreMarketOrigin([a,b,c,d,e,a],b),/origin/);
 assert.throws(()=>restoreMarketOrigin([a,d,c,d,e,a],d),/origin/);
});
test('requires all previously approved islands and protects selected indexes',()=>{
 const p=[[[]]],old={coordinates:Array.from({length:3229},()=>p)};
 const r={existingALDReservedComponents:43,pairs:Array.from({length:32},(_,targetIndex)=>({targetIndex,coordinates:p}))};
 assert.doesNotThrow(()=>assertPreservedFinIslands(r,old,old));
 const changed=structuredClone(old);changed.coordinates[2]=[];
 assert.throws(()=>assertPreservedFinIslands(r,old,changed),/island/);
 assert.throws(()=>assertPreservedFinIslands({...r,pairs:r.pairs.slice(1)},old,old),/32/);
});
test('exact ALD and all disjoint neighbors required with zero overlap and no new loss',()=>{
 const peers=Object.fromEntries(['ALD','DNK','EST','LTU','LVA','NOR','POL','RUS'].map(c=>[c,{exactIntersection:true,exactShared:true,deltaDisjoint:true}]));
 const p={pin:'pin',newOverlapKm2:0,oldCoverageLossKm2:0,valid:true,aldUnchanged:true,prior32Exact:true,unchangedComponentCount:3227,operations,peers};
 const b={sourcePin:'pin'};
 assert.doesNotThrow(()=>assertFinSweTopology(p,b));
 for(const k of ['newOverlapKm2','oldCoverageLossKm2','aldUnchanged','prior32Exact'])assert.throws(()=>assertFinSweTopology({...p,[k]:1},b),/topology/);
 assert.throws(()=>assertFinSweTopology({...p,peers:{...peers,ALD:{...peers.ALD,deltaDisjoint:false}}},b),/topology/);
});
test('only explicitly selected FIN method changes this route',()=>{
 const geometryVersions=[{validTo:null,modernBoundarySupplement:{adoptionMode:finSweSeamMethod}}];
 assert(hasFinSweSeam({entityId:'state:FIN',geometryVersions}));assert(!hasFinSweSeam({entityId:'state:SWE',geometryVersions}));
 assert(!hasFinSweSeam({entityId:'state:FIN',geometryVersions:[{validTo:null,modernBoundarySupplement:{adoptionMode:'exact-fin-current-detached-islands-preserving-ald-and-paired-nordic-arcs'}}]}));
});
