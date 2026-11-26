import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { applyGrwlHydronyms } from '../../../tools/gis/build-grwl-hydro.mjs';
import { GRWL_SOURCE, prepareGrwlFeatures, splitReviewedGrwlLine } from '../../../tools/gis/grwl-hydro.mjs';

const line = coordinates => ({ type: 'LineString', coordinates });
const reach = (objectId, widthM, waterClass, coordinates) => ({
  objectId, widthM, waterClass, parts: [coordinates],
});

test('a mainstem cut retains the original junction vertices and widths on both sides', () => {
  const coordinates = [[127, 36], [127.1, 36], [127.2, 36], [127.3, 36], [127.4, 36]];
  const widths = [0.7, 0.8, 0.9, 1, 1.1];
  const sections = splitReviewedGrwlLine(coordinates, widths, { start: 1, end: 3 });
  assert.deepEqual(sections, [
    { named: false, start: 0, coordinates: coordinates.slice(0, 2), widths: widths.slice(0, 2) },
    { named: true, start: 1, coordinates: coordinates.slice(1, 4), widths: widths.slice(1, 4) },
    { named: false, start: 3, coordinates: coordinates.slice(3), widths: widths.slice(3) },
  ]);
  assert.throws(() => splitReviewedGrwlLine(coordinates, widths, { start: 3, end: 3 }), /GRWL mainstem range/);
});

test('the GRWL edition retains both branches and the existing lake without reusing old river coordinates', () => {
  const oldRiver = {
    metadata: { fid: 4, logicalFid: 7, awId: 'hydro-system:24', systemId: '24', name: '시험강',
      layerId: 'rivers_hydro', category: 'river', stage: 0, role: 'mainstem' },
    geometry: line([[127, 36], [127.1, 36]]),
  };
  const lake = {
    metadata: { fid: 5, logicalFid: 8, awId: 'lake:43', category: 'lake', stage: 0 },
    geometry: { type: 'Polygon', coordinates: [[[127, 36], [127.1, 36], [127.1, 36.1], [127, 36]]] },
  };
  const trunk = [[127, 36.002], [127.05, 36.003], [127.1, 36.002]];
  const branchA = [trunk.at(-1), [127.12, 35.99]];
  const branchB = [trunk.at(-1), [127.12, 36.015]];
  const { features } = prepareGrwlFeatures({
    existing: [oldRiver, lake],
    rivers: [
      reach(11, 1200, 0, trunk), reach(12, 400, 2, branchA), reach(13, 500, 2, branchB),
      reach(14, 500, 1, [[128, 36], [128.1, 36]]),
    ],
  });
  assert.deepEqual(features.find(feature => feature.metadata.category === 'lake'), lake);
  const rivers = features.filter(feature => feature.metadata.category === 'river');
  assert.equal(rivers.length, 3);
  const same = rivers.find(feature => feature.metadata.sourceId === '11');
  assert.deepEqual(same.geometry, line(trunk));
  assert.equal(same.metadata.awId, oldRiver.metadata.awId);
  for (const branch of [branchA, branchB]) {
    assert.ok(rivers.some(feature => JSON.stringify(feature.geometry) === JSON.stringify(line(branch))));
  }
  assert.equal(new Set(features.map(feature => feature.metadata.fid)).size, features.length);
});

test('the reviewed lower Nakdong keeps one identity and an exact shared junction', () => {
  const junction = [128.99813,35.2309];
  const river = {
    metadata: { fid: 1, logicalFid: 4, awId: 'hydro-system:40505530', systemId: '40505530',
      name: '낙동강', category: 'river', stage: 0, role: 'mainstem' },
    geometry: line([[128.8,35.37],junction]),
  };
  const { features } = prepareGrwlFeatures({ existing:[river],rivers:[
    reach(13029,402,0,[[128.81349,35.38089],junction]),
    reach(13030,408,2,[[128.9978,35.23077],[128.88985,35.09019]]),
    reach(13032,488,2,[[128.99797,35.23063],[128.95517,35.10835]]),
  ] });
  assert.deepEqual(features.map(row => row.metadata.awId),Array(3).fill(river.metadata.awId));
  assert.deepEqual(features.slice(1).map(row => row.geometry.coordinates[0]),[junction,junction]);
});

test('reviewed names target GRWL OBJECTIDs and preserve index and geometry bytes', () => {
  const awId = 'hydro-grwl:V01.02:42';
  const river = { fid: 9, logicalFid: 11, awId, category: 'river', name: '' };
  const lake = { fid: 10, logicalFid: 12, awId: 'lake:5', category: 'lake', name: '시험호' };
  const info = { fid: 9, source: 'GRWL V01.02', sourceId: '42' };
  const encode = features => gzipSync(JSON.stringify({ version:5, features }));
  const index = Buffer.from('index');
  const geometry = Buffer.from('geometry');
  const chunks = [index, encode([river, lake]), encode([info, { fid: 10 }]), geometry];
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  let offset = 0;
  const [indexSpec, core, detail, shard] = chunks.map(bytes => {
    const spec = { offset, bytes: bytes.length, sha256: sha(bytes) };
    offset += bytes.length;
    return spec;
  });
  const binary = Buffer.concat(chunks);
  const manifest = {
    version: '0.14.0', sources: { grwl: { sha256: GRWL_SOURCE.sha256 } },
    index: indexSpec, metadata: { core, detail }, shards: [shard], stats: {}, cache: {},
    container: { bytes: binary.length, sha256: sha(binary) },
  };
  const binding = { objectId: 42, name: '템스강', aliases: ['River Thames'], sourceUrls: ['https://www.gov.uk/'] };
  const next = applyGrwlHydronyms({ manifest, binary, bindings: [binding] });
  const section = spec => next.binary.subarray(spec.offset, spec.offset + spec.bytes);
  assert.deepEqual(section(next.manifest.index), index);
  assert.deepEqual(section(next.manifest.shards[0]), geometry);
  assert.deepEqual(JSON.parse(gunzipSync(section(next.manifest.metadata.core))).features,
    [{ ...river, name: '템스강', mainstemNameKo: '템스강' }, lake]);
  assert.deepEqual(JSON.parse(gunzipSync(section(next.manifest.metadata.detail))).features,
    [{ ...info, aliases: binding.aliases, independentSourceUrls: binding.sourceUrls }, { fid: 10 }]);
  assert.throws(() => applyGrwlHydronyms({ manifest, binary, bindings: [{ ...binding, objectId: 9 }] }),
    /reach is no longer unnamed/);
});
