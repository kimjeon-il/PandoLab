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
  if(!Number.isSafeInteger(byteBudget)||byteBudget<0)throw new RangeError('Invalid mesh cache budget');
  const packets = new Map(), digests = new Map();
  let bytes = 0, manifestPromise, hits = 0, builds = 0, assetHits = 0;
  function removeAlias(key){
    const digest=packets.get(key);
    if(digest!==undefined){digests.get(digest)?.aliases.delete(key);packets.delete(key);}
  }
  function rememberAlias(key,digest,entry){
    removeAlias(key);packets.set(key,digest);entry.aliases.add(key);
    while(packets.size>4096)removeAlias(packets.keys().next().value);
  }
  function touch(digest,entry){digests.delete(digest);digests.set(digest,entry);}
  function trim(){
    while(bytes>byteBudget){
      const oldest=digests.keys().next().value,entry=digests.get(oldest);
      bytes-=entry.encoded.byteLength;
      for(const key of entry.aliases)packets.delete(key);
      digests.delete(oldest);
    }
  }
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
    // Aliases are bounded separately and removed with their owning digest.
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
          entry = {encoded, positions:validated.positions, indices:validated.indices, maxEdgeDegrees:validated.maxEdgeDegrees,aliases:new Set()};
          if (encoded.byteLength <= byteBudget) { digests.set(digest, entry); bytes += encoded.byteLength; }
        }
      } else hits++;
      if(digests.has(digest)){touch(digest,entry);rememberAlias(item.cacheKey,digest,entry);}
      trim();
    }else{
      hits++;const digest=packets.get(item.cacheKey);touch(digest,entry);rememberAlias(item.cacheKey,digest,entry);
    }
    context.throwIfCancelled();
    return { cacheKey: item.cacheKey, packet: {
      positions: entry.positions.slice(), indices: entry.indices.slice(), maxEdgeDegrees: entry.maxEdgeDegrees,
    } };
  }
  return Object.freeze({ prepare, stats: () => ({ hits, builds, assetHits, bytes }) });
}
