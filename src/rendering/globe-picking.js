import {globeStrokePoint} from './globe-mesh.js';
import {walkGlobeSpatialLeaves,globePrimitiveOwner} from './globe-spatial-partition.js';

/** A sparse hierarchy is shared with GPU selection; no fixed 32^3 table or
 * per-packet grid download. Clip the ray to the exact primitive AABB. */
export function globeRayIntersectsBounds(ray,bounds,at=0){
 if(!ray||!bounds)return false;
 let lo=ray.start-1e-12,hi=ray.end;
 for(let axis=0;axis<3;axis++){
  const o=ray.origin[axis],d=ray.direction[axis],min=bounds[at+axis],max=bounds[at+axis+3];
  if(!d){if(o<min||o>max)return false;continue;}
  let a=(min-o)/d,b=(max-o)/d;
  if(a>b){const swap=a;a=b;b=swap;}
  if(a>lo)lo=a;if(b<hi)hi=b;
  if(hi<lo)return false;
 }
 return true;
}

function intersects(mesh,first,ray){
 const {positions:p,residuals:l,indices}=mesh,{origin:o,direction:d,start,end}=ray;
 const a=indices[first]*3,b=indices[first+1]*3,c=indices[first+2]*3;
 const ax=p[a]+l[a],ay=p[a+1]+l[a+1],az=p[a+2]+l[a+2];
 const ux=p[b]+l[b]-ax,uy=p[b+1]+l[b+1]-ay,uz=p[b+2]+l[b+2]-az;
 const vx=p[c]+l[c]-ax,vy=p[c+1]+l[c+1]-ay,vz=p[c+2]+l[c+2]-az;
 const nx=d[1]*vz-d[2]*vy,ny=d[2]*vx-d[0]*vz,nz=d[0]*vy-d[1]*vx;
 const det=ux*nx+uy*ny+uz*nz;
 if(Math.abs(det)<1e-20)return false;
 const rx=o[0]-ax,ry=o[1]-ay,rz=o[2]-az,inv=1/det;
 const u=(rx*nx+ry*ny+rz*nz)*inv;
 if(u<0||u>1)return false;
 const qx=ry*uz-rz*uy,qy=rz*ux-rx*uz,qz=rx*uy-ry*ux;
 const v=(d[0]*qx+d[1]*qy+d[2]*qz)*inv;
 if(v<0||u+v>1)return false;
 const t=(vx*qx+vy*qy+vz*qz)*inv;
 return t>=start-1e-12&&t<end;
}

export function pickGlobeSlots(mesh,index,ray,visible=()=>true,{firstHit=false,signal}={}){
 if(!ray)return [];
 const hits=new Set();
 const ownerVisible=owner=>owner<0||visible(owner);
 walkGlobeSpatialLeaves(index,(bounds,at)=>globeRayIntersectsBounds(ray,bounds,at),(first,end,owner)=>{
  signal?.throwIfAborted();
  for(let i=first;i<end;i++){
   const triangle=index.order[i],slot=globePrimitiveOwner(mesh,triangle);
   const id=slot<0?0:slot;
   if(hits.has(id)||!visible(id))continue;
   if(intersects(mesh,triangle*3,ray)){hits.add(id);if(firstHit)return true;}
  }
  return false;
 },ownerVisible);
 return [...hits].sort((a,b)=>b-a);
}

const pointSegmentDistance=([x,y],[[ax,ay],[bx,by]])=>{
 const dx=bx-ax,dy=by-ay,fraction=Math.min(1,Math.max(0,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy||1)));
 return Math.hypot(x-ax-dx*fraction,y-ay-dy*fraction);
};

// A tolerance rectangle is four perspective half-spaces. Bounding a stroke
// by its chord includes the endpoints clipped by the renderer at the horizon.
export function globeStrokePickPredicate(camera,point,tolerance=5){
 const {frame:{eye,right,up,forward,focal,center}}=camera;
 const [x,y]=point,planes=[];
 const plane=(axis,sign,slope)=>{
  const n=axis.map((v,i)=>sign*v+slope*forward[i]);
  planes.push([n,n[0]*eye[0]+n[1]*eye[1]+n[2]*eye[2]]);
 };
 plane(right,1,(center[0]-x+tolerance)/focal);
 plane(right,-1,(x+tolerance-center[0])/focal);
 plane(up,1,(y+tolerance-center[1])/focal);
 plane(up,-1,(center[1]-y+tolerance)/focal);
 planes.push([forward,forward[0]*eye[0]+forward[1]*eye[1]+forward[2]*eye[2]]);
 const epsilon=1e-10*(1+Math.hypot(...eye));
 return (bounds,at=0)=>{
  for(const [normal,offset] of planes){
   let maximum=0;
   for(let axis=0;axis<3;axis++)maximum+=normal[axis]*bounds[at+axis+(normal[axis]>=0?3:0)];
   if(maximum<offset-epsilon)return false;
  }
  return true;
 };
}
export function pickGlobeStrokeSlots(packet,index,camera,point,tolerance=5,{predicate=globeStrokePickPredicate(camera,point,tolerance),signal}={}){
 const hits=new Map();
 walkGlobeSpatialLeaves(index,predicate,(first,end)=>{
  signal?.throwIfAborted();
  for(let i=first;i<end;i++){
   const segment=index.order[i],slot=packet.ownerGroups[segment];
   const line=camera.projectStroke(globeStrokePoint(packet,segment,0),globeStrokePoint(packet,segment,1));
   if(!line)continue;
   const distance=pointSegmentDistance(point,line);
   if(distance<=tolerance&&distance<(hits.get(slot)??Infinity))hits.set(slot,distance);
  }
  return false;
 });
 return [...hits].sort((a,b)=>a[1]-b[1]).map(([slot])=>slot);
}

/** A single budget spans all packets for one accepted-frame pick. Yield to
 * the browser task queue, not a microtask, so new pointer events and
 * cancellation can actually be delivered during a dense exact query. */
export function createGlobePickBudget({signal,isCurrent=()=>true,sliceMs=3,quantum=128,
 now=()=>performance.now(),yieldTask=()=>typeof globalThis.scheduler?.yield==='function'?globalThis.scheduler.yield():new Promise(resolve=>setTimeout(resolve,0))}={}){
 let remaining=quantum,deadline=now()+sliceMs,yields=0;
 function check(){
  signal?.throwIfAborted();
  if(!isCurrent())throw new DOMException('Picking frame superseded','AbortError');
 }
 function step(){
  if(--remaining>0)return null;
  remaining=quantum;check();
  if(now()<deadline)return null;
  yields++;
  return Promise.resolve(yieldTask()).then(()=>{check();deadline=now()+sliceMs;});
 }
 check();
 return {step,check,stats:()=>({yields})};
}

function* globePickCandidates(index,admit,ownerVisible=null){
 const {nodes,bounds,owners,order}=index;
 for(let node=0;node<owners.length;){
  // Rejected nodes also count toward the time budget.
  yield -1;
  const at=node*3,escape=nodes[at+2],owner=owners[node];
  if((ownerVisible&&owner>=0&&!ownerVisible(owner))||!admit(bounds,node*6)){node=escape;continue;}
  if(escape===node+1)for(let i=nodes[at];i<nodes[at+1];i++)yield order[i];
  node++;
 }
}

export async function pickGlobeSlotsCooperative(mesh,index,ray,visible=()=>true,{firstHit=false,budget=createGlobePickBudget()}={}){
 budget.check();if(!ray)return [];
 const hits=new Set(),ownerVisible=owner=>owner<0||visible(owner);
 for(const triangle of globePickCandidates(index,(bounds,at)=>globeRayIntersectsBounds(ray,bounds,at),ownerVisible)){
  const pause=budget.step();if(pause)await pause;
  if(triangle<0)continue;
  const slot=globePrimitiveOwner(mesh,triangle),id=slot<0?0:slot;
  if(hits.has(id)||!visible(id))continue;
  if(intersects(mesh,triangle*3,ray)){hits.add(id);if(firstHit)break;}
 }
 budget.check();return [...hits].sort((a,b)=>b-a);
}
export async function pickGlobeStrokeSlotsCooperative(packet,index,camera,point,tolerance=5,
 {predicate=globeStrokePickPredicate(camera,point,tolerance),budget=createGlobePickBudget()}={}){
 budget.check();const hits=new Map();
 for(const segment of globePickCandidates(index,predicate)){
  const pause=budget.step();if(pause)await pause;
  if(segment<0)continue;
  const slot=packet.ownerGroups[segment];
  const line=camera.projectStroke(globeStrokePoint(packet,segment,0),globeStrokePoint(packet,segment,1));
  if(!line)continue;
  const distance=pointSegmentDistance(point,line);
  if(distance<=tolerance&&distance<(hits.get(slot)??Infinity))hits.set(slot,distance);
 }
 budget.check();return [...hits].sort((a,b)=>a[1]-b[1]).map(([slot])=>slot);
}

/** Broad phase across active packets. Median splitting on actual bound
 * centres keeps disjoint water/territory packets out of the query entirely. */
export function createGlobePacketIndex(rows,boundsOf){
 const entries=rows.map((row,order)=>({row,order,bounds:boundsOf(row)})).filter(row=>row.bounds);
 function build(items){
  if(!items.length)return null;
  const bounds=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
  for(const {bounds:box} of items)for(let axis=0;axis<3;axis++){
   bounds[axis]=Math.min(bounds[axis],box[axis]);bounds[axis+3]=Math.max(bounds[axis+3],box[axis+3]);
  }
  if(items.length<=4)return {bounds,items};
  let axis=0;
  for(let i=1;i<3;i++)if(bounds[i+3]-bounds[i]>bounds[axis+3]-bounds[axis])axis=i;
  items.sort((a,b)=>a.bounds[axis]+a.bounds[axis+3]-b.bounds[axis]-b.bounds[axis+3]||a.order-b.order);
  const middle=items.length>>1;
  return {bounds,left:build(items.slice(0,middle)),right:build(items.slice(middle))};
 }
 const root=build(entries);
 function query(predicate){
  const found=[];
  function visit(node){
   if(!node||!predicate(node.bounds))return;
   if(node.items){for(const item of node.items)if(predicate(item.bounds))found.push(item);}
   else{visit(node.left);visit(node.right);}
  }
  visit(root);
  return found.sort((a,b)=>a.order-b.order).map(item=>item.row);
 }
 async function queryCooperative(predicate,budget){
  const found=[],stack=root?[root]:[];
  while(stack.length){
   const pause=budget.step();if(pause)await pause;
   const node=stack.pop();
   if(!predicate(node.bounds))continue;
   if(node.items){for(const item of node.items)if(predicate(item.bounds))found.push(item);}
   else{stack.push(node.right,node.left);}
  }
  budget.check();return found.sort((a,b)=>a.order-b.order).map(item=>item.row);
 }
 return {query,queryCooperative};
}
