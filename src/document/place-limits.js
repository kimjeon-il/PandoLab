// Pure, side-effect-free limits shared by the Viewer and label-placement Worker.
// Loading font/layout constants must never initialize the compiled calendar core.
export const PLACE_LIMITS = Object.freeze({
  candidates: 1500,
  layoutCandidates: 2048,
  tileRecords: 512,
  queryTiles: 96,
  shardBytes: 512 * 1024,
  cacheBytes: 24 * 1024 * 1024,
  searchResults: 50,
  retainedRecords: 256,
});
