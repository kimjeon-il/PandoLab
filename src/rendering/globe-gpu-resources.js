import { renderPacketBuffers, renderFootprintBytes } from './render-cache-budget.js';

// Data textures and screen-space geometry use explicit culling and filter policy.
export function createGlobeDataTexture(THREE, data, width, height, {format, type, filter = THREE.NearestFilter, upload = false} = {}) {
  const texture = new THREE.DataTexture(data, width, height, format, type);
  texture.minFilter = texture.magFilter = filter;
  texture.generateMipmaps = false;
  if (upload)texture.needsUpdate = true;
  return texture;
}

export function createGlobeMesh(THREE, geometry, material, order) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  return mesh;
}

export function globeMeshMaterials(meshes) {
  return new Set(meshes.flatMap(mesh => Array.isArray(mesh.material)?mesh.material:[mesh.material]));
}

// CPU backing stores are counted by identity; GPU storage by distinct
// attributes/textures. Do not walk material uniforms (shared texture owners).
export function gpuResourceFootprint(geometries, textures = [], retained = [], immutableBuffers = null) {
  const buffers = renderPacketBuffers(retained), attributes = new Set();
  for (const buffer of immutableBuffers??[])buffers.add(buffer);
  let extraBytes = 0;
  for (const geometry of geometries) {
    for (const attribute of Object.values(geometry.attributes))attributes.add(attribute);
    if (geometry.index)attributes.add(geometry.index);
  }
  for (const attribute of attributes) {
    buffers.add(attribute.array.buffer);
    extraBytes+=attribute.array.byteLength;
  }
  for (const texture of new Set(textures)) {
    const data = texture.image?.data;
    if (!data)continue;
    buffers.add(data.buffer);
    extraBytes+=data.byteLength;
  }
  return {buffers, extraBytes};
}

// Footprint data and protection are independent. Only dirty resources are
// remeasured, and protection-only changes reuse the previous footprint.
// The shared residency ledger owns actual eviction and backing-buffer
// deduplication; local totals are maintained by deltas for cache diagnostics.
export function createGlobeGpuResidency(residency = null, {now = () => performance.now()} = {}) {
  const rows = new Map(), dirty = new Set(), groups = new Map();
  let total = 0, reads = 0, updates = 0;
  function groupDelta(group, bytes) {
    if (group)groups.set(group, (groups.get(group)??0)+bytes);
  }
  function track(resource, read, options = {}) {
    if (rows.has(resource))throw Error('GPU resource already tracked');
    rows.set(resource, {read, footprint:null, bytes:0, accounted:0, accountedGroup:null, group:null, protected:true, ...options});
    dirty.add(resource);
  }
  function measure(row) {
    if (!row.footprint) {
      row.footprint = row.read(); row.bytes = renderFootprintBytes(row.footprint); reads++;
    }
    return row;
  }
  function mark(resource) {
    const row = rows.get(resource); if (!row)return;
    row.footprint = null; dirty.add(resource);
  }
  function configure(resource, options) {
    const row = rows.get(resource); if (!row)throw Error('GPU resource not tracked');
    Object.assign(row, options); dirty.add(resource);
  }
  function protect(resource, value) {
    const row = rows.get(resource);
    if (!row)return;
    // Refresh recency on both cache hits and release. A resource's standby
    // age starts when it was last used, not when it first became active.
    resource.lastUsed = now();
    if (row.protected!==value)row.protected = value;
    dirty.add(resource);
  }
  function flush() {
    if (!dirty.size)return false;
    for (const resource of [...dirty]) {
      dirty.delete(resource);
      const row = rows.get(resource); if (!row)continue;
      const {footprint, bytes} = measure(row);
      const previous = row.accounted;
      total+=bytes-previous;
      if (row.accountedGroup===row.group)groupDelta(row.group, bytes-previous);
      else {groupDelta(row.accountedGroup, -previous); groupDelta(row.group, bytes);}
      row.accounted = bytes; row.accountedGroup = row.group;
      residency?.set(resource, {...footprint, lastUsed:resource.lastUsed, protected:row.protected,
        groups:row.group?[row.group]:[], evict:row.evict});
      updates++;
      if (previous!==bytes)row.onBytesChanged?.(bytes);
    }
    return true;
  }
  function remove(resource) {
    const row = rows.get(resource); if (!row)return;
    rows.delete(resource); dirty.delete(resource);
    total-=row.accounted; groupDelta(row.accountedGroup, -row.accounted);
    residency?.remove(resource);
  }
  return Object.freeze({track, mark, configure, protect, flush, remove,
    footprint:resource => measure(rows.get(resource)).footprint,
    bytes:resource => measure(rows.get(resource)).bytes,
    stats:() => ({bytes:total, reads, updates, entries:rows.size}),
    groupBytes:group => groups.get(group)??0});
}

// Only explicitly owned textures are retired. Shared uniforms and retained
// textures must not be traversed/disposed automatically.
export function disposeGlobeGpuResources(scene, meshes, {
  geometries = meshes.map(mesh => mesh.geometry), materials = globeMeshMaterials(meshes),
  textures = [], afterGeometry,
} = {}) {
  for (const mesh of meshes)scene.remove(mesh);
  for (const geometry of new Set(geometries))geometry.dispose();
  afterGeometry?.();
  for (const material of new Set(materials))material.dispose();
  for (const texture of new Set(textures))texture.dispose();
}

// Both scalar hydro roles and SDF atlas rectangles need a temporary CPU
// source wrapper. Do not retain the backing store after the copy.
export function createGlobeTextureCopier(THREE, renderer) {
  const source = new THREE.DataTexture(null, 1, 1, THREE.RedFormat);
  const region = new THREE.Box2(new THREE.Vector2(), new THREE.Vector2()), position = new THREE.Vector2();
  function copy(texture, rects, onCopied) {
    source.image = texture.image;
    try {
      for (const {x, y, width, height} of rects) {
        region.min.set(x, y);
        region.max.set(x+width, y+height);
        position.set(x, y);
        renderer.copyTextureToTexture(source, texture, region, position);
        onCopied(width*height);
      }
    }finally {source.image = null;}
  }
  return Object.freeze({copy, dispose:() => source.dispose()});
}
