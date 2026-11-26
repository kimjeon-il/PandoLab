import test from 'node:test';
import assert from 'node:assert/strict';
import {MAP_OWNER_PORTS,MAP_OWNER_REQUIRED_PORTS,connectMapOwner,createReadPorts,mergeCapabilityPorts} from '../../../src/app/map-owner-ports.js';

test('one capability contract retains required and optional owner ports',()=>{
 for(const [name,allowed] of Object.entries(MAP_OWNER_PORTS)){
  assert.equal(new Set(allowed).size,allowed.length);
  for(const key of MAP_OWNER_REQUIRED_PORTS[name])assert.ok(allowed.includes(key),name+' '+key);
 }
 assert.deepEqual(MAP_OWNER_REQUIRED_PORTS.projectSession,['domains','applicationConstants','modelValidation','physicalConfig','mapFactories']);
 assert.ok(MAP_OWNER_PORTS.projectSession.includes('runtimeConfiguration'));
 assert.deepEqual(MAP_OWNER_REQUIRED_PORTS.objectPresentation,['colorModel','domains','objectDefinitions','objectPresentation','preferences','projectState','territorialModel']);
});

test('owner connection merges admitted descriptors without touching unrelated groups',()=>{
 let live=1,connected;
 const common={domains:{get value(){return live;},retained:true},applicationConstants:{},modelValidation:{},physicalConfig:{},mapFactories:{},
  get unrelated(){throw Error('unrelated capability should not be materialized');}};
 const override={domains:{retained:false,added:3}};
 const owner={connect(ports){connected=ports;}};
 assert.equal(connectMapOwner('projectSession',owner,common,override),owner);
 assert.deepEqual(Object.keys(connected),MAP_OWNER_PORTS.projectSession);
 assert.equal(connected.runtimeConfiguration,undefined);
 assert.equal(connected.domains.retained,false);
 assert.equal(connected.domains.added,3);
 assert.equal(connected.domains.value,1);
 live=2;
 assert.equal(connected.domains.value,2);
 assert.equal(Object.isFrozen(connected),true);
 assert.throws(()=>connectMapOwner('projectSession',owner,{domains:{}},{}),/requires applicationConstants/);
 assert.throws(()=>connectMapOwner('notAnOwner',owner,{}),/Unknown map owner/);
});

test('read ports support a natural field name and explicit alias with live getters',()=>{
 const providers={provider:{field:1}};
 const ports=createReadPorts(providers,{group:[['field','provider'],['renamed','provider','field']]});
 assert.equal(ports.group.field,1);
 assert.equal(ports.group.renamed,1);
 providers.provider.field=2;
 assert.equal(ports.group.field,2);
 assert.equal(ports.group.renamed,2);
 const merged=mergeCapabilityPorts(ports,{group:{extra:true}});
 assert.equal(merged.group.field,2);
 providers.provider.field=3;
 assert.equal(merged.group.renamed,3);
 assert.equal(merged.group.extra,true);
});

test('map host initializes the real renderer once and retains the browser inspection API',async()=>{
  const {createMapHost}=await import('../../../src/ui/map-workspace-host.js');
  const oldWindow=globalThis.window,oldDocument=globalThis.document;
  const events=[],element={},state={projection:'globe',view:{globeRotation:[0,0,0],zoom:1},size:{width:800,height:600}};
  const renderer={kind:'three',loaded:true,attach:value=>events.push(['attach',value]),
    initialize:async()=>{events.push(['initialize']);return true;},getRenderPixelRatio:()=>1,
    cameraSnapshot:()=>({center:[0,0],zoom:1}),projection:{projectVisibleCoordinate:point=>point,screenToGeo:point=>point,geographicBounds:()=>null},
    syncCameraFromState:()=>events.push(['sync']),panBy:()=>true};
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
    assert.equal(state.view.zoom,3);
    assert.throws(()=>owner.mapHost.setViewState({projection:'flat'}));
    owner.stopMapResizeObserver();assert.equal(owner.mapHost.isReady(),false);
  } finally {globalThis.window=oldWindow;globalThis.document=oldDocument;}
});
