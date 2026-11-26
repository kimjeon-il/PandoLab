import { renderPacketBuffers } from './render-cache-budget.js';

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
export function gpuResourceFootprint(geometries, textures = [], retained = []) {
  const buffers = renderPacketBuffers(retained), attributes = new Set();
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
