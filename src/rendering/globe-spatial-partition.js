// Display-only partitioning: preserve primitive and owner order. Bounds are
// in the same Cartesian coordinates as the high/low shader attributes, so
// neither longitude wrapping nor pole-specific clipping is necessary.
const emptyBounds=()=>[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
function include(bounds,high,low,offset){
 for(let axis=0;axis<3;axis++){
  const value=high[offset+axis]+low[offset+axis];
  if(value<bounds[axis])bounds[axis]=value;
  if(value>bounds[axis+3])bounds[axis+3]=value;
 }
}
function extend(bounds,other){
 for(let axis=0;axis<3;axis++){
  bounds[axis]=Math.min(bounds[axis],other[axis]);
  bounds[axis+3]=Math.max(bounds[axis+3],other[axis+3]);
 }
}
function combinedSpan(a,b){
 let span=0;
 for(let axis=0;axis<3;axis++)span=Math.max(span,Math.max(a[axis+3],b[axis+3])-Math.min(a[axis],b[axis]));
 return span;
}
function partition(count,read,{maxRanges=96,minPrimitives=128,span=.28}={}){
 if(!count)return [];
 // Limit the number of render submissions even on fragmented source order.
 // Split contiguous primitive ranges whenever their spatial extent grows.
 const minCount=Math.max(minPrimitives,Math.ceil(count/maxRanges));
 const maxCount=minCount*4,ranges=[];
 let first=0,bounds=emptyBounds(),primitive=emptyBounds();
 for(let i=0;i<count;i++){
  for(let axis=0;axis<3;axis++){primitive[axis]=Infinity;primitive[axis+3]=-Infinity;}
  read(i,primitive);
  if(i-first>=minCount&&(i-first>=maxCount||combinedSpan(bounds,primitive)>span)){
   ranges.push({first,end:i,bounds});first=i;bounds=emptyBounds();
  }
  extend(bounds,primitive);
 }
 ranges.push({first,end:count,bounds});
 return ranges;
}
export function partitionGlobeMesh(packet,options){
 return partition(packet.indices.length/3,(i,bounds)=>{
  for(let j=i*3;j<i*3+3;j++)include(bounds,packet.positions,packet.residuals,packet.indices[j]*3);
 },options);
}
export function partitionGlobeStrokes(packet,options){
 return partition(packet.count,(i,bounds)=>{
  include(bounds,packet.start,packet.startLow,i*3);include(bounds,packet.end,packet.endLow,i*3);
 },options);
}
export function globeStrokeRange(packet,first,end){
 const result={count:end-first,widths:packet.widths.subarray(first,end),ownerGroups:packet.ownerGroups.subarray(first,end)};
 for(const key of ['start','startLow','end','endLow'])result[key]=packet[key].subarray(first*3,end*3);
 return result;
}

function maxDot(bounds,vector){
 let sum=0;
 for(let axis=0;axis<3;axis++)sum+=vector[axis]*bounds[axis+(vector[axis]>=0?3:0)];
 return sum;
}
function minNormSquared(bounds){
 let sum=0;
 for(let axis=0;axis<3;axis++){
  const value=bounds[axis]>0?bounds[axis]:bounds[axis+3]<0?bounds[axis+3]:0;
  sum+=value*value;
 }
 return sum;
}

/** Conservative frustum and horizon planes for the actual shader camera.
 * Chord interiors and stroke-expanded endpoints are included. Never cull
 * simply because all individual vertices lie outside the viewport.
 */
export function createGlobeRangeCuller(frame,width,height,padding=0){
 const {eye,right,up,forward,focal,center}=frame;
 const planes=[];
 const add=(axis,sign,slope)=>{
  const vector=axis.map((value,i)=>sign*value+slope*forward[i]);
  planes.push([vector,dot(vector,eye)]);
 };
 add(right,1,(center[0]+padding)/focal);
 add(right,-1,(width-center[0]+padding)/focal);
 add(up,1,(height-center[1]+padding)/focal);
 add(up,-1,(center[1]+padding)/focal);
 planes.push([forward,dot(forward,eye)]);
 // High/low attributes and shader arithmetic are float32. Keep a small
 // conservative allowance at silhouettes, clip edges and extreme zoom.
 const epsilon=2e-6*(1+Math.hypot(...eye));
 for(const plane of planes)plane[1]-=epsilon*Math.max(1,Math.hypot(...plane[0]));
 return bounds=>{
  if(maxDot(bounds,eye)<minNormSquared(bounds)-epsilon)return false;
  for(const [normal,offset] of planes)
   if(maxDot(bounds,normal)<offset)return false;
  return true;
 };
}

// Adjacent admitted triangles share one indexed submission; original index
// order is preserved, including overlap priority between territorial slots.
export function visibleGlobeMeshRanges(ranges,visible){
 const selected=[];
 for(const range of ranges){
  if(!visible(range.bounds))continue;
  const previous=selected.at(-1);
  if(previous&&previous.end===range.first)previous.end=range.end;
  else selected.push({first:range.first,end:range.end});
 }
 return selected;
}
