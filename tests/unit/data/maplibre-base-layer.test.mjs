import test from 'node:test';
import assert from 'node:assert/strict';
import {syncMapLibreBaseLayer} from '../../../src/rendering/maplibre-base-layer.js';
import {createViewerInitialMapSkeleton} from '../../../src/app/viewer-initial-map-skeleton.js';

function mockMap(){
 const sources=new Map(),layers=new Map([['territories',{id:'territories',type:'fill',source:'territories'}]]),calls=[];
 return {sources,layers,calls,getSource:id=>sources.get(id),getLayer:id=>layers.get(id),
  addSource(id,source){assert.equal(sources.has(id),false);sources.set(id,source);calls.push(['source',id]);},
  addLayer(layer,before){assert.equal(before,'territories');assert.equal(layers.has(layer.id),false);layers.set(layer.id,layer);calls.push(['layer',layer.id]);},
 };
}
const style={paint:{'physical-land-fill':{'fill-color':'#f1f1f1','fill-antialias':true}}};
test('one immutable canonical vector base with stable physical-land ownership',()=>{
 const map=mockMap(),geometry={type:'MultiPolygon',coordinates:[[[[-10,-10],[10,-10],[10,10],[-10,10],[-10,-10]]]]};
 assert.equal(syncMapLibreBaseLayer(map,{style,landGeometry:geometry}),true);
 assert.deepEqual(map.calls,[['source','physical-land'],['layer','physical-land-fill']]);
 assert.equal(map.getSource('physical-land').type,'geojson');
 assert.deepEqual(map.getSource('physical-land').data.features[0].geometry,geometry);
 assert.equal(map.getLayer('physical-land-fill').type,'fill');
 assert.equal(map.getLayer('physical-land-fill').source,'physical-land');
 const source=map.getSource('physical-land'),count=map.calls.length;
 assert.equal(syncMapLibreBaseLayer(map,{style,landGeometry:{type:'Polygon',coordinates:[]}}),false);
 assert.equal(map.calls.length,count);
 assert.equal(map.getSource('physical-land'),source);
});
test('existing canonical land remains stable and source ownership is required',()=>{
 const map=mockMap();
 map.sources.set('physical-land',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
 assert.equal(syncMapLibreBaseLayer(map,{style}),true);
 assert.equal(syncMapLibreBaseLayer(map,{style}),false);
 map.layers.get('physical-land-fill').source='incorrect';
 assert.throws(()=>syncMapLibreBaseLayer(map,{style}),/Incorrect canonical land owner/);
});
test('initial publication waits for the admitted canonical frame, not optional tiles',()=>{
 let ready=false,loading=true;
 const renderer={getStats:()=>({mapReadiness:{mapReady:ready}}),map:{areTilesLoaded(){assert.fail('Optional tiles cannot gate canonical publication');}}};
 const skeleton=createViewerInitialMapSkeleton({setLoading:value=>{loading=value;},readRenderer:()=>renderer});
 assert.equal(skeleton.onFirstMapPresented(),false);assert.equal(loading,true);
 ready=true;assert.equal(skeleton.reconsider(),true);assert.equal(loading,false);
});
