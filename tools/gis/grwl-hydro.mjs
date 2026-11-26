import { hydroGeometryBounds } from './hydro-encoding-native.mjs';

export const GRWL_SOURCE = Object.freeze({
  file: 'GRWL_summaryStats_V01.02.zip',
  sha256: '78aa43a7104d24b1696e9b1547347eec13ba5d660aa990c1e7cea98e7ae70e4a',
  url: 'https://zenodo.org/records/18624542',
  license: 'CC-BY-4.0',
});
export const GRWL_DATASET = 'GRWL V01.02';
const NAKDONG_ID = 'hydro-system:40505530';
const NAKDONG_LOWER_REACHES = new Set([13027, 13029, 13030, 13032]);

export function splitReviewedGrwlLine(coordinates, widths, { start, end }) {
  const last = coordinates.length - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 ||
      start >= end || end > last || widths.length !== coordinates.length) {
    throw Error('Invalid GRWL mainstem range');
  }
  const section = (first, final, named) => ({
    named, start: first, coordinates: coordinates.slice(first, final + 1), widths: widths.slice(first, final + 1),
  });
  return [
    ...(start > 0 ? [section(0, start, false)] : []),
    section(start, end, true),
    ...(end < last ? [section(end, last, false)] : []),
  ];
}

export function prepareReviewedGrwlMainstems({ existing, rivers, bindings }) {
  const byId = new Map(rivers.map(row => [row.objectId, row]));
  const prior = new Map();
  const namedIds = new Set(existing.map(row => row.metadata.awId));
  let fid = 0, logicalFid = 0;
  for (const feature of existing) {
    const row = feature.metadata;
    if (row.category === 'river' && row.source === GRWL_DATASET) prior.set(Number(row.sourceId), feature);
    fid = Math.max(fid, row.fid + 1);
    logicalFid = Math.max(logicalFid, row.logicalFid + 1);
  }
  const changed = new Set(), replaced = new Set(), groups = new Map(), additions = [];
  const touched = new Set();
  const rounded = point => point.map(value => Math.round(value * 1e6) / 1e6);
  const equalPoint = (a, b) => a?.length === 2 && b?.length === 2 && a[0] === b[0] && a[1] === b[1];
  const allocateGroup = (id, name) => {
    if (!groups.has(id)) groups.set(id, { name, logicalFid: logicalFid++ });
    const group = groups.get(id);
    if (group.name !== name) throw Error('Conflicting GRWL mainstem names: ' + id);
    touched.add(id);
    return group.logicalFid;
  };

  for (const binding of bindings) {
    const { objectId, formerSystemId, name, aliases, sourceUrls, start, end, startCoordinate, endCoordinate, previousName } = binding;
    const input = byId.get(objectId), before = prior.get(objectId);
    const baseId = `hydro-grwl:V01.02:${objectId}`;
    if (!input || input.parts.length !== 1 || replaced.has(objectId) ||
        !/^hydro-system:\d+$/.test(formerSystemId) || namedIds.has(formerSystemId) ||
        !name?.trim() || !Array.isArray(aliases) || !aliases.length ||
        !Array.isArray(sourceUrls) || !sourceUrls.length ||
        sourceUrls.some(url => !/^https:\/\//.test(url) || /openstreetmap|overpass/i.test(url)) ||
        (before ? before.metadata.name !== previousName : input.waterClass !== 1 || previousName !== null)) {
      throw Error('GRWL mainstem preimage differs: ' + objectId);
    }
    const source = input.parts[0].map(rounded);
    if (!equalPoint(source[start], startCoordinate) || !equalPoint(source[end], endCoordinate)) {
      throw Error('GRWL mainstem endpoints differ: ' + objectId);
    }
    const line = before?.geometry.coordinates ?? source;
    if (before && (before.geometry.type !== 'LineString' || line.length !== source.length ||
        line.some((point, index) => !equalPoint(point, source[index])))) {
      throw Error('Packed mainstem differs from GRWL source: ' + objectId);
    }
    let sections = splitReviewedGrwlLine(line, before?.widths?.[0] ?? line.map(() =>
      Math.min(2.6, .55 + .48 * Math.log2(Math.max(1, input.widthM / 90)))), binding);
    if (!before) sections = sections.filter(section => section.named);
    else touched.add(before.metadata.awId);
    replaced.add(objectId);
    let keptOriginal = false;
    for (const section of sections) {
      const keep = !section.named && !keptOriginal;
      if (keep) keptOriginal = true;
      const awId = section.named ? formerSystemId : keep ? before.metadata.awId : baseId + ':' + section.start;
      const geometry = { type: 'LineString', coordinates: section.coordinates };
      const metadata = {
        ...before?.metadata,
        fid: keep ? before.metadata.fid : fid++,
        logicalFid: section.named ? allocateGroup(awId, name) : keep ? before.metadata.logicalFid : logicalFid++,
        awId, category: 'river', layerId: 'rivers_hydro', role: 'mainstem',
        systemId: section.named ? formerSystemId.slice('hydro-system:'.length) : keep ? before.metadata.systemId : awId,
        stage: before?.metadata.stage ?? 2,
        width: before?.metadata.width ?? section.widths[0],
        flags: before?.metadata.flags ?? 0,
        source: GRWL_DATASET, sourceId: String(objectId),
        name: section.named ? name : keep ? before.metadata.name : '',
        mainstemNameKo: section.named ? name : keep ? before.metadata.mainstemNameKo : '',
        aliases: section.named ? aliases : keep ? before.metadata.aliases : [],
        independentSourceUrls: section.named ? sourceUrls : keep ? before.metadata.independentSourceUrls : [],
        bounds: hydroGeometryBounds(geometry).map(value => Math.round(value * 1e6)),
        fragmentIndex: keep ? before.metadata.fragmentIndex : 0, fragmentCount: 1,
      };
      additions.push({ geometry, metadata, widths: [section.widths] });
      changed.add(metadata.fid);
      touched.add(awId);
    }
  }
  if (!replaced.size) throw Error('Explicit GRWL mainstem reviews required');
  const removedIds = new Set([...replaced].map(id => prior.get(id)?.metadata.fid));
  const retained = existing.filter(row => !removedIds.has(row.metadata.fid))
    .map(row => touched.has(row.metadata.awId) ? { ...row } : row);
  const features = retained.concat(additions);
  const fragments = new Map();
  for (const feature of features) {
    const { awId } = feature.metadata;
    if (!touched.has(awId)) continue;
    if (!fragments.has(awId)) fragments.set(awId, []);
    fragments.get(awId).push(feature);
  }
  for (const group of fragments.values()) {
    group.sort((a, b) => a.metadata.fragmentIndex - b.metadata.fragmentIndex || a.metadata.fid - b.metadata.fid);
    for (const [index, feature] of group.entries()) {
      if (feature.metadata.fragmentIndex === index && feature.metadata.fragmentCount === group.length) continue;
      feature.metadata = { ...feature.metadata, fragmentIndex: index, fragmentCount: group.length };
      changed.add(feature.metadata.fid);
    }
  }
  return { features, changedFeatureIds: [...changed] };
}

function lines(geometry) {
  return geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
}

function degreeDistance(point, a, b) {
  const scale = Math.cos(point[1] * Math.PI / 180);
  const x = (a[0] - point[0]) * scale;
  const y = a[1] - point[1];
  const dx = (b[0] - a[0]) * scale;
  const dy = b[1] - a[1];
  const denom = dx * dx + dy * dy;
  const t = denom ? Math.max(0, Math.min(1, -(x * dx + y * dy) / denom)) : 0;
  return Math.hypot(x + t * dx, y + t * dy);
}

// A name or project reference is carried forward only when a single known
// river accounts for most of the new reach. The old line is never emitted.
function indexNamedRivers(existing) {
  const cells = new Map();
  const cell = value => Math.floor(value * 4);
  for (const { metadata, geometry } of existing) {
    if (metadata.category !== 'river' || !metadata.name || /^미명명 수계(?: |$)/.test(metadata.name) ||
        metadata.role !== 'mainstem') continue;
    for (const part of lines(geometry)) {
      for (let i = 1; i < part.length; i++) {
        const [a, b] = part.slice(i - 1, i + 1);
        if (Math.abs(a[0] - b[0]) > 180) continue;
        const pad = .02 / Math.max(.10, Math.cos(Math.max(Math.abs(a[1]), Math.abs(b[1])) * Math.PI / 180));
        const west = cell(Math.min(a[0], b[0]) - pad);
        const east = cell(Math.max(a[0], b[0]) + pad);
        const south = cell(Math.min(a[1], b[1]) - .02);
        const north = cell(Math.max(a[1], b[1]) + .02);
        const segment = { a, b, metadata };
        for (let x = west; x <= east; x++) {
          for (let y = south; y <= north; y++) {
            const key = `${x}/${y}`;
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key).push(segment);
          }
        }
      }
    }
  }
  return (parts) => {
    const votes = new Map();
    let samples = 0;
    for (const part of parts) {
      const sampleCount = Math.min(12, Math.max(3, part.length));
      for (let i = 0; i < sampleCount; i++) {
        const point = part[Math.round(i * (part.length - 1) / (sampleCount - 1))];
        let best;
        let distance = .012;
        for (const segment of cells.get(`${cell(point[0])}/${cell(point[1])}`) || []) {
          const candidate = degreeDistance(point, segment.a, segment.b);
          if (candidate < distance) {
            best = segment.metadata;
            distance = candidate;
          }
        }
        samples++;
        if (best) {
          const vote = votes.get(best.awId) || { metadata: best, count: 0 };
          vote.count++;
          votes.set(best.awId, vote);
        }
      }
    }
    return [...votes.values()].find(vote => vote.count / samples >= .8)?.metadata;
  };
}

export function prepareGrwlFeatures({ rivers, existing }) {
  const lakes = existing.filter(feature => feature.metadata.category === 'lake');
  const named = indexNamedRivers(existing);
  const nakdong = existing.find(({metadata}) => metadata.awId === NAKDONG_ID && metadata.name === '낙동강')?.metadata;
  const nakdongJunction = rivers.find(row => row.objectId === 13029)?.parts[0]?.at(-1);
  const used = new Set();
  const byObject = [];
  const sourceClasses = {};
  for (const row of rivers) {
    const { objectId, widthM, waterClass, parts } = row;
    if (!Number.isSafeInteger(objectId) || objectId < 1 || used.has(objectId) ||
        !Number.isFinite(widthM) || widthM < 0 || !Number.isFinite(waterClass) ||
        !parts.length || parts.some(part => part.length < 2)) throw Error('Invalid GRWL line record');
    used.add(objectId);
    sourceClasses[waterClass] = (sourceClasses[waterClass] || 0) + 1;
    // Published class 1 denotes a lake or reservoir centerline. The archive's
    // other codes remain in the provenance counts without assigning a meaning.
    if (waterClass === 1) continue;
    byObject.push({ row, coordinates: parts.reduce((n, part) => n + part.length, 0), stage: 3 });
  }

  const budgets = [0,0,0];
  for (const { metadata, geometry } of existing) {
    if (metadata.category === 'river' && metadata.stage < budgets.length) {
      budgets[metadata.stage] += lines(geometry).reduce((n, part) => n + part.length, 0);
    }
  }
  // Bound the resident and intermediate stages by the previous coordinate
  // budgets. Keep full source geometry and defer the rest to the detail stage.
  const ranked = [...byObject].sort((a,b) => b.row.widthM - a.row.widthM || a.row.objectId - b.row.objectId);
  let stage = 0;
  let remaining = budgets[stage];
  for (const entry of ranked) {
    while (stage < budgets.length && entry.coordinates > remaining) {
      stage++;
      remaining = budgets[stage];
    }
    entry.stage = stage;
    remaining -= entry.coordinates;
  }

  // Reserve all published numeric identities: an unnamed new reach must
  // never acquire the identity of a previous river or an existing lake.
  let fid = existing.reduce((max, row) => Math.max(max, row.metadata.fid + 1),0);
  let logical = existing.reduce((max, row) => Math.max(max, row.metadata.logicalFid + 1),0);
  const groups = new Map();
  for (const { row, stage: stageId } of byObject.sort((a,b) => a.row.objectId - b.row.objectId)) {
    let riverParts = row.parts;
    if ((row.objectId === 13030 || row.objectId === 13032) && nakdongJunction) {
      const start = riverParts[0][0];
      if (degreeDistance(start,nakdongJunction,nakdongJunction) > .0009) {
        throw Error('Reviewed Nakdong GRWL junction no longer matches its source');
      }
      riverParts = [[nakdongJunction,...riverParts[0].slice(1)], ...riverParts.slice(1)];
    }
    const geometry = riverParts.length === 1
      ? { type: 'LineString', coordinates: riverParts[0] }
      : { type: 'MultiLineString', coordinates: riverParts };
    const previous = (NAKDONG_LOWER_REACHES.has(row.objectId) ? nakdong : undefined) || named(row.parts);
    const awId = previous?.awId || `hydro-grwl:V01.02:${row.objectId}`;
    const group = groups.get(awId) || [];
    const width = Math.min(2.6, .55 + .48 * Math.log2(Math.max(1, row.widthM / 90)));
    const metadata = {
      fid: fid++, awId, logicalFid: previous?.logicalFid ?? logical++,
      name: previous?.name || '', mainstemNameKo: previous?.mainstemNameKo || previous?.name || '',
      layerId: 'rivers_hydro', category: 'river', stage: stageId, flags: 0,
      source: GRWL_DATASET, sourceId: String(row.objectId),
      systemId: previous?.systemId || awId, role: 'mainstem', width,
      bounds: hydroGeometryBounds(geometry).map(value => Math.round(value * 1e6)),
      fragmentIndex: group.length,
    };
    if (previous?.aliases?.length) metadata.aliases = previous.aliases;
    group.push({ metadata, geometry, widths: riverParts.map(part => part.map(() => width)) });
    groups.set(awId, group);
  }
  const features = [...lakes];
  for (const group of groups.values()) {
    for (const feature of group) {
      feature.metadata.fragmentCount = group.length;
      features.push(feature);
    }
  }
  return { features, sourceClasses };
}
