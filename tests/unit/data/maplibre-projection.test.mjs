import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapLibreProjection,readMapLibreCamera} from '../../../src/rendering/maplibre-projection.js';
import {createMapProjection} from '../../../src/map/map-projection.js';

test('projection uses the map camera and rejects points behind the globe',()=>{
 const map={getProjection:()=>({type:'globe'}),getCanvas:()=>({clientWidth:200,clientHeight:100}),project:([lng,lat])=>({x:Math.sin(lng*Math.PI/180)*100,y:lat}),
  unproject:([x,y])=>({lng:Math.asin(x/100)*180/Math.PI,lat:y})};
 const projection=createMapLibreProjection(map);
 assert.ok(projection.projectVisibleCoordinate([30,4]));
 assert.equal(projection.projectVisibleCoordinate([150,4]),null);
 assert.deepEqual(projection.screenToGeo([50,4]).map(v=>Math.round(v)),[30,4]);
});

test('screen positions outside the globe cannot select a horizon coordinate',()=>{
 const map={getProjection:()=>({type:'globe'}),getCanvas:()=>({clientWidth:200,clientHeight:100}),project:([lng,lat])=>({x:lng,y:lat}),unproject:([x,y])=>({lng:Math.max(-90,Math.min(90,x)),lat:y})};
 const projection=createMapLibreProjection(map);
 assert.equal(projection.screenToGeo([150,4]),null);
 assert.deepEqual(projection.screenToGeo([40,4]),[40,4]);
});

test('globe coordinates outside the current canvas are not visible or selectable',()=>{
 const map={getProjection:()=>({type:'globe'}),getCanvas:()=>({clientWidth:100,clientHeight:100}),project:([x,y])=>({x,y}),unproject:([x,y])=>({lng:x,lat:y})};
 const projection=createMapLibreProjection(map);
 assert.deepEqual(projection.projectVisibleCoordinate([40,20]),[40,20]);
 assert.equal(projection.projectVisibleCoordinate([-1,20]),null);
 assert.equal(projection.projectVisibleCoordinate([101,20]),null);
 assert.equal(projection.screenToGeo([40,-1]),null);
});

test('camera snapshots derive from the globe and unsupported flat projections stay unavailable',()=>{
 const center={lng:179,lat:25};
 const map={getProjection:()=>({type:'globe'}),getCenter:()=>center,getZoom:()=>5,getBearing:()=>12,getPitch:()=>30,getRoll:()=>0,
  getCanvas:()=>({clientWidth:400,clientHeight:200}),getBounds:()=>({toArray:()=>[[170,-20],[190,60]]}),
  project:([x,y])=>({x:(x-170)*10,y:100-y}),unproject:([x,y])=>({lng:x/10+170,lat:100-y})};
 const snapshot=readMapLibreCamera(map,3),projection=createMapLibreProjection(map);
 assert.equal(snapshot.zoom,map.getZoom());assert.equal(snapshot.projection,'globe');
 assert.deepEqual(snapshot.center,[179,25]);assert.equal(Object.isFrozen(snapshot.center),true);
 assert.ok(Array.isArray(projection.geographicBounds()));
 assert.deepEqual(projection.projectVisibleCoordinate([179,25]),[90,75]);
 center.lng=10;assert.deepEqual(snapshot.center,[179,25]);
 map.getProjection=()=>({type:'mercator'});
 assert.equal(projection.geographicBounds(),null);
 assert.equal(projection.projectVisibleCoordinate([179,25]),null);
 assert.equal(projection.screenToGeo([90,75]),null);
 map.getProjection=()=>undefined;
 assert.equal(readMapLibreCamera(map,3).projection,null);
 assert.equal(projection.geographicBounds(),null);
});

test('map projection adapter reads only the live MapLibre camera without a D3 globe fallback',()=>{
 const adapter=createMapProjection({capabilities:{graticule:false}});
 adapter.connect({projectState:{state:{view:{zoom:2},size:{width:800,height:600}}}});
 adapter.initializeGraticule();
 const project=adapter.activeProjection();
 assert.equal(project([2,3]),null);
 assert.equal(project.invert([4,6]),null);
 const renderer={loaded:true,map:{getZoom:()=>5},projection:{
  projectVisibleCoordinate:point=>point.map(value=>value*2),
  screenToGeo:point=>point.map(value=>value/2),
 }};
 adapter.installMapLibreRenderer(renderer);
 assert.equal(adapter.activeProjection(),project);
 assert.deepEqual(project([2,3]),[4,6]);
 assert.deepEqual(project.invert([4,6]),[2,3]);
 assert.deepEqual(project.translate(),[400,300]);
 renderer.loaded=false;
 assert.equal(project([2,3]),null);
});
