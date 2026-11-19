import test from 'node:test';
import assert from 'node:assert/strict';
import {createExternalBasemap,mergeExternalBasemapStyle} from '../../../src/rendering/maplibre-external-style.js';

test('external basemap stays beneath historical overlays and retains their source definitions',()=>{
 const prior={version:8,projection:{type:'globe'},sources:{territories:{type:'geojson',data:{type:'FeatureCollection',features:[]}}},layers:[{id:'ocean',type:'background'},{id:'map-base',type:'background'},{id:'territories',type:'fill',source:'territories'}]};
 const external={version:8,sources:{external:{type:'raster',tiles:['https://example.test/{z}/{x}/{y}.png'],tileSize:256}},layers:[{id:'external',type:'raster',source:'external'}]};
 const merged=mergeExternalBasemapStyle(prior,external);
 assert.deepEqual(merged.layers.map(layer=>layer.id),['ocean','map-base','external','territories']);
 assert.equal(merged.sources.territories,prior.sources.territories);assert.deepEqual(merged.projection,{type:'globe'});
 assert.throws(()=>mergeExternalBasemapStyle(prior,{...external,sources:{territories:external.sources.external}}),/collision/i);
});

test('cancelling a pending GeoJSON snapshot releases the installation',async()=>{
 let dataReady=false;const handlers=new Map();
 const map={style:{},getStyle:()=>({version:8,sources:{territories:{type:'geojson',data:{type:'FeatureCollection',features:[]}}},layers:[{id:'territories',type:'fill',source:'territories'}]}),getSource:()=>({getData:()=>dataReady?Promise.resolve({type:'FeatureCollection',features:[]}):new Promise(()=>{})}),getLayer:id=>id==='territories'?{}:null,on:(type,handler)=>handlers.set(type,handler),off:type=>handlers.delete(type),setStyle(){},triggerRepaint(){queueMicrotask(()=>handlers.get('render')?.());}};
 const owner=createExternalBasemap(map),external={version:8,sources:{},layers:[]};
 const pending=owner.install(external);await Promise.resolve();await owner.cancelPending();
 await assert.rejects(Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(new Error('snapshot cancellation timed out')),100))]),{name:'AbortError'});
 dataReady=true;const remove=await owner.install(external);assert.equal(typeof remove,'function');owner.dispose();
});
