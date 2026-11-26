import {compactGlobeStrokeRange} from './globe-mesh.js';
// Shared display and picking hierarchy: preserve original primitive and owner order. Bounds are
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
export function globeStrokeRange(packet,first,end){
 return {count:end-first,points:packet.points,endpointIndices:packet.endpointIndices.subarray(first*2,end*2),
  widths:packet.widths.subarray(first,end),ownerGroups:packet.ownerGroups.subarray(first,end)};
}

function maxDot(bounds,vector,at=0){
 let sum=0;
 for(let axis=0;axis<3;axis++)sum+=vector[axis]*bounds[at+axis+(vector[axis]>=0?3:0)];
 return sum;
}
function minNormSquared(bounds,at=0){
 let sum=0;
 for(let axis=0;axis<3;axis++){
  const value=bounds[at+axis]>0?bounds[at+axis]:bounds[at+axis+3]<0?bounds[at+axis+3]:0;
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
 return (bounds,at=0)=>{
  if(maxDot(bounds,eye,at)<minNormSquared(bounds,at)-epsilon)return false;
  for(const [normal,offset] of planes)
   if(maxDot(bounds,normal,at)<offset)return false;
  return true;
 };
}

// Sparse Morton octree. Leaf membership depends on exact Cartesian primitive
// centres, not their source order. Each node stores the union of the original
// vertex/endpoint bounds. The leaf permutation is shared by draw and picking.
const MORTON_DEPTH=7,LEAF_SIZE=128,STROKE_BATCH_SIZE=250_000;
export function globePrimitiveBounds(packet,i,out){
 for(let axis=0;axis<3;axis++){out[axis]=Infinity;out[axis+3]=-Infinity;}
 if(packet.indices){
  for(let j=i*3;j<i*3+3;j++)include(out,packet.positions,packet.residuals,packet.indices[j]*3);
 }else{
  const points=packet.points;
  for(let side=0;side<2;side++){
   const offset=packet.endpointIndices[i*2+side]*6;
   for(let axis=0;axis<3;axis++){
    const value=points[offset+axis]+points[offset+axis+3];
    if(value<out[axis])out[axis]=value;if(value>out[axis+3])out[axis+3]=value;
   }
  }
 }
}
export function globePrimitiveOwner(packet,i){
 return packet.indices?(packet.slots[packet.indices[i*3]]??-1):(packet.ownerGroups[i]??-1);
}
function mortonCode(bounds){
 let x=0,y=0,z=0;
 const scale=2**MORTON_DEPTH/4;
 x=Math.max(0,Math.min(127,Math.floor((bounds[0]+bounds[3]+2)*scale)));
 y=Math.max(0,Math.min(127,Math.floor((bounds[1]+bounds[4]+2)*scale)));
 z=Math.max(0,Math.min(127,Math.floor((bounds[2]+bounds[5]+2)*scale)));
 let code=0;
 for(let bit=MORTON_DEPTH-1;bit>=0;bit--)code=(code<<3)|(((x>>bit)&1)<<2)|(((y>>bit)&1)<<1)|((z>>bit)&1);
 return code;
}
// Shared offline and Worker spatial sort. Every primitive retains its
// source ID. Preserve painter order between distinct owner runs when
// rendering colors may differ (territories, lakes, highlighted rivers).
function sortGlobePrimitives(packet,count){
 const codes=new Uint32Array(count),scratch=emptyBounds();
 let order=new Uint32Array(count),temp=new Uint32Array(count);
 for(let i=0;i<count;i++){globePrimitiveBounds(packet,i,scratch);codes[i]=mortonCode(scratch);order[i]=i;}
 // Stable linear-time radix sort of the spatial keys. Ties retain source order.
 for(let shift=0;shift<21;shift+=7){
  const offsets=new Uint32Array(128);
  for(const id of order)offsets[(codes[id]>>shift)&127]++;
  let sum=0;for(let i=0;i<128;i++){const n=offsets[i];offsets[i]=sum;sum+=n;}
  for(const id of order)temp[offsets[(codes[id]>>shift)&127]++]=id;
  [order,temp]=[temp,order];
 }

 return {codes,order};
}
export function globeSpatialPrimitiveOrder(packet,{preserveOwnerOrder=true}={}){
 const count=packet.indices?packet.indices.length/3:packet.count;
 if(!count)return new Uint32Array();
 const {order}=sortGlobePrimitives(packet,count);
 if(!preserveOwnerOrder)return order;
 const rank=new Uint32Array(count),result=new Uint32Array(count);
 for(let i=0;i<count;i++){rank[order[i]]=i;result[i]=i;}
 for(let first=0;first<count;){
  const owner=globePrimitiveOwner(packet,first);let end=first+1;
  while(end<count&&globePrimitiveOwner(packet,end)===owner)end++;
  if(end-first>1)result.subarray(first,end).sort((a,b)=>rank[a]-rank[b]);
  first=end;
 }
 return result;
}
export function buildGlobeSpatialIndex(packet,{leafSize=LEAF_SIZE}={}){
 const count=packet.indices?packet.indices.length/3:packet.count;
 if(!count)return {count:0,leafCount:0,order:new Uint32Array(),bounds:new Float64Array(),nodes:new Uint32Array(),owners:new Int32Array(),rootBounds:null};
 const {codes,order}=sortGlobePrimitives(packet,count),scratch=emptyBounds();
 const rows=[],boxes=[],owners=[];let leafCount=0;
 function node(first,end,depth){
  const index=owners.length;
  rows.push(first,end,0);owners.push(-1);boxes.push(0,0,0,0,0,0);
  const bounds=emptyBounds();let owner=-2;
  const take=(childBounds,childOwner)=>{extend(bounds,childBounds);owner=owner===-2?childOwner:owner===childOwner?owner:-1;};
  if((depth>=3&&end-first<=leafSize)||end-first===1){
   leafCount++;
   for(let i=first;i<end;i++){const id=order[i];globePrimitiveBounds(packet,id,scratch);take(scratch,globePrimitiveOwner(packet,id));}
  }else if(depth<MORTON_DEPTH){
   const shift=(MORTON_DEPTH-depth-1)*3;
   for(let at=first;at<end;){
    const octant=(codes[order[at]]>>shift)&7;
    let next=at+1;while(next<end&&((codes[order[next]]>>shift)&7)===octant)next++;
    const child=node(at,next,depth+1);take(child.bounds,child.owner);at=next;
   }
  }else{
   const middle=first+Math.floor((end-first)/2);
   const a=node(first,middle,depth+1),b=node(middle,end,depth+1);
   take(a.bounds,a.owner);take(b.bounds,b.owner);
  }
  rows[index*3+2]=owners.length;owners[index]=owner;
  for(let axis=0;axis<6;axis++)boxes[index*6+axis]=bounds[axis];
  return {bounds,owner};
 }
 const root=node(0,count,0);
 return {count,leafCount,order,bounds:Float64Array.from(boxes),nodes:Uint32Array.from(rows),owners:Int32Array.from(owners),rootBounds:root.bounds};
}

export function walkGlobeSpatialLeaves(index,admit,visit,ownerVisible=null){
 const {nodes,bounds,owners}=index;
 for(let i=0;i<owners.length;){
  const at=i*3,escape=nodes[at+2],owner=owners[i];
  if((ownerVisible&&owner>=0&&!ownerVisible(owner))||!admit(bounds,i*6)){i=escape;continue;}
  if(escape===i+1&&visit(nodes[at],nodes[at+1],owner,i))return true;
  i++;
 }
 return false;
}
export function globeSpatialUnion(boundsList){
 const bounds=emptyBounds();let any=false;
 for(const row of boundsList)if(row){extend(bounds,row);any=true;}
 return any?bounds:null;
}

/** Selection retains the previous admitted leaf set and owner revision.
 * Only a changed set is compacted; original primitive order is restored
 * before submitting, so overlapping countries and strokes retain priority.
 */
export function createGlobeSpatialSelection(packet,index){
 let priorLeaves=[],priorRevision=-1,priorCull=null,result={ranges:new Uint32Array(),count:0,leaves:0,changed:true};
 const all=index.count;
 function select(cull,revision=0,ownerVisible=null){
  if(cull===priorCull&&revision===priorRevision)return {...result,changed:false};
  const leaves=[];
  walkGlobeSpatialLeaves(index,cull,(first,end,owner,node)=>{leaves.push(node);},ownerVisible);
  if(revision===priorRevision&&leaves.length===priorLeaves.length&&leaves.every((id,i)=>id===priorLeaves[i])){
   priorCull=cull;return {...result,changed:false};
  }
  priorLeaves=leaves;priorRevision=revision;priorCull=cull;
  let possible=0;
  for(const node of leaves)possible+=index.nodes[node*3+1]-index.nodes[node*3];
  if(possible===all&&!ownerVisible){result={ranges:Uint32Array.of(0,all),count:all,leaves:leaves.length,changed:true};return result;}
  let n=0;
  const dense=possible>all/4,marks=dense?new Uint8Array(all):null,ids=dense?null:new Uint32Array(possible);
  for(const node of leaves){
   const at=node*3,owner=index.owners[node];
   for(let i=index.nodes[at];i<index.nodes[at+1];i++){
    const id=index.order[i];
    if(ownerVisible&&owner<0&&!ownerVisible(globePrimitiveOwner(packet,id)))continue;
    if(marks)marks[id]=1;else ids[n]=id;n++;
   }
  }
  if(n===all){result={ranges:Uint32Array.of(0,all),count:all,leaves:leaves.length,changed:true};return result;}
  const ranges=[];
  if(marks){
   for(let i=0;i<all;){
    if(!marks[i]){i++;continue;}
    const first=i++;while(i<all&&marks[i])i++;ranges.push(first,i);
   }
  }else{
   const sorted=ids.subarray(0,n);sorted.sort();
   for(let i=0;i<n;){
    const first=sorted[i];let end=first+1;i++;
    while(i<n&&sorted[i]===end){end++;i++;}
    ranges.push(first,end);
   }
  }
  result={ranges:Uint32Array.from(ranges),count:n,leaves:leaves.length,changed:true};return result;
 }
 return {select};
}

/** Run in the packet Worker; GPU slices share the immutable point dictionary
 * unless it exceeds the portable texture cap. No separate pick-grid packet.
 */
export function prepareGlobeSpatialPacket(packet,{outline=false}={}){
 if(packet.indices){
  const spatial=buildGlobeSpatialIndex(packet);
  return {...packet,spatial,spatialBounds:spatial.rootBounds};
 }
 const parts=[],share=outline||packet.points.length/6<=1_000_000,batchSize=outline?8192:STROKE_BATCH_SIZE;
 for(let first=0;first<packet.count;first+=batchSize){
  const end=Math.min(packet.count,first+batchSize);
  const part=share?globeStrokeRange(packet,first,end):compactGlobeStrokeRange(packet,first,end);
  parts.push({first,end,packet:part,index:buildGlobeSpatialIndex(part)});
 }
 return {...packet,spatialParts:parts,spatialBounds:globeSpatialUnion(parts.map(row=>row.index.rootBounds))};
}
