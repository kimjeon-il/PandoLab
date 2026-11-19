// Prepared per-owner spatial blocks for the shared-country stroke packet.
// Indexes are derived in the boundary Worker and never change source geometry.
const RAD = Math.PI / 180;
const BLOCK_INSTANCES = 128;

function combineBounds(blocks) {
  if (blocks.some(block => !block.bounds)) return null;
  const values = [Infinity, Infinity, -Infinity, -Infinity];
  const sphere = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const { bounds } of blocks) {
    for (let index = 0; index < 2; index++) values[index] = Math.min(values[index], bounds.geo[index]);
    for (let index = 2; index < 4; index++) values[index] = Math.max(values[index], bounds.geo[index]);
    for (let index = 0; index < 3; index++) {
      sphere[index] = Math.min(sphere[index], bounds.sphere[index]);
      sphere[index + 3] = Math.max(sphere[index + 3], bounds.sphere[index + 3]);
    }
  }
  return { geo: values, sphere };
}

function boundsFor(data, first, count, stride, node) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const sphere = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const add = (lon, lat) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90) return false;
    west = Math.min(west, lon); east = Math.max(east, lon);
    south = Math.min(south, lat); north = Math.max(north, lat);
    const longitude = lon * RAD, latitude = lat * RAD, cosLat = Math.cos(latitude);
    const point = [cosLat * Math.cos(longitude), cosLat * Math.sin(longitude), Math.sin(latitude)];
    for (let k = 0; k < 3; k++) {
      sphere[k] = Math.min(sphere[k], point[k]);
      sphere[k + 3] = Math.max(sphere[k + 3], point[k]);
    }
    return true;
  };
  for (let index = first; index < first + count; index++) {
    const offset = index * stride;
    // GPU segment vertices are projected at start/end; joins/caps are
    // projected at their node center. The shader expands only in screen pixels.
    if (!add(data[offset + 2], data[offset + 3])) return null;
    if (!node && !add(data[offset + 4], data[offset + 5])) return null;
  }
  return { geo: [west, south, east, north], sphere };
}

function blocksFor(data, ranges, stride, node, size) {
  const owners = Object.create(null);
  let blockCount = 0;
  for (const [id, source] of Object.entries(ranges || {})) {
    const first = Number(source?.first), count = Number(source?.count);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count)
      || first < 0 || count <= 0 || first + count > data.length / stride) continue;
    const blocks = [];
    for (let start = first; start < first + count; start += size) {
      const length = Math.min(size, first + count - start);
      blocks.push({ first: start, count: length,
        bounds: boundsFor(data, start, length, stride, node) });
      blockCount++;
    }
    owners[id] = { first, count, bounds: combineBounds(blocks), blocks };
  }
  return { owners, blockCount };
}

export function prepareGpuStrokeVisibilityBlocks(geometry, { blockSize = BLOCK_INSTANCES } = {}) {
  if (!geometry?.instances?.length || !geometry?.ownerRanges
    || !Number.isSafeInteger(blockSize) || blockSize <= 0) return null;
  const segments = blocksFor(geometry.instances, geometry.ownerRanges, 10, false, blockSize);
  const nodes = blocksFor(geometry.nodes, geometry.ownerNodeRanges, 8, true, blockSize);
  // Conservative JS object + number storage estimate for the existing Worker LRU.
  const estimatedBytes = (segments.blockCount + nodes.blockCount) * 224
    + (Object.keys(segments.owners).length + Object.keys(nodes.owners).length) * 160;
  return { version: 1, segments: segments.owners, nodes: nodes.owners,
    blockSize, blockCount: segments.blockCount + nodes.blockCount, estimatedBytes };
}
