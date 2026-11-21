import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapDisplayClient} from '../../../src/ui/map-display-client.js';
import {createMapDisplayPreparation} from '../../../src/rendering/map-display-preparation.js';
import {createMapContentPresentation} from '../../../src/ui/map-content-presentation.js';
import {buildTerritorialInternalBoundarySegments} from '../../../src/geometry/boundary-topology.js';

function polygon(id, entityKind, west, south, east, north, geometryKey = id) {
  return {id, type: 'Feature', geometryKey, properties: {entityKind, parentId: ''},
    geometry: {type: 'Polygon', coordinates: [[[west,south],[east,south],[east,north],[west,north],[west,south]]]}};
}

test('territorial boundaries send geometry deltas and recover their Worker snapshot', async t => {
  let worker;
  const payloads = [];
  let afterPreparation, workerCount = 0;
  const client = createMapDisplayClient({createWorker() {
    const display = createMapDisplayPreparation();
    const firstWorker = ++workerCount === 1;
    worker = {
      postMessage(message) {
        if (message.type !== 'request') return;
        payloads.push(structuredClone(message.payload));
        if (firstWorker) {
          queueMicrotask(() => this.onmessage?.({data: {...message, type: 'result', ok: false,
            error: {code: 'PL-MAP-DISPLAY-INITIALIZATION', message: 'Module could not initialize'}}}));
          return;
        }
        display.prepare(structuredClone(message.payload)).then(result => {
          const callback = afterPreparation;
          afterPreparation = null;
          callback?.();
          this.onmessage?.({data: {...message, type: 'result', ok: true, result}});
        }, error => {
          this.onmessage?.({data: {...message, type: 'result', ok: false, error: {message: error.message}}});
        });
      },
    };
    return worker;
  }});
  t.after(client.dispose);
  const west = polygon('west', 'general', 0, 0, 4, 4);
  const east = polygon('east', 'general', 4, 0, 8, 4);
  const region = polygon('region', 'regional', 2, 1, 6, 3);
  await assert.rejects(client.prepare([west, east, region]), {code: 'PL-MAP-DISPLAY-INITIALIZATION'});
  const initial = await client.prepare([west, east, region]);
  assert.ok(initial.result.segments.some(({a,b}) => a[0] < 4 && b[0] < 4));
  assert.ok(initial.result.segments.some(({a,b}) => a[0] > 4 && b[0] > 4));
  const changed = polygon('region', 'regional', 2, 1, 7, 3, 'region:2');
  const updated = await client.prepare([west, east, changed]);
  assert.deepEqual(payloads.at(-1).upserts.map(row => row.id), ['region']);
  assert.ok(updated.result.segments.some(({a,b}) => Math.abs(a[0] - 7) < 1e-9 && Math.abs(b[0] - 7) < 1e-9));

  const controller = new AbortController();
  afterPreparation = () => controller.abort();
  await assert.rejects(client.prepare([west, east, region], {signal: controller.signal}), {name: 'AbortError'});
  const staleBase = payloads.length;
  const reconciled = await client.prepare([west, east, changed]);
  assert.equal(payloads[staleBase].baseVersion, updated.result.version);
  assert.equal(payloads[staleBase + 1].baseVersion, null);
  assert.deepEqual(reconciled.result.segments, updated.result.segments);

  worker.onerror({message: 'Worker stopped'});
  const recovered = await client.prepare([west, east, region]);
  assert.equal(payloads.at(-1).baseVersion, null);
  assert.deepEqual(recovered.result.segments, initial.result.segments);

  const adjacent = polygon('adjacent', 'regional', 2, 3, 6, 4);
  const joined = await client.prepare([west, east, adjacent, region]);
  assert.deepEqual(payloads.at(-1).upserts.map(row => row.id), ['adjacent']);
  const shared = joined.result.segments.find(segment => segment.unitOwners.length === 2);
  assert.deepEqual(shared?.unitOwners.map(owner => owner.id), ['adjacent', 'region']);

  await client.prepare([west, east]);
  assert.deepEqual(payloads.at(-1).removedIds, ['adjacent', 'region']);
});

test('a regional patch rebuilds only intersecting topology and leaves cancelled patches uncommitted', async () => {
  const preparation = createMapDisplayPreparation();
  const west = polygon('west', 'general', 0, 0, 5, 5);
  const east = polygon('east', 'general', 5, 0, 10, 5);
  const first = polygon('first', 'regional', 3, 1, 6, 3);
  const shared = polygon('shared', 'regional', 3, 3, 6, 4);
  const distant = polygon('distant', 'regional', 30, 15, 31, 16);
  const seamWest = polygon('seam-west', 'general', 176, 5, 180, 10);
  const seamEast = polygon('seam-east', 'general', -180, 5, -176, 10);
  const seam = polygon('seam', 'regional', 179, 6, -179, 8);
  const seamNeighbor = polygon('seam-neighbor', 'regional', -179, 6, -178, 8);
  const rows = [west, east, seamWest, seamEast, first, distant, seam, shared, seamNeighbor];
  const reference = input => buildTerritorialInternalBoundarySegments(
    input.filter(row => row.properties.entityKind === 'general'), input.filter(row => row.properties.entityKind === 'regional'),
  );
  const entityIds = rows.map(row => row.id);
  const initial = await preparation.prepare({baseVersion: null, version: 1, entityIds, upserts: rows, removedIds: []});
  const far = initial.segments.filter(row => row.unitOwners[0].id === 'distant');
  assert.ok(far.length > 0);
  assert.ok(initial.segments.some(row => row.unitOwners.length === 2));
  assert.ok(initial.segments.some(row => row.unitOwners.map(owner => owner.id).join(',') === 'seam,seam-neighbor'));
  assert.deepEqual(initial.segments, reference(rows));

  const changed = polygon('first', 'regional', 4, 1, 7, 3, 'first:2');
  const request = {baseVersion: 1, version: 2, entityIds, upserts: [changed], removedIds: []};
  let checkpoints = 0;
  await assert.rejects(preparation.prepare(request, async () => {
    if (++checkpoints === 3) throw new DOMException('Cancelled', 'AbortError');
  }), {name: 'AbortError'});
  const updated = await preparation.prepare(request);
  const distantAfter = updated.segments.filter(row => row.unitOwners[0].id === 'distant');
  distantAfter.forEach((row, index) => assert.strictEqual(row, far[index]));
  const fresh = await createMapDisplayPreparation().prepare({...request, baseVersion: null,
    upserts: rows.map(row => row.id === changed.id ? changed : row)});
  assert.deepEqual(updated.segments, fresh.segments);
  assert.deepEqual(updated.segments, reference(rows.map(row => row.id === changed.id ? changed : row)));

  const noChange = await preparation.prepare({...request, baseVersion: 2, version: 3, upserts: []});
  assert.strictEqual(noChange.segments, updated.segments);
});

test('project overlays stay installed when the camera leaves and respect explicit hiding', () => {
  const shapes = ['west', 'east'].map((id, index) => ({id, geometry: {type:'Point', coordinates:[index,0]}}));
  let visible = 'west';
  const hidden = new Set(), scenes = new Map();
  const state = {layerVisibility: {}, genericFeatures: shapes,
    distributionLayers:[{id:'values'}],
    distributionEntries:shapes.map(row=>({...row,layerId:'values',value:1,mode:'geometry',
      geometry:{type:'LineString',coordinates:[row.geometry.coordinates,[1,1]]}}))};
  const regions=shapes.map((row,index)=>polygon(row.id,'regional',index,0,index+.5,1));
  const common={
    getState:()=>state,visibleMapObjectCandidates:()=>[{id:visible}],
    isLayerItemVisible:(_group,id)=>!hidden.has(id),geometryMayIntersectViewport:()=>true,
    replaceSceneDomain:(id,scene)=>scenes.set(id,scene),layerStyle:()=>({boundaryVisible:true}),
  };
  const content=createMapContentPresentation({
    territorial:{...common,displayEntities:()=>regions,entityRepository:{get:()=>null}},
    generic:{...common,genericFeatureColor:()=> '#333333'},
    distribution:{...common,DISTRIBUTION_MODES:{TERRITORIAL:'territorial'},
      DISTRIBUTION_RENDER_MODES:{SINGLE:'single'},distributionColor:()=> '#333333'},
    isSmooth:()=>true,
  });
  const render=()=>{
    content.renderTerritorialUnits();content.renderGenericFeatures();content.renderDistributions();
    return [...scenes.values()].map(scene=>[...(scene.polygons||[]),...(scene.strokes||[])].map(row=>row.key));
  };
  assert.deepEqual(render().map(rows=>rows.length),[1,1,1]);
  visible='east';
  assert.deepEqual(render().map(rows=>rows.length),[2,2,2]);
  hidden.add('west');state.distributionEntries=state.distributionEntries.filter(row=>row.id!=='west');
  assert.ok(render().every(rows=>rows.length===1&&rows[0].includes('east')));
});

test('territorial presentation cancels superseded input and publishes after retry', async t => {
  let entities = [polygon('region', 'regional', 1, 1, 3, 3)];
  const pending = [], diagnostics = [], strokes = new Map();
  let ready = 0, onRequest = null;
  const failures = [];
  const state = {layerVisibility: {objects: true}};
  const content = createMapContentPresentation({
    mapPalette: () => ({border: '#fff'}), territorial: {
      getState: () => state, displayEntities: () => entities, entityRepository: {get: () => null},
      isLayerItemVisible: () => true, visibleMapObjectCandidates: () => [],
    }, territorialBoundary: {
      geometryToken: geometry => geometry.coordinates[0][0][0],
      layerStyle: () => ({boundaryVisible: true, blendMode: 'normal'}),
      replaceSceneDomain: (domain, scene) => strokes.set(domain, scene.strokes),
    },
    prepareMapDisplay: (input, {signal} = {}) => new Promise((resolve,reject) => {
      pending.push({input,signal,resolve,reject});
      onRequest?.();
    }),
    reportDiagnostic: entry => diagnostics.push(entry), onMapDisplayReady: () => ready++,
    onMapDisplayFailed: error => failures.push(error),
  });
  t.after(content.resetContentCaches);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  content.renderTerritorialUnits();
  entities = [polygon('region', 'regional', 2, 2, 4, 4)];
  content.renderTerritorialUnits();
  assert.equal(pending[0].signal?.aborted, true);
  const result = (a,b) => ({result: {segments: [{a,b,unitOwners: [{id: 'region'}],styleType: 'region'}]}});
  pending[0].resolve(result([1,1],[3,1]));
  pending[1].reject(new Error('Topology interrupted'));
  await flush();
  assert.equal(ready, 0);
  assert.equal(diagnostics.length, 1);
  assert.equal(content.territorialBoundariesPending(), true);
  await new Promise(resolve => { onRequest = resolve; });
  onRequest = null;
  const terminalError = new Error('Topology interrupted again');
  pending[2].reject(terminalError);
  await flush();
  assert.deepEqual(failures, [terminalError]);
  assert.equal(content.territorialBoundariesPending(), true);
  content.retryTerritorialBoundaries();
  content.renderTerritorialUnits();
  pending[3].resolve(result([2,2],[4,2]));
  await flush();
  assert.equal(ready, 1);
  content.renderTerritorialUnits();
  assert.equal(content.territorialBoundariesPending(), false);
  assert.deepEqual(strokes.get('territorial-boundaries')[0].geometry.coordinates, [[[2,2],[4,2]]]);
  state.layerVisibility.objects = false;
  content.renderTerritorialUnits();
  assert.equal(pending.length, 4);
  assert.deepEqual(strokes.get('territorial-boundaries'), []);
  entities = [];
  content.renderTerritorialUnits();
  assert.deepEqual(strokes.get('territorial-boundaries'), []);
});
