import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGlobePickGrid } from '../../../scripts/lib/globe-pick-grid.mjs';
import { combineGlobeCountryMeshes } from '../../../scripts/lib/globe-preview-assets.mjs';
import { createGlobeCamera } from '../../../src/rendering/globe-camera.js';
import { decodeGlobeMesh } from '../../../src/rendering/globe-mesh.js';
import { decodeGlobePickGrid, globePickCellBounds, globePickRayCells, pickCellsIntersectBounds, pickGlobeSlots } from '../../../src/rendering/globe-picking.js';
import { createObjectPicking } from '../../../src/map/object-picking.js';
import { normalizeObjectRef } from '../../../src/document/object-ref-identity.js';

test('picking returns overlapping visible slots, excludes the far side and skips a hidden slot', () => {
  const row = (id, lon) => ({ id, geometry: { id, version: 1 },
    vertices: Float64Array.of(lon - 1, -1, lon + 1, -1, lon, 1), indices: Uint32Array.of(0, 1, 2) });
  const { buffer } = combineGlobeCountryMeshes([row('first', 179.9), row('second', 179.9), row('far', 0)]);
  const mesh = decodeGlobeMesh(buffer);
  const grid = decodeGlobePickGrid(buildGlobePickGrid(mesh), mesh.indices.length / 3);
  const camera = createGlobeCamera({ center: [179.9, 0], zoom: 3 }, { width: 800, height: 600 });
  assert.deepEqual(pickGlobeSlots(mesh, grid, camera.worldRay([400, 300])), [1, 0]);
  assert.deepEqual(pickGlobeSlots(mesh, grid, camera.worldRay([400, 300]), slot => slot !== 1), [0]);
  assert.deepEqual(pickGlobeSlots(mesh, grid, camera.worldRay([0, 0])), []);
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
  const {buildGlobeStrokePickGrid}=await import('../../../scripts/lib/globe-pick-grid.mjs');
  const {pickGlobeStrokeSlots}=await import('../../../src/rendering/globe-picking.js');
  const {encodeGlobeStrokes}=await import('../../../scripts/lib/globe-preview-assets.mjs');
  const {decodeGlobeStrokes}=await import('../../../src/rendering/globe-mesh.js');
  const packet=decodeGlobeStrokes(encodeGlobeStrokes([179.8,0,-179.8,0,-.2,0,.2,0],null,[1,1],Uint16Array.of(3,7)));
  const grid=decodeGlobePickGrid(buildGlobeStrokePickGrid(packet),packet.count);
  const camera=createGlobeCamera({center:[180,0],zoom:5},{width:800,height:600});
  assert.deepEqual(pickGlobeStrokeSlots(packet,grid,camera,[400,303]),[3]);
  assert.deepEqual(pickGlobeStrokeSlots(packet,grid,camera,[400,325]),[]);
});

test('packet bounds use exact grid cells and a shared ray traversal preserves hits', () => {
  const row=(id,lon)=>({id,geometry:{id,version:1},
    vertices:Float64Array.of(lon-1,-1,lon+1,-1,lon,1),indices:Uint32Array.of(0,1,2)});
  const near=decodeGlobeMesh(combineGlobeCountryMeshes([row('near',179.9)]).buffer);
  const far=decodeGlobeMesh(combineGlobeCountryMeshes([row('far',0)]).buffer);
  const camera=createGlobeCamera({center:[179.9,0],zoom:5},{width:800,height:600});
  const ray=camera.worldRay([400,300]),cells=globePickRayCells(ray);
  const bounds=mesh=>globePickCellBounds([mesh.positions,mesh.residuals]);
  assert.equal(pickCellsIntersectBounds(cells,bounds(near)),true);
  assert.equal(pickCellsIntersectBounds(cells,bounds(far)),false);
  const grid=decodeGlobePickGrid(buildGlobePickGrid(near),near.indices.length/3);
  assert.deepEqual(pickGlobeSlots(near,grid,ray,undefined,{cells}),[0]);
});
