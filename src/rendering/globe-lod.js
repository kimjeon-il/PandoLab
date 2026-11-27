import { referenceZoomPixelsPerDegree } from '../map/map-display-zoom.js';

// Display-only tessellation and spatial partition tiers. The exact tier
// retains the existing native edge threshold and canonical vertex words.
export const GLOBE_LOD_VERSION = 1;
export const GLOBE_LODS = Object.freeze([
  Object.freeze({id:0, maxEdgeDegrees:4, span:.8, cellDivisions:4, maxPrimitives:32_768, riverError:.0002}),
  Object.freeze({id:1, maxEdgeDegrees:1.5, span:.45, cellDivisions:8, maxPrimitives:32_768, riverError:.00005}),
  Object.freeze({id:2, maxEdgeDegrees:.499, span:.24, cellDivisions:16, maxPrimitives:32_768, riverError:0}),
]);
export const GLOBE_FINE_LOD = GLOBE_LODS.at(-1).id;

export function globeLodEnabled(version) {
  if (version===undefined)return false;
  if (version!==GLOBE_LOD_VERSION)throw Error('Unsupported globe LOD version');
  return true;
}
export function globeChunkLod(row) {
  const id = row.lod===undefined?GLOBE_FINE_LOD:row.lod;
  if (!Number.isInteger(id)||!GLOBE_LODS[id])throw Error('Invalid globe chunk LOD');
  return id;
}

// Estimated chord deviation in physical screen pixels. This is a conservative
// quality heuristic, not a certified bound for every source polygon or pitch.
// High zoom always falls back to the exact tier.
export function selectGlobeLod({zoom, dpr = 1, pitch = 0, enabled = true} = {}) {
  if (!enabled||!Number.isFinite(zoom)||!Number.isFinite(dpr)||dpr<=0||!Number.isFinite(pitch))return GLOBE_FINE_LOD;
  const radians = Math.PI/180;
  const scale = referenceZoomPixelsPerDegree(zoom)/radians*Math.max(1,dpr)
    /Math.max(.5,Math.cos(Math.abs(pitch)*radians));
  for (const lod of GLOBE_LODS) {
    if (lod.id===GLOBE_FINE_LOD)return lod.id;
    const error = Math.max(1-Math.cos(lod.maxEdgeDegrees*radians/2),lod.riverError);
    if (scale*error<=.6)return lod.id;
  }
  return GLOBE_FINE_LOD;
}

// Versioned asset families must contain all tiers. Legacy manifests contain
// exact packets only; the reader never treats a missing coarse tier as empty.
export function validateGlobeLodChunks(rows, version) {
  if (!Array.isArray(rows))throw Error('Missing globe LOD chunk family');
  const enabled = globeLodEnabled(version);
  const levels = new Set();
  for (const row of rows) {
    if (enabled&&row.lod===undefined||!enabled&&row.lod!==undefined)throw Error('Globe LOD manifest/chunk version mismatch');
    levels.add(globeChunkLod(row));
  }
  if (enabled&&rows.length&&levels.size!==GLOBE_LODS.length)throw Error('Incomplete globe LOD chunk family');
  return rows;
}
