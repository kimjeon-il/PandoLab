// Shared binary coordinate contract for water fragments and border strokes.
// Offsets count vertices or scalar width samples, never bytes.
function encodeParts(parts,stride){
 const offsets=new Uint32Array(parts.length+1);let count=0;
 for(let i=0;i<parts.length;i++){
  if(!Array.isArray(parts[i]))throw new TypeError('Invalid geometry part');
  count+=parts[i].length;
  if(count>0xffffffff)throw new RangeError('Geometry packet exceeds Uint32 offsets');
  offsets[i+1]=count;
 }
 const values=new Float64Array(count*stride);let at=0;
 for(const part of parts)for(const sample of part){
  if(stride===1){
   if(!Number.isFinite(sample))throw new TypeError('Invalid hydro width');
   values[at++]=sample;
  }else{
   if(!Array.isArray(sample)||sample.length<2||!Number.isFinite(sample[0])||!Number.isFinite(sample[1]))
    throw new TypeError('Invalid geometry coordinate');
   values[at++]=sample[0];values[at++]=sample[1];
  }
 }
 return {offsets,values};
}
function validateParts(offsets,values,stride){
 if(!(offsets instanceof Uint32Array)||!(values instanceof Float64Array)||!offsets.length
  ||offsets[0]!==0||offsets[offsets.length-1]*stride!==values.length)
  throw new TypeError('Invalid geometry packet offsets or lengths');
 for(let i=1;i<offsets.length;i++)
  if(offsets[i]<offsets[i-1])throw new TypeError('Invalid geometry packet offset order');
}
function decodeParts(offsets,values,stride){
 validateParts(offsets,values,stride);
 const parts=new Array(offsets.length-1);
 for(let i=0;i<parts.length;i++){
  const start=offsets[i],end=offsets[i+1],part=new Array(end-start);
  for(let j=start;j<end;j++){
   const x=values[j*stride];
   if(!Number.isFinite(x)||(stride===2&&!Number.isFinite(values[j*2+1])))
    throw new TypeError('Invalid geometry packet sample');
   part[j-start]=stride===1?x:[x,values[j*2+1]];
  }
  parts[i]=part;
 }
 return parts;
}
export function encodeStrokeGeometry(geometry){
 if(geometry?.type!=='MultiLineString')throw new TypeError('Expected MultiLineString');
 const {offsets,values:coordinates}=encodeParts(geometry.coordinates,2);
 return {offsets,coordinates};
}
export function decodeStrokeGeometry({offsets,coordinates}={}){
 return {type:'MultiLineString',coordinates:decodeParts(offsets,coordinates,2)};
}
export function geometryTransferBuffers(packet){
 return [...new Set(Object.values(packet).filter(ArrayBuffer.isView).map(value=>value.buffer))];
}
export function packHydroFeatures(features){
 const metadata=[],parts=[],widthParts=[];
 for(const feature of features){
  const geometry=feature.geometry,lineStart=parts.length;
  let polygonLengths=null;
  switch(geometry.type){
   case 'LineString':parts.push(geometry.coordinates);break;
   case 'MultiLineString':
   case 'Polygon':for(const line of geometry.coordinates)parts.push(line);break;
   case 'MultiPolygon':
    polygonLengths=[];
    for(const polygon of geometry.coordinates){
     polygonLengths.push(polygon.length);
     for(const ring of polygon)parts.push(ring);
    }
    break;
   default:throw new TypeError('Unsupported hydro geometry: '+geometry.type);
  }
  const lineCount=parts.length-lineStart;
  let properties=feature.properties,widthRange=null;
  if(properties&&Object.hasOwn(properties,'stroke_widths')){
   const {stroke_widths,...remaining}=properties;
   if(!Array.isArray(stroke_widths))throw new TypeError('Invalid hydro width profile');
   if(stroke_widths.length&&(geometry.type!=='LineString'&&geometry.type!=='MultiLineString'
    ||stroke_widths.length!==lineCount||stroke_widths.some((part,i)=>!Array.isArray(part)||part.length!==parts[lineStart+i].length)))
    throw new TypeError('Hydro width profile does not match geometry');
   widthRange=[widthParts.length,stroke_widths.length];
   for(const part of stroke_widths)widthParts.push(part);
   properties=remaining;
  }
  metadata.push({id:feature.id,properties,type:geometry.type,lineStart,lineCount,polygonLengths,widthRange});
 }
 const {offsets,values:coordinates}=encodeParts(parts,2);
 const {offsets:widthOffsets,values:widths}=encodeParts(widthParts,1);
 return {metadata,offsets,coordinates,widthOffsets,widths};
}
export function unpackHydroFeatures({metadata,offsets,coordinates,widthOffsets,widths}={}){
 if(!Array.isArray(metadata))throw new TypeError('Invalid hydro transport');
 validateParts(offsets,coordinates,2);validateParts(widthOffsets,widths,1);
 let lineCursor=0,widthCursor=0;
 // Validate metadata before allocating nested coordinate arrays.
 for(const row of metadata){
  if(!row||row.lineStart!==lineCursor||!Number.isSafeInteger(row.lineCount)||row.lineCount<1
   ||lineCursor+row.lineCount>=offsets.length)
   throw new TypeError('Invalid hydro feature line range');
  if(row.type==='LineString'){
   if(row.lineCount!==1)throw new TypeError('Invalid hydro line');
  }else if(row.type==='MultiPolygon'){
   if(!Array.isArray(row.polygonLengths)||!row.polygonLengths.length
    ||row.polygonLengths.some(count=>!Number.isSafeInteger(count)||count<1)
    ||row.polygonLengths.reduce((a,b)=>a+b,0)!==row.lineCount)
    throw new TypeError('Invalid hydro polygon lengths');
  }else if(row.type!=='MultiLineString'&&row.type!=='Polygon')throw new TypeError('Invalid hydro geometry type');
  if(row.widthRange!==null){
   const range=row.widthRange;
   if(!Array.isArray(range)||range.length!==2||range[0]!==widthCursor
    ||!Number.isSafeInteger(range[1])||range[1]<0||widthCursor+range[1]>=widthOffsets.length)
    throw new TypeError('Invalid hydro width range');
   if(range[1]){
    if(row.type!=='LineString'&&row.type!=='MultiLineString'||range[1]!==row.lineCount)
     throw new TypeError('Invalid hydro width parts');
    for(let i=0;i<range[1];i++)
     if(widthOffsets[widthCursor+i+1]-widthOffsets[widthCursor+i]!==offsets[lineCursor+i+1]-offsets[lineCursor+i])
      throw new TypeError('Invalid hydro width sample count');
   }
   widthCursor+=range[1];
  }
  lineCursor+=row.lineCount;
 }
 if(lineCursor!==offsets.length-1||widthCursor!==widthOffsets.length-1)
  throw new TypeError('Unused geometry packet parts');
 const lines=decodeParts(offsets,coordinates,2),profiles=decodeParts(widthOffsets,widths,1);
 return metadata.map(row=>{
  const slices=lines.slice(row.lineStart,row.lineStart+row.lineCount);
  let geometry;
  if(row.type==='LineString')geometry={type:row.type,coordinates:slices[0]};
  else if(row.type==='MultiPolygon'){
   let offset=0;
   geometry={type:row.type,coordinates:row.polygonLengths.map(count=>{
    const polygon=slices.slice(offset,offset+count);offset+=count;return polygon;
   })};
  }else geometry={type:row.type,coordinates:slices};
  const properties=row.widthRange===null?row.properties:{...row.properties,
   stroke_widths:profiles.slice(row.widthRange[0],row.widthRange[0]+row.widthRange[1])};
  return {type:'Feature',id:row.id,properties,geometry};
 });
}

// This transport does not truncate altitude, other coordinate ordinates or
// custom geometry fields. Unsupported input keeps the original object path.
export function canPackExactGeometry(geometry){
 if(!geometry||!['LineString','MultiLineString','Polygon','MultiPolygon'].includes(geometry.type)
  ||Object.keys(geometry).some(key=>key!=='type'&&key!=='coordinates'))return false;
 const line=points=>Array.isArray(points)&&points.length>0&&points.every(p=>Array.isArray(p)&&p.length===2&&Number.isFinite(p[0])&&Number.isFinite(p[1]));
 const lines=parts=>Array.isArray(parts)&&parts.length>0&&parts.every(line);
 return geometry.type==='LineString'?line(geometry.coordinates):geometry.type==='MultiPolygon'
  ?Array.isArray(geometry.coordinates)&&geometry.coordinates.length>0&&geometry.coordinates.every(lines):lines(geometry.coordinates);
}
