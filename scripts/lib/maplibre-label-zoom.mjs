// These factories are inserted into the corresponding pinned MapLibre bundles.
export function createLabelZoomWorker() {
 const pack=128,limit=255*pack;
 function add(bucket,buffers,feature,canonical,vertexEnd,vertexCount,parameters){
  if(!vertexCount)return;
  const value=bucket.layers[0]._unevaluatedLayout._values['text-size'];
  const expression=value.expression;
  if(expression.kind!=='composite')return;
  const stops=expression.zoomStops;
  const evaluate=zoom=>value.possiblyEvaluate(parameters(zoom),canonical).evaluate(feature,{},canonical);
  // The collision rectangles are prepared at tile zoom + 1, independent of
  // the two stops that MapLibre stores for drawing its composite symbols.
  const layoutSize=evaluate(bucket.zoom+1);
  const packed=stops.map(zoom=>Math.max(0,Math.min(limit,Math.round(pack*evaluate(zoom)))));
  const table=buffers.pandoZoomSizes??={stops,entries:[]};
  table.entries[buffers.placedSymbolArray.length-1]={
   first:vertexEnd-vertexCount,end:vertexEnd,packed,layoutSize,
  };
 }
 return {add};
}

export function createLabelZoomRenderer() {
 const states=new WeakMap();
 const attributes=[{name:'a_pando_label_size',type:'Uint16',components:2,offset:0}];
 function band(buffers,native,zoom){
  const table=buffers?.pandoZoomSizes;
  if(!table||native.kind!=='composite'||(zoom>=native.minZoom&&zoom<=native.maxZoom))return null;
  const {stops}=table;
  let upper=stops.findIndex(stop=>stop>=zoom);
  if(upper<0)upper=stops.length-1;
  const lower=zoom>=stops[upper]&&upper===stops.length-1?upper:Math.max(0,upper-1);
  return {lower,upper,sizeData:{...native,minZoom:stops[lower],maxZoom:stops[upper]}};
 }
 function prepare(buffers,native,zoom,context){
  if(!buffers.pandoZoomSizes)return native;
  const interval=band(buffers,native,zoom);
  buffers.pandoActiveSizeBuffer=null;
  if(!interval)return native;
  const {lower,upper,sizeData}=interval;
  const previous=states.get(buffers);
  if(previous?.lower===lower&&previous.upper===upper){
   buffers.pandoActiveSizeBuffer=previous.buffer;
   return sizeData;
  }
  const length=buffers.layoutVertexBuffer.length;
  const values=previous?.values??new Uint16Array(length*2);
  for(const entry of buffers.pandoZoomSizes.entries){
   if(!entry)continue;
   const lo=entry.packed[lower],hi=entry.packed[upper];
   for(let i=entry.first*2;i<entry.end*2;i+=2){
    values[i]=lo;
    values[i+1]=hi;
   }
  }
  const data={length,bytesPerElement:4,arrayBuffer:values.buffer};
  const buffer=previous?.buffer??context.createVertexBuffer(data,attributes,true);
  if(previous)buffer.updateData(data);
  buffers.pandoSizeUploads=(buffers.pandoSizeUploads??0)+1;
  states.set(buffers,{lower,upper,values,buffer});
  buffers.pandoActiveSizeBuffer=buffer;
  return sizeData;
 }
 function collision(buffers,interval,index,box,zoom,evaluateZoom,evaluateFeature){
  const entry=interval&&buffers.pandoZoomSizes.entries[index];
  if(!entry||entry.layoutSize<=0)return null;
  const {lower,upper,sizeData}=interval;
  const size=evaluateFeature(sizeData,evaluateZoom(sizeData,zoom),{
   lowerSize:entry.packed[lower],upperSize:entry.packed[upper],
  });
  // Broad-phase coverage must include the interpolated glyph. Keep
  // the tile's existing padding conservative as the label grows or shrinks.
  const scale=Math.max(1,size/entry.layoutSize);
  return {size,box:scale>1?{...box,x1:box.x1*scale,y1:box.y1*scale,x2:box.x2*scale,y2:box.y2*scale}:box};
 }
 function destroy(buffers){
  states.get(buffers)?.buffer.destroy();
  states.delete(buffers);
  buffers.pandoActiveSizeBuffer=null;
 }
 return {band,prepare,collision,destroy};
}
