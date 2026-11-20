import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { canonicalSharedBoundaryPath } from '../../src/data/world-bundle-manifest.js';

// The source contact topology and grouped chain-conservation check both use
// the same C++ kernel as the Web worker. Keep cache serialization and exact v1
// bytes unchanged; only file I/O, classification and signatures stay in Node.
function verifySharedBorderChains(sharedCalculationCore, segments, quality) {
  if (typeof sharedCalculationCore.boundaryVerifyStrokeChains !== 'function') {
    throw Object.assign(new Error('Compiled shared-border chain verifier unavailable.'),
      { code: 'PL-CORE-WASM-CAPABILITY' });
  }
  // The native verifier accepts at most 1,000,000 sources per call.
  // Conservation is per source edge, so each bounded group must preserve
  // exactly its own entries. Splitting does not rewrite any border geometry.
  let checked=0;
  for(let index=0;index<segments.length;index+=100_000){
    const slice=segments.slice(index,index+100_000);
    const count=sharedCalculationCore.boundaryVerifyStrokeChains(
      slice.map(segment=>[segment.start,segment.end,segment.ownerIds]));
    if(count!==slice.length)
      throw new Error('Shared-border generator dropped source edges: '+quality+' at '+index);
    checked+=count;
  }
  if(checked!==segments.length)
    throw new Error('Shared-border generator dropped source edges: '+quality);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const data = path.join(root, 'assets', 'data');
const bundle = JSON.parse(fs.readFileSync(path.join(data, 'world/current.json'), 'utf8'));
if (bundle.schema !== 'pandolab-world-bundle' || bundle.schemaVersion !== 1) throw new Error('World bundle manifest missing');
const qualityArgument = process.argv.find(value => value.startsWith('--quality='));
const quality = 'canonical';
if (qualityArgument && qualityArgument.slice('--quality='.length) !== quality)
  throw new Error('Unknown boundary cache quality: ' + qualityArgument.slice('--quality='.length));
const output = canonicalSharedBoundaryPath(bundle.compatibility?.sharedBoundaries);
if (output) {
  await import('./load-spherical-core.mjs');
  const [{ sharedCalculationCore }, { buildCountrySharedBoundarySegments, serializeCountrySharedBoundarySegments },
    { countryGeometrySignature }, { classifyBuiltinCountries }, { loadBuiltinDisplayPolicy },
    { loadBoundedCurrentWorld }] = await Promise.all([
    import('../../src/document/temporal.js'), import('../../src/geometry/boundary-topology.js'),
    import('../../src/rendering/country-shared-boundary-cache.js'), import('../gis/builtin-country-classification.mjs'),
    import('../gis/builtin-display-policy.mjs'),
    import('../data/current-world-bounded-loader.mjs'),
  ]);
  const displayPolicy = loadBuiltinDisplayPolicy();
  const source = loadBoundedCurrentWorld(path.join(data, bundle.source.url));
  const classified = classifyBuiltinCountries(source, {displayPolicy});
  const countries = [...classified.countries.features, ...classified.subunits.map(unit => ({
    id: unit.properties.metadata.builtinSubunit.sourceCountryId,
    geometry: unit.geometry,
  }))];
  const signatures = Object.fromEntries(countries.map(feature => [String(feature.id), countryGeometrySignature(feature)]));
  const segments = serializeCountrySharedBoundarySegments(buildCountrySharedBoundarySegments(countries));
  verifySharedBorderChains(sharedCalculationCore, segments, quality);
  const content = Buffer.from(JSON.stringify({ version: 1, quality, signatures, segments }));
  const payload = gzipSync(content, { level: 9, mtime: 0 });
  const destination = path.join(data, output);
  if (process.argv.includes('--check')) {
    // Gzip headers and DEFLATE encodings vary by platform and zlib version.
    // Verify the exact generated content, including geometry order and signatures.
    if (!fs.existsSync(destination) || !gunzipSync(fs.readFileSync(destination)).equals(content)) throw new Error(`${output} is stale`);
  } else {
    const { writeLibraryOutput } = await import('../data/library-runtime.mjs');
    writeLibraryOutput(destination, payload);
  }
  console.log(`${quality}: ${countries.length} countries, ${segments.length} segments, ${payload.length} bytes`);
}
