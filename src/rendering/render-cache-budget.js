// These are standby-cache ceilings, not limits on the visible world.
// Unknown device hints keep the original defaults. Do not infer available
// heap from total device RAM or change the canonical geometry quality.
const MiB=1024*1024;
export function renderCacheBudget(deviceMemory=globalThis.navigator?.deviceMemory){
 const ram = Number(deviceMemory);
 const hasMemoryHint = Number.isFinite(ram) && ram > 0;
 const isLowMemory = hasMemoryHint && ram <= 2;
 const isMediumMemory = hasMemoryHint && ram <= 4;
 const factor = isLowMemory ? 0.375 : isMediumMemory ? 0.625 : 1;
 return Object.freeze({
  hydroBytes:Math.round(64*MiB*factor),
  hydroPacks:Math.max(24,Math.floor(96*factor)),
  physicalBytes:Math.round(128*MiB*factor),
  physicalEntries:isMediumMemory?2:3,
  builtinGeometryBytes:Math.round(64*MiB*factor),
  physicalDisplayBytes:Math.round(64*MiB*factor),
  datedStandbyBytes:Math.round(96*MiB*factor),
  workerMeshBytes:Math.round(64*MiB*factor),
  workerGeometryInputBytes:Math.round(48*MiB*factor),
  workerHydroShardBytes:Math.round(32*MiB*factor),
  polarBatchBytes:Math.round(8*MiB*factor),
 });
}
