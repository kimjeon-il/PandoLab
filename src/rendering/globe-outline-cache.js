import { gpuResourceFootprint, disposeGlobeGpuResources } from './globe-gpu-resources.js';
import { touchLruEntry, trimLruCount } from '../runtime/lru-cache.js';
import { createGlobeSpatialSelection } from './globe-spatial-partition.js';
import { createThreeGlobeStrokes, createGlobeStrokePointTexture } from './three-globe-strokes.js';
import { renderPacketBuffers, renderFootprintBytes } from './render-cache-budget.js';
import { planGlobeCompactionUpdates, applyGlobeDrawWrites, useDirectGlobeStrokeAttributes, globeBufferCapacity } from './globe-draw-compaction.js';

import { indexGlobeOutlineChunks, selectGlobeOutlineGroups } from './globe-outline-index.js';
export { indexGlobeOutlineRanges, selectGlobeOutlineGroups, globeOutlineRanges, indexGlobeOutlineChunks } from './globe-outline-index.js';

// Only points referenced by active owners enter the texture dictionary.
// Preserve all six Float32 words, including the low-coordinate residuals.
// The short local segment lookup never duplicates the full point dictionary.
export function buildGlobeOutlinePointSubset(packet, ranges) {
  const count = ranges.reduce((sum, [first, end]) => sum+end-first, 0);
  const sourceWords = new Uint32Array(packet.points.buffer, packet.points.byteOffset, packet.points.length);
  const words = new Uint32Array(count*12), endpointIndices = new Uint32Array(count*2);
  const segmentOffsets = new Int32Array(packet.count).fill(-1), remap = new Map();
  let offset = 0, pointCount = 0;
  for (const [first, end] of ranges)for (let segment = first; segment<end; segment++) {
    segmentOffsets[segment] = offset;
    for (let side = 0; side<2; side++) {
      const id = packet.endpointIndices[segment*2+side];
      let local = remap.get(id);
      if (local===undefined) {
        local = pointCount++; remap.set(id, local);
        words.set(sourceWords.subarray(id*6, id*6+6), local*6);
      }
      endpointIndices[offset*2+side] = local;
    }
    offset++;
  }
  return {points:new Float32Array(words.slice(0, pointCount*6).buffer), endpointIndices, segmentOffsets, count};
}

export function outlineInstanceCapacity(current, needed, limit) {
  if (needed>limit)throw Error('Outline selection exceeds chunk capacity');
  return globeBufferCapacity(current, needed, limit, 32, current);
}

export function createGlobeOutlineCache(THREE,{scene,packet,owners,preparedIndex=null,strokeOptions,maxTextureSize,orderForChunk,residency,onResidencyChange=()=>{},gpuFrameBudget=null,prepareGpuMesh=null}) {
  const index = preparedIndex??indexGlobeOutlineChunks(packet, owners), partitions = packet.spatialParts;
  const packetBuffers = renderPacketBuffers(packet);
  const outlineStyles = Array.from({length:5}, () => new THREE.Vector2());
  const strokeColor = new THREE.Color(strokeOptions.style.color);
  const options = {...strokeOptions, order:6, outlineUniforms:{outlineStyles:{value:outlineStyles}}};
  const chunks = new Map(), activeChunks = new Set(), dirtyChunks = new Set(), baseKey = {};
  let baseDirty = true, ledgerActive = null;
  function markChunk(chunk) {dirtyChunks.add(chunk); onResidencyChange();}
  let previousGroups = new Map(), previousRoles = null, previousStyles = null, previousColor = null, lastUsed = performance.now();
  let evictedChunks = 0, createdChunks = 0, shrunkBuffers = 0, updatedChunks = 0, subsetHits = 0, subsetBuilds = 0;
  const subsetLimit = 2;
  function hideMesh(chunk) {
    if (chunk.gpu?.mesh.visible) {chunk.gpu.mesh.visible = false; chunk.lastUsed = performance.now(); markChunk(chunk);}
  }
  function disposePendingGpu(chunk) {
    const gpu=chunk.pendingGpu;if(!gpu)return;
    disposeGlobeGpuResources(scene,[gpu.mesh],{textures:gpu.texture&&gpu.texture!==chunk.gpu?.texture?[gpu.texture.texture]:[]});
    chunk.pendingGpu=null;
  }
  function disposeGpu(chunk, {keepTexture = false} = {}) {
    const gpu = chunk.gpu;
    if (!gpu)return;
    disposeGlobeGpuResources(scene, [gpu.mesh], {textures:!keepTexture&&gpu.texture?[gpu.texture.texture]:[]});
    chunk.gpu = null; markChunk(chunk);
  }
  function evictChunk(chunk) {
    if (!chunk.gpu&&!chunk.pendingGpu)return;
    disposeGpu(chunk);disposePendingGpu(chunk);evictedChunks++;
    chunk.selection = null; chunk.selected = null; chunk.subsets.clear();
    if (!chunk.roles.size)chunks.delete(chunk.id);
    else residency?.set(chunk, {...chunkFootprint(chunk), lastUsed:chunk.lastUsed, protected:true, groups:['outline','outlineChunk']});
    markChunk(chunk);
  }
  function clearInactive(chunk) {
    hideMesh(chunk); activeChunks.delete(chunk);
    chunk.selection = null; chunk.selected = null;
    if (!chunk.gpu) {disposePendingGpu(chunk);chunk.subsets.clear();chunks.delete(chunk.id);}
    markChunk(chunk);
  }
  function paint(roles, styles, color) {
    const sameRoles = previousRoles&&previousRoles.size===roles.size&&[...roles].every(([slot, code]) => previousRoles.get(slot)===code);
    const signature = styles.map(row => [row?.width??0, row?.alpha??0]).flat().join(',');
    if (sameRoles&&previousStyles===signature&&previousColor===color)return activeChunks.size>0;
    previousRoles = new Map(roles); previousStyles = signature; previousColor = color;
    for (let code = 0; code<outlineStyles.length; code++) {
      const style = styles[code]; outlineStyles[code].set((style?.width??0)/2,style?.alpha??0);
    }
    if (color!==undefined&&color!==null)strokeColor.set(color);
    const groups = selectGlobeOutlineGroups(index, roles, styles), changed = new Set([...previousGroups.keys(), ...groups.keys()]);
    const touched = new Map();
    for (const group of changed) {
      const before = previousGroups.get(group), after = groups.get(group);
      if (before===after)continue;
      for (const row of index.chunksByGroup[group]) {
        let chunk = chunks.get(row.chunkId);
        if (!chunk) {chunk = {id:row.chunkId, roles:new Map(), selectedCount:0, membershipRevision:0, roleRevision:0, selection:null, selected:null, gpu:null, subsets:new Map(), lastUsed:performance.now()}; chunks.set(chunk.id, chunk);}
        if (after===undefined) {chunk.roles.delete(group); chunk.selectedCount-=row.count;}
        else {
          chunk.roles.set(group, {code:after, row});
          if (before===undefined)chunk.selectedCount+=row.count;
        }
        touched.set(chunk, (touched.get(chunk)??false)||before===undefined||after===undefined);
      }
    }
    for (const [chunk, membershipChanged] of touched) {
      chunk.roleRevision++;
      if (membershipChanged)chunk.membershipRevision++;
      if (chunk.roles.size) {activeChunks.add(chunk); markChunk(chunk);}else clearInactive(chunk);
    }
    previousGroups = groups;
    if (touched.size) {updatedChunks+=touched.size; lastUsed = performance.now(); baseDirty = true; onResidencyChange();}
    return activeChunks.size>0;
  }
  function hide() {
    if (!activeChunks.size)return;
    for (const chunk of [...activeChunks]) {
      chunk.roles.clear(); chunk.selectedCount = 0; chunk.membershipRevision++; chunk.roleRevision++; clearInactive(chunk);
    }
    previousGroups = new Map(); previousRoles = null; lastUsed = performance.now(); baseDirty = true; onResidencyChange();
  }
  function newGpu(chunk, subset, capacity, reuseTexture = null) {
    const direct = useDirectGlobeStrokeAttributes({count:capacity});
    const output = {count:capacity, widths:new Float32Array(0), ownerGroups:new Uint16Array(capacity)};
    const names = direct?['start','startLow','end','endLow']:['endpointIndices'];
    if (direct)for (const name of names)output[name] = new Float32Array(capacity*3);
    else output.endpointIndices = new Uint32Array(capacity*2);
    const texture = direct?null:reuseTexture??createGlobeStrokePointTexture(THREE, subset.points, maxTextureSize);
    const mesh = createThreeGlobeStrokes(THREE, {...options, order:orderForChunk(chunk.id, partitions.length), packet:output, pointUniforms:texture?.uniforms});
    mesh.material.uniforms.strokeColor.value = strokeColor;
    for (const name of [...names,'ownerGroup'])mesh.geometry.getAttribute(name).setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.instanceCount = 0; mesh.visible = false; scene.add(mesh);
    createdChunks++;
    return {mesh,texture,output,capacity,subset,direct,names,sourceGroups:new Set(chunk.roles.keys()),membershipRevision:chunk.membershipRevision,roleRevision:-1,ranges:null,ready:false};
  }
  function ensureGpu(chunk,needed) {
    const gpu=chunk.gpu,part=partitions[chunk.id].packet,capacity=outlineInstanceCapacity(gpu?.capacity??0,needed,part.count);
    const direct=useDirectGlobeStrokeAttributes({count:capacity});
    if (gpu&&gpu.capacity===capacity&&gpu.direct===direct&&(direct||gpu.membershipRevision===chunk.membershipRevision))return gpu;
    const membership=[...chunk.roles.keys()].sort((a,b)=>a-b).join(',');
    let subset=null;
    if (!direct) {
      subset=touchLruEntry(chunk.subsets,membership);
      if (subset)subsetHits++;
      else {
        const build=()=>buildGlobeOutlinePointSubset(part,[...chunk.roles.values()].flatMap(({row})=>row.ranges).sort((a,b)=>a[0]-b[0]));
        subset=residency?.withTemporary(chunk.selectedCount*72+part.count*4,'outline-subset',build)??build();
        subsetBuilds++;chunk.subsets.set(membership,subset);trimLruCount(chunk.subsets,subsetLimit);markChunk(chunk);
      }
    }
    if (gpu&&gpu.capacity===capacity&&gpu.direct===direct&&(direct||gpu.subset===subset)) {gpu.membershipRevision=chunk.membershipRevision;return gpu;}
    if (gpu&&capacity<gpu.capacity)shrunkBuffers++;
    const reuseTexture=gpu&&!direct&&gpu.subset===subset?gpu.texture:null;
    const signature=membership+':'+capacity+':'+Number(direct)+':'+(subset===null?'direct':'subset');
    let replacement=chunk.pendingGpu;
    if (replacement&&replacement.signature!==signature) {disposePendingGpu(chunk);replacement=null;}
    if (!replacement) {
      const createBytes=capacity*(direct?100:24)+(reuseTexture?0:(subset?.points.byteLength??0)*2);
      if (gpuFrameBudget&&!gpuFrameBudget.admitCreate(createBytes,1))return null;
      const create=()=>newGpu(chunk,subset,capacity,reuseTexture);
      replacement=residency?.withTemporary(createBytes,'outline-gpu',create)??create();
      replacement.signature=signature;chunk.pendingGpu=replacement;
    }
    if (!replacement.ready) {
      if (prepareGpuMesh&&!prepareGpuMesh(replacement.mesh))return null;
      replacement.ready=true;
    }
    disposeGpu(chunk,{keepTexture:Boolean(reuseTexture)});
    chunk.gpu=replacement;chunk.pendingGpu=null;markChunk(chunk);return replacement;
  }
  function update(getCuller, strokePadding, stats) {
    const cull = getCuller(strokePadding(options, 1));
    for (const chunk of activeChunks) {
      const partition = partitions[chunk.id], part = partition.packet;
      stats.segments+=chunk.selectedCount; stats.ranges+=partition.index.leafCount;
      if (!partition.index.rootBounds||!cull(partition.index.rootBounds)) {hideMesh(chunk); continue;}
      chunk.selection??=createGlobeSpatialSelection(part, partition.index);
      const selected = chunk.selection.select(cull, chunk.membershipRevision, group => chunk.roles.has(group));
      if (chunk.selected?.ranges!==selected.ranges) {chunk.selected = selected; markChunk(chunk);}
      stats.submittedSegments+=selected.count; stats.visibleRanges+=selected.leaves;
      if (!selected.count) {hideMesh(chunk); continue;}
      const gpu=ensureGpu(chunk,selected.count);if(!gpu)continue;
      const {mesh,output,subset}=gpu;
      const rangesChanged = gpu.ranges!==selected.ranges, rolesChanged = gpu.roleRevision!==chunk.roleRevision;
      if (rangesChanged||rolesChanged) {
        const writes=planGlobeCompactionUpdates(selected.ranges,gpu.ranges??new Uint32Array());
        const uploadBytes=writes.reduce((sum,row)=>sum+(row.end-row.first)*(gpu.direct?48:8)+selected.count*2,0);
        if (uploadBytes&&gpuFrameBudget&&!gpuFrameBudget.admitCompaction(uploadBytes,1))continue;
        for (const {first, end, offset} of writes) {
          let dst = offset;
          for (let id = first; id<end; id++, dst++) {
            if (gpu.direct) {
              const a = part.endpointIndices[id*2]*6, b = part.endpointIndices[id*2+1]*6;
              for (let axis = 0; axis<3; axis++) {
                output.start[dst*3+axis] = part.points[a+axis]; output.startLow[dst*3+axis] = part.points[a+axis+3];
                output.end[dst*3+axis] = part.points[b+axis]; output.endLow[dst*3+axis] = part.points[b+axis+3];
              }
            }else {
              const at = subset.segmentOffsets[id]*2;
              output.endpointIndices[dst*2] = subset.endpointIndices[at]; output.endpointIndices[dst*2+1] = subset.endpointIndices[at+1];
            }
            output.ownerGroups[dst] = chunk.roles.get(part.ownerGroups[id]).code;
          }
        }
        for (const name of gpu.names)stats.compactionUploadBytes+=applyGlobeDrawWrites(mesh.geometry.getAttribute(name), writes);
        if (rolesChanged) {
          let offset = 0;
          for (let i = 0; i<selected.ranges.length; i+=2)for (let id = selected.ranges[i]; id<selected.ranges[i+1]; id++)
            output.ownerGroups[offset++] = chunk.roles.get(part.ownerGroups[id]).code;
          stats.compactionUploadBytes+=applyGlobeDrawWrites(mesh.geometry.getAttribute('ownerGroup'), [{first:0, end:selected.count, offset:0}]);
        }else stats.compactionUploadBytes+=applyGlobeDrawWrites(mesh.geometry.getAttribute('ownerGroup'), writes);
        gpu.ranges = selected.ranges; gpu.roleRevision = chunk.roleRevision; markChunk(chunk);
      }
      stats.strokeDrawCalls++; if (gpu.direct)stats.directStrokeSegments+=selected.count;
      mesh.geometry.instanceCount = selected.count;
      if (!mesh.visible) {mesh.visible = true; markChunk(chunk);}
      chunk.lastUsed = lastUsed = performance.now();
    }
  }
  function chunkFootprint(chunk) {
    const gpu = chunk.gpu;
    const row = gpuResourceFootprint(gpu?[gpu.mesh.geometry]:[], gpu?.texture?[gpu.texture.texture]:[],
      [chunk.selection?.footprint(), chunk.selected?.ranges, ...chunk.subsets.values(), gpu?.subset, gpu?.output, gpu?.ranges]);
    row.extraBytes+=chunk.roles.size*48+96;
    return row;
  }
  function footprint() {
    const buffers = new Set(packetBuffers); let extraBytes = index.metadataBytes;
    for (const chunk of chunks.values()) {
      const row = chunkFootprint(chunk);
      for (const buffer of row.buffers)buffers.add(buffer);
      extraBytes+=row.extraBytes;
    }
    return {buffers, extraBytes};
  }
  function bytes() {return renderFootprintBytes(footprint());}
  // Only altered chunk records enter the global ledger. An active base
  // packet no longer forces its entire cache to be traversed on each hover.
  function syncResidency({active, evict}) {
    if (baseDirty||ledgerActive!==active) {
      residency?.set(baseKey, {buffers:packetBuffers, extraBytes:index.metadataBytes, lastUsed, protected:active,
       groups:['outline','outlinePacket'], evict});
      baseDirty = false; ledgerActive = active;
    }
    for (const chunk of dirtyChunks) {
      if (chunks.get(chunk.id)!==chunk) {residency?.remove(chunk); continue;}
      const row = chunkFootprint(chunk);
      residency?.set(chunk, {...row, lastUsed:chunk.lastUsed, protected:!chunk.gpu||chunk.gpu.mesh.visible,
       groups:['outline','outlineChunk'], evict:() => evictChunk(chunk)});
    }
    dirtyChunks.clear();
  }
  function dispose() {
    residency?.remove(baseKey);
    for (const chunk of chunks.values()) {disposeGpu(chunk); residency?.remove(chunk);}
    for (const chunk of dirtyChunks)residency?.remove(chunk);
    dirtyChunks.clear(); chunks.clear(); activeChunks.clear(); previousGroups.clear();
  }
  function stats() {
    let resident = 0, visible = 0;
    for (const chunk of chunks.values())if (chunk.gpu) {resident++; if (chunk.gpu.mesh.visible)visible++;}
    return {residentChunks:resident, visibleChunks:visible, activeChunks:activeChunks.size, evictedChunks, createdChunks, shrunkBuffers, updatedChunks, subsetHits, subsetBuilds};
  }
  return {paint, hide, update, dispose, bytes, syncResidency, stats, get lastUsed() {return lastUsed;}};
}
