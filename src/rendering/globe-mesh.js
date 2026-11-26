export const GLOBE_MESH_MAGIC = 0x314d4750; // PGM1
export const GLOBE_MESH_HEADER_BYTES = 16;
const PACKED_GLOBE_MESH_MAGIC = 0x324d4750; // PGM2
export const GLOBE_STROKE_MAGIC = 0x32534750; // PGS2
export const GLOBE_STROKE_HEADER_BYTES = 16;
export const INDEXED_GLOBE_STROKE_MAGIC = 0x33534750; // PGS3
export const INDEXED_GLOBE_STROKE_HEADER_BYTES = 20;

function invalidGlobeMesh() { throw new Error('Invalid globe mesh'); }

function meshLayout(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < GLOBE_MESH_HEADER_BYTES) invalidGlobeMesh();
  const header = new DataView(buffer);
  const magic = header.getUint32(0, true);
  const count = header.getUint32(4, true), indexCount = header.getUint32(8, true), slotCount = header.getUint32(12, true);
  const vectorWords = count * 3;
  const high = GLOBE_MESH_HEADER_BYTES, low = high + vectorWords * 4;
  const index = low + vectorWords * 4, slot = index + indexCount * 4;
  if (!count || !indexCount || indexCount % 3 || (slotCount !== 0 && slotCount !== count) ||
      slot + slotCount * 2 !== buffer.byteLength) invalidGlobeMesh();
  return { magic, count, vectorWords, indexCount, slotCount, high, low, index, slot };
}

function meshBufferWithMagic(source, magic) {
  const result = new ArrayBuffer(source.byteLength);
  new Uint8Array(result, 0, GLOBE_MESH_HEADER_BYTES).set(new Uint8Array(source, 0, GLOBE_MESH_HEADER_BYTES));
  new DataView(result).setUint32(0, magic, true);
  return result;
}

function writeWordPlanes(bytes, length, i, word) {
  bytes[i] = word;
  bytes[i + length] = word >>> 8;
  bytes[i + length * 2] = word >>> 16;
  bytes[i + length * 3] = word >>> 24;
}

function readWordPlanes(bytes, length, i) {
  return bytes[i] | (bytes[i + length] << 8) | (bytes[i + length * 2] << 16) | (bytes[i + length * 3] << 24);
}

/** Reorder every coordinate bit and encode index differences before gzip. */
export function packGlobeMesh(buffer) {
  const { magic, vectorWords, indexCount, slotCount, high, low, index, slot } = meshLayout(buffer);
  if (magic !== GLOBE_MESH_MAGIC) invalidGlobeMesh();
  const packed = meshBufferWithMagic(buffer, PACKED_GLOBE_MESH_MAGIC);
  for (const offset of [high, low]) {
    const words = new Uint32Array(buffer, offset, vectorWords);
    const bytes = new Uint8Array(packed, offset, vectorWords * 4);
    for (let i = 0; i < vectorWords; i++) writeWordPlanes(bytes, vectorWords, i, words[i]);
  }
  const indices = new Uint32Array(buffer, index, indexCount);
  const indexBytes = new Uint8Array(packed, index, indexCount * 4);
  let previous = 0;
  for (let i = 0; i < indexCount; i++) {
    const delta = (indices[i] - previous) | 0;
    writeWordPlanes(indexBytes, indexCount, i, (delta << 1) ^ (delta >> 31));
    previous = indices[i];
  }
  const slots = new Uint16Array(buffer, slot, slotCount);
  const slotBytes = new Uint8Array(packed, slot, slotCount * 2);
  for (let i = 0; i < slotCount; i++) {
    slotBytes[i] = slots[i];
    slotBytes[i + slotCount] = slots[i] >>> 8;
  }
  return packed;
}

function restoreGlobeMesh(buffer, { count, vectorWords, indexCount, slotCount, high, low, index, slot }) {
  const restored = meshBufferWithMagic(buffer, GLOBE_MESH_MAGIC);
  for (const offset of [high, low]) {
    const bytes = new Uint8Array(buffer, offset, vectorWords * 4);
    const words = new Uint32Array(restored, offset, vectorWords);
    for (let i = 0; i < vectorWords; i++) words[i] = readWordPlanes(bytes, vectorWords, i);
  }
  const indexBytes = new Uint8Array(buffer, index, indexCount * 4);
  const indices = new Uint32Array(restored, index, indexCount);
  let previous = 0;
  for (let i = 0; i < indexCount; i++) {
    const word = readWordPlanes(indexBytes, indexCount, i);
    previous = (previous + ((word >>> 1) ^ -(word & 1))) >>> 0;
    if (previous >= count) invalidGlobeMesh();
    indices[i] = previous;
  }
  const slotBytes = new Uint8Array(buffer, slot, slotCount * 2);
  const slots = new Uint16Array(restored, slot, slotCount);
  for (let i = 0; i < slotCount; i++) slots[i] = slotBytes[i] | (slotBytes[i + slotCount] << 8);
  return restored;
}

/** GPU attributes share one buffer in the draw layout. */
export function decodeGlobeMesh(buffer) {
  const layout = meshLayout(buffer);
  const { magic, count, vectorWords, indexCount, slotCount, high, low, index, slot } = layout;
  if (magic === PACKED_GLOBE_MESH_MAGIC) buffer = restoreGlobeMesh(buffer, layout);
  else if (magic !== GLOBE_MESH_MAGIC) invalidGlobeMesh();
  const positions = new Float32Array(buffer, high, vectorWords);
  const residuals = new Float32Array(buffer, low, vectorWords);
  const indices = new Uint32Array(buffer, index, indexCount);
  const slots = new Uint16Array(buffer, slot, slotCount);
  if (magic === GLOBE_MESH_MAGIC) for (const vertex of indices) if (vertex >= count) invalidGlobeMesh();
  return Object.freeze({ positions, residuals, indices, slots });
}

function restoreGlobeStrokes(buffer, count, tailBytes, fail) {
  if (buffer.byteLength < INDEXED_GLOBE_STROKE_HEADER_BYTES) fail();
  const pointCount = new DataView(buffer).getUint32(16, true);
  const pointOffset = INDEXED_GLOBE_STROKE_HEADER_BYTES;
  const indexOffset = pointOffset + pointCount * 24;
  const tailOffset = indexOffset + count * 8;
  if (pointCount > count * 2 || (count > 0 && pointCount === 0) ||
      tailOffset + tailBytes !== buffer.byteLength) fail();
  const points = new Uint32Array(buffer, pointOffset, pointCount * 6);
  const indices = new Uint32Array(buffer, indexOffset, count * 2);
  for (const index of indices) if (index >= pointCount) fail();

  const result = new ArrayBuffer(GLOBE_STROKE_HEADER_BYTES + count * 48 + tailBytes);
  new Uint8Array(result, 0, GLOBE_STROKE_HEADER_BYTES).set(new Uint8Array(buffer, 0, GLOBE_STROKE_HEADER_BYTES));
  new DataView(result).setUint32(0, GLOBE_STROKE_MAGIC, true);
  const endpoints = new Uint32Array(result, GLOBE_STROKE_HEADER_BYTES, count * 12);
  const vectorWords = count * 3;
  for (let i = 0; i < count; i++) {
    for (let side = 0; side < 2; side++) {
      const source = indices[i * 2 + side] * 6;
      const destination = i * 3 + side * vectorWords * 2;
      for (let axis = 0; axis < 3; axis++) {
        endpoints[destination + axis] = points[source + axis];
        endpoints[destination + vectorWords + axis] = points[source + 3 + axis];
      }
    }
  }
  new Uint8Array(result, GLOBE_STROKE_HEADER_BYTES + count * 48).set(new Uint8Array(buffer, tailOffset));
  return result;
}

export function decodeGlobeStrokes(buffer) {
  const fail = () => { throw new Error('Invalid globe stroke packet'); };
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < GLOBE_STROKE_HEADER_BYTES) fail();
  const header = new DataView(buffer);
  const count = header.getUint32(4, true), widthCount = header.getUint32(8, true);
  const ownerCount = header.getUint32(12, true);
  if ((widthCount !== 0 && widthCount !== count) || (ownerCount !== 0 && ownerCount !== count)) fail();
  const tailBytes = widthCount * 4 + ownerCount * 2;
  const magic = header.getUint32(0, true);
  if (magic === INDEXED_GLOBE_STROKE_MAGIC) buffer = restoreGlobeStrokes(buffer, count, tailBytes, fail);
  else if (magic !== GLOBE_STROKE_MAGIC || count * 48 + tailBytes + GLOBE_STROKE_HEADER_BYTES !== buffer.byteLength) fail();
  const attribute = index => new Float32Array(buffer, GLOBE_STROKE_HEADER_BYTES + index * count * 12, count * 3);
  const widths = new Float32Array(buffer, GLOBE_STROKE_HEADER_BYTES + count * 48, widthCount);
  const ownerGroups = new Uint16Array(buffer, widths.byteOffset + widths.byteLength, ownerCount);
  return Object.freeze({ count, start: attribute(0), startLow: attribute(1), end: attribute(2), endLow: attribute(3), widths, ownerGroups });
}

export const globeTerritoryKey=(id,geometry)=>JSON.stringify([id,geometry?.id,geometry?.version]);
export const globeMeshResourceKey=spec=>`${spec.sha256}:${spec.pickGrid?.sha256??''}`;
