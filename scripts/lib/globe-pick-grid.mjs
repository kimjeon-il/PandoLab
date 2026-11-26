import { GLOBE_PICK_GRID_MAGIC,GLOBE_PICK_GRID_SIDE,globePickCellCoordinate,globePickCellIndex } from '../../src/rendering/globe-picking.js';

/** Index exact primitive extents. The browser only reads packed ranges. */
function buildGrid(count,extents){
  const offsets=new Uint32Array(GLOBE_PICK_GRID_SIDE**3+1);
  function visitCells(visit){
    for(let primitive=0;primitive<count;primitive++){
      const [x,y,z]=extents(primitive);
      const x0=globePickCellCoordinate(Math.min(...x)),x1=globePickCellCoordinate(Math.max(...x));
      const y0=globePickCellCoordinate(Math.min(...y)),y1=globePickCellCoordinate(Math.max(...y));
      const z0=globePickCellCoordinate(Math.min(...z)),z1=globePickCellCoordinate(Math.max(...z));
      for(let iz=z0;iz<=z1;iz++)for(let iy=y0;iy<=y1;iy++)for(let ix=x0;ix<=x1;ix++)visit(globePickCellIndex(ix,iy,iz),primitive);
    }
  }
  visitCells(cell=>offsets[cell+1]++);
  for(let cell=1;cell<offsets.length;cell++)offsets[cell]+=offsets[cell-1];
  const words=new Uint32Array(3+offsets.length+offsets.at(-1));
  words.set([GLOBE_PICK_GRID_MAGIC,GLOBE_PICK_GRID_SIDE,count]);
  words.set(offsets,3);
  const triangles=words.subarray(3+offsets.length);
  visitCells((cell,triangle)=>{triangles[offsets[cell]++]=triangle;});
  return words.buffer;
}

export function buildGlobePickGrid({positions,residuals,indices}){
  return buildGrid(indices.length/3,triangle=>{
    const first=triangle*3,a=indices[first]*3,b=indices[first+1]*3,c=indices[first+2]*3;
    return [0,1,2].map(axis=>[a,b,c].map(i=>positions[i+axis]+residuals[i+axis]));
  });
}

export function buildGlobeStrokePickGrid({count,start,startLow,end,endLow}){
  return buildGrid(count,segment=>[0,1,2].map(axis=>{
    const i=segment*3+axis;
    return [start[i]+startLow[i],end[i]+endLow[i]];
  }));
}
