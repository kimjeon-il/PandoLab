// Revision 6 preserves exact nonzero native fill; the packed v2 layout is unchanged.
export const MESH_ALGORITHM_REVISION = 6;

export function decodeCountryMesh(buffer, ids = []) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 32) throw new Error("Invalid country mesh buffer");
  const prefix = new Uint32Array(buffer, 0, 8);
  const formatVersion = Number(prefix[1]);
  const headerWords = formatVersion >= 2 ? 12 : 8;
  const header = new Uint32Array(buffer, 0, headerWords);
  if (header[0] !== 0x434d4731 || ![1, 2].includes(formatVersion) || header[2] < 1
    || header[6] < 1 || header[7] !== MESH_ALGORITHM_REVISION) {
    throw new Error('외부 GPU 메시 형식 또는 알고리즘 리비전이 올바르지 않습니다.');
  }
  const countryCount = header[2];
  if (ids.length && (ids.length !== countryCount || new Set(ids).size !== ids.length)) {
    throw new Error('외부 GPU 메시의 국가 identity 수가 올바르지 않습니다.');
  }
  const vertexCount = header[3];
  const triangleIndexCount = header[4];
  const lineIndexCount = header[5];
  const triangleRangeLength = formatVersion >= 2 ? Number(header[8]) : 0;
  const boundaryRangeLength = formatVersion >= 2 ? Number(header[9]) : 0;
  const boundsLength = formatVersion >= 2 ? Number(header[10]) : 0;
  const boundsFlagsLength = formatVersion >= 2 ? Number(header[11]) : 0;
  if (formatVersion >= 2 && (
    triangleRangeLength !== countryCount * 2
    || boundaryRangeLength !== countryCount * 2
    || boundsLength !== countryCount * 4
    || boundsFlagsLength !== countryCount
  )) throw new Error('외부 GPU 메시의 국가별 범위 메타데이터가 손상되었습니다.');
  let offset = headerWords * 4;
  const positions = new Int32Array(buffer, offset, vertexCount * 2);
  offset += positions.byteLength;
  const countryIndices = new Uint16Array(buffer, offset, vertexCount);
  offset += (countryIndices.byteLength + 3) & ~3;
  const triangleIndices = new Uint32Array(buffer, offset, triangleIndexCount);
  offset += triangleIndices.byteLength;
  const lineIndices = new Uint32Array(buffer, offset, lineIndexCount);
  offset += lineIndices.byteLength;
  const countryTriangleRanges = formatVersion >= 2 ? new Uint32Array(buffer, offset, triangleRangeLength) : null;
  offset += countryTriangleRanges?.byteLength || 0;
  const countryBoundaryRanges = formatVersion >= 2 ? new Uint32Array(buffer, offset, boundaryRangeLength) : null;
  offset += countryBoundaryRanges?.byteLength || 0;
  const countryBounds = formatVersion >= 2 ? new Int32Array(buffer, offset, boundsLength) : null;
  offset += countryBounds?.byteLength || 0;
  const countryBoundsFlags = formatVersion >= 2 ? new Uint32Array(buffer, offset, boundsFlagsLength) : null;
  offset += countryBoundsFlags?.byteLength || 0;
  if (offset !== buffer.byteLength) throw new Error('외부 GPU 메시의 크기가 헤더와 일치하지 않습니다.');
  return {
    mesh: {
      positions,
      countryIndices,
      triangleIndices,
      lineIndices,
      countryTriangleRanges,
      countryBoundaryRanges,
      countryBounds,
      countryBoundsFlags,
      metadataCountryIds: ids,
    },
    ids,
    sourceCoordinateCount: header[6],
    buffer,
  };
}

/** The generator writes the same v2 surface layout consumed by the renderer. */
export function encodeCountryMesh(mesh, ids, sourceCoordinateCount) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 65535 || new Set(ids).size !== ids.length
    || !Number.isSafeInteger(sourceCoordinateCount) || sourceCoordinateCount < 1) throw new Error('Invalid mesh slot identity');
  const fields = ['positions','countryIndices','triangleIndices','lineIndices','countryTriangleRanges',
    'countryBoundaryRanges','countryBounds','countryBoundsFlags'];
  const types = [Int32Array, Uint16Array, Uint32Array, Uint32Array, Uint32Array, Uint32Array, Int32Array, Uint32Array];
  for (let i = 0; i<fields.length; i++) if (!(mesh[fields[i]] instanceof types[i])) throw new Error('Invalid mesh array '+fields[i]);
  if (mesh.positions.length !== mesh.countryIndices.length*2) throw new Error('Invalid mesh vertex count');
  const size = 48 + fields.reduce((sum, key) => sum+((mesh[key].byteLength+3)&~3), 0), buffer = new ArrayBuffer(size);
  new Uint32Array(buffer, 0, 12).set([0x434d4731, 2, ids.length, mesh.countryIndices.length,
    mesh.triangleIndices.length, mesh.lineIndices.length, sourceCoordinateCount, MESH_ALGORITHM_REVISION,
    mesh.countryTriangleRanges.length, mesh.countryBoundaryRanges.length, mesh.countryBounds.length, mesh.countryBoundsFlags.length]);
  let offset = 48;
  for (const key of fields) { const source = mesh[key]; new Uint8Array(buffer, offset, source.byteLength)
    .set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength)); offset+=(source.byteLength+3)&~3; }
  decodeCountryMesh(buffer, ids);
  return buffer;
}

/** Copy a verified source slot; never assume its ordinal is the Viewer ID. */
export function extractCountryMeshSlot(mesh, slot) {
  const count = mesh.countryBoundsFlags?.length;
  if (!Number.isInteger(slot)||slot<0||slot>=count) throw new Error('Invalid source mesh slot');
  const sourceVertices = [], remap = new Map();
  // Explicit remapping handles interleaved layouts and rejects cross-country primitives.
  for (let i = 0; i < mesh.countryIndices.length; i++) {
    if (mesh.countryIndices[i] === slot) {
      remap.set(i, sourceVertices.length); sourceVertices.push(i);
    }
  }
  const positions = new Int32Array(sourceVertices.length*2);
  sourceVertices.forEach((value, index) => positions.set(mesh.positions.subarray(value*2, value*2+2), index*2));
  const select = (indices, ranges) => {
    const first = ranges[slot*2], length = ranges[slot*2+1];
    if (first+length>indices.length)throw new Error('Invalid source slot range');
    return Uint32Array.from(indices.subarray(first, first+length), index => {
      const next = remap.get(index); if (next===undefined)throw new Error('Source slot has another owner'); return next;
    });
  };
  const triangleIndices = select(mesh.triangleIndices, mesh.countryTriangleRanges);
  const lineIndices = select(mesh.lineIndices, mesh.countryBoundaryRanges);
  return {positions, countryIndices:new Uint16Array(sourceVertices.length), triangleIndices, lineIndices,
    countryTriangleRanges:Uint32Array.of(0, triangleIndices.length), countryBoundaryRanges:Uint32Array.of(0, lineIndices.length),
    countryBounds:mesh.countryBounds.slice(slot*4, slot*4+4), countryBoundsFlags:mesh.countryBoundsFlags.slice(slot, slot+1),
    stats:{algorithmRevision:MESH_ALGORITHM_REVISION, polygonCount:0, polarPolygonCount:0, maxEdgeDegrees:0, removedDegenerateTriangleCount:0}};
}
