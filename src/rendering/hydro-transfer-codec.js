// Packed geometry crosses the worker boundary without cloning coordinate trees.
export function packHydroFeatures(features){
 const metadata=[],lengths=[],values=[];
 for(const feature of features){
  const geometry=feature.geometry;
  const lines=geometry.type==='LineString'?[geometry.coordinates]:
   geometry.type==='MultiLineString'?geometry.coordinates:
   geometry.type==='Polygon'?geometry.coordinates:
   geometry.type==='MultiPolygon'?geometry.coordinates.flat():null;
  if(!lines)throw new TypeError('Unsupported hydro geometry: '+geometry.type);
  const starts=lengths.length;
  for(const line of lines){
   lengths.push(line.length);
   for(const point of line)values.push(point[0],point[1]);
  }
  metadata.push({id:feature.id,properties:feature.properties,type:geometry.type,lineStart:starts,lineCount:lines.length,
   polygonLengths:geometry.type==='MultiPolygon'?geometry.coordinates.map(polygon=>polygon.length):null});
 }
 return {metadata,lengths:Uint32Array.from(lengths),coordinates:Float64Array.from(values)};
}
export function unpackHydroFeatures({metadata,lengths,coordinates}={}){
 if(!Array.isArray(metadata)||!(lengths instanceof Uint32Array)||!(coordinates instanceof Float64Array))
  throw new TypeError('Invalid hydro transport');
 if(coordinates.length%2||lengths.reduce((sum,length)=>sum+length,0)*2!==coordinates.length)
  throw new TypeError('Invalid hydro coordinate lengths');
 const lines=[];let at=0;
 for(const length of lengths){
  const line=[];
  for(let i=0;i<length;i++){
   if(at+1>=coordinates.length)throw new TypeError('Truncated hydro coordinates');
   line.push([coordinates[at++],coordinates[at++]]);
  }
  lines.push(line);
 }
 if(at!==coordinates.length)throw new TypeError('Unexpected hydro coordinates');
 return metadata.map(row=>{
  if(!Number.isSafeInteger(row.lineStart)||!Number.isSafeInteger(row.lineCount)||row.lineStart<0||row.lineCount<1||row.lineStart+row.lineCount>lines.length)
   throw new TypeError('Invalid hydro feature line range');
  const slices=lines.slice(row.lineStart,row.lineStart+row.lineCount);
  let geometry;
  if(row.type==='LineString'){
   if(slices.length!==1)throw new TypeError('Invalid hydro line');
   geometry={type:row.type,coordinates:slices[0]};
  }
  else if(row.type==='MultiLineString'||row.type==='Polygon')geometry={type:row.type,coordinates:slices};
  else if(row.type==='MultiPolygon'){
   if(!Array.isArray(row.polygonLengths)||!row.polygonLengths.length||row.polygonLengths.some(count=>!Number.isSafeInteger(count)||count<1)||row.polygonLengths.reduce((a,b)=>a+b,0)!==slices.length)
    throw new TypeError('Invalid hydro polygon lengths');
   let offset=0;geometry={type:row.type,coordinates:row.polygonLengths.map(count=>{
    const polygon=slices.slice(offset,offset+count);offset+=count;return polygon;
   })};
  }else throw new TypeError('Invalid hydro geometry type');
  return {type:'Feature',id:row.id,properties:row.properties,geometry};
 });
}
