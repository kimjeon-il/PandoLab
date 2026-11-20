import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapDisplayClient} from '../../../src/ui/map-display-client.js';
import {createMapDisplayPreparation} from '../../../src/rendering/map-display-preparation.js';
import {createMapContentPresentation} from '../../../src/ui/map-content-presentation.js';

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
  t.after(content.resetTerritorialBoundaryCache);
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
