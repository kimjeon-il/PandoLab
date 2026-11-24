import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapScene} from '../../../src/rendering/map-scene.js';
import {createMapVisualFrame,isMapVisualFrame} from '../../../src/rendering/map-visual-frame.js';

test('MapLibre scene owns one set of live overlay domains without a second GPU packet lifecycle',()=>{
 const submissions=[];
 const scene=createMapScene();
 const state={stateRevision:5,layerPresentation:{overlayOrder:['distributions','objects','genericFeatures']}};
 scene.connect({projectState:{state},countries:{countryLandRevision:6},
  rendering:{mapRenderer:{setSceneDomains:domains=>submissions.push(domains)}}});
 scene.initializeSceneDomains();
 const geometry={type:'Polygon',coordinates:[[[0,0],[1,0],[0,1],[0,0]]]};
 const domain=style=>({polygons:[{key:'example',geometry,geometryRevision:'v1',style,order:10}]});
 assert.equal(scene.replaceSceneDomain('distributions',domain({color:'#123456',fillAlpha:1})),true);
 assert.equal(scene.replaceSceneDomain('distributions',domain({color:'#123456',fillAlpha:1})),false);
 assert.equal(scene.replaceSceneDomain('distributions',domain({color:'#abcdef',fillAlpha:1})),true);
 const submitted=scene.syncMapScene();
 assert.equal(submitted,submissions[0]);
 assert.equal(submitted.size,1);
 assert.equal(submitted.get('distributions').polygons[0].style.color,'#abcdef');
 assert.equal(scene.replaceSceneDomain('distributions',{polygons:[]}),true);
 assert.equal(scene.syncMapScene().get('distributions').polygons.length,0);
 assert.equal(scene.selectionGeometryRevision('x','fill'), 'x:fill:state-5:country-6');
 assert.equal(scene.sceneOrder('objects','fill'),1010);
 assert.equal(Object.hasOwn(scene,'selectionPass'),false);
 assert.equal(Object.hasOwn(scene,'renderSceneBuilder'),false);
});

test('a displayed frame carries the MapLibre camera without old GPU matrices or D3 fallback',()=>{
 const mapPoint=coord=>[coord[0]+100,coord[1]+200];
 const visiblePoint=coord=>[coord[0],coord[1]];
 const state={projection:'globe',size:{width:900,height:600},zoom:4,
  dpr:2,rotation:[2,3,0],camera:{bearing:20,pitch:10,roll:0}};
 const make=zoom=>createMapVisualFrame({frameId:7,viewRevision:4,projectGeneration:2,
  viewState:{...state,zoom},projectCoordinate:mapPoint,projectVisibleCoordinate:visiblePoint});
 const frame=make(4);
 assert.equal(isMapVisualFrame(frame),true);
 assert.equal(Object.isFrozen(frame),true);
 assert.deepEqual(frame.size,{width:900,height:600});
 assert.deepEqual(frame.projectCoordinate([1,2]),[101,202]);
 assert.equal(frame.viewState.zoom,4);
 assert.equal(frame.projectionRevision,0);
 assert.equal(frame.projectGeneration,2);
 assert.notEqual(frame.signature,make(5).signature);
 assert.equal(Object.hasOwn(frame,'rowX'),false);
 assert.equal(Object.hasOwn(frame,'projectPath'),false);
});

test('scene snapshots retain unchanged domains and rows, including after a mutable style edit',()=>{
 const scene=createMapScene();scene.connect({rendering:{mapRenderer:{setSceneDomains(){}}}});
 const geometry={type:'Point',coordinates:[1,2]},style={color:'#aaaaaa'};
 const a={key:'a',geometry,geometryRevision:'a1',style,order:10};
 const b={key:'b',geometry,geometryRevision:'b1',style:{color:'#bbbbbb'},order:10};
 scene.replaceSceneDomain('genericFeatures',{polygons:[a,b]});
 scene.replaceSceneDomain('distributions',{polygons:[b]});
 const first=scene.syncMapScene(),domain=first.get('genericFeatures'),other=first.get('distributions');
 assert.equal(scene.replaceSceneDomain('genericFeatures',{polygons:[a,b]}),false);
 assert.equal(scene.syncMapScene(),first);
 style.color='#ffffff';
 assert.equal(scene.replaceSceneDomain('genericFeatures',{polygons:[a,b]}),true);
 const next=scene.syncMapScene();
 assert.notEqual(next,first);
 assert.equal(next.get('distributions'),other);
 assert.equal(next.get('genericFeatures').polygons[1],domain.polygons[1]);
 assert.equal(domain.polygons[0].style.color,'#aaaaaa');
 assert.equal(next.get('genericFeatures').polygons[0].style.color,'#ffffff');
});
