import { applyPreparedMeshDelta } from './prepared-mesh-delta.js';

// Exact original JSON bytes, not a coordinate simplification. Keep the
// canonical catalog untouched and use an optional one-hop transfer receipt.
export const geometryDeltaLayout = 'exact-geometry-delta-v1';
const hex = /^[a-f0-9]{64}$/;
export const geometryDeltaPath = sha =>`assets/world-geometry-deltas/sha256-${sha}.bin.gz`;
export function readGeometryDeltaReceipt(receipt, catalogSha256, assets) {
  const result = new Map();
  if (!receipt||receipt.layout!==geometryDeltaLayout||receipt.catalogSha256!==catalogSha256
    ||!Array.isArray(receipt.entries)||receipt.entries.length>48)return result;
  const byHash = new Map(assets.map(asset => [asset.sha256, asset]));
  for (const row of receipt.entries) {
    const target = byHash.get(row.target), base = byHash.get(row.base), spec = row.replacement;
    if (!target||!base||target.sha256===base.sha256||target.type!==base.type||result.has(target.sha256)
      ||!spec||!hex.test(spec.sha256)||spec.url!==geometryDeltaPath(spec.sha256)||spec.encoding!=='gzip'
      ||!Number.isSafeInteger(spec.compressedBytes)||spec.compressedBytes<1||spec.compressedBytes>=target.compressedBytes
      ||!Number.isSafeInteger(spec.decodedBytes)||spec.decodedBytes<20||spec.decodedBytes>target.decodedBytes+1024*1024
      ||target.decodedBytes>4*1024*1024||base.decodedBytes>4*1024*1024)continue;
    result.set(target.sha256, {target, base, replacement:spec});
  }
  return result;
}
export function reconstructGeometryBytes(baseBytes, patch, target) {
  // Reuse the already maintained lossless copy/literal wire codec.
  return applyPreparedMeshDelta(baseBytes, patch, {decodedBytes:target.decodedBytes});
}
