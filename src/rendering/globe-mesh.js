export const GLOBE_MESH_MAGIC = 0x314d4750; // PGM1
export const GLOBE_MESH_HEADER_BYTES = 16;
const PACKED_GLOBE_MESH_MAGIC = 0x324d4750; // PGM2
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

/** Retain the exact high/low coordinate bits and two point IDs per stroke.
 * The published indexed packet is also the CPU picking representation.
 */
export function decodeGlobeStrokes(buffer) {
  const fail = () => {throw Error('Invalid globe stroke packet');};
  if (!(buffer instanceof ArrayBuffer)||buffer.byteLength<INDEXED_GLOBE_STROKE_HEADER_BYTES)fail();
  const header = new DataView(buffer);
  if (header.getUint32(0, true)!==INDEXED_GLOBE_STROKE_MAGIC)fail();
  const count = header.getUint32(4, true), widthCount = header.getUint32(8, true),
    ownerCount = header.getUint32(12, true), pointCount = header.getUint32(16, true);
  const pointOffset = INDEXED_GLOBE_STROKE_HEADER_BYTES, indexOffset = pointOffset+pointCount*24,
    widthOffset = indexOffset+count*8, ownerOffset = widthOffset+widthCount*4;
  if ((widthCount!==0&&widthCount!==count)||(ownerCount!==0&&ownerCount!==count)||
    pointCount>count*2||(count>0&&pointCount===0)||ownerOffset+ownerCount*2!==buffer.byteLength)fail();
  const points = new Float32Array(buffer, pointOffset, pointCount*6),
    endpointIndices = new Uint32Array(buffer, indexOffset, count*2);
  if (endpointIndices.some(index => index>=pointCount))fail();
  return Object.freeze({count, points, endpointIndices, widths:new Float32Array(buffer, widthOffset, widthCount),
    ownerGroups:new Uint16Array(buffer, ownerOffset, ownerCount)});
}

export function globeStrokePoint(packet, segment, side) {
 const offset = packet.endpointIndices[segment*2+side]*6, points = packet.points;
 return [points[offset]+points[offset+3], points[offset+1]+points[offset+4], points[offset+2]+points[offset+5]];
}

/** Intern six exact float32 words; no rounding, tolerance or string keys. */
export function createGlobeStrokePointTable(maxPoints) {
 let points = new Uint32Array(Math.min(maxPoints, 1024)*6), count = 0, table = new Uint32Array(2048);
 function hash(words, offset) {
  return Math.imul(words[offset], 2654435761)^Math.imul(words[offset+1], 2246822519)^Math.imul(words[offset+2], 3266489917)^
   Math.imul(words[offset+3], 668265263)^Math.imul(words[offset+4], 374761393)^words[offset+5];
 }
 function growTable() {
  table = new Uint32Array(table.length*2);
  const mask = table.length-1;
  for (let index = 0; index<count; index++) {
   let bucket = hash(points, index*6)&mask;
   while (table[bucket])bucket = (bucket+1)&mask;
   table[bucket] = index+1;
  }
 }
 function intern(words, offset = 0) {
  if ((count+1)*2>table.length)growTable();
  const mask = table.length-1;
  let bucket = hash(words, offset)&mask;
  while (table[bucket]) {
   const index = table[bucket]-1, at = index*6;
   let equal = true;
   for (let axis = 0; axis<6; axis++)if (points[at+axis]!==words[offset+axis]) {equal = false; break;}
   if (equal)return index;
   bucket = (bucket+1)&mask;
  }
  if (count>=maxPoints)throw Error('Globe stroke point capacity exceeded');
  if ((count+1)*6>points.length) {
   const next = new Uint32Array(Math.min(maxPoints, Math.max(count+1, points.length/3))*6);
   next.set(points); points = next;
  }
  const index = count++;
  for (let axis = 0; axis<6; axis++)points[index*6+axis] = words[offset+axis];
  table[bucket] = index+1; return index;
 }
 return Object.freeze({intern, finish:() => new Float32Array(points.slice(0, count*6).buffer)});
}

export function encodeIndexedGlobeStrokes({count, points, endpointIndices, widths, ownerGroups}) {
 const pointOffset = INDEXED_GLOBE_STROKE_HEADER_BYTES, indexOffset = pointOffset+points.byteLength,
  widthOffset = indexOffset+endpointIndices.byteLength, ownerOffset = widthOffset+widths.byteLength;
 const buffer = new ArrayBuffer(ownerOffset+ownerGroups.byteLength), header = new DataView(buffer);
 [INDEXED_GLOBE_STROKE_MAGIC, count, widths.length, ownerGroups.length, points.length/6].forEach((value,index)=>header.setUint32(index*4,value,true));
 new Uint32Array(buffer, pointOffset, points.length).set(new Uint32Array(points.buffer, points.byteOffset, points.length));
 new Uint32Array(buffer, indexOffset, endpointIndices.length).set(endpointIndices);
 new Float32Array(buffer, widthOffset, widths.length).set(widths);
 new Uint16Array(buffer, ownerOffset, ownerGroups.length).set(ownerGroups);
 return buffer;
}

/** Incremental exact-bit merge. Keep the builder and at most one decoded
 * input live; no retained raw group packet cache or cloned spatial trees. */
export function createGlobeStrokeBatchBuilder(maxPoints) {
 const table = createGlobeStrokePointTable(maxPoints);
 let count = 0, capacity = 0, hasWidths = null, hasOwners = null, finished = false;
 let endpointIndices = new Uint32Array(), widths = new Float32Array(), ownerGroups = new Uint16Array();
 function append(packet) {
  if (finished)throw Error('Globe stroke builder already finished');
  if (!packet.count)return;
  const useWidths = Boolean(packet.widths.length), useOwners = Boolean(packet.ownerGroups.length);
  if (hasWidths!==null&&(useWidths!==hasWidths||useOwners!==hasOwners))throw Error('Incompatible globe stroke packet attributes');
  hasWidths = useWidths; hasOwners = useOwners;
  const needed = count+packet.count;
  if (needed>capacity) {
   capacity = Math.max(needed, Math.ceil(capacity*1.5), 32);
   const next = new Uint32Array(capacity*2); next.set(endpointIndices); endpointIndices = next;
   if (hasWidths) {const next = new Float32Array(capacity); next.set(widths); widths = next;}
   if (hasOwners) {const next = new Uint16Array(capacity); next.set(ownerGroups); ownerGroups = next;}
  }
  const words = new Uint32Array(packet.points.buffer, packet.points.byteOffset, packet.points.length);
  const remap = new Uint32Array(packet.points.length/6);
  for (let i = 0; i<remap.length; i++)remap[i] = table.intern(words, i*6);
  for (let i = 0; i<packet.endpointIndices.length; i++)endpointIndices[count*2+i] = remap[packet.endpointIndices[i]];
  if (hasWidths)widths.set(packet.widths, count);
  if (hasOwners)ownerGroups.set(packet.ownerGroups, count);
  count = needed;
 }
 function finish() {
  if (finished)throw Error('Globe stroke builder already finished');
  finished = true;
  const result = Object.freeze({count, points:table.finish(), endpointIndices:endpointIndices.slice(0, count*2),
   widths:widths.slice(0, hasWidths?count:0), ownerGroups:ownerGroups.slice(0, hasOwners?count:0)});
  endpointIndices = widths = ownerGroups = null; return result;
 }
 return {append, finish};
}

export function compactGlobeStrokeRange(packet, first, end) {
 const count = end-first, table = createGlobeStrokePointTable(count*2);
 const words = new Uint32Array(packet.points.buffer, packet.points.byteOffset, packet.points.length);
 const endpointIndices = new Uint32Array(count*2), remap = new Map();
 for (let i = 0; i<endpointIndices.length; i++) {
  const old = packet.endpointIndices[first*2+i];
  let index = remap.get(old);
  if (index===undefined) {index = table.intern(words, old*6); remap.set(old, index);}
  endpointIndices[i] = index;
 }
 return {count, points:table.finish(), endpointIndices, widths:packet.widths.subarray(first, end),
  ownerGroups:packet.ownerGroups.subarray(first, end)};
}

export const globeTerritoryKey = (id, geometry) => JSON.stringify([id, geometry?.id, geometry?.version]);
export const globeMeshResourceKey = spec => spec.sha256;
