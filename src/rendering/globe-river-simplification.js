import { createGlobeStrokePointTable, encodeIndexedGlobeStrokes } from './globe-mesh.js';
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


// Last-resort display aggregation: quantize the unit-sphere network into a
// bounded spatial lattice, merge duplicate edges, and retain maximum width.
// This is display-only and deliberately drops object ownership when requested;
// the exact source packets remain immutable and are still used at higher LODs.
export function aggregateGlobeStrokePacket(packet,{gridDivisions=64,preserveOwners=true}={}) {
  if(!packet||!Number.isSafeInteger(packet.count)||packet.count<0||
    !Number.isInteger(gridDivisions)||gridDivisions<16||gridDivisions>256||
    typeof preserveOwners!=='boolean'||packet.endpointIndices?.length!==packet.count*2||
    packet.points?.length%6!==0||packet.widths?.length!==0&&packet.widths.length!==packet.count||
    packet.ownerGroups?.length!==0&&packet.ownerGroups.length!==packet.count)
    throw new TypeError('Invalid spatial stroke aggregation packet');
  if(!packet.count)return packet;
  const values=packet.points,words=new Uint32Array(packet.points.buffer,packet.points.byteOffset,packet.points.length);
  const table=createGlobeStrokePointTable(Math.max(1,packet.count*2));
  const pointCache=new Map(),cellCache=new Map(),edges=new Map(),side=gridDivisions+1;
  function quantizePoint(id) {
    if(pointCache.has(id))return pointCache.get(id);
    const at=id*6,x=values[at]+values[at+3],y=values[at+1]+values[at+4],z=values[at+2]+values[at+5];
    if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(z))throw new TypeError('Invalid stroke endpoint');
    const cell=[x,y,z].map(value=>Math.max(0,Math.min(gridDivisions,
      Math.round((Math.max(-1,Math.min(1,value))+1)*.5*gridDivisions))));
    const cellKey=cell[0]+side*(cell[1]+side*cell[2]);
    let output=cellCache.get(cellKey);
    if(output===undefined) {
      let vector=cell.map(value=>-1+value*2/gridDivisions),length=Math.hypot(...vector);
      if(!Number.isFinite(length)||length<1e-12){vector=[x,y,z];length=Math.hypot(...vector);}
      vector=vector.map(value=>value/length);
      const high=Float32Array.from(vector),low=Float32Array.from(vector.map((value,index)=>value-high[index]));
      const point=Float32Array.from([...high,...low]);
      output=table.intern(new Uint32Array(point.buffer),0);
      cellCache.set(cellKey,output);
    }
    pointCache.set(id,output);return output;
  }
  const pointCapacity=Math.max(2,packet.count*2+1),hasWidths=packet.widths.length>0;
  const keepOwners=preserveOwners&&packet.ownerGroups.length>0;
  for(let segment=0;segment<packet.count;segment++) {
    const first=quantizePoint(packet.endpointIndices[segment*2]),last=quantizePoint(packet.endpointIndices[segment*2+1]);
    if(first===last)continue;
    const low=Math.min(first,last),high=Math.max(first,last),owner=keepOwners?packet.ownerGroups[segment]:0;
    const key=keepOwners?owner+':'+low+':'+high:low*pointCapacity+high;
    const prior=edges.get(key),width=hasWidths?packet.widths[segment]:0;
    if(prior)prior.width=Math.max(prior.width,width);
    else edges.set(key,{first,last,owner,width});
  }
  const rows=[...edges.values()],endpointIndices=new Uint32Array(rows.length*2);
  const widths=new Float32Array(hasWidths?rows.length:0),ownerGroups=new Uint16Array(keepOwners?rows.length:0);
  rows.forEach((row,index)=>{
    endpointIndices[index*2]=row.first;endpointIndices[index*2+1]=row.last;
    if(widths.length)widths[index]=row.width;
    if(ownerGroups.length)ownerGroups[index]=row.owner;
  });
  // Re-encode through the canonical packet contract before building its
  // shared draw/picking spatial index in the Worker.
  const encoded=encodeIndexedGlobeStrokes({count:rows.length,points:table.finish(),endpointIndices,widths,ownerGroups});
  const pointOffset=20,indexOffset=pointOffset+table.finish().byteLength;
  return {count:rows.length,points:table.finish(),endpointIndices,widths,ownerGroups,
    encodedBytes:encoded.byteLength,pointCount:indexOffset};
}
