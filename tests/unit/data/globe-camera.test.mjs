import test from 'node:test';
import assert from 'node:assert/strict';
import { createGlobeCamera } from '../../../src/rendering/globe-camera.js';

const viewport = { width: 900, height: 650 };
const view = { center: [179, 25], zoom: 2, bearing: 18, pitch: 15, roll: 2 };
const close = (actual, expected, tolerance = 1e-6) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < tolerance,
    `${value} differs from ${expected[index]}`));
};

test('a saved camera round-trips CSS coordinates across the date line and rejects the far side', () => {
  const camera = createGlobeCamera(view, viewport);
  close(camera.projectVisibleCoordinate(view.center), [450, 325]);
  const coordinate = [-176, 26];
  close(camera.screenToGeo(camera.projectVisibleCoordinate(coordinate)), coordinate);
  assert.equal(camera.projectVisibleCoordinate([-1, -25]), null);
  assert.equal(camera.screenToGeo([-1, 200]), null);
  assert.equal(camera.screenToGeo([0, 0]), null);
  assert.deepEqual(camera.view.center, view.center);
});

test('pointer-centred zoom and drag retain a geographic anchor without flipping at a pole', () => {
  const camera = createGlobeCamera({ center: [10, 75], zoom: 2 }, viewport);
  const point = [480, 345];
  const coordinate = camera.screenToGeo(point);
  const zoomed = camera.zoomAt(point, 1);
  assert.equal(zoomed.view.zoom, 3);
  close(zoomed.projectVisibleCoordinate(coordinate), point, 0.1);
  const movedPoint = [490, 330];
  const moved = zoomed.drag(point, movedPoint);
  close(moved.projectVisibleCoordinate(coordinate), movedPoint, 0.1);
  const polar = createGlobeCamera({ center: [180, 90], zoom: 2 }, viewport);
  const movedFromPole = polar.drag([450, 325], [450, 420]);
  assert.ok(Math.abs(movedFromPole.view.center[1]) <= 90);
  assert.ok(movedFromPole.view.center.every(Number.isFinite));
});

test('country labels stay in front of the globe and give larger countries priority at overlapping anchors', async () => {
  const {orderGlobeLabels,placeGlobeLabels}=await import('../../../src/rendering/three-globe-labels.js');
  const camera=createGlobeCamera({center:[0,0],zoom:4},viewport);
  const candidates=[
    {key:'small',coordinate:[0,0],area:.0002,width:90,height:45},
    {key:'large',coordinate:[0,0],area:.013,width:90,height:45},
    {key:'behind',coordinate:[180,0],area:.027,width:90,height:45},
    {key:'clear',coordinate:[8,0],area:.0002,width:90,height:45},
    {key:'competing city',place:true,coordinate:[0,0],priority:1000,width:110,height:45},
    {key:'city',place:true,coordinate:[-8,0],priority:500,width:110,height:45},
  ];
  const placed=placeGlobeLabels(orderGlobeLabels(candidates),camera,viewport,new Set());
  assert.deepEqual(placed.map(row=>row.key),['large','clear','city']);
  assert.ok(placed[0].bottom-placed[0].top>placed[1].bottom-placed[1].top);
  assert.equal((placed[0].left+placed[0].right)/2,viewport.width/2);
});

test('the viewport bounds include visible locations across the date line and stay local at city zoom', () => {
  const camera=createGlobeCamera({...view,zoom:9},viewport);
  const [west,south,east,north]=camera.geographicBounds();
  assert.ok(east-west<4&&north-south<4);
  for(let y=25;y<viewport.height;y+=100)for(let x=25;x<viewport.width;x+=100){
    const [lon,lat]=camera.screenToGeo([x,y]);
    const unwrapped=lon+360*Math.round(((west+east)/2-lon)/360);
    assert.ok(unwrapped>=west&&unwrapped<=east&&lat>=south&&lat<=north);
  }
});
