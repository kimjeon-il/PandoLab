import test from 'node:test';
import assert from 'node:assert/strict';
import {buildGlobeSpatialIndex} from '../../../src/rendering/globe-spatial-partition.js';
import { combineGlobeCountryMeshes } from '../../../scripts/lib/globe-preview-assets.mjs';
import { createGlobeCamera } from '../../../src/rendering/globe-camera.js';
import { decodeGlobeMesh } from '../../../src/rendering/globe-mesh.js';
import {globeRayIntersectsBounds,createGlobePacketIndex,pickGlobeSlotsCooperative} from '../../../src/rendering/globe-picking.js';
import { createObjectPicking } from '../../../src/map/object-picking.js';
import { normalizeObjectRef } from '../../../src/document/object-ref-identity.js';

test('picking returns overlapping visible slots, excludes the far side and skips a hidden slot', async () => {
  const row = (id, lon) => ({ id, geometry: { id, version: 1 },
    vertices: Float64Array.of(lon - 1, -1, lon + 1, -1, lon, 1), indices: Uint32Array.of(0, 1, 2) });
  const { buffer } = combineGlobeCountryMeshes([row('first', 179.9), row('second', 179.9), row('far', 0)]);
  const mesh = decodeGlobeMesh(buffer);
  const grid=buildGlobeSpatialIndex(mesh);
  const camera = createGlobeCamera({ center: [179.9, 0], zoom: 3 }, { width: 800, height: 600 });
  assert.deepEqual(await pickGlobeSlotsCooperative(mesh, grid, camera.worldRay([400, 300])), [1, 0]);
  assert.deepEqual(await pickGlobeSlotsCooperative(mesh, grid, camera.worldRay([400, 300]), slot => slot !== 1), [0]);
  assert.deepEqual(await pickGlobeSlotsCooperative(mesh, grid, camera.worldRay([0, 0])), []);
});

test('the overlapping-object chooser publishes temporary candidates and clears them on close', async t => {
  const originalDocument=globalThis.document;
  globalThis.document={createElement:()=>({dataset:{},setAttribute(){},append(){}})};
  t.after(()=>{globalThis.document=originalDocument;});
  const chooser={classList:{add(){},remove(){}},removeAttribute(){}};
  const elements={objectChooser:chooser,objectChooserList:{replaceChildren(){}}};
  const refs=['one','two'].map(id=>normalizeObjectRef({domain:'territorial',type:'entity',id}));
  const picking=createObjectPicking();
  let invalidations=0;
  picking.connect({
    selectionServices:{normalizeObjectRef},platform:{$:id=>elements[id]},surfaces:{isMobile:()=>false},
    objectOperations:{objectRefVisible:Boolean,objectDisplayInfo:ref=>({name:ref.id})},
    mapView:{screenToGeo:()=>[0,0]},mapLayout:{viewRevision:0},
    renderScene:{OVERLAY_GROUPS:[]},projectState:{state:{}},
    territorialModel:{entityRepository:{ancestors:()=>[],get:()=>({properties:{}})}},
    domains:{projectDomain:{getGeneration:()=>0},selectionDomain:{has:()=>false}},
    rendering:{mapRenderer:{queryObjectRefs:()=>refs},selectionPerformanceMetrics:{},invalidateChooserHighlight:()=>invalidations++},
  });
  assert.equal(await picking.handleObjectSelectionAt([20,20],{sourceEvent:{}}),true);
  assert.deepEqual(picking.highlightCandidates(),refs);
  assert.equal(invalidations,1);
  picking.closeObjectChooser();
  assert.deepEqual(picking.highlightCandidates(),[]);
  assert.equal(invalidations,2);
});

test('indexed line picking finds the nearby visible river and ignores the far hemisphere', async () => {
  const {pickGlobeStrokeSlotsCooperative}=await import('../../../src/rendering/globe-picking.js');
  const {encodeGlobeStrokes}=await import('../../../scripts/lib/globe-preview-assets.mjs');
  const {decodeGlobeStrokes}=await import('../../../src/rendering/globe-mesh.js');
  const packet=decodeGlobeStrokes(encodeGlobeStrokes([179.8,0,-179.8,0,-.2,0,.2,0],null,[1,1],Uint16Array.of(3,7)));
  const grid=buildGlobeSpatialIndex(packet);
  const camera=createGlobeCamera({center:[180,0],zoom:5},{width:800,height:600});
  assert.deepEqual(await pickGlobeStrokeSlotsCooperative(packet,grid,camera,[400,303]),[3]);
  assert.deepEqual(await pickGlobeStrokeSlotsCooperative(packet,grid,camera,[400,325]),[]);
});

test('packet hierarchy excludes disjoint packet bounds and preserves exact ray hits', async () => {
  const row=(id,lon)=>({id,geometry:{id,version:1},
    vertices:Float64Array.of(lon-1,-1,lon+1,-1,lon,1),indices:Uint32Array.of(0,1,2)});
  const near=decodeGlobeMesh(combineGlobeCountryMeshes([row('near',179.9)]).buffer);
  const far=decodeGlobeMesh(combineGlobeCountryMeshes([row('far',0)]).buffer);
  const camera=createGlobeCamera({center:[179.9,0],zoom:5},{width:800,height:600});
  const ray=camera.worldRay([400,300]);
  const nearIndex=buildGlobeSpatialIndex(near),farIndex=buildGlobeSpatialIndex(far);
  const index=createGlobePacketIndex([{mesh:near,index:nearIndex},{mesh:far,index:farIndex}],row=>row.index.rootBounds);
  const matches=index.query(bounds=>globeRayIntersectsBounds(ray,bounds));
  assert.equal(matches.length,1);assert.equal(matches[0].mesh,near);
  assert.deepEqual(await pickGlobeSlotsCooperative(near,nearIndex,ray),[0]);
});


test('cooperative picking yields to input and cancels a superseded query',async()=>{
 const {createGlobePickBudget,pickGlobeSlotsCooperative}=await import('../../../src/rendering/globe-picking.js');
 const row={id:'near',geometry:{id:'near',version:1},vertices:Float64Array.of(-1,-1,1,-1,0,1),indices:Uint32Array.of(0,1,2)};
 const mesh=decodeGlobeMesh(combineGlobeCountryMeshes([row]).buffer),index=buildGlobeSpatialIndex(mesh);
 const camera=createGlobeCamera({center:[0,0],zoom:5},{width:800,height:600}),ray=camera.worldRay([400,300]);
 const controller=new AbortController();
 const budget=createGlobePickBudget({signal:controller.signal,sliceMs:0,quantum:1,yieldTask:()=>{controller.abort();return Promise.resolve();}});
 await assert.rejects(pickGlobeSlotsCooperative(mesh,index,ray,undefined,{budget}),{name:'AbortError'});
});

test('accepted-frame river picking admits Core identities and discards superseded asynchronous hits',async()=>{
 const {createGlobeObjectQuery}=await import('../../../src/rendering/globe-object-query.js');
 const {encodeGlobeStrokes}=await import('../../../scripts/lib/globe-preview-assets.mjs');
 const {decodeGlobeStrokes}=await import('../../../src/rendering/globe-mesh.js');
 const packet=decodeGlobeStrokes(encodeGlobeStrokes([-0.1,0,0.1,0],null,[1],Uint16Array.of(3)));
 const index=buildGlobeSpatialIndex(packet),camera=createGlobeCamera({center:[0,0],zoom:12},{width:800,height:600});
 const empty=createGlobePacketIndex([],()=>null);
 let sample={camera,waterIndex:empty,lakeIndex:empty,countryIndex:empty,
  riverIndex:createGlobePacketIndex([{packet,index,minZoom:5}],row=>row.index.rootBounds),
  labelHit:()=>null,lakesVisible:true,riversVisible:true,physical:{spec:{identity:'physical-fixture',riverMinZoom:3}},visibleSlots:new Set(),
  generation:1,contextRevision:0,month:'2026-11',territories:{key:'base'},viewport:{width:800,height:600},hydroVisibilityKey:'all'};
 const feature={id:'river:fixture',properties:{category:'river'},__awBounds:[-.1,0,.1,0]};
 let hold=null,started=null,completed=0,published=[];
 const query=createGlobeObjectQuery({
  getAcceptedPick:()=>sample,canPickFrame:()=>true,cancelNeighborPrefetch(){},
  startRequest:()=>new AbortController(),finishRequest(){completed++;},refs:[],
  async hydroFeaturesForSlots(slots,water){assert.deepEqual([...slots],[3]);assert.deepEqual(water,[]);return [feature];},
  isHydroFeatureVisible:()=>true,hydroFeatureById:()=>null,
  async admitHydroFeatures(rows,{isCurrent}){
   assert.deepEqual(rows,[feature]);
   if(hold){started.resolve();await hold.promise;}
   if(isCurrent())published.push(...rows.map(row=>row.id));
  },
 });
 const point=camera.projectVisibleCoordinate([0,0]);
 const refs=await query.queryObjectRefs(point,{includeLabels:false});
 assert.deepEqual(refs.map(row=>[row.domain,row.id]),[['hydro',feature.id]]);
 assert.deepEqual(published,[feature.id]);
 hold=Promise.withResolvers();started=Promise.withResolvers();
 const refreshing=query.queryObjectRefs(point,{includeLabels:false});
 await started.promise;
 sample={...sample,labelHit:()=>null,physical:{...sample.physical},riverChunks:[]};
 hold.resolve();
 assert.deepEqual((await refreshing).map(row=>row.id),[feature.id]);
 assert.deepEqual(published,[feature.id,feature.id]);
 for(const change of [
  {month:'1923-11'}, {generation:2}, {hydroVisibilityKey:'hidden'},
  {camera:createGlobeCamera({center:[1,0],zoom:12},{width:800,height:600})},
 ]){
  const accepted=sample;
  hold=Promise.withResolvers();started=Promise.withResolvers();
  const stale=query.queryObjectRefs(point,{includeLabels:false});
  const rejected=assert.rejects(stale,{name:'AbortError'});
  await started.promise;sample={...sample,...change};hold.resolve();await rejected;
  sample=accepted;
 }
 assert.deepEqual(published,[feature.id,feature.id]);assert.equal(completed,6);
});


test('hover fill coverage ignores optional margins and label or river refreshes', async () => {
  const {reconcileGlobeFillPickIndex, sameGlobeHoverScene, createGlobeObjectQuery} = await import('../../../src/rendering/globe-object-query.js');
  const {createGlobePacketIndex} = await import('../../../src/rendering/globe-picking.js');
  const row = key => ({key, mesh:{packet:{spatialBounds:[-1,-1,-1,1,1,1]}}});
  const country = row('country'), margin = row('margin');
  const required = [country], first = reconcileGlobeFillPickIndex(null, required, [country]);
  const refreshed = reconcileGlobeFillPickIndex(first, [country], [country,margin]);
  assert.equal(refreshed.index,first.index);
  const changed = reconcileGlobeFillPickIndex(first, [country,margin], [country,margin]);
  assert.notEqual(changed.index,first.index);
  const empty = createGlobePacketIndex([],()=>null), camera = createGlobeCamera({center:[0,0],zoom:5},{width:800,height:600});
  let gate = Promise.withResolvers(), started = Promise.withResolvers();
  const delayedIndex = {async queryCooperative(){started.resolve(); await gate.promise; return [];}};
  let sample = {generation:1,contextRevision:0,month:'2026-11',camera,viewport:{width:800,height:600},
    visibleSlots:new Set(),lakesVisible:true,countryIndex:empty,waterIndex:delayedIndex,lakeIndex:empty,
    riverIndex:empty,labelHit:()=>null};
  const query = createGlobeObjectQuery({getAcceptedPick:()=>sample,canPickFrame:()=>true,cancelNeighborPrefetch(){},
    startRequest:()=>new AbortController(),finishRequest(){},refs:[]});
  const original = sample, point = [400,300];
  const pending = query.queryObjectRefs(point,{includeHydro:false,includeLabels:false});
  await started.promise;
  sample = {...sample,riverIndex:changed.index,labelHit:()=>({id:'label'}),riversVisible:false,hydroVisibilityKey:'updated'};
  assert.equal(sameGlobeHoverScene(original,sample),true);
  gate.resolve(); assert.deepEqual(await pending,[]);
  gate = Promise.withResolvers(); started = Promise.withResolvers();
  const obsolete = query.queryObjectRefs(point,{includeHydro:false,includeLabels:false});
  const rejected = assert.rejects(obsolete,{name:'AbortError'});
  await started.promise;
  sample = {...sample,countryIndex:changed.index}; gate.resolve(); await rejected;
});
