export const GLOBE_PICK_GRID_MAGIC = 0x31494750;
export const GLOBE_PICK_GRID_SIDE = 32;
const side = GLOBE_PICK_GRID_SIDE;
const cellWidth = 2 / side;

export const globePickCellCoordinate = value => Math.max(0, Math.min(side - 1, Math.floor((value + 1) / cellWidth)));
export const globePickCellIndex = (x,y,z) => (z * side + y) * side + x;

export function decodeGlobePickGrid(buffer, triangleCount) {
  const headerWords = 3, offsetCount = side ** 3 + 1;
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < (headerWords + offsetCount) * 4 || buffer.byteLength % 4) throw Error('Invalid globe pick grid');
  const words = new Uint32Array(buffer);
  if (words[0] !== GLOBE_PICK_GRID_MAGIC || words[1] !== side || words[2] !== triangleCount) throw Error('Globe pick grid does not match its mesh');
  const offsets = words.subarray(headerWords, headerWords + offsetCount), triangles = words.subarray(headerWords + offsetCount);
  if (offsets[0] !== 0 || offsets.at(-1) !== triangles.length || offsets.some((offset,i)=>i>0&&offset<offsets[i-1]) ||
    triangles.some(triangle=>triangle>=triangleCount)) throw Error('Invalid globe pick grid ranges');
  return Object.freeze({offsets,triangles});
}

const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const minus = (a,b) => [a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];

function intersects(mesh, first, {origin,direction,start,end}) {
  const vertex = index => {
    const offset = mesh.indices[index] * 3;
    return [0,1,2].map(axis=>mesh.positions[offset+axis]+mesh.residuals[offset+axis]);
  };
  const a=vertex(first), ab=minus(vertex(first+1),a), ac=minus(vertex(first+2),a);
  const normal=cross(direction,ac), determinant=dot(ab,normal);
  if (Math.abs(determinant)<1e-20) return false;
  const relative=minus(origin,a), u=dot(relative,normal)/determinant;
  if (u<0||u>1) return false;
  const q=cross(relative,ab), v=dot(direction,q)/determinant;
  if (v<0||u+v>1) return false;
  const distance=dot(ac,q)/determinant;
  return distance>=start-1e-12&&distance<end;
}

function visitPickCells(ray,visitor){
  if(!ray)return;
  const {origin,direction,start,end}=ray;
  const cell=origin.map((value,axis)=>globePickCellCoordinate(value+direction[axis]*start));
  const steps=direction.map(Math.sign);
  const advance=direction.map(value=>value ? cellWidth/Math.abs(value) : Infinity);
  const next=direction.map((value,axis)=>value ? (-1+(cell[axis]+Number(value>0))*cellWidth-origin[axis])/value : Infinity);
  while (cell.every(value=>value>=0&&value<side)) {
    if(visitor(cell))return;
    const axis=next[0]<=next[1]&&next[0]<=next[2]?0:next[1]<=next[2]?1:2;
    if(next[axis]>end)break;
    cell[axis]+=steps[axis];next[axis]+=advance[axis];
  }
}

/** Packet bounds in the exact same Cartesian grid used by the pick index.
 * All triangle/segment extents lie inside the endpoint/vertex bounds.
 */
export function globePickCellBounds(...vectors){
  const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
  for(const [positions,residuals] of vectors){
    for(let i=0;i<positions.length;i+=3)for(let axis=0;axis<3;axis++){
      const coordinate=positions[i+axis]+residuals[i+axis];
      if(coordinate<low[axis])low[axis]=coordinate;
      if(coordinate>high[axis])high[axis]=coordinate;
    }
  }
  return low[0]===Infinity?null:[...low.map(globePickCellCoordinate),...high.map(globePickCellCoordinate)];
}

export function pickCellsIntersectBounds(cells,bounds){
  if(!bounds)return false;
  const [x0,y0,z0,x1,y1,z1]=bounds;
  for(const index of cells){
    const x=index%side,y=Math.floor(index/side)%side,z=Math.floor(index/(side*side));
    if(x>=x0&&x<=x1&&y>=y0&&y<=y1&&z>=z0&&z<=z1)return true;
  }
  return false;
}

export function globePickRayCells(ray){
  const cells=[];
  visitPickCells(ray,cell=>{cells.push(globePickCellIndex(...cell));});
  return cells;
}

export function pickGlobeSlots(mesh, grid, ray, visible = () => true, { firstHit = false, cells = globePickRayCells(ray) } = {}) {
  const seen=new Set(), hits=new Set();
  for(const index of cells){
    for(let i=grid.offsets[index];i<grid.offsets[index+1];i++){
      const triangle=grid.triangles[i],first=triangle*3,slot=mesh.slots[mesh.indices[first]]??0;
      if(hits.has(slot)||seen.has(triangle)||!visible(slot))continue;
      seen.add(triangle);
      if(intersects(mesh,first,ray)){
        hits.add(slot);
        if(firstHit)return [slot];
      }
    }
  }
  // The combined mesh draws larger slot indices last when fills overlap.
  return [...hits].sort((a,b)=>b-a);
}

const pointSegmentDistance=([x,y],[[ax,ay],[bx,by]])=>{
  const dx=bx-ax,dy=by-ay;
  const fraction=Math.min(1,Math.max(0,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy||1)));
  return Math.hypot(x-ax-dx*fraction,y-ay-dy*fraction);
};

export function globePickStrokeCells(camera,point,tolerance=5){
  const cells=new Set();
  const [x,y]=point;
  for(const dy of [-tolerance,0,tolerance])for(const dx of [-tolerance,0,tolerance]){
    visitPickCells(camera.worldRay([x+dx,y+dy]),([a,b,c])=>{
      for(let iz=Math.max(0,c-1);iz<=Math.min(side-1,c+1);iz++)
        for(let iy=Math.max(0,b-1);iy<=Math.min(side-1,b+1);iy++)
          for(let ix=Math.max(0,a-1);ix<=Math.min(side-1,a+1);ix++)cells.add(globePickCellIndex(ix,iy,iz));
    });
  }
  return cells;
}

export function pickGlobeStrokeSlots(packet,grid,camera,point,tolerance=5,cells=globePickStrokeCells(camera,point,tolerance)){
  const seen=new Set(),hits=new Map();
  for(const cell of cells)for(let i=grid.offsets[cell];i<grid.offsets[cell+1];i++){
    const segment=grid.triangles[i],slot=packet.ownerGroups[segment];
    if(seen.has(segment))continue;
    seen.add(segment);
    const offset=segment*3;
    const start=[0,1,2].map(axis=>packet.start[offset+axis]+packet.startLow[offset+axis]);
    const end=[0,1,2].map(axis=>packet.end[offset+axis]+packet.endLow[offset+axis]);
    const line=camera.projectStroke(start,end);
    if(!line)continue;
    const distance=pointSegmentDistance(point,line);
    if(distance<=tolerance&&distance<(hits.get(slot)??Infinity))hits.set(slot,distance);
  }
  return [...hits].sort((a,b)=>a[1]-b[1]).map(([slot])=>slot);
}
