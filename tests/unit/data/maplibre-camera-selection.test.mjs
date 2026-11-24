import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapLibreCamera} from '../../../src/rendering/maplibre-camera-controller.js';
import {createMapLibrePicking} from '../../../src/rendering/maplibre-picking-controller.js';
import {createMapLibreSelection} from '../../../src/rendering/maplibre-selection-controller.js';
import {normalizeObjectRef} from '../../../src/document/object-ref-identity.js';

test('camera controller owns movement listeners, presented zoom and viewport fitting',()=>{
 let zoom=2,min=0,pan=null;
 const center={lng:0,lat:0,toArray(){return [this.lng,this.lat];},wrap(){return this;}};
 const listeners=new Map(),moves=[],fits=[];
 const map={getCenter:()=>center,getZoom:()=>zoom,getMinZoom:()=>min,getMaxZoom:()=>22,setMinZoom:value=>{min=value;},
  getBearing:()=>0,getPitch:()=>0,getRoll:()=>0,getProjection:()=>({type:'globe'}),
  getCanvas:()=>({clientWidth:800,clientHeight:600,width:800,height:600}),
  cameraForBounds:(bounds,options)=>{fits.push({bounds,options});return {center,zoom:2};},
  jumpTo:target=>{zoom=target.zoom;listeners.get('move')?.({});},
  on:(name,fn)=>listeners.set(name,fn),off:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);},
  panBy:delta=>{pan=delta;},resize(){}};
 const camera=createMapLibreCamera({getMap:()=>map,isLoaded:()=>true,
  getProjection:()=>({projectVisibleCoordinate:()=>[0,0]}),getView:()=>({globeRotation:[0,0],zoom:2}),
  readSafeInsets:()=>({}),onMove:move=>moves.push(move)});
 camera.captureNativeMinZoom();
 camera.refreshWorldFit();
 camera.attachMovement();
 camera.markPresented();
 camera.jumpCamera({center:[0,0],zoom:5});
 assert.equal(moves[0].largeJump,true);
 assert.equal(moves[0].hasPresented,true);
 assert.equal(moves[0].farFromPresented,true);
 camera.panBy(3,-2);
 assert.deepEqual(pan,[-3,2]);
 camera.fitGeometry({type:'LineString',coordinates:[[1,2],[3,4]]},{left:50});
 assert.deepEqual(fits.at(-1).bounds,[[1,2],[3,4]]);
 assert.equal(fits.at(-1).options.padding.left,50);
 assert.equal(camera.cameraSnapshot().zoom,2);
 camera.dispose();
 assert.equal(listeners.size,0);
});

test('picking uses required native layers and injected polar visibility queries',()=>{
 const country=normalizeObjectRef({domain:'territorial',type:'entity',id:'A'});
 const lake=normalizeObjectRef({domain:'hydro',type:'lake',id:'L'});
 const river=normalizeObjectRef({domain:'hydro',type:'river',id:'R'});
 let polar=false;
 const geometry={type:'Polygon',coordinates:[[[-1,85],[1,85],[1,87],[-1,85]]]};
 const picker=createMapLibrePicking({
  getMap:()=>({getZoom:()=>5,queryRenderedFeatures:(_point,{layers})=>{
   assert.deepEqual(layers,['territories']);return [{source:'territories',properties:{objectKey:country.key}}];}}),
  getProjection:()=>({screenToGeo:()=>polar?[0,86]:[0,0],projectVisibleCoordinate:()=>[0,0]}),
  getTerritories:()=>[],getHydroFeatures:()=>[{id:'L',geometry,properties:{physical_water:true,category:'lake'}}],
  getPolarLines:()=>[{ref:river,geometry:{type:'LineString',coordinates:[[0,85],[0,87]]},displayMinZoom:0,width:2,packFeatureId:null}],
  getVectorRole:()=>undefined,ownsHighlight:()=>false,canPick:()=>true,canPickHydro:()=>true,
  objectRefVisible:()=>true,containsGeometry:()=>true,isHydroFeatureVisible:()=>true,
  mapSourceLayers:()=>[{id:'territories',source:'territories',visible:true,minzoom:0,maxzoom:Infinity}],
  sourceLayer:id=>id,datedSources:{active:kind=>kind},requiredSource:()=>true,objectKeyRef:()=>country});
 assert.deepEqual(picker.queryObjectRefs([0,0]),[country]);
 polar=true;
 assert.deepEqual(picker.queryObjectRefs([0,0]).map(ref=>ref.key),[lake.key,river.key]);
 picker.reset();
});

test('selection owner queues style-blocked updates and suppresses hover during temporal admission',()=>{
 const country=normalizeObjectRef({domain:'territorial',type:'entity',id:'A'});
 const river=normalizeObjectRef({domain:'hydro',type:'river',id:'R'});
 let styleReady=false,suppressHover=false,resets=0,disposed=false;
 const submissions=[];
 const owner=createMapLibreSelection({getMap:()=>({}),state:{},styleReady:()=>styleReady,
  ensurePolar:()=>({prepareHighlights(){},clearHighlights(){}}),setData(){},orderSceneLayers(){},
  metrics:{record(){}},invalidate(){},feedback:{reportOperationError(){}},
  suppressHover:()=>suppressHover,objectRefVisible:()=>true,
  getTerritory:()=>({geometry:{type:'Point',coordinates:[1,2]}}),
  getHydroFeature:()=>({geometry:{type:'Point',coordinates:[2,3]}}),
  getInteractionStyle:()=>null,rgba:()=>[],pickingPorts:{},
  createHighlight:()=>({submit:(...args)=>submissions.push(args),reset(){resets++;},
   hasHover:()=>true,dispose(){disposed=true;}})});
 const snapshot={selection:{items:[country],primaryKey:country.key},hover:river};
 owner.setSelection(snapshot);
 assert.equal(submissions.length,0);
 styleReady=true;owner.flushPending();
 assert.equal(submissions[0][1].length,2);
 suppressHover=true;owner.onTemporalAdmission();
 assert.equal(submissions.at(-1)[1].length,1);
 assert.equal(resets,1);
 assert.equal(owner.snapshot,snapshot);
 owner.dispose();
 assert.equal(disposed,true);
});
