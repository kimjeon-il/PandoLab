import {createGlobeSpatialSelection} from './globe-spatial-partition.js';
import {createThreeGlobeStrokes,createGlobeStrokePointTexture} from './three-globe-strokes.js';
import {renderPacketBuffers} from './render-cache-budget.js';
import {planGlobeCompactionUpdates,applyGlobeDrawWrites,useDirectGlobeStrokeAttributes} from './globe-draw-compaction.js';

function indexOwners(owners){
  const groupsBySlot=new Map();
  owners.forEach((slots,group)=>{
    for(const slot of slots){
      let groups=groupsBySlot.get(slot);
      if(!groups){groups=[];groupsBySlot.set(slot,groups);}
      groups.push(group);
    }
  });
  return groupsBySlot;
}
export function indexGlobeOutlineRanges(packet,owners){
  const groupsBySlot=indexOwners(owners),rangesByGroup=Array.from({length:owners.length},()=>[]);
  for(let first=0;first<packet.count;){
    const group=packet.ownerGroups[first];
    let end=first+1;
    while(end<packet.count&&packet.ownerGroups[end]===group)end++;
    rangesByGroup[group].push([first,end]);first=end;
  }
  return {groupsBySlot,rangesByGroup};
}
export function selectGlobeOutlineGroups(index,roles,styles){
  const groups=new Map();
  for(const [slot,code] of roles){
    const style=styles[code];
    if(!style||style.width<=0||style.alpha<=0)continue;
    for(const group of index.groupsBySlot.get(slot)??[]){
      if(code>(groups.get(group)??0))groups.set(group,code);
    }
  }
  return groups;
}
export function globeOutlineRanges(index,groups){
  return [...groups].flatMap(([group,code])=>index.rangesByGroup[group].map(([first,end])=>({first,end,code})))
    .sort((a,b)=>a.first-b.first);
}

// One immutable reverse index: changing one owner group visits only its
// affected chunks, even for a base packet spanning the entire world.
export function indexGlobeOutlineChunks(packet,owners){
  const groupsBySlot=indexOwners(owners);
  const chunksByGroup=Array.from({length:owners.length},()=>[]);
  let metadataBytes=owners.reduce((sum,slots)=>sum+slots.length*8,0)+owners.length*24;
  packet.spatialParts.forEach(({packet:part},chunkId)=>{
    const groups=new Map();
    for(let first=0;first<part.count;){
      const group=part.ownerGroups[first];
      let end=first+1;while(end<part.count&&part.ownerGroups[end]===group)end++;
      let row=groups.get(group);
      if(!row){row={chunkId,count:0,ranges:[]};groups.set(group,row);chunksByGroup[group].push(row);metadataBytes+=48;}
      row.count+=end-first;row.ranges.push([first,end]);metadataBytes+=32;first=end;
    }
  });
  return {groupsBySlot,chunksByGroup,metadataBytes};
}

// Only points referenced by active owners enter the texture dictionary.
// Preserve all six Float32 words, including the low-coordinate residuals.
// The short local segment lookup never duplicates the full point dictionary.
export function buildGlobeOutlinePointSubset(packet,ranges){
  const count=ranges.reduce((sum,[first,end])=>sum+end-first,0);
  const sourceWords=new Uint32Array(packet.points.buffer,packet.points.byteOffset,packet.points.length);
  const words=new Uint32Array(count*12),endpointIndices=new Uint32Array(count*2);
  const segmentOffsets=new Int32Array(packet.count).fill(-1),remap=new Map();
  let offset=0,pointCount=0;
  for(const [first,end] of ranges)for(let segment=first;segment<end;segment++){
    segmentOffsets[segment]=offset;
    for(let side=0;side<2;side++){
      const id=packet.endpointIndices[segment*2+side];
      let local=remap.get(id);
      if(local===undefined){
        local=pointCount++;remap.set(id,local);
        words.set(sourceWords.subarray(id*6,id*6+6),local*6);
      }
      endpointIndices[offset*2+side]=local;
    }
    offset++;
  }
  return {points:new Float32Array(words.slice(0,pointCount*6).buffer),endpointIndices,segmentOffsets,count};
}

export function outlineInstanceCapacity(current,needed,limit){
  if(needed>limit)throw Error('Outline selection exceeds chunk capacity');
  if(!needed)return current;
  if(current>=needed&&needed>current/4)return current;
  const desired=Math.max(32,2**Math.ceil(Math.log2(needed)));
  return Math.min(limit,desired);
}
const bytesOf=buffers=>[...buffers].reduce((sum,buffer)=>sum+buffer.byteLength,0);

export function createGlobeOutlineCache(THREE,{scene,packet,owners,strokeOptions,maxTextureSize,orderForChunk,residency,onResidencyChange=()=>{}}){
  const index=indexGlobeOutlineChunks(packet,owners),partitions=packet.spatialParts;
  const packetBuffers=renderPacketBuffers(packet);
  const outlineStyles=Array.from({length:5},()=>new THREE.Vector2());
  const strokeColor=new THREE.Color(strokeOptions.style.color);
  const options={...strokeOptions,order:6,outlineUniforms:{outlineStyles:{value:outlineStyles}}};
  const chunks=new Map(),activeChunks=new Set(),dirtyChunks=new Set(),baseKey={};
  let baseDirty=true,ledgerActive=null;
  function markChunk(chunk){dirtyChunks.add(chunk);onResidencyChange();}
  let previousGroups=new Map(),lastUsed=performance.now();
  let evictedChunks=0,createdChunks=0,shrunkBuffers=0,updatedChunks=0;
  function hideMesh(chunk){
    if(chunk.gpu?.mesh.visible){chunk.gpu.mesh.visible=false;chunk.lastUsed=performance.now();markChunk(chunk);}
  }
  function disposeGpu(chunk,{keepTexture=false}={}){
    const gpu=chunk.gpu;
    if(!gpu)return;
    scene.remove(gpu.mesh);gpu.mesh.geometry.dispose();gpu.mesh.material.dispose();if(!keepTexture)gpu.texture?.texture.dispose();
    chunk.gpu=null;markChunk(chunk);
  }
  function evictChunk(chunk){
    if(!chunk.gpu)return;
    disposeGpu(chunk);evictedChunks++;
    chunk.selection=null;chunk.selected=null;
    if(!chunk.roles.size)chunks.delete(chunk.id);
    else residency?.set(chunk,{...chunkFootprint(chunk),lastUsed:chunk.lastUsed,protected:true,groups:['outline','outlineChunk']});
    markChunk(chunk);
  }
  function clearInactive(chunk){
    hideMesh(chunk);activeChunks.delete(chunk);
    chunk.selection=null;chunk.selected=null;
    if(!chunk.gpu)chunks.delete(chunk.id);
    markChunk(chunk);
  }
  function paint(roles,styles,color){
    for(let code=0;code<outlineStyles.length;code++){
      const style=styles[code];outlineStyles[code].set((style?.width??0)/2,style?.alpha??0);
    }
    if(color!==undefined&&color!==null)strokeColor.set(color);
    const groups=selectGlobeOutlineGroups(index,roles,styles),changed=new Set([...previousGroups.keys(),...groups.keys()]);
    const touched=new Map();
    for(const group of changed){
      const before=previousGroups.get(group),after=groups.get(group);
      if(before===after)continue;
      for(const row of index.chunksByGroup[group]){
        let chunk=chunks.get(row.chunkId);
        if(!chunk){chunk={id:row.chunkId,roles:new Map(),selectedCount:0,membershipRevision:0,roleRevision:0,selection:null,selected:null,gpu:null,lastUsed:performance.now()};chunks.set(chunk.id,chunk);}
        if(after===undefined){chunk.roles.delete(group);chunk.selectedCount-=row.count;}
        else{
          chunk.roles.set(group,{code:after,row});
          if(before===undefined)chunk.selectedCount+=row.count;
        }
        touched.set(chunk,(touched.get(chunk)??false)||before===undefined||after===undefined);
      }
    }
    for(const [chunk,membershipChanged] of touched){
      chunk.roleRevision++;
      if(membershipChanged)chunk.membershipRevision++;
      if(chunk.roles.size){activeChunks.add(chunk);markChunk(chunk);}else clearInactive(chunk);
    }
    previousGroups=groups;
    if(touched.size){updatedChunks+=touched.size;lastUsed=performance.now();baseDirty=true;onResidencyChange();}
    return activeChunks.size>0;
  }
  function hide(){
    if(!activeChunks.size)return;
    for(const chunk of [...activeChunks]){
      chunk.roles.clear();chunk.selectedCount=0;chunk.membershipRevision++;chunk.roleRevision++;clearInactive(chunk);
    }
    previousGroups=new Map();lastUsed=performance.now();baseDirty=true;onResidencyChange();
  }
  function newGpu(chunk,subset,capacity,reuseTexture=null){
    const direct=useDirectGlobeStrokeAttributes({count:capacity});
    const output={count:capacity,widths:new Float32Array(0),ownerGroups:new Uint16Array(capacity)};
    const names=direct?['start','startLow','end','endLow']:['endpointIndices'];
    if(direct)for(const name of names)output[name]=new Float32Array(capacity*3);
    else output.endpointIndices=new Uint32Array(capacity*2);
    const texture=direct?null:reuseTexture??createGlobeStrokePointTexture(THREE,subset.points,maxTextureSize);
    const mesh=createThreeGlobeStrokes(THREE,{...options,order:orderForChunk(chunk.id,partitions.length),packet:output,pointUniforms:texture?.uniforms});
    mesh.material.uniforms.strokeColor.value=strokeColor;
    for(const name of [...names,'ownerGroup'])mesh.geometry.getAttribute(name).setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.instanceCount=0;mesh.visible=false;scene.add(mesh);
    createdChunks++;
    return {mesh,texture,output,capacity,subset,direct,names,sourceGroups:new Set(chunk.roles.keys()),membershipRevision:chunk.membershipRevision,roleRevision:-1,ranges:null};
  }
  function ensureGpu(chunk,needed){
    let gpu=chunk.gpu;
    const part=partitions[chunk.id].packet;
    let same=!!gpu;
    if(gpu&&gpu.membershipRevision!==chunk.membershipRevision){
      same=gpu.sourceGroups.size===chunk.roles.size&&[...chunk.roles.keys()].every(group=>gpu.sourceGroups.has(group));
      if(same)gpu.membershipRevision=chunk.membershipRevision;
    }
    const capacity=outlineInstanceCapacity(gpu?.capacity??0,needed,part.count);
    if(!gpu||!same||capacity!==gpu.capacity){
      const subset=same?gpu.subset:buildGlobeOutlinePointSubset(part,[...chunk.roles.values()].flatMap(({row})=>row.ranges).sort((a,b)=>a[0]-b[0]));
      if(gpu&&capacity<gpu.capacity)shrunkBuffers++;
      const reuseTexture=same&&!useDirectGlobeStrokeAttributes({count:capacity})?gpu.texture:null;
      disposeGpu(chunk,{keepTexture:Boolean(reuseTexture)});
      chunk.gpu=gpu=newGpu(chunk,subset,capacity,reuseTexture);markChunk(chunk);
    }
    return gpu;
  }
  function update(getCuller,strokePadding,stats){
    const cull=getCuller(strokePadding(options,1));
    for(const chunk of activeChunks){
      const partition=partitions[chunk.id],part=partition.packet;
      stats.segments+=chunk.selectedCount;stats.ranges+=partition.index.leafCount;
      if(!partition.index.rootBounds||!cull(partition.index.rootBounds)){hideMesh(chunk);continue;}
      chunk.selection??=createGlobeSpatialSelection(part,partition.index);
      const selected=chunk.selection.select(cull,chunk.membershipRevision,group=>chunk.roles.has(group));
      if(chunk.selected?.ranges!==selected.ranges){chunk.selected=selected;markChunk(chunk);}
      stats.submittedSegments+=selected.count;stats.visibleRanges+=selected.leaves;
      if(!selected.count){hideMesh(chunk);continue;}
      const gpu=ensureGpu(chunk,selected.count),{mesh,output,subset}=gpu;
      const rangesChanged=gpu.ranges!==selected.ranges,rolesChanged=gpu.roleRevision!==chunk.roleRevision;
      if(rangesChanged||rolesChanged){
        const writes=planGlobeCompactionUpdates(selected.ranges,gpu.ranges??new Uint32Array());
        for(const {first,end,offset} of writes){
          let dst=offset;
          for(let id=first;id<end;id++,dst++){
            const at=subset.segmentOffsets[id]*2,a=subset.endpointIndices[at],b=subset.endpointIndices[at+1];
            if(gpu.direct){
              for(let axis=0;axis<3;axis++){
                output.start[dst*3+axis]=subset.points[a*6+axis];output.startLow[dst*3+axis]=subset.points[a*6+axis+3];
                output.end[dst*3+axis]=subset.points[b*6+axis];output.endLow[dst*3+axis]=subset.points[b*6+axis+3];
              }
            }else{output.endpointIndices[dst*2]=a;output.endpointIndices[dst*2+1]=b;}
            output.ownerGroups[dst]=chunk.roles.get(part.ownerGroups[id]).code;
          }
        }
        for(const name of gpu.names)stats.compactionUploadBytes+=applyGlobeDrawWrites(mesh.geometry.getAttribute(name),writes);
        if(rolesChanged){
          let offset=0;
          for(let i=0;i<selected.ranges.length;i+=2)for(let id=selected.ranges[i];id<selected.ranges[i+1];id++)
            output.ownerGroups[offset++]=chunk.roles.get(part.ownerGroups[id]).code;
          stats.compactionUploadBytes+=applyGlobeDrawWrites(mesh.geometry.getAttribute('ownerGroup'),[{first:0,end:selected.count,offset:0}]);
        }else stats.compactionUploadBytes+=applyGlobeDrawWrites(mesh.geometry.getAttribute('ownerGroup'),writes);
        gpu.ranges=selected.ranges;gpu.roleRevision=chunk.roleRevision;markChunk(chunk);
      }
      stats.strokeDrawCalls++;if(gpu.direct)stats.directStrokeSegments+=selected.count;
      mesh.geometry.instanceCount=selected.count;
      if(!mesh.visible){mesh.visible=true;markChunk(chunk);}
      chunk.lastUsed=lastUsed=performance.now();
    }
  }
  function chunkFootprint(chunk){
    const gpu=chunk.gpu;
    const buffers=renderPacketBuffers([chunk.selected?.ranges,gpu?.subset,gpu?.output,gpu?.ranges]);
    let extraBytes=chunk.roles.size*48+96;
    if(gpu){
      const geometry=gpu.mesh.geometry;
      for(const attribute of [...Object.values(geometry.attributes),geometry.index]){
        buffers.add(attribute.array.buffer);extraBytes+=attribute.array.byteLength;
      }
      if(gpu.texture){buffers.add(gpu.texture.texture.image.data.buffer);extraBytes+=gpu.texture.bytes;}
    }
    return {buffers,extraBytes};
  }
  function footprint(){
    const buffers=new Set(packetBuffers);let extraBytes=index.metadataBytes;
    for(const chunk of chunks.values()){
      const row=chunkFootprint(chunk);
      for(const buffer of row.buffers)buffers.add(buffer);
      extraBytes+=row.extraBytes;
    }
    return {buffers,extraBytes};
  }
  function bytes(){const row=footprint();return bytesOf(row.buffers)+row.extraBytes;}
  // Only altered chunk records enter the global ledger. An active base
  // packet no longer forces its entire cache to be traversed on each hover.
  function syncResidency({active,evict}){
    if(baseDirty||ledgerActive!==active){
      residency?.set(baseKey,{buffers:packetBuffers,extraBytes:index.metadataBytes,lastUsed,protected:active,
       groups:['outline','outlinePacket'],evict});
      baseDirty=false;ledgerActive=active;
    }
    for(const chunk of dirtyChunks){
      if(chunks.get(chunk.id)!==chunk){residency?.remove(chunk);continue;}
      const row=chunkFootprint(chunk);
      residency?.set(chunk,{...row,lastUsed:chunk.lastUsed,protected:!chunk.gpu||chunk.gpu.mesh.visible,
       groups:['outline','outlineChunk'],evict:()=>evictChunk(chunk)});
    }
    dirtyChunks.clear();
  }
  function dispose(){
    residency?.remove(baseKey);
    for(const chunk of chunks.values()){disposeGpu(chunk);residency?.remove(chunk);}
    for(const chunk of dirtyChunks)residency?.remove(chunk);
    dirtyChunks.clear();chunks.clear();activeChunks.clear();previousGroups.clear();
  }
  function stats(){
    let resident=0,visible=0;
    for(const chunk of chunks.values())if(chunk.gpu){resident++;if(chunk.gpu.mesh.visible)visible++;}
    return {residentChunks:resident,visibleChunks:visible,activeChunks:activeChunks.size,evictedChunks,createdChunks,shrunkBuffers,updatedChunks};
  }
  return {paint,hide,update,dispose,bytes,syncResidency,stats,get lastUsed(){return lastUsed;}};
}
