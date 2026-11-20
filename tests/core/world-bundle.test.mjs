import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { validateWorldBundle, WORLD_BUNDLE_ROLES } from '../../src/data/world-bundle-manifest.js';
import { artifactGraph, graphStatus } from '../../scripts/lib/generated-artifact-graph.mjs';
import { inspectCanonicalCountryPacket } from '../../src/rendering/canonical-country-packet.js';
import { encodeCountryMesh, MESH_ALGORITHM_REVISION } from '../../src/rendering/country-mesh-codec.js';
import { bundleDescriptor, sha256, verifyPublishedWorldBundle } from '../../tools/build/build-world-bundle.mjs';
import { encodeCanonicalCountryPacket } from '../../tools/build/canonical-country-packet-encoder.mjs';

test('published world keeps immutable assets and verifies a shared boundary when registered', t => {
  const root = mkdtempSync(join(tmpdir(), 'pando-world-bundle-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writeFile = (path, bytes) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  };
  const write = (path, bytes) => writeFile('assets/data/' + path, bytes);
  const source = { type: 'FeatureCollection', features: [{
    type: 'Feature', id: 'AAA', properties: {},
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 1], [0, 0]]] },
  }] };
  const sourceBytes = Buffer.from(JSON.stringify(source));
  const sourceSha256 = sha256(sourceBytes);
  const seed = { schema: 'pandolab-world-build-input', schemaVersion: 1, canonicalSource: 'countries.geojson' };
  const legacy = {
    countries: 1, source: seed.canonicalSource, sourceSha256, canonicalSourceSha256: sourceSha256,
    coordinateCount: 4, meshAlgorithmRevision: MESH_ALGORITHM_REVISION,
    defaultClassification: { countries: { AAA: 'fixture' } }, assets: {},
  };
  const pcg = encodeCanonicalCountryPacket(source);
  const cmg = encodeCountryMesh({
    positions: Int32Array.of(0, 0, 1e6, 0, 0, 1e6),
    countryIndices: Uint16Array.of(0, 0, 0),
    triangleIndices: Uint32Array.of(0, 1, 2), lineIndices: Uint32Array.of(0, 1, 1, 2, 2, 0),
    countryTriangleRanges: Uint32Array.of(0, 3), countryBoundaryRanges: Uint32Array.of(0, 6),
    countryBounds: Int32Array.of(0, 0, 1e6, 1e6), countryBoundsFlags: Uint32Array.of(0),
  }, ['AAA'], 4);
  const raw = { canonicalCountryPacket: Buffer.from(pcg), canonicalMesh: Buffer.from(cmg), labelAnchors: Buffer.from('{}') };
  const headers = { canonicalCountryPacket: inspectCanonicalCountryPacket(pcg).words, canonicalMesh: [...new Uint32Array(cmg, 0, 12)] };
  const assets = {};
  for (const [role, [, , encoding]] of Object.entries(WORLD_BUNDLE_ROLES)) {
    const decoded = raw[role];
    const bytes = encoding === 'gzip' ? gzipSync(decoded) : decoded;
    assets[role] = bytes;
    legacy.assets[role] = {
      url: role, encoding, sha256: sha256(bytes), compressedBytes: bytes.length, decodedBytes: decoded.length,
      ...(headers[role] ? { header: headers[role] } : {}),
    };
  }
  const catalog = bundleDescriptor({ seed, legacy, assets, sourceBytes });
  for (const [role, asset] of Object.entries(catalog.assets)) write(asset.url, assets[role]);
  const publish = () => write('world/current.json', JSON.stringify(catalog));
  const verify = () => verifyPublishedWorldBundle({ root });
  publish();
  assert.equal(validateWorldBundle(catalog).countryCount, 1);
  assert.equal(verify().validatedAssets, 3);
  writeFile('config/generated-artifacts.json', JSON.stringify({
    schema: 'pandolab-generated-artifact-graph', schemaVersion: 1,
    families: [
      { id: 'world-bundle', resolve: 'world-bundle', outputs: ['assets/data/world/current.json'] },
      { id: 'shared-boundaries', resolve: 'shared-boundaries', dependencies: ['world-bundle'] },
    ],
  }));
  writeFile('config/toolchain-versions.json', '{}');
  const sharedFamily = () => artifactGraph(root).find(family => family.id === 'shared-boundaries');
  const worldOutputs = () => artifactGraph(root).find(family => family.id === 'world-bundle').outputs;
  assert.deepEqual(sharedFamily().outputs, []);
  assert.equal(graphStatus(root).statuses['shared-boundaries'].selected, false);
  assert.deepEqual(graphStatus(root, { requested: ['shared-boundaries'] }).statuses['shared-boundaries'].outputs, {});
  const expectedWorldOutputs = ['assets/data/world/current.json', ...Object.values(catalog.assets).map(asset => 'assets/data/' + asset.url)].sort();
  const oldScene = Buffer.from('archived scene bytes');
  const compressedScene = gzipSync(oldScene);
  const sceneHash = sha256(compressedScene);
  catalog.assets.preparedCountryScene = {
    url: `world/objects/country-scene-sha256-${sceneHash}.bin.gz`, encoding: 'gzip', sha256: sceneHash,
    compressedBytes: compressedScene.length, decodedBytes: oldScene.length,
  };
  write(catalog.assets.preparedCountryScene.url, compressedScene);
  publish();
  assert.deepEqual(worldOutputs(), expectedWorldOutputs);
  assert.equal(verify().validatedAssets, 4);
  write(catalog.assets.preparedCountryScene.url, Buffer.from('corrupt'));
  assert.throws(verify, /Published world asset integrity mismatch: preparedCountryScene/);
  delete catalog.assets.preparedCountryScene;

  const sharedPath = 'countries-canonical-shared-v1.2.3.json.gz';
  catalog.compatibility = { sharedBoundaries: { canonical: sharedPath } };
  publish();
  assert.deepEqual(sharedFamily().outputs, ['assets/data/' + sharedPath]);
  assert.equal(graphStatus(root).statuses['shared-boundaries'].selected, true);
  assert.throws(verify, /Missing published shared boundary/);
  write(sharedPath, gzipSync(Buffer.from('{}')));
  assert.equal(verify().check, true);
  catalog.compatibility.sharedBoundaries.canonical = '../outside.json.gz';
  publish();
  assert.throws(verify, /세계지도 canonical 공유 국경선 경로|Unsafe world asset path/);

  delete catalog.compatibility;
  publish();
  write(catalog.assets.canonicalMesh.url, Buffer.from('corrupt'));
  assert.throws(verify, /Published world asset integrity mismatch: canonicalMesh/);
});
