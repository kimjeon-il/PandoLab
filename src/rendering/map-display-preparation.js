import {boundarySourceSegments, buildTerritorialInternalBoundarySegments} from '../geometry/boundary-topology.js';

export function createMapDisplayPreparation() {
  let version = 0;
  let entities = new Map();
  const sources = new WeakMap();

  function sourceSegments(feature) {
    let byId = sources.get(feature.geometry);
    if (!byId) sources.set(feature.geometry, byId = new Map());
    if (!byId.has(feature.id)) byId.set(feature.id, boundarySourceSegments(feature, 0, {compactPrepared: true}));
    return byId.get(feature.id);
  }

  async function prepare({baseVersion, version: nextVersion, entityIds, upserts, removedIds}, checkpoint = async () => {}) {
    if (nextVersion <= version || (baseVersion !== null && baseVersion !== version)) return {needsSnapshot: true};
    const startingVersion = version;
    const next = baseVersion === null ? new Map() : new Map(entities);
    for (const id of removedIds) next.delete(id);
    for (const row of upserts) {
      const previous = entities.get(row.id);
      next.set(row.id, previous?.geometryKey === row.geometryKey ? {...row, geometry: previous.geometry} : row);
    }
    const countries = [], regions = [];
    // Repository order establishes the precedence of the visible owners
    // sharing a segment. Map insertion order can differ after a patch.
    for (const id of entityIds) {
      const row = next.get(id);
      if (row.properties.entityKind === 'regional') regions.push(row);
      else if (row.properties.entityKind === 'general' && !row.properties.parentId) countries.push(row);
    }

    await checkpoint();
    // Independent regions can cross countries. Every active country still
    // participates in the same topology while its source edges stay reusable.
    const segments = buildTerritorialInternalBoundarySegments(countries, regions, {sourceSegments});
    await checkpoint();
    if (nextVersion <= version || (baseVersion !== null && startingVersion !== version)) return {needsSnapshot: true};
    entities = next;
    version = nextVersion;
    return {version, segments};
  }

  return {prepare};
}
