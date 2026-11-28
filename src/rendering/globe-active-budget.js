import { GLOBE_GPU_MESH_BATCH_LIMITS, canAppendGlobeMeshCell, includeGlobeMeshCell, globeMeshCellKey, globeMeshCellState } from './globe-draw-compaction.js';

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
  const quality=tier==='coarse' ? .65 : tier==='high' ? 1.2 : 1;
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
  return {hard,target,optional,transitionBytes:bytes+Math.floor(cacheBudget.pendingBytes/2),labelCandidates:Math.floor(768*quality*memoryFactor)};
}

function primitiveCount(row,kind) {
  if (row.aggregateReductionEstimate&&row.sources?.length)
    return Math.max(1,Math.ceil(row.sources.reduce((count,source)=>count+primitiveCount(source,kind),0)/row.aggregateReductionEstimate));
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
  const rawDecoded=Math.max(0,Number(row.spec?.decodedBytes)||0);
  const decoded=row.aggregateReductionEstimate&&row.sources?.length
    ?Math.ceil(rawDecoded/row.aggregateReductionEstimate):rawDecoded;
  // CPU packet + spatial tree + copied/compacted buffers + GPU storage.
  // These are accounting estimates, not hardware-reported allocations.
  const cost={triangles:kind==='mesh'?count:0,segments:kind==='stroke'?count:0,
    drawCalls:kind==='mesh'?2:Math.max(1,Math.ceil(count/(row.role==='outline'?8192:500_000))),
    bytes:Math.ceil(decoded*(kind==='stroke'?4:3)+count*(kind==='stroke'?24:20)+4096),chunks:1};
  rowCosts.set(row,cost); return cost;
}
function meshCompatibility(row) {
  if(row.role==='country')return 'country';
  if(row.role==='water')return 'water:'+String(row.id);
  if(row.role==='lake')return 'lake:'+String(row.minZoom);
  return null;
}
function meshVertexEstimate(row,triangles) {
  if(Number.isSafeInteger(row.vertexCount)&&row.vertexCount>=0)return row.vertexCount;
  const decoded=Math.max(0,Number(row.spec?.decodedBytes)||0);
  return Math.max(0,Math.floor((decoded-16-triangles*12)/24));
}
export function estimateGlobePlanCost(rows) {
  let cost=planCosts.get(rows); if(cost)return cost;
  cost=emptyGlobeCost();let group=null;
  const flush=()=>{
    if(!group)return;
    for(const row of group.rows){const next=estimateGlobeChunkCost(row);cost.triangles+=next.triangles;cost.bytes+=next.bytes;}
    cost.drawCalls+=2;cost.chunks++;
    if(group.rows.length>1)cost.bytes+=group.vertices*26+group.triangles*12;
    group=null;
  };
  for(const row of rows){
    const compatibility=meshCompatibility(row),next=estimateGlobeChunkCost(row);
    if(compatibility!==null&&row.kind!=='stroke'){
      const triangles=next.triangles,vertices=meshVertexEstimate(row,triangles);
      const cell=globeMeshCellKey(row);
      if(group&&(group.compatibility!==compatibility||!canAppendGlobeMeshCell(group,cell)||
        group.rows.length>=GLOBE_GPU_MESH_BATCH_LIMITS.maxChunks||
        group.triangles+triangles>GLOBE_GPU_MESH_BATCH_LIMITS.maxTriangles||
        group.vertices+vertices>GLOBE_GPU_MESH_BATCH_LIMITS.maxVertices))flush();
      if(!group)group={compatibility,rows:[],triangles:0,vertices:0,...globeMeshCellState(cell)};
      else includeGlobeMeshCell(group,cell);
      group.rows.push(row);group.triangles+=triangles;group.vertices+=vertices;
    }else{flush();for(const field of fields)cost[field]+=next[field];}
  }
  flush();planCosts.set(rows,cost);return cost;
}

// Reused chunks are charged once while the previous accepted scene and its
// replacement must coexist. Content aliases with different GPU keys remain
// conservative separate charges.
export function estimateGlobeTransitionBytes(...plans) {
  let bytes=0;
  const seen=new Set();
  for (const rows of plans)for (const row of rows??[]) {
    const key=row.key===undefined?row:(row.role??row.kind??'mesh')+':'+row.key;
    if (seen.has(key))continue;
    seen.add(key);bytes+=estimateGlobeChunkCost(row).bytes;
  }
  return bytes;
}
export function globeBudgetError(cost,limits) {
  const exceeded=globeBudgetViolations(cost,limits);
  return Object.assign(new RangeError('Required globe geometry exceeds active render budget: '+exceeded.join(', ')),
    {code:'PL-THREE-ACTIVE-BUDGET',cost:{...cost},limits:{...limits},exceeded});
}
// Prefer the highest affordable tier at or below the camera request. If the
// soft target is unattainable, use the coarsest hard-admissible complete
// coverage. If even that is too large, do not download or publish a partial map.
export function chooseGlobeActivePlan({requestedLod,minLod=0,limits,build,aggregateLevels=[]}) {
  let fallback=null,aggregateFallback=null,last=null;
  for (let lod=requestedLod;lod>=minLod;lod--) {
    const candidate=build(lod,0,0),cost=candidate.cost;last=candidate;
    if (!globeCostFits(cost,limits.hard)||(candidate.transitionBytes??0)>(limits.transitionBytes??Infinity))continue;
    fallback={...candidate,lod,aggregationLevel:0,targetExceeded:true,budgetLimited:lod!==requestedLod};
    if (globeCostFits(cost,limits.target))return {...fallback,targetExceeded:false};
  }
  // Only after every ordinary LOD has failed its soft target do we trade
  // line identity/precision for bounded spatial-network aggregation.
  for (const level of aggregateLevels) {
    const candidate=build(minLod,0,level),cost=candidate.cost;last=candidate;
    if (!globeCostFits(cost,limits.hard)||(candidate.transitionBytes??0)>(limits.transitionBytes??Infinity))continue;
    aggregateFallback={...candidate,lod:minLod,aggregationLevel:level,aggregateFallback:true,
      targetExceeded:true,budgetLimited:true};
    if (globeCostFits(cost,limits.target))return {...aggregateFallback,targetExceeded:false};
  }
  if (fallback)return fallback;
  if (aggregateFallback)return aggregateFallback;
  const error=globeBudgetError(last?.cost??emptyGlobeCost(),limits.hard);
  if ((last?.transitionBytes??0)>(limits.transitionBytes??Infinity)) {
    error.exceeded.push('transitionBytes');
    error.cost.transitionBytes=last.transitionBytes;
    error.limits.transitionBytes=limits.transitionBytes;
    error.message='Required globe geometry exceeds active render budget: '+error.exceeded.join(', ');
  }
  throw error;
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
