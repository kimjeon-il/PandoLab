// Binary transfer for prepared strokes; MapLibre still receives canonical GeoJSON.
export function encodeStrokeGeometry(geometry){
 if(geometry?.type!=='MultiLineString')throw new TypeError('Expected MultiLineString');
 const lines=geometry.coordinates,offsets=new Uint32Array(lines.length+1);
 let count=0;
 for(let i=0;i<lines.length;i++){count+=lines[i].length;offsets[i+1]=count;}
 const coordinates=new Float64Array(count*2);let at=0;
 for(const line of lines)for(const point of line){coordinates[at++]=point[0];coordinates[at++]=point[1];}
 return {coordinates,offsets};
}
export function decodeStrokeGeometry({coordinates,offsets}){
 if(!(coordinates instanceof Float64Array)||!(offsets instanceof Uint32Array)||!offsets.length
  ||coordinates.length!==offsets[offsets.length-1]*2)throw new TypeError('Invalid stroke packet');
 const lines=[];
 for(let i=0;i<offsets.length-1;i++){
  const line=[];
  for(let j=offsets[i];j<offsets[i+1];j++)line.push([coordinates[j*2],coordinates[j*2+1]]);
  lines.push(line);
 }
 return {type:'MultiLineString',coordinates:lines};
}
