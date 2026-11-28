import { createGlobeStrokePointTable } from './globe-mesh.js';
function pointWords(packet){return new Uint32Array(packet.points.buffer,packet.points.byteOffset,packet.points.length);}
function pointHash(words,index){let hash=2166136261;for(let axis=0;axis<6;axis++)hash=Math.imul(hash^words[index*6+axis],16777619);hash^=hash>>>16;return Math.imul(hash,0x85ebca6b)>>>0;}
function hasBit(bits,hash){const bit=hash%(bits.length*8);return Boolean(bits[bit>>>3]&(1<<(bit&7)));}
function setBit(bits,hash){const bit=hash%(bits.length*8);bits[bit>>>3]|=1<<(bit&7);}
export function createGlobeRiverJunctionGuard(packets,{filterBytes=1024*1024}={}) {
  const seen=new Uint8Array(Math.max(1,filterBytes)),shared=new Uint8Array(Math.max(1,filterBytes));
  for(const packet of packets){const words=pointWords(packet);for(let point=0;point<words.length/6;point++){
    const hash=pointHash(words,point);if(hasBit(seen,hash))setBit(shared,hash);else setBit(seen,hash);
  }}
  return (words,point)=>hasBit(shared,pointHash(words,point));
}
// Simplify only contiguous same-owner degree-two chains. Emergency aggregation
// widens the screen-error tolerance but still protects shared junctions,
// seams, poles, cell boundaries, widths and exact endpoint coordinate words.
export function simplifyGlobeRiverPacket(packet,lod,isShared=()=>false,{maxRun=32,errorScale=1,protectedBounds=null}={}) {
  if(!lod.riverError||packet.count<2)return packet;
  const words=pointWords(packet),points=packet.points,endpoints=packet.endpointIndices,degree=new Uint32Array(points.length/6);
  for(const id of endpoints)degree[id]++;
  const run=Math.max(1,Math.min(512,Math.floor(maxRun)||32)),tolerance=Math.max(0,Number(errorScale)||1)*lod.riverError;
  const tolerance2=tolerance*tolerance,boundaryMargin=Math.max(1e-7,tolerance*2),bounds=protectedBounds;
  const minimumDot=Math.cos(lod.maxEdgeDegrees*Math.PI/180),outIndices=new Uint32Array(endpoints.length);
  const widths=new Float32Array(packet.widths.length),owners=new Uint16Array(packet.ownerGroups.length),table=createGlobeStrokePointTable(points.length/6);
  const xyz=id=>{const at=id*6;return [points[at]+points[at+3],points[at+1]+points[at+4],points[at+2]+points[at+5]];};
  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  function protectedAt(id){if(!bounds)return false;const p=xyz(id);for(let axis=0;axis<3;axis++)
    if(p[axis]<=bounds[axis]+boundaryMargin||p[axis]>=bounds[axis+3]-boundaryMargin)return true;return false;}
  function admissible(first,end){
    const a=xyz(endpoints[first*2]),b=xyz(endpoints[(end-1)*2+1]);if(dot(a,b)<minimumDot)return false;
    const dx=b[0]-a[0],dy=b[1]-a[1],dz=b[2]-a[2],length2=dx*dx+dy*dy+dz*dz;if(!length2)return false;
    for(let at=first;at<end-1;at++){const p=xyz(endpoints[at*2+1]),x=p[0]-a[0],y=p[1]-a[1],z=p[2]-a[2];
      const t=Math.max(0,Math.min(1,(x*dx+y*dy+z*dz)/length2));
      if((x-t*dx)**2+(y-t*dy)**2+(z-t*dz)**2>tolerance2)return false;}
    return true;
  }
  let count=0;
  for(let first=0;first<packet.count;){
    let end=first+1,low=packet.widths[first]??0,high=low;const owner=packet.ownerGroups[first];
    while(end<packet.count&&end-first<run){
      const joint=endpoints[(end-1)*2+1];
      if(endpoints[end*2]!==joint||degree[joint]!==2||isShared(words,joint)||protectedAt(joint)||packet.ownerGroups[end]!==owner)break;
      const [jx,jy,jz]=xyz(joint);if(jx<0&&Math.abs(jy)<1e-10||Math.abs(jz)>1-1e-12)break;
      const width=packet.widths[end]??0,nextLow=Math.min(low,width),nextHigh=Math.max(high,width);
      if(nextHigh-nextLow>.08||!admissible(first,end+1))break;
      low=nextLow;high=nextHigh;end++;
    }
    outIndices[count*2]=table.intern(words,endpoints[first*2]*6);
    outIndices[count*2+1]=table.intern(words,endpoints[(end-1)*2+1]*6);
    if(widths.length)widths[count]=(low+high)/2;if(owners.length)owners[count]=owner;count++;first=end;
  }
  if(count===packet.count)return packet;
  return {count,points:table.finish(),endpointIndices:outIndices.slice(0,count*2),
    widths:widths.slice(0,widths.length?count:0),ownerGroups:owners.slice(0,owners.length?count:0)};
}
