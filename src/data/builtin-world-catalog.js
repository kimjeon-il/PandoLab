import { parseTemporal, temporalContains, temporalMonthEnd, sharedCalculationCore } from '../document/temporal.js';
import { createBuiltinProjectSetup } from '../document/project-setup.js';
import { PROJECT_SCHEMA_VERSION } from '../runtime/version-contract.js';

/** Pure dated catalog selection and project assembly; no file/cache ownership. */
const contains = (rows, date) => rows.some(row => temporalContains(row, date));
function validateBuiltinCatalog(index) {
  if (index?.schema!=='pandolab-builtin-world'||index.schemaVersion!==2||!Array.isArray(index.entities))throw new Error('Invalid builtin country catalog');
}
export function queryMonthEnd(month) {
  const value = parseTemporal(month, {nullable:false});
  if (value.precision!=='month')throw new Error('A query month is required');
  return temporalMonthEnd(value);
}
const countriesAt = (index, date) => index.entities.filter(entry => contains(entry.coverage, date));
export function selectBuiltinCountries(index, month) {
  validateBuiltinCatalog(index);
  return countriesAt(index, queryMonthEnd(month));
}
export function assembleBuiltinWorld(index, countries, month) {
  validateBuiltinCatalog(index);
  queryMonthEnd(month);
  const expected = index.entities;
  const byId = new Map(countries.map(row => [row.entityId, row]));
  if (byId.size!==countries.length||expected.length!==countries.length)throw new Error('Incomplete builtin country selection');
  if (index.template?.schemaVersion!==PROJECT_SCHEMA_VERSION
      ||index.template?.format!=='pandolab-project-state'
      ||Object.hasOwn(index.template,'projectSetup'))
      throw new Error('Invalid builtin project template');
  const project = structuredClone(index.template), geometries = new Map();
  project.territorialEntities = []; project.geometries = [];
  project.timelineRecords = {schemaVersion:3, lifetimes:[], geometryBindings:[], parentRelations:[], propertyBindings:[]};
  for (const entry of expected) {
    const country = byId.get(entry.entityId);
    if (country?.schemaVersion!==2||country.identity?.id!==entry.entityId)throw new Error('Builtin country identity mismatch');
    const identity = structuredClone(country.identity);
    if (identity.properties.metadata?.historicalTimeline)
      identity.properties.metadata.historicalTimeline.geometryBindings = structuredClone(country.sourceBindings);
    project.territorialEntities.push(identity);
    // Historical lifetimes, geometries, parents, names and flags remain dated.
    // Only the canonical C++ cursor selects an effective month.
    for (const name of ['lifetimes','geometryBindings','parentRelations','propertyBindings'])
      project.timelineRecords[name].push(...structuredClone(country.timelineRecords[name]));
    for (const geometry of country.geometries) {
      const key = JSON.stringify([geometry.id, geometry.version]), existing = geometries.get(key);
      if (existing&&JSON.stringify(existing)!==JSON.stringify(geometry))throw new Error('Conflicting builtin geometry');
      geometries.set(key, geometry);
    }
  }
  const used = new Set(project.timelineRecords.geometryBindings.map(row => JSON.stringify([row.geometryRef.id, row.geometryRef.version])));
  project.geometries = [...geometries].filter(([key]) => used.has(key)).map(([, value]) => value);
  project.projectSetup = createBuiltinProjectSetup(month);
  return project;
}
export const builtinGeometryKey = ref => JSON.stringify([ref.id, ref.version]);
export function resolveBuiltinWorldGeometry(index, read, month) {
  const catalog = new Map(index.geometryAssets.map(asset => [builtinGeometryKey(asset), asset]));
  const world = sharedCalculationCore.timelineResolveWorld(read.records, {
    entities:read.identities.map(row => ({objectRef:{domain:'territorial', id:row.id}, entityKind:row.properties.entityKind})),
    geometryType:ref => catalog.get(builtinGeometryKey(ref))?.type ?? '',
  }, month);
  return world.entities.map(row => ({owner:row.objectRef.id, asset:catalog.get(builtinGeometryKey(row.geometryRef))}));
}
