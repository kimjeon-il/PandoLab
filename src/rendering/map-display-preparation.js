import {boundarySourceSegments, buildTerritorialInternalBoundarySegments} from '../geometry/boundary-topology.js';
import {coordinateBounds} from '../geometry/coordinate-bounds.js';
import {createBoundarySpatialIndex, padBoundaryBounds} from '../geometry/boundary-spatial-index.js';

const CONTACT_PADDING = 1e-4;
const sameRows = (a, b) => a?.length === b.length && a.every((row, index) => row === b[index]);

function contactBoxes(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const planarSeams = [];
  const connected = polygons.flatMap(polygon => polygon.flatMap(ring => {
    const bounds = coordinateBounds(ring);
    if (!Number.isFinite(bounds[0])) return [];
    let [west,south,east,north] = padBoundaryBounds(bounds, CONTACT_PADDING);
    if (west < -180 || east > 180 || bounds[2] - bounds[0] > 180) {
      // Follow the same connected longitude direction as the native
      // splitter, so a narrow seam ring doesn't join a whole latitude band.
      let longitude = ring[0][0], min = longitude, max = longitude;
      let seamSouth = Infinity, seamNorth = -Infinity;
      for (let index = 1; index < ring.length; index++) {
        const [previous, previousLatitude] = ring[index - 1];
        const [next, latitude] = ring[index];
        const delta = next - previous;
        if (Math.abs(delta) > 180 || Math.max(Math.abs(previous),Math.abs(next)) >= 180 - CONTACT_PADDING) {
          seamSouth = Math.min(seamSouth, previousLatitude, latitude);
          seamNorth = Math.max(seamNorth, previousLatitude, latitude);
        }
        longitude += delta > 180 ? delta - 360 : delta < -180 ? delta + 360 : delta;
        min = Math.min(min, longitude);
        max = Math.max(max, longitude);
      }
      // The two aliases of the seam can produce segments spanning the original
      // longitude chart. Coast proximity is evaluated in that chart.
      if (seamSouth <= seamNorth) planarSeams.push([-180,seamSouth - CONTACT_PADDING,180,seamNorth + CONTACT_PADDING]);
      if (max - min + 2 * CONTACT_PADDING >= 360) return [[-180,south,180,north]];
      west = ((min - CONTACT_PADDING + 180) % 360 + 360) % 360 - 180;
      east = west + max - min + 2 * CONTACT_PADDING;
    }
    if (west < -180) return [[west + 360,south,180,north],[-180,south,east,north]];
    if (east > 180) return [[west,south,180,north],[-180,south,east - 360,north]];
    return [[west,south,east,north]];
  }));
  return {connected, planarSeams, coast: [...connected, ...planarSeams]};
}

function spatialRows(rows, boxesFor, previous) {
  if (sameRows(previous?.rows, rows)) return previous;
  const index = createBoundarySpatialIndex();
  for (const row of rows) index.insert(row.id, row, boxesFor(row.geometry));
  return {rows, index};
}

export function createMapDisplayPreparation() {
  let version = 0;
  let entities = new Map();
  let orderedRows = [], components = new Map(), segments = [];
  let preparedCountries, preparedRegions;
  const sources = new WeakMap();
  const bounds = new WeakMap();

  function boxesFor(geometry) {
    if (!bounds.has(geometry)) bounds.set(geometry, contactBoxes(geometry));
    return bounds.get(geometry);
  }

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
      if (!previous || previous.geometryKey !== row.geometryKey) next.set(row.id, row);
      else if (previous.properties.entityKind === row.properties.entityKind && previous.properties.parentId === row.properties.parentId)
        next.set(row.id, previous);
      else next.set(row.id, {...row, geometry: previous.geometry});
    }
    // Repository order establishes the precedence of the visible owners
    // sharing a segment. Map insertion order can differ after a patch.
    const rows = entityIds.map(id => next.get(id));

    await checkpoint();
    let prepared = components, output = segments;
    let countrySide = preparedCountries, regionSide = preparedRegions;
    if (!sameRows(orderedRows, rows)) {
      const countries = rows.filter(row => row.properties.entityKind === 'general' && !row.properties.parentId);
      const regions = rows.filter(row => row.properties.entityKind === 'regional');
      prepared = new Map();
      if (regions.length) {
        countrySide = spatialRows(countries, geometry => boxesFor(geometry).coast, countrySide);
        regionSide = spatialRows(regions, geometry => boxesFor(geometry).connected, regionSide);
        const countryIndex = countrySide.index, regionIndex = regionSide.index;
        const regionOrder = new Map(regions.map((row, index) => [row.id, index]));
        const countryOrder = new Map(countries.map((row, index) => [row.id, index]));
        const remaining = new Set(regions);
        for (const seed of remaining) {
          const members = [seed], nearby = new Set(), roots = [];
          remaining.delete(seed);
          let memberIndex = 0, rootIndex = 0;
          const includeCountry = country => {
            if (nearby.has(country)) return;
            nearby.add(country);
            roots.push(country);
          };
          while (memberIndex < members.length || rootIndex < roots.length) {
            for (; memberIndex < members.length; memberIndex++) for (const box of boxesFor(members[memberIndex].geometry).connected) {
              for (const other of regionIndex.query(box)) if (remaining.delete(other)) members.push(other);
              for (const country of countryIndex.query(box)) includeCountry(country);
            }
            for (; rootIndex < roots.length; rootIndex++) {
              const {planarSeams,connected,coast} = boxesFor(roots[rootIndex].geometry);
              if (!planarSeams.length) continue;
              for (const box of connected) for (const country of countryIndex.query(box)) includeCountry(country);
              for (const box of coast) for (const other of regionIndex.query(box)) if (remaining.delete(other)) members.push(other);
            }
          }
          members.sort((a,b) => regionOrder.get(a.id) - regionOrder.get(b.id));
          roots.sort((a,b) => countryOrder.get(a.id) - countryOrder.get(b.id));
          let component = components.get(seed.id);
          if (!sameRows(component?.members, members) || !sameRows(component?.roots, roots)) {
            await checkpoint();
            component = {members, roots, segments: buildTerritorialInternalBoundarySegments(roots, members, {sourceSegments})};
          }
          prepared.set(seed.id, component);
        }
        // A component can contain members separated in repository order by
        // another component. Keep the original precedence and drawing order.
        output = [...prepared.values()].flatMap(component => component.segments);
        output.sort((a,b) => regionOrder.get(a.unitOwners[0].id) - regionOrder.get(b.unitOwners[0].id));
      } else {
        output = [];
        if (!sameRows(countrySide?.rows, countries)) countrySide = undefined;
        regionSide = undefined;
      }
    }
    await checkpoint();
    if (nextVersion <= version || (baseVersion !== null && startingVersion !== version)) return {needsSnapshot: true};
    entities = next;
    orderedRows = rows;
    components = prepared;
    segments = output;
    preparedCountries = countrySide;
    preparedRegions = regionSide;
    version = nextVersion;
    return {version, segments};
  }

  return {prepare};
}
