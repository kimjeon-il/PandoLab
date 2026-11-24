// These are standby-cache ceilings, not limits on the visible world.
// Unknown device hints keep the original defaults. Do not infer available
// heap from total device RAM or change the canonical geometry quality.
const MiB=1024*1024;
export function renderCacheBudget(deviceMemory=globalThis.navigator?.deviceMemory){
 const ram=Number(deviceMemory);
 const limited=Number.isFinite(ram)&&ram>0;
 const factor=limited&&ram<=2?.375:limited&&ram<=4?.625:1;
 return Object.freeze({
  hydroBytes:Math.round(64*MiB*factor),
  hydroPacks:Math.max(24,Math.floor(96*factor)),
  physicalBytes:Math.round(128*MiB*factor),
  physicalEntries:limited&&ram<=4?2:3,
 });
}
