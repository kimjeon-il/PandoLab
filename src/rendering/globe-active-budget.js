// Bound active viewport work before packet I/O, not just standby cache bytes.
// Estimates deliberately include all primitives in admitted chunks, even
// when the GPU/CPU culler will reject part of them. Never drop required land
// or water chunks to make a fine tier fit.
const MiB=1024*1024;
const fields=['triangles','segments','drawCalls','bytes','chunks'];
export const emptyGlobeCost=()=>({triangles:0,segments:0,drawCalls:0,bytes:0,chunks:0});
export function sumGlobeCosts(...costs) {
  const total=emptyGlobeCost();
  for (const cost of costs)for (const field of fields)total[field]+=cost[field]??0;
  return total;
}
export function globeCostFits(cost,limit) {
  return fields.every(field=>Number.isFinite(cost[field])&&cost[field]>=0&&cost[field]<=limit[field]);
}
export function globeBudgetViolations(cost,limit) {
  return fields.filter(field=>!Number.isFinite(cost[field])||cost[field]>limit[field]);
}
export function globeActiveLimits(cacheBudget,{tier='medium',otherBytes=0}={}) {
  const memoryFactor=Math.max(.25,Math.min(1,cacheBudget.totalRenderBytes/(320*MiB)));
  const quality=tier==='coarse'?.65:tier==='high'?1.2:1;
  // Leave shared headroom for labels, transient decoding/upload, frame
  // buffers and metadata. The global residency ledger still counts these.
  const bytes=Math.max(0,Math.floor(cacheBudget.totalRenderBytes-cacheBudget.labelAtlasBytes-
    cacheBudget.pendingBytes/2-Math.max(8*MiB*memoryFactor,otherBytes)));
  const hard={triangles:Math.floor(2_000_000*memoryFactor),segments:Math.floor(800_000*memoryFactor),
    drawCalls:Math.floor(1400*memoryFactor),bytes,chunks:Math.floor(800*memoryFactor)};
  const target={triangles:Math.min(hard.triangles,Math.floor(600_000*quality*memoryFactor)),
    segments:Math.min(hard.segments,Math.floor(180_000*quality*memoryFactor)),
    drawCalls:Math.min(hard.drawCalls,Math.floor(300*quality*memoryFactor)),
    bytes:Math.floor(bytes*.72),chunks:Math.min(hard.chunks,Math.floor(240*quality*memoryFactor))};
  const optional={triangles:0,segments:Math.floor(90_000*quality*memoryFactor),
    drawCalls:Math.floor(96*quality*memoryFactor),bytes:Math.floor(bytes*.12),chunks:Math.floor(64*quality*memoryFactor)};
  return {hard,target,optional,labelCandidates:Math.floor(768*quality*memoryFactor)};
}

function primitiveCount(row,kind) {
  if (row.sources?.length)return row.sources.reduce((count,source)=>count+primitiveCount(source,kind),0);
  if (Number.isSafeInteger(row.end)&&Number.isSafeInteger(row.first)&&row.end>=row.first)return row.end-row.first;
  // Legacy unpartitioned lines (graticule) have no descriptor range.
  // The packed indices alone occupy at least 8/12 bytes per primitive.
  return Math.floor(Math.max(0,Number(row.spec?.decodedBytes)||0)/(kind==='stroke'?8:12));
}
const rowCosts=new WeakMap(), planCosts=new WeakMap();
export function estimateGlobeChunkCost(row) {
  const prior=rowCosts.get(row); if (prior)return prior;
  const kind=row.kind==='stroke'||['border','river','detail','outline','graticule'].includes(row.role)?'stroke':'mesh';
  const count=primitiveCount(row,kind);
  const decoded=Math.max(0,Number(row.spec?.decodedBytes)||0);
  // CPU packet + spatial tree + copied/compacted buffers + GPU storage.
  // These are accounting estimates, not hardware-reported allocations.
  const cost={triangles:kind==='mesh'?count:0,segments:kind==='stroke'?count:0,
    drawCalls:kind==='mesh'?2:Math.max(1,Math.ceil(count/(row.role==='outline'?8192:250_000))),
    bytes:Math.ceil(decoded*(kind==='stroke'?4:3)+count*(kind==='stroke'?24:20)+4096),chunks:1};
  rowCosts.set(row,cost); return cost;
}
export function estimateGlobePlanCost(rows) {
  let cost=planCosts.get(rows); if (cost)return cost;
  cost=emptyGlobeCost();
  for (const row of rows) {
    const next=estimateGlobeChunkCost(row);
    for (const field of fields)cost[field]+=next[field];
  }
  planCosts.set(rows,cost); return cost;
}

export function globeBudgetError(cost,limits) {
  const exceeded=globeBudgetViolations(cost,limits);
  return Object.assign(new RangeError('Required globe geometry exceeds active render budget: '+exceeded.join(', ')),
    {code:'PL-THREE-ACTIVE-BUDGET',cost:{...cost},limits:{...limits},exceeded});
}
// Prefer the highest affordable tier at or below the camera request. If the
// soft target is unattainable, use the coarsest hard-admissible complete
// coverage. If even that is too large, do not download or publish a partial map.
export function chooseGlobeActivePlan({requestedLod,minLod=0,limits,build}) {
  let fallback=null,last=null;
  for (let lod=requestedLod;lod>=minLod;lod--) {
    const candidate=build(lod), cost=candidate.cost;
    last=candidate;
    if (!globeCostFits(cost,limits.hard))continue;
    fallback={...candidate,lod,targetExceeded:true,budgetLimited:lod!==requestedLod};
    if (globeCostFits(cost,limits.target))return {...fallback,targetExceeded:false};
  }
  if (fallback)return fallback;
  throw globeBudgetError(last?.cost??emptyGlobeCost(),limits.hard);
}
// Rank optional resources at the caller (selection role/viewport distance).
// Only admit whole chunks and preserve the original drawing order afterwards.
export function admitGlobeOptional(rows,{required,limits,optionalUsed=emptyGlobeCost()}={}) {
  const admitted=[],used={...optionalUsed};
  for (const row of rows) {
    const cost=estimateGlobeChunkCost(row),next=sumGlobeCosts(used,cost);
    if (!globeCostFits(next,limits.optional)||!globeCostFits(sumGlobeCosts(required,next),limits.hard))continue;
    admitted.push(row);
    for (const field of fields)used[field]=next[field];
  }
  return {rows:admitted,cost:used,omitted:rows.length-admitted.length};
}
