import test from 'node:test';
import assert from 'node:assert/strict';
import {installManagedMapLibreFeature} from '../../../src/rendering/maplibre-feature-lifecycle.js';

function fixture(){
 const sources=new Map(),layers=new Map(),images=new Set(),events=new Map(),controls=new Set(),operations=[];
 const map={
  getStyle:()=>({version:8,sources:Object.fromEntries(sources),layers:[...layers.values()]}),
  getLayersOrder:()=>[...layers.keys()],getSource:id=>sources.get(id),getLayer:id=>layers.get(id),
  addSource(id,data){if(sources.has(id))throw new Error('source collision');sources.set(id,{data});operations.push('add:'+id);},
  addLayer(layer){if(layers.has(layer.id)||!sources.has(layer.source))throw new Error('invalid layer');layers.set(layer.id,layer);operations.push('add:'+layer.id);},
  removeLayer(id){if(!layers.delete(id))throw new Error('missing layer');operations.push('remove:'+id);},
  removeSource(id){if([...layers.values()].some(layer=>layer.source===id))throw new Error('source still used');if(!sources.delete(id))throw new Error('missing source');operations.push('remove:'+id);},
  listImages:()=>[...images],hasImage:id=>images.has(id),addImage(id){images.add(id);},removeImage:id=>images.delete(id),
  on(type,listener){const set=events.get(type)||new Set();set.add(listener);events.set(type,set);},off(type,listener){events.get(type)?.delete(listener);},
  addControl(control){controls.add(control);},removeControl(control){controls.delete(control);},
 };
 return {map,sources,layers,images,events,controls,operations};
}

test('a partially installed source, layer and image are rolled back without touching existing assets',()=>{
 const {map,sources,layers,images,operations}=fixture();
 map.addSource('existing',{});map.addLayer({id:'existing-layer',source:'existing'});map.addImage('existing-image');
 assert.throws(()=>installManagedMapLibreFeature(map,view=>{
  view.addSource('extension',{});view.addLayer({id:'extension-fill',source:'extension'});
  view.addImage('extension-image');throw new Error('mid-install failure');
 }),/mid-install failure/);
 assert.deepEqual([...sources.keys()],['existing']);assert.deepEqual([...layers.keys()],['existing-layer']);
 assert.deepEqual([...images],['existing-image']);
 assert.ok(operations.indexOf('remove:extension-fill')<operations.indexOf('remove:extension'));
 const installed=installManagedMapLibreFeature(map,view=>{
  view.addSource('extension',{});view.addLayer({id:'extension-fill',source:'extension'});
  return ()=>{};
 });
 installed.dispose();installed.dispose();assert.deepEqual([...sources.keys()],['existing']);
});

test('event, control, and GPU/Worker disposers run after partial failure and normal shutdown',()=>{
 const {map,events,controls}=fixture(),calls=[];const listener=()=>{},control={};
 const register=(view,scope)=>{
  scope.on('click',listener);scope.addControl(control);
  scope.track({id:'gpu-buffer'},value=>calls.push('released:'+value.id));
  view.addSource('extra',{});view.addLayer({id:'extra-layer',source:'extra'});
 };
 assert.throws(()=>installManagedMapLibreFeature(map,(view,scope)=>{register(view,scope);throw new Error('bad shader');}),/bad shader/);
 assert.equal(events.get('click')?.size,0);assert.equal(controls.size,0);
 assert.deepEqual(calls,['released:gpu-buffer']);
 const feature=installManagedMapLibreFeature(map,(view,scope)=>{register(view,scope);return ()=>{throw new Error('cleanup failure');};});
 assert.throws(()=>feature.dispose(),/cleanup failure/);
 feature.dispose();
 assert.equal(events.get('click')?.size,0);assert.equal(controls.size,0);
 assert.deepEqual(calls,['released:gpu-buffer','released:gpu-buffer']);
 assert.equal(map.getSource('extra'),undefined);assert.equal(map.getLayer('extra-layer'),undefined);
});

test('missing cleanup after partial native install still rolls back the feature',()=>{
 const {map,sources,layers}=fixture();
 assert.throws(()=>installManagedMapLibreFeature(map,view=>{view.addSource('forgotten',{});view.addLayer({id:'forgotten-layer',source:'forgotten'});}),/cleanup function/);
 assert.equal(sources.size,0);assert.equal(layers.size,0);
});

test('a control or event hook that throws after registration is also undone',()=>{
 const {map,controls,events}=fixture();
 const addControl=map.addControl;
 map.addControl=control=>{addControl(control);throw new Error('control onAdd failed');};
 assert.throws(()=>installManagedMapLibreFeature(map,(_view,scope)=>{scope.addControl({});return ()=>{};}),/control onAdd failed/);
 assert.equal(controls.size,0);
 const on=map.on;
 map.on=(type,listener)=>{on(type,listener);throw new Error('delegated listener failed');};
 assert.throws(()=>installManagedMapLibreFeature(map,(_view,scope)=>{scope.on('move',()=>{});return ()=>{};}),/delegated listener failed/);
 assert.equal(events.get('move')?.size,0);
});
