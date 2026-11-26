import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { applyHistoricalLsibDisplay, applyLsibDisplay, buildArchivedTerritorialRestoration, buildLsibDisplayEdition, coordinateDigest } from '../../tools/build/reviewed-border-edition.mjs';
import { encodeBuiltinCountries, finalizeBuiltinWorldFiles } from '../../tools/data/builtin-country-bytes.mjs';
import { assertHistoricalCompiledChanges, historicalLsibDisplayEvidencePath, lsibDisplayEvidencePath, worldPolygonsDisplayEvidencePath } from '../../tools/gis/historical-display-review.mjs';

const polygon = size => ({ type: 'Polygon', coordinates: [[[0, 0], [size, 0], [0, size], [0, 0]]] });
const objectRef = { id: 'ROU', domain: 'territorial' };
const geometryRef = { id: 'old', version: 1 };
const original = { objectRef, geometryRef, validFrom: '1950-01-01', validTo: null, sourceVersionId: 'test:version' };
const originalCountry = {
  entityId: 'ROU',
  sourceBindings: [original],
  geometries: [{ ...geometryRef, geojson: polygon(1) }],
  timelineRecords: { geometryBindings: [{ ...original, id: 'display' }] },
  identity: { properties: { metadata: { historicalTimeline: {
    entityId: 'state:ROU', geometryVersions: [{
      versionId: original.sourceVersionId, validFrom: original.validFrom, validTo: null,
      historicalProvenance: { worldPolygonsDisplay: [{
        validFrom: original.validFrom, validTo: null, featureId: '2c6696e3-17b7-4dec-b599-50901cccf1ed',
      }] },
    }],
  } } } },
};
const feature = {
  type: 'Feature',
  id: 'ROU',
  properties: { sourceEntityId: 'state:ROU', before: geometryRef, wpIds: ['2c6696e3-17b7-4dec-b599-50901cccf1ed'] },
  geometry: polygon(2),
};
const cutoff = { displayValidFrom: '2026-11-26', previousDisplayThrough: '2026-11-25' };

test('archived display restoration preserves the current roster and binding dates', () => {
  function country(id, size, date, historical = false) {
    const result = structuredClone(originalCountry);
    const sourceId = 'state:' + id;
    const geometryRef = { id: id + ':' + size, version: 1 };
    const binding = { ...original, objectRef: { domain: 'territorial', id }, geometryRef, validFrom: date };
    result.schemaVersion = 2;
    result.entityId = result.identity.id = id;
    result.sourceBindings = [binding];
    result.geometries = [{ ...geometryRef, geojson: polygon(size) }];
    result.timelineRecords = { schemaVersion: 3, lifetimes: [], parentRelations: [], propertyBindings: [],
      geometryBindings: [{ ...binding, id: id + ':display' }] };
    const timeline = result.identity.properties.metadata.historicalTimeline;
    timeline.entityId = sourceId;
    if (historical) {
      const past = { ...binding, validFrom: '1950-01-01', validTo: '2026-11-25' };
      result.sourceBindings.unshift(past);
      result.timelineRecords.geometryBindings.unshift({ ...past, id: id + ':past' });
      timeline.geometryVersions[0].historicalProvenance.historicalLsibDisplay = [past];
    }
    return result;
  }
  const indexPath = 'builtin/index.json';
  function edition(countries) {
    const index = { schema: 'pandolab-builtin-world', schemaVersion: 2, entities: countries.map(({entityId}) => ({entityId})) };
    const files = finalizeBuiltinWorldFiles(index, encodeBuiltinCountries(index, countries, new Map()));
    const read = path => files.get(path.slice('builtin/'.length));
    return { index, read, readFiles: paths => new Map(paths.map(path => [path, read(path)])) };
  }
  const archived = edition([country('ROU', 1, '1950-01-01'), country('DEL', 1, '1950-01-01')]);
  const current = edition([country('ROU', 2, '2026-11-26', true), country('NEW', 2, '2026-11-26')]);
  const result = buildArchivedTerritorialRestoration({
    baseline: 'a'.repeat(40), donorRevision: 'b'.repeat(40), indexPath,
    readBaseline: current.read, readDonor: archived.read,
    readBaselineFiles: current.readFiles, readDonorFiles: archived.readFiles,
  });
  const next = JSON.parse(result.files.get(indexPath));
  assert.deepEqual(next.entities.map(row => row.entityId), ['ROU', 'NEW']);
  assert.deepEqual(next.entities[1], current.index.entities[1]);
  const dates = index => index.readIndex.records.geometryBindings.map(({geometryRef, ...row}) => row);
  assert.deepEqual(dates(next), dates(current.index));
  assert.deepEqual(next.readIndex.records.geometryBindings.filter(row => row.objectRef.id === 'ROU')
    .map(row => row.geometryRef.id), ['ROU:1', 'ROU:1']);
});

test('LSIB switches the current display on the selected date and requires exact evidence', () => {
  const evidence = gzipSync(JSON.stringify({
    type: 'FeatureCollection', ...cutoff, features: [feature], method: 'geos-coverage-visvalingam-whyatt',
  }));
  const sha256 = createHash('sha256').update(evidence).digest('hex');
  const source = { sha256, reference: lsibDisplayEvidencePath(sha256) };
  const next = applyLsibDisplay(originalCountry, feature, source, cutoff);

  assert.deepEqual(next.sourceBindings[0], { ...original, validTo: cutoff.previousDisplayThrough });
  assert.equal(next.sourceBindings[1].validFrom, cutoff.displayValidFrom);
  assert.deepEqual(next.geometries[0], originalCountry.geometries[0]);
  assert.deepEqual(next.geometries[1].geojson, feature.geometry);
  assert.deepEqual(next.timelineRecords.geometryBindings[1].geometryRef, next.sourceBindings[1].geometryRef);
  assert.equal(assertHistoricalCompiledChanges(next, originalCountry, { readDisplayEvidence: () => evidence }), 1);
  assert.throws(
    () => assertHistoricalCompiledChanges(next, originalCountry, { readDisplayEvidence: () => gzipSync('{}') }),
    /LSIB display evidence/,
  );
  const missingPrior = structuredClone(next);
  missingPrior.sourceBindings.shift();
  assert.throws(
    () => assertHistoricalCompiledChanges(missingPrior, originalCountry, { readDisplayEvidence: () => evidence }),
    /retained and current timeline bindings/,
  );
});

test('LSIB admission requires the approved World Polygons ownership mapping', () => {
  const differentDonor = structuredClone(feature);
  differentDonor.properties.wpIds = ['9c54a3b9-0413-4169-a3ae-e09f2f2668e5'];
  assert.throws(
    () => applyLsibDisplay(originalCountry, differentDonor, {}, cutoff),
    /approved World Polygons source/,
  );
});

test('LSIB compiles a one-sided correction without rewriting the retained division member', () => {
  const featureId = feature.properties.wpIds[0];
  const division = gzipSync(JSON.stringify({ partitions: [{
    featureId, ownerEntityId: 'state:ROU', memberEntityId: 'state:MEM',
  }] }));
  const sha256 = createHash('sha256').update(division).digest('hex');
  const divisionSource = { reference: worldPolygonsDisplayEvidencePath(sha256, 'partitions'), sha256 };
  const countries = ['ROU', 'MEM'].map(id => {
    const country = structuredClone(originalCountry);
    country.schemaVersion = 2;
    country.entityId = country.identity.id = id;
    country.sourceBindings[0].objectRef.id = id;
    Object.assign(country.timelineRecords, { schemaVersion: 3, lifetimes: [], parentRelations: [], propertyBindings: [] });
    Object.assign(country.timelineRecords.geometryBindings[0], { id: id + ':display', objectRef: { domain: 'territorial', id } });
    const timeline = country.identity.properties.metadata.historicalTimeline;
    timeline.entityId = 'state:' + id;
    timeline.geometryVersions[0].historicalProvenance.worldPolygonsDisplay[0].source = divisionSource;
    return country;
  });
  const index = { schema: 'pandolab-builtin-world', schemaVersion: 2, entities: countries.map(({ entityId }) => ({ entityId })) };
  const indexPath = 'builtin/index.json';
  const initial = finalizeBuiltinWorldFiles(index, encodeBuiltinCountries(index, countries, new Map()));
  const read = path => {
    if (path === divisionSource.reference) return division;
    if (path === worldPolygonsDisplayEvidencePath()) return gzipSync(JSON.stringify({ sourcePackageSha256: 'world' }));
    if (path === 'tools/historical-library/sources/lsib-11.4/provenance.json') return Buffer.from(JSON.stringify({ masterSha256: 'lines' }));
    return initial.get(path.slice('builtin/'.length));
  };
  const selected = countries.map(({ entityId }) => ({
    ...feature, id: entityId, geometry: entityId === 'ROU' ? feature.geometry : polygon(1),
    properties: { ...feature.properties, divisionSource, sourceEntityId: 'state:' + entityId },
  }));
  const build = features => buildLsibDisplayEdition({
    baseline: 'fixture', readBaseline: read, indexPath, expectedDisplayValidFrom: cutoff.displayValidFrom,
    sourceBytes: gzipSync(JSON.stringify({
      type: 'FeatureCollection', baseline: 'fixture', ...cutoff, features, method: 'geos-coverage-visvalingam-whyatt',
      toleranceDegrees: .0075, held: {}, source: { lsibVersion: '11.4', boundarySha256: 'lines',
        worldPolygonsSha256: 'world', polygonLayer: 'DoS_WP_11_4_G65', shorelineLayer: 'DoS_WP_Shoreline_G65' },
    })),
  });

  assert.throws(() => build(selected.slice(0, 1)), /both sides of the approved division/);
  const edition = build(selected);
  assert.deepEqual(edition.plan.changed, ['ROU']);
  assert.deepEqual(JSON.parse(edition.files.get(indexPath)).entities[1], index.entities[1]);
});

test('historical LSIB replacement preserves its exact date and current binding', () => {
  const country = structuredClone(originalCountry);
  const past = { ...original, validFrom: '1900-01-01', validTo: '1949-12-31' };
  const modern = polygon(2);
  const modernRef = { id: 'historical-world:' + coordinateDigest(modern), version: 1 };
  country.sourceBindings[0].geometryRef = modernRef;
  country.timelineRecords.geometryBindings[0].geometryRef = modernRef;
  country.geometries.push({ ...modernRef, geojson: modern });
  country.sourceBindings.unshift(past);
  country.timelineRecords.geometryBindings.unshift({ ...past, id: 'past' });
  const candidate = {
    entityId: 'ROU', sourceEntityId: 'state:ROU', sourceVersionId: past.sourceVersionId,
    validFrom: past.validFrom, validTo: past.validTo, before: geometryRef,
    geometry: modern, donor: 'ROU', donorGeometryRef: modernRef,
  };
  const evidence = gzipSync(JSON.stringify({ schemaVersion: 1, method: 'lsib-historical-common-display', rows: [candidate] }));
  const sha256 = createHash('sha256').update(evidence).digest('hex');
  const result = applyHistoricalLsibDisplay(country, candidate, { sha256, reference: historicalLsibDisplayEvidencePath(sha256) });
  assert.deepEqual(result.sourceBindings[1], country.sourceBindings[1]);
  assert.deepEqual(result.timelineRecords.geometryBindings[1], country.timelineRecords.geometryBindings[1]);
  assert.deepEqual(result.sourceBindings[0], { ...past, geometryRef: modernRef });
  assert.deepEqual(result.geometries.find(g => g.id === result.sourceBindings[0].geometryRef.id).geojson, candidate.geometry);
  assert.equal(assertHistoricalCompiledChanges(result, country, { readDisplayEvidence: () => evidence }), 1);
  const disconnected = structuredClone(result);
  disconnected.timelineRecords.geometryBindings[0].geometryRef = geometryRef;
  assert.throws(
    () => assertHistoricalCompiledChanges(disconnected, country, { readDisplayEvidence: () => evidence }),
    /selected object, dates or shape/,
  );
  assert.throws(() => applyHistoricalLsibDisplay(country, { ...candidate, validTo: '1949-12-30' }, {}), /historical display binding/);
});
