// The source pack format is shared by offline display preparation and GIS tools.
export function decodeHydroMetadata(bytes) {
  const payload = JSON.parse(new TextDecoder().decode(bytes));
  if (Number(payload?.version)!==5||!Array.isArray(payload?.features))throw Error('수계 메타데이터 버전이 올바르지 않습니다.');
  return new Map(payload.features.map(row => [Number(row.fid), row]));
}

export function decodeHydroIndex(bytes, { tilePacks = new Map(), packSpecs = new Map(), logicalPacks = null } = {}) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x34495741 || view.getUint16(4, true) !== 4) {
    throw new Error('수계 공간 인덱스 버전이 올바르지 않습니다.');
  }
  const tileCount = view.getUint32(8, true);
  const logicalCount = view.getUint32(12, true);
  const packCount = view.getUint32(16, true);
  let offset = 20;
  for (let index = 0; index < tileCount; index += 1) {
    const stage = view.getUint8(offset);
    const x = view.getUint16(offset + 1, true);
    const y = view.getUint16(offset + 3, true);
    const count = view.getUint16(offset + 5, true);
    offset += 7;
    const packs = new Array(count);
    for (let item = 0; item < count; item += 1, offset += 4) packs[item] = view.getUint32(offset, true);
    tilePacks.set(`${stage}/${x}-${y}`, packs);
  }
  for (let index = 0; index < logicalCount; index += 1) {
    const logicalFid = view.getUint32(offset, true);
    const count = view.getUint16(offset + 4, true);
    offset += 6;
    if (logicalPacks) {
      const packs = Array.from({ length: count }, (_, item) => view.getUint32(offset + item * 4, true));
      logicalPacks.set(logicalFid, packs);
    }
    offset += count * 4;
  }
  for (let index = 0; index < packCount; index += 1) {
    const id = view.getUint32(offset, true);
    const shard = view.getUint16(offset + 4, true);
    const packOffset = view.getUint32(offset + 6, true);
    const length = view.getUint32(offset + 10, true);
    const stage = view.getUint8(offset + 14);
    packSpecs.set(id, { id, shard, offset: packOffset, length, stage });
    offset += 15;
  }
  if (offset !== bytes.length) throw new Error('수계 공간 인덱스에 불필요한 데이터가 있습니다.');
  return { tilePacks, packSpecs };
}

function readUVarint(bytes, cursor) {
  let value = 0;
  let shift = 0;
  while (cursor.offset < bytes.length) {
    const byte = bytes[cursor.offset++];
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return value >>> 0;
    shift += 7;
    if (shift > 35) throw new Error('수계 varint가 손상되었습니다.');
  }
  throw new Error('수계 varint가 중간에서 끝났습니다.');
}

function readSVarint(bytes, cursor) {
  const value = readUVarint(bytes, cursor);
  return (value >>> 1) ^ -(value & 1);
}

function readLine(bytes, cursor) {
  const count = readUVarint(bytes, cursor);
  const points = new Array(count);
  let x = 0;
  let y = 0;
  for (let index = 0; index < count; index += 1) {
    if (index === 0) {
      x = readSVarint(bytes, cursor);
      y = readSVarint(bytes, cursor);
    } else {
      x += readSVarint(bytes, cursor);
      y += readSVarint(bytes, cursor);
    }
    points[index] = [x / 1e6, y / 1e6];
  }
  return points;
}

function readGeometry(bytes, geometryKind) {
  const cursor = { offset: 0 };
  if (geometryKind === 1 || geometryKind === 2) {
    const partCount = readUVarint(bytes, cursor);
    const parts = new Array(partCount);
    for (let part = 0; part < partCount; part += 1) parts[part] = readLine(bytes, cursor);
    return geometryKind === 1 ? { type: 'LineString', coordinates: parts[0] || [] } : { type: 'MultiLineString', coordinates: parts };
  }
  const polygonCount = readUVarint(bytes, cursor);
  const polygons = new Array(polygonCount);
  for (let polygon = 0; polygon < polygonCount; polygon += 1) {
    const ringCount = readUVarint(bytes, cursor);
    const rings = new Array(ringCount);
    for (let ring = 0; ring < ringCount; ring += 1) rings[ring] = readLine(bytes, cursor);
    polygons[polygon] = rings;
  }
  return geometryKind === 3 ? { type: 'Polygon', coordinates: polygons[0] || [] } : { type: 'MultiPolygon', coordinates: polygons };
}

function lineParts(geometry) {
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

function readWidthProfile(bytes, geometry) {
  if (!bytes.length) return [];
  const cursor = { offset: 0 };
  const geometryParts = lineParts(geometry);
  const partCount = readUVarint(bytes, cursor);
  if (partCount !== geometryParts.length) throw new Error('강 너비 part 수가 지오메트리와 다릅니다.');
  return geometryParts.map(points => {
    const count = readUVarint(bytes, cursor);
    if (count !== points.length) throw new Error('강 너비 꼭짓점 수가 지오메트리와 다릅니다.');
    let width = count ? readUVarint(bytes, cursor) : 0;
    const widths = new Array(count);
    for (let index = 0; index < count; index += 1) {
      if (index) width += readSVarint(bytes, cursor);
      widths[index] = width / 1000;
    }
    return widths;
  });
}

export function decodeHydroPack(bytes, packId, { featureMetadata, stages }) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46485741 || view.getUint16(4, true) !== 4) throw new Error('수계 feature pack 버전이 올바르지 않습니다.');
  const count = view.getUint32(8, true);
  const features = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const fid = view.getUint32(offset, true);
    const logicalFid = view.getUint32(offset + 4, true);
    const kind = view.getUint8(offset + 8);
    const stage = view.getUint8(offset + 9);
    const geometryKind = view.getUint8(offset + 10);
    const flags = view.getUint8(offset + 11);
    const fragmentIndex = view.getUint16(offset + 12, true);
    const fragmentCount = view.getUint16(offset + 14, true);
    const width = view.getFloat32(offset + 16, true);
    const bounds = [0, 1, 2, 3].map(item => view.getInt32(offset + 20 + item * 4, true) / 1e6);
    const geometryLength = view.getUint32(offset + 36, true);
    const widthLength = view.getUint32(offset + 40, true);
    offset += 44;
    const geometry = readGeometry(bytes.subarray(offset, offset + geometryLength), geometryKind); offset += geometryLength;
    const widthProfile = kind === 1 ? readWidthProfile(bytes.subarray(offset, offset + widthLength), geometry) : []; offset += widthLength;
    const metadata = featureMetadata.get(fid);
    if (!metadata || Number(metadata.logicalFid) !== logicalFid) throw new Error(`수계 feature ${fid} 메타데이터가 없습니다.`);
    const feature = {
      type: 'Feature', id: metadata.awId,
      properties: {
        __fid: fid, __logicalFid: logicalFid, __flags: flags, border_aligned: (flags & 1) !== 0,
        fragment_index: fragmentIndex, fragment_count: fragmentCount,
        pandolab_id: metadata.awId, layer_id: metadata.layerId, category: kind === 1 ? 'river' : 'lake', name: metadata.name || '', name_ko: metadata.name || '',
        source_id: metadata.sourceId || '', source: metadata.source || '',
        system_id: metadata.systemId || '', mainstem_name_ko: metadata.mainstemNameKo || metadata.name || '',
        role: metadata.role || '', aliases: metadata.aliases || [], tributary_names: metadata.tributaryNames || [],
        osm_relation_ids: metadata.osmRelationIds || [],
        independent_source_urls: metadata.independentSourceUrls || [],
        min_zoom: stages[stage].minZoom, stage, stroke_width: width, stroke_widths: widthProfile, pack_id: packId,
      },
      geometry, __awBounds: bounds,
    };
    features.push(feature);
  }
  if (offset !== bytes.length) throw new Error(`수계 pack ${packId}에 불필요한 데이터가 있습니다.`);
  return features;
}
