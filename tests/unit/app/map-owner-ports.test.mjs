import test from 'node:test';
import assert from 'node:assert/strict';
import {connectMapOwner, mergeMapPorts} from '../../../src/app/map-owner-ports.js';

test('owner wiring selects only declared groups and reuses their live shared references', () => {
  let live = 1, connected, qualityPorts;
  const common = mergeMapPorts({
    domains: {get value() {return live;}, retained: true},
    applicationConstants: {}, modelValidation: {}, physicalConfig: {}, mapFactories: {},
    preferences: {}, projectState: {}, rendering: {}, mapLayout: {}, objectDisplay: {}, physicalResources: {},
  }, {domains: {retained: false, added: 3}});
  const registry = {...common, get unrelated() {throw Error('unrelated capability should not be materialized');}};
  const owner = {connect(ports) {connected = ports;}};
  const quality = {connect(ports) {qualityPorts = ports;}};
  assert.equal(connectMapOwner('projectSession', owner, registry), owner);
  connectMapOwner('renderQuality', quality, registry);
  assert.deepEqual(Object.keys(connected), ['domains', 'applicationConstants', 'modelValidation', 'physicalConfig', 'mapFactories', 'rendering', 'mapLayout', 'preferences', 'objectDisplay', 'physicalResources']);
  assert.equal(connected.runtimeConfiguration, undefined);
  assert.equal(connected.domains, common.domains);
  assert.equal(qualityPorts.domains, connected.domains);
  assert.equal(qualityPorts.mapFactories, connected.mapFactories);
  assert.equal(connected.domains.retained, false);
  assert.equal(connected.domains.added, 3);
  assert.equal(connected.domains.value, 1);
  live = 2;
  assert.equal(connected.domains.value, 2);
  assert.equal(Object.isFrozen(connected), true);
  assert.throws(() => connectMapOwner('projectSession', owner, {domains: {}}), /requires applicationConstants/);
  assert.throws(() => connectMapOwner('notAnOwner', owner, {}), /Unknown map owner/);
});

test('map port merging retains live accessors and combines shared definitions',()=>{
 let live=1;
 const common={group:{get value(){return live;},retained:true}};
 const merged=mergeMapPorts(common,{group:{extra:true,retained:false}});
 assert.equal(merged.group.value,1);
 assert.equal(merged.group.extra,true);
 assert.equal(merged.group.retained,false);
 live=3;assert.equal(merged.group.value,3);
 assert.equal(Object.isFrozen(merged),true);
});

test('map host initializes the real renderer once and retains the browser inspection API',async()=>{
 const {createMapHost}=await import('../../../src/ui/map-workspace-host.js');
 const oldWindow=globalThis.window,oldDocument=globalThis.document;
 const events=[],element={},state={projection:'globe',view:{globeRotation:[0,0,0],zoom:1},size:{width:800,height:600}};
 let camera = {center:[0,0],zoom:1};
 const renderer={kind:'three',loaded:true,attach:value=>events.push(['attach',value]),
  initialize:async()=>{events.push(['initialize']);return true;},getRenderPixelRatio:()=>1,
  cameraSnapshot:()=>camera,projection:{projectVisibleCoordinate:point=>point,screenToGeo:point=>point,geographicBounds:()=>null},
  syncCameraFromState:view=>{camera={center:view.center||view.globeRotation.slice(0,2).map(value=>-value),zoom:view.zoom};events.push(['sync']);},panBy:()=>true};
 globalThis.window={devicePixelRatio:1};globalThis.document={body:{dataset:{}}};
 try {
  const owner=createMapHost();
  owner.connect({platform:{$:()=>element},rendering:{mapRenderer:renderer},projectState:{state},
   mapView:{projectionLayoutMetrics:()=>({safe:{}})},domains:{renderingDomain:{invalidateView:reason=>events.push(['invalidate',reason])}}});
  owner.attachMapOutput();assert.equal(owner.mapHost.isReady(),false);
  await owner.initializeMapHost();
  assert.equal(owner.mapHost.isReady(),true);
  assert.equal(globalThis.window.__PANDOLAB_MAP_HOST__,owner.mapHost);
  assert.deepEqual(owner.mapHost.project([1,2]),[1,2]);
  owner.mapHost.setViewState({projection:'globe',view:{globeRotation:[1,2,0],zoom:3}});
  assert.deepEqual(events,[['attach',element],['initialize'],['sync'],['invalidate','host-camera']]);
  assert.equal(owner.mapHost.getViewState().zoom,3);
  assert.equal(state.view.zoom,1);
  assert.throws(()=>owner.mapHost.setViewState({projection:'flat'}));
  owner.stopMapResizeObserver();assert.equal(owner.mapHost.isReady(),false);
 } finally {globalThis.window=oldWindow;globalThis.document=oldDocument;}
});
