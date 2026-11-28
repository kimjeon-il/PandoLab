// A compacted GPU stream is the original-order concatenation of selected
// primitive runs. Compare source positions at the same destination position;
// copy only intervals whose source mapping actually changed.
export function planGlobeCompactionUpdates(next, previous = new Uint32Array()) {
  const writes = []; let prior = 0, priorAt = 0, destination = 0;
  function add(first, end, offset) {
    const tail = writes.at(-1);
    if (tail&&tail.end===first&&tail.offset+tail.end-tail.first===offset)tail.end = end;
    else writes.push({first, end, offset});
  }
  for (let i = 0; i<next.length; i+=2) {
    let first = next[i], end = next[i+1];
    while (first<end) {
      while (prior<previous.length&&priorAt+previous[prior+1]-previous[prior]<=destination) {
        priorAt+=previous[prior+1]-previous[prior]; prior+=2;
      }
      if (prior>=previous.length) {
        add(first, end, destination); destination+=end-first; break;
      }
      const priorSource = previous[prior]+destination-priorAt;
      const count = Math.min(end-first, previous[prior+1]-priorSource);
      if (priorSource!==first)add(first, first+count, destination);
      first+=count; destination+=count;
    }
  }
  return writes;
}

// Limit both bytes and interval count. More than 32 intervals would widen
// applyGlobeDrawWrites' actual upload beyond the selected slice.
export function takeGlobeDrawWriteSlice(writes,cursor,maxPrimitives,maxRanges=32) {
  let index=cursor.index,offset=cursor.offset,remaining=Math.max(0,Math.floor(maxPrimitives)),count=0;
  const rows=[];
  while(index<writes.length&&remaining>0&&rows.length<maxRanges) {
    const row=writes[index],size=Math.min(remaining,row.end-row.first-offset);
    if (size<=0) {index++;offset=0;continue;}
    rows.push({first:row.first+offset,end:row.first+offset+size,offset:row.offset+offset});
    count+=size;remaining-=size;offset+=size;
    if(offset===row.end-row.first){index++;offset=0;}
  }
  return {writes:rows,cursor:{index,offset},count,complete:index>=writes.length};
}
export function estimateGlobeDrawWriteBytes(writes,bytesPerPrimitive) {
  if (!writes.length)return 0;
  if (writes.length>32) {
    const first=writes[0],last=writes.at(-1);
    return (last.offset+last.end-last.first-first.offset)*bytesPerPrimitive;
  }
  return writes.reduce((sum,row)=>sum+row.end-row.first,0)*bytesPerPrimitive;
}
export function mergeGlobeDrawRanges(parts) {
  const result = []; let count = 0;
  for (const {ranges, offset = 0} of parts)for (let i = 0; i<ranges.length; i+=2) {
    const first = ranges[i]+offset, end = ranges[i+1]+offset;
    if (result.length&&result.at(-1)===first)result[result.length-1] = end;
    else result.push(first, end);
    count+=end-first;
  }
  return {ranges:Uint32Array.from(result), count};
}

export function applyGlobeDrawWrites(attribute, writes, stride = attribute.itemSize) {
  if (!writes.length)return 0;
  attribute.clearUpdateRanges();
  let uploaded = 0;
  // Avoid a driver call for every tiny interleaved interval.
  if (writes.length>32) {
    const first = writes[0].offset*stride, last = writes.at(-1);
    const end = (last.offset+last.end-last.first)*stride;
    attribute.addUpdateRange(first, end-first); uploaded = end-first;
  }else {
    let start = -1, end = -1;
    for (const row of writes) {
      const a = row.offset*stride, b = (row.offset+row.end-row.first)*stride;
      if (a<=end)end = Math.max(end, b);
      else {if (start>=0) {attribute.addUpdateRange(start, end-start); uploaded+=end-start;}start = a; end = b;}
    }
    if (start>=0) {attribute.addUpdateRange(start, end-start); uploaded+=end-start;}
  }
  attribute.needsUpdate = true;
  return uploaded*attribute.array.BYTES_PER_ELEMENT;
}

export function copyGlobeDrawWrites(attribute, source, writes, stride = attribute.itemSize) {
  for (const {first, end, offset} of writes)attribute.array.set(source.subarray(first*stride, end*stride), offset*stride);
  return applyGlobeDrawWrites(attribute, writes, stride);
}

// Small packets use vertex attributes instead of four texture fetches per
// quad vertex. This avoids paying the texture indirection for sparse batches,
// while keeping large packets in the compact indexed format.
export function useDirectGlobeStrokeAttributes(packet, limit = 2048) {
  return packet.count>0&&packet.count<=limit;
}
export function writeDirectGlobeStrokes(output, packet, writes) {
  const points = packet.points, indices = packet.endpointIndices;
  for (const {first, end, offset} of writes) {
    let at = offset*3;
    for (let segment = first; segment<end; segment++, at+=3) {
      const a = indices[segment*2]*6, b = indices[segment*2+1]*6;
      for (let axis = 0; axis<3; axis++) {
        output.start[at+axis] = points[a+axis]; output.startLow[at+axis] = points[a+axis+3];
        output.end[at+axis] = points[b+axis]; output.endLow[at+axis] = points[b+axis+3];
      }
    }
  }
}

// A few fixed source blocks bound the amount of data shifted by an insertion.
// Keep the small-packet one-draw path, and never create a draw per leaf.
export function globeDrawBlockSize(count) {
  return count<=65536?Math.max(1, count):Math.max(32768, Math.ceil(count/2));
}
export function globeBufferCapacity(current, needed, limit, minimum, empty = 0) {
  if (!needed)return empty;
  if (current>=needed&&needed>current/4)return current;
  return Math.min(limit, Math.max(minimum, 2**Math.ceil(Math.log2(needed))));
}
export function globeDrawCapacity(current, needed, limit) {
  return globeBufferCapacity(current, needed, limit, 128);
}
export function splitGlobeDrawRanges(ranges, count, blockSize = globeDrawBlockSize(count)) {
  const blocks = new Map();
  for (let i = 0; i<ranges.length; i+=2) {
    let at = ranges[i]; const end = ranges[i+1];
    while (at<end) {
      const block = Math.floor(at/blockSize),first=block*blockSize,last=Math.min(end,first+blockSize);
      let row = blocks.get(block); if (!row) {row = {id:block, limit:Math.min(blockSize, count-first), ranges:[], count:0}; blocks.set(block, row);}
      row.ranges.push(at, last); row.count+=last-at; at = last;
    }
  }
  return [...blocks.values()].map(row => ({...row, ranges:Uint32Array.from(row.ranges)}));
}
export function globeDrawGroups(blocks) {
  const groups = [];
  for (const {offset, count} of blocks) {
    if (!count)continue;
    const prior = groups.at(-1);
    if (prior&&prior.start+prior.count===offset*3)prior.count+=count*3;
    else groups.push({start:offset*3, count:count*3});
  }
  return groups;
}

export const GLOBE_GPU_MESH_BATCH_LIMITS = Object.freeze({
  maxTriangles:65_536,maxVertices:262_144,maxChunks:64,maxCellSpan:4,
});
const cellCoordinates=value=>{
  if(value===null||value===undefined)return null;
  const parts=String(value).split(':').map(Number);
  return parts.length===3&&parts.every(Number.isSafeInteger)?parts:null;
};
export function globeMeshCellKey(row) {
  if(row.cell!==undefined&&row.cell!==null)return String(row.cell);
  const bounds=row.bounds;
  if(!Array.isArray(bounds)||bounds.length!==6||!bounds.every(Number.isFinite))return null;
  return bounds.slice(0,3).map((min,axis)=>Math.floor((min+bounds[axis+3]+2)*2)).join(':');
}
export function globeMeshCellState(cell) {
  const coordinates=cellCoordinates(cell);
  return {cellKey:cell===null?null:String(cell),cellBounds:coordinates?[...coordinates,...coordinates]:null};
}
export function canAppendGlobeMeshCell(group,cell,maxCellSpan=GLOBE_GPU_MESH_BATCH_LIMITS.maxCellSpan) {
  const key=cell===null?null:String(cell);
  if(group.cellKey===key)return true;
  const coordinates=cellCoordinates(cell);
  if(!coordinates||!group.cellBounds)return false;
  for(let axis=0;axis<3;axis++) {
    const span=Math.max(group.cellBounds[axis+3],coordinates[axis])-Math.min(group.cellBounds[axis],coordinates[axis]);
    if(span>=maxCellSpan)return false;
  }
  return true;
}
export function includeGlobeMeshCell(group,cell) {
  const key=cell===null?null:String(cell);
  if(group.cellKey===key)return;
  const coordinates=cellCoordinates(cell);
  if(!coordinates)return;
  if(!group.cellBounds)group.cellBounds=[...coordinates,...coordinates];
  else for(let axis=0;axis<3;axis++) {
    group.cellBounds[axis]=Math.min(group.cellBounds[axis],coordinates[axis]);
    group.cellBounds[axis+3]=Math.max(group.cellBounds[axis+3],coordinates[axis]);
  }
}

/** Merge consecutive compatible packets in a bounded spatial neighborhood.
  * Preserve painter order and each source packet's spatial sub-index. */
export function groupGlobeGpuMeshes(rows, compatibility, {
  maxTriangles=GLOBE_GPU_MESH_BATCH_LIMITS.maxTriangles,
  maxVertices=GLOBE_GPU_MESH_BATCH_LIMITS.maxVertices,
  maxChunks=GLOBE_GPU_MESH_BATCH_LIMITS.maxChunks,
  maxCellSpan=GLOBE_GPU_MESH_BATCH_LIMITS.maxCellSpan,
}={}) {
  const result=[];
  for(const row of rows) {
    const packet=row.mesh.packet,triangles=packet.indices.length/3,vertices=packet.positions.length/3;
    const style=compatibility(row),cell=globeMeshCellKey(row),prior=result.at(-1);
    if(prior&&prior.style===style&&canAppendGlobeMeshCell(prior,cell,maxCellSpan)&&
      prior.rows.length<maxChunks&&prior.triangles+triangles<=maxTriangles&&prior.vertices+vertices<=maxVertices) {
      prior.rows.push(row);prior.triangles+=triangles;prior.vertices+=vertices;includeGlobeMeshCell(prior,cell);
    }else result.push({rows:[row],style,cell,triangles,vertices,...globeMeshCellState(cell)});
  }
  return result.map(group=>({...group,key:group.rows.length===1?group.rows[0].key:
    'gpu-batch:'+JSON.stringify(group.rows.map(row=>row.key))}));
}
export function combineGlobeDrawMeshes(rows) {
  if (rows.length===1)return rows[0].mesh.packet;
  let vertices = 0, indicesCount = 0, hasSlots = false;
  for (const {mesh:{packet}} of rows) {vertices+=packet.positions.length/3;indicesCount+=packet.indices.length;hasSlots||=packet.slots.length>0;}
  const positions = new Float32Array(vertices*3), residuals = new Float32Array(vertices*3), indices = new Uint32Array(indicesCount), slots = new Uint16Array(hasSlots?vertices:0);
  const parts = []; let vertex = 0, at = 0;
  for (const {mesh:{packet}} of rows) {
    positions.set(packet.positions, vertex*3); residuals.set(packet.residuals, vertex*3);
    if (packet.slots.length)slots.set(packet.slots, vertex);
    for (let i = 0; i<packet.indices.length; i++)indices[at+i] = packet.indices[i]+vertex;
    parts.push({packet, index:packet.spatial, offset:at/3});
    vertex+=packet.positions.length/3;at+=packet.indices.length;
  }
  return {positions, residuals, indices, slots, drawParts:parts};
}
