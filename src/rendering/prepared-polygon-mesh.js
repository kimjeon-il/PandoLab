import { decodePolygonMesh, encodePolygonMesh } from "./polygon-mesh-codec.js";
import {applyPreparedMeshDelta,preparedMeshDeltaLayout} from '../data/prepared-mesh-delta.js';
const binaryDigest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');

export async function polygonGeometryDigest(geometry) {
  const bytes = new TextEncoder().encode(JSON.stringify([geometry.type, geometry.coordinates]));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Cache validated bytes and their views. Each renderer response owns its transferable arrays. */
export function createPreparedPolygonMeshStore({ engine, loadManifest = null, loadAsset = null,
  byteBudget = 64 * 1024 * 1024 } = {}) {
  const packets = new Map(), digests = new Map();
  let bytes = 0, manifestPromise, hits = 0, builds = 0, assetHits = 0;
  function readManifest() {
    if (!loadManifest) return null;
    return manifestPromise ||= Promise.resolve().then(loadManifest).catch(error => {
      manifestPromise = null;
      throw error;
    });
  }
  async function prepare(item, context) {
    context.throwIfCancelled();
    let entry = digests.get(packets.get(item.cacheKey));
    // A cache-key mapping may survive eviction of its encoded payload.
    if (!entry) {
      // Polygon rings must retain their topology at every display quality.
      const geometry = item.geometry;
      const digest = await polygonGeometryDigest(geometry);
      context.throwIfCancelled();
      entry = digests.get(digest);
      if (!entry) {
        const manifest = await readManifest();
        let encoded;
        const spec = manifest?.meshes?.[digest];
        if (spec) {
          if(spec.storageLayout===undefined)encoded=await loadAsset(spec);
          else{
            if(spec.storageLayout!==preparedMeshDeltaLayout||!spec.baseGeometryDigest||!spec.base||spec.base.storageLayout!==undefined||!spec.replacement)throw Error('Invalid prepared mesh storage representation');
            const base=digests.get(spec.baseGeometryDigest)?.encoded||await loadAsset(spec.base),delta=await loadAsset(spec.replacement);
            context.throwIfCancelled();
            if(await binaryDigest(base)!==spec.baseContentSha256)throw Error('Prepared mesh base content mismatch');
            encoded=applyPreparedMeshDelta(base,delta,{decodedBytes:spec.decodedBytes});
            if(await binaryDigest(encoded)!==spec.contentSha256)throw Error('Prepared mesh result content mismatch');
          }
          assetHits++;
        }
        else { encoded = encodePolygonMesh(engine.buildPolygonGeometryPacket(geometry, { ownerId: item.cacheKey, throwIfCancelled: () => context.throwIfCancelled() })); builds++; }
        context.throwIfCancelled();
        // Admit only the current algorithm and precision contract.
        entry = digests.get(digest);
        if (!entry) {
          const validated = decodePolygonMesh(encoded, { algorithmVersion: engine.MESH_ALGORITHM_REVISION, includeStrokeEndpoints: false });
          entry = {encoded, positions:validated.positions, indices:validated.indices, maxEdgeDegrees:validated.maxEdgeDegrees};
          if (encoded.byteLength <= byteBudget) { digests.set(digest, entry); bytes += encoded.byteLength; }
        }
      } else hits++;
      if (digests.has(digest)) { digests.delete(digest); digests.set(digest, entry); packets.set(item.cacheKey, digest); }
      while (packets.size > 4096) packets.delete(packets.keys().next().value);
      while (bytes > byteBudget) {
        const oldest = digests.keys().next().value;
        bytes -= digests.get(oldest).encoded.byteLength; digests.delete(oldest);
        for (const [key, value] of packets) if (value === oldest) packets.delete(key);
      }
    } else { hits++; const digest = packets.get(item.cacheKey); digests.delete(digest); digests.set(digest, entry); }
    context.throwIfCancelled();
    return { cacheKey: item.cacheKey, packet: {
      positions: entry.positions.slice(), indices: entry.indices.slice(), maxEdgeDegrees: entry.maxEdgeDegrees,
    } };
  }
  return Object.freeze({ prepare, stats: () => ({ hits, builds, assetHits, bytes }) });
}
