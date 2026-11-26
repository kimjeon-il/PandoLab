import test from 'node:test';
import assert from 'node:assert/strict';
import {createGlobeCamera, globeVector} from '../../../src/rendering/globe-camera.js';
import {createGlobeViewerInput} from '../../../src/map/globe-viewer-input.js';

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
    {key:'small',coordinate:[0,0],area:.0002,shortSide:2,width:90,height:45},
    {key:'large',coordinate:[0,0],area:.013,shortSide:30,width:90,height:45},
    {key:'behind',coordinate:[180,0],area:.027,shortSide:30,width:90,height:45},
    {key:'clear',coordinate:[8,0],area:.0002,shortSide:2,width:90,height:45},
    {key:'competing city',place:true,coordinate:[0,0],priority:1000,width:110,height:45},
    {key:'city',place:true,coordinate:[-8,0],priority:500,width:110,height:45},
  ];
  const placed=placeGlobeLabels(orderGlobeLabels(candidates),camera,viewport,new Set());
  assert.deepEqual(placed.map(row=>row.key),['large','clear','city']);
  assert.ok(placed[0].bottom-placed[0].top>placed[1].bottom-placed[1].top);
  assert.equal(placed[0].bottom-placed[0].top,22.5,'large territory labels at zoom 4 use the 28px type size');
  assert.ok(Math.abs(placed[2].bottom-placed[2].top-45*12/56)<1e-9);
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

test('label collision grid keeps the retained gap rule across cell boundaries', async () => {
  const {placeGlobeLabels}=await import('../../../src/rendering/three-globe-labels.js');
  const camera={view:{zoom:4},frame:{eye:[2,2,0]},projectVisibleCoordinate:([x])=>[x,64]};
  const base={place:true,width:56,height:56};
  const candidates=[
    {...base,key:'first',coordinate:[57,0]},
    {...base,key:'overlap-gap',coordinate:[70,0]},
    {...base,key:'clear',coordinate:[90,0]},
  ];
  const ordinary=placeGlobeLabels(candidates,camera,{width:128,height:128},new Set());
  assert.deepEqual(ordinary.map(row=>row.key),['first','clear']);
  const retained=placeGlobeLabels(candidates,camera,{width:128,height:128},new Set(['overlap-gap']));
  assert.deepEqual(retained.map(row=>row.key),['first','overlap-gap','clear']);
});

test('atlas compaction repacks live runs without mixing place and country pages', async () => {
  const {planGlobeAtlasPages}=await import('../../../src/rendering/three-globe-labels.js');
  const run=(place,width,height)=>({page:{place},width,height});
  const plan=planGlobeAtlasPages([run(false,40,32),run(false,24,32),run(true,64,32)],64);
  assert.equal(plan.length,2);
  assert.deepEqual(plan[0].placements.map(row=>[row.x,row.y]),[[0,0],[40,0]]);
  assert.equal(plan[1].place,true);
  assert.equal(planGlobeAtlasPages([run(false,65,20)],64),null);
});

test('range culling preserves visible date-line and polar bounds and stroke padding', async () => {
  const {createGlobeRangeCuller}=await import('../../../src/rendering/globe-spatial-partition.js');
  const pointBounds=coordinate=>{const v=globeVector(coordinate);return [...v,...v];};
  const viewport={width:800,height:600};
  const dateLine=createGlobeCamera({center:[179.9,0],zoom:5},viewport);
  const visible=createGlobeRangeCuller(dateLine.frame,800,600);
  assert.equal(visible(pointBounds([-179.9,0])),true);
  assert.equal(visible(pointBounds([0,0])),false);
  const polar=createGlobeCamera({center:[0,89.9],zoom:5},viewport);
  assert.equal(createGlobeRangeCuller(polar.frame,800,600)(pointBounds([180,89.9])),true);
  const frame={eye:[2,0,0],right:[0,1,0],up:[0,0,1],forward:[-1,0,0],focal:100,center:[50,50]};
  const edge=[1,.55,0,1,.55,0];
  assert.equal(createGlobeRangeCuller(frame,100,100)(edge),false);
  assert.equal(createGlobeRangeCuller(frame,100,100,6)(edge),true);
  // A large triangle/chord can cross the viewport even when its vertices
  // fall outside. The conservative bound must survive.
  assert.equal(createGlobeRangeCuller(frame,100,100)([.8,-.8,-.1,1,.8,.1]),true);
});


test('label spatial selection preserves priority across the date line and defers off-screen measurements',async()=>{
  const {createGlobeLabelSpatialIndex,orderGlobeLabels,placeGlobeLabels}=await import('../../../src/rendering/three-globe-labels.js');
  const {createGlobeRangeCuller}=await import('../../../src/rendering/globe-spatial-partition.js');
  const camera=createGlobeCamera({center:[179.9,0],zoom:5},viewport);
  const rows=orderGlobeLabels([
    {key:'near-city',place:true,priority:10,coordinate:[-179.9,0]},
    {key:'far-country',area:.01,shortSide:30,coordinate:[0,0]},
    {key:'hidden',area:.1,shortSide:30,coordinate:[179.9,0],visible:false},
    {key:'near-country',area:.01,shortSide:30,coordinate:[179.9,0]},
  ]);
  const index=createGlobeLabelSpatialIndex(rows),visible=index.query(createGlobeRangeCuller(camera.frame,viewport.width,viewport.height));
  assert.deepEqual(visible.map(row=>row.key),['near-country','near-city']);
  assert.ok(visible.every(row=>Array.isArray(row.vector)));
  const measured=[];
  placeGlobeLabels(visible,camera,viewport,new Set(),null,row=>{measured.push(row.key);return {width:56,height:56};});
  assert.ok(measured.includes('near-country'));assert.ok(!measured.includes('far-country'));assert.ok(!measured.includes('hidden'));
});

test('label dirty rectangles merge adjacent updates and dynamic batches shrink without losing rows',async()=>{
  const {mergeLabelTextureRects,labelInstanceCapacity}=await import('../../../src/rendering/three-globe-labels.js');
  assert.deepEqual(mergeLabelTextureRects([
    {x:0,y:4,width:2,height:1},{x:0,y:5,width:2,height:2},{x:20,y:30,width:10,height:10},
  ]),[{x:0,y:4,width:2,height:3},{x:20,y:30,width:10,height:10}]);
  assert.equal(labelInstanceCapacity(0,5,2048),16);
  assert.equal(labelInstanceCapacity(1024,350,2048),1024);
  assert.equal(labelInstanceCapacity(1024,200,2048),256);
  assert.equal(labelInstanceCapacity(0,1500,1500),1500);
});


test('SDF transform consumes a single-channel mask and preserves signed distances',async()=>{
 const {distanceMask}=await import('../../../src/rendering/globe-label-sdf.js');
 const mask=Uint8Array.of(0,0,0,0,255,0,0,0,0);
 const field=distanceMask(mask,3,3,7);
 assert.equal(field.length,9);
 assert.ok(field[4]>127);assert.ok(field[0]<127);
 assert.equal(field[1],field[3]);assert.equal(field[5],field[7]);
});

test('single-channel hydro upload rectangles merge only compatible changed slots',async()=>{
 const {globeHydroTextureRects}=await import('../../../src/rendering/three-globe-surface.js');
 assert.deepEqual(globeHydroTextureRects(new Set([1,2,5,6,11]),4),[
  {x:1,y:0,width:2,height:2},{x:3,y:2,width:1,height:1},
 ]);
});


test('accepted map camera state is published before temporal presentation listeners',async()=>{
 const {createMapPresentationSession}=await import('../../../src/rendering/map-presentation-session.js');
 const order=[],session=createMapPresentationSession({
  getGeneration:()=>1,getContextRevision:()=>0,isDisposed:()=>false,
  getReadiness:()=>({mapReady:true}),invalidateFrame:()=>{},prepareContentKey:()=> 'world',
  isProjectBlocked:()=>false,isRecoveryFrameAdmissible:()=>true,waitForCanonicalFrame:()=>Promise.resolve(true),
 });
 const token=session.beginTemporalViewTransition(()=>true,()=>order.push('presented'));
 await session.prepareTemporalCountrySource([]);
 session.admitTemporalViewTransition(token);
 const frame={frameId:1,projectGeneration:1};
 session.markTemporalFrame(frame);
 assert.equal(session.commitVisualFrame(frame,()=>order.push('published-camera')),true);
 assert.deepEqual(order,['published-camera','presented']);
 session.dispose();
});

test('globe gesture owner publishes one movement lifecycle for an explicit pan', () => {
  const events = [], controller = new AbortController();
  let camera = {frame:{center:[10,20]},drag(from,to){events.push(['drag',from,to]);return this;}};
  const input = createGlobeViewerInput({
    getCamera:()=>camera,getViewport:()=>viewport,setCamera:value=>{camera=value;},
    invalidate:()=>{},beforeMovement:()=>events.push('before'),
    onMovementStart:()=>events.push('start'),onMovementEnd:()=>events.push('end'),
    signal:controller.signal,
  });
  const offStart=input.subscribeInput('movestart',()=>events.push(['movestart',input.isMoving()]));
  input.subscribeInput('moveend',()=>events.push(['moveend',input.isMoving()]));
  assert.equal(input.panBy(3,-4),true);
  assert.deepEqual(events,['before',['movestart',true],'start',['drag',[10,20],[13,16]],['moveend',false],'end']);
  assert.equal(input.isMoving(),false);
  offStart();
  camera=null;
  assert.equal(input.panBy(1,1),false);
  controller.abort();
  input.dispose();
});
