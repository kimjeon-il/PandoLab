import test from 'node:test';
import assert from 'node:assert/strict';
import {mapLibreVendorAssets} from '../../../scripts/lib/maplibre-vendor.mjs';

test('Viewer receives the MapLibre module, worker, stylesheet and license',()=>{
 const assets=mapLibreVendorAssets(process.cwd());
 for(const name of ['maplibre-gl.mjs','maplibre-gl-worker.mjs','maplibre-gl-shared.mjs','maplibre-gl.css','LICENSE.txt'])
  assert.ok(assets.has('assets/vendor/maplibre-gl/'+name),name);
 assert.ok(assets.get('assets/vendor/maplibre-gl/maplibre-gl-worker.mjs').length>0);
});
