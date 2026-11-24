// Estimates only CPU-side JS coordinate storage. Native tile/GPU allocation
// is opaque and must not be presented as measured heap or VRAM.
export function createGeometryByteEstimator(){
 const sizes=new WeakMap();
 function sizeOf(value){
  if(!Array.isArray(value))return 8;
  let bytes=32+value.length*8;
  if(Array.isArray(value[0]))for(const child of value)bytes+=sizeOf(child);
  return bytes;
 }
 return geometry=>{
  if(!geometry||typeof geometry!=='object')return 0;
  if(!sizes.has(geometry))sizes.set(geometry,64+sizeOf(geometry.coordinates));
  return sizes.get(geometry);
 };
}
export function estimateFeatureRows(features,geometryBytes){
 const seen=new Set();let bytes=0;
 for(const feature of features){
  bytes+=256;
  if(feature?.geometry&&!seen.has(feature.geometry)){
   seen.add(feature.geometry);bytes+=geometryBytes(feature.geometry);
  }
 }
 return bytes;
}
