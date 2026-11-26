import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { applyHistoricalLsibDisplay, applyLsibDisplay, coordinateDigest } from '../../tools/build/reviewed-border-edition.mjs';
import { assertHistoricalCompiledChanges, historicalLsibDisplayEvidencePath, lsibDisplayEvidencePath } from '../../tools/gis/historical-display-review.mjs';

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
