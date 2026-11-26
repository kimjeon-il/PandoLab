import test from 'node:test';
import assert from 'node:assert/strict';
import {createViewerInitialMapSkeleton} from '../../../src/app/viewer-initial-map-skeleton.js';

test('the initial cover releases once an accepted globe frame is ready', () => {
  let renderer = null;
  let mapReady = false;
  const loading = [];
  const skeleton = createViewerInitialMapSkeleton({
    setLoading: value => loading.push(value),
    readRenderer: () => renderer,
  });

  assert.equal(skeleton.onFirstMapPresented(), false);
  renderer = {getStats: () => ({mapReadiness: {mapReady}})};
  assert.equal(skeleton.reconsider(), false);
  assert.deepEqual(loading, []);
  mapReady = true;
  assert.equal(skeleton.reconsider(), true);
  assert.equal(skeleton.reconsider(), false);
  assert.deepEqual(loading, [false]);
});
