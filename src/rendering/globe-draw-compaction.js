// A compacted GPU stream is the original-order concatenation of selected
// primitive runs. Compare source positions at the same destination position;
// copy only intervals whose source mapping actually changed.
export function planGlobeCompactionUpdates(next,previous=new Uint32Array()){
 const writes=[];let prior=0,priorAt=0,destination=0;
 function add(first,end,offset){
  const tail=writes.at(-1);
  if(tail&&tail.end===first&&tail.offset+tail.end-tail.first===offset)tail.end=end;
  else writes.push({first,end,offset});
 }
 for(let i=0;i<next.length;i+=2){
  let first=next[i],end=next[i+1];
  while(first<end){
   while(prior<previous.length&&priorAt+previous[prior+1]-previous[prior]<=destination){
    priorAt+=previous[prior+1]-previous[prior];prior+=2;
   }
   if(prior>=previous.length){
    add(first,end,destination);destination+=end-first;break;
   }
   const priorSource=previous[prior]+destination-priorAt;
   const count=Math.min(end-first,previous[prior+1]-priorSource);
   if(priorSource!==first)add(first,first+count,destination);
   first+=count;destination+=count;
  }
 }
 return writes;
}

export function mergeGlobeDrawRanges(parts){
 const result=[];let count=0;
 for(const {ranges,offset=0} of parts)for(let i=0;i<ranges.length;i+=2){
  const first=ranges[i]+offset,end=ranges[i+1]+offset;
  if(result.length&&result.at(-1)===first)result[result.length-1]=end;
  else result.push(first,end);
  count+=end-first;
 }
 return {ranges:Uint32Array.from(result),count};
}

export function applyGlobeDrawWrites(attribute,writes,stride=attribute.itemSize){
 if(!writes.length)return 0;
 attribute.clearUpdateRanges();
 let uploaded=0;
 // Avoid a driver call for every tiny interleaved interval.
 if(writes.length>32){
  const first=writes[0].offset*stride,last=writes.at(-1);
  const end=(last.offset+last.end-last.first)*stride;
  attribute.addUpdateRange(first,end-first);uploaded=end-first;
 }else{
  let start=-1,end=-1;
  for(const row of writes){
   const a=row.offset*stride,b=(row.offset+row.end-row.first)*stride;
   if(a<=end)end=Math.max(end,b);
   else{if(start>=0){attribute.addUpdateRange(start,end-start);uploaded+=end-start;}start=a;end=b;}
  }
  if(start>=0){attribute.addUpdateRange(start,end-start);uploaded+=end-start;}
 }
 attribute.needsUpdate=true;
 return uploaded*attribute.array.BYTES_PER_ELEMENT;
}

export function copyGlobeDrawWrites(attribute,source,writes,stride=attribute.itemSize){
 for(const {first,end,offset} of writes)attribute.array.set(source.subarray(first*stride,end*stride),offset*stride);
 return applyGlobeDrawWrites(attribute,writes,stride);
}

// Small packets use vertex attributes instead of four texture fetches per
// quad vertex. This avoids paying the texture indirection for sparse batches,
// while keeping large packets in the compact indexed format.
export function useDirectGlobeStrokeAttributes(packet,limit=2048){
 return packet.count>0&&packet.count<=limit;
}
export function writeDirectGlobeStrokes(output,packet,writes){
 const points=packet.points,indices=packet.endpointIndices;
 for(const {first,end,offset} of writes){
  let at=offset*3;
  for(let segment=first;segment<end;segment++,at+=3){
   const a=indices[segment*2]*6,b=indices[segment*2+1]*6;
   for(let axis=0;axis<3;axis++){
    output.start[at+axis]=points[a+axis];output.startLow[at+axis]=points[a+axis+3];
    output.end[at+axis]=points[b+axis];output.endLow[at+axis]=points[b+axis+3];
   }
  }
 }
}
