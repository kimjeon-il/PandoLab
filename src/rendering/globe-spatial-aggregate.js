const unionBounds=rows=>{
  const bounds=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];
  for(const row of rows)for(let axis=0;axis<3;axis++){bounds[axis]=Math.min(bounds[axis],row.bounds[axis]);bounds[axis+3]=Math.max(bounds[axis+3],row.bounds[axis+3]);}
  return bounds;
};
const bytesOf=row=>Math.max(0,Number(row.spec?.decodedBytes)||0);
const compressedOf=row=>Math.max(0,Number(row.spec?.compressedBytes)||0);
// Batch consecutive compatible descriptors across cell boundaries. The
// combined packet keeps its own spatial index, so union bounds do not disable
// fine-grained culling or reorder painter/owner runs.
export function batchGlobeStrokeDescriptors(rows,{prefix='stroke-batch',byteBudget=8*1024*1024,maxSources=32,
  groupKey=row=>String(row.lod??2)+':'+String(row.minZoom??''),aggregate=null}={}) {
  const result=[];let sources=[],bytes=0,activeKey=null;
  const flush=()=>{
    if(!sources.length)return;
    const metadata=aggregate?.(sources)??{}, {force=false,...extra}=metadata;
    if(sources.length===1&&!force)result.push({...sources[0],...extra});
    else {
      const key=prefix+':'+sources.map(row=>row.key??row.spec.sha256).join(',');
      const decodedBytes=sources.reduce((sum,row)=>sum+bytesOf(row),0),compressedBytes=sources.reduce((sum,row)=>sum+compressedOf(row),0);
      const first=sources[0],slots=[...new Set(sources.flatMap(row=>row.slots??[]))].sort((a,b)=>a-b);
      result.push({...first,...extra,key,sources:[...sources],bounds:unionBounds(sources),slots,cell:null,
        spec:{sha256:key,decodedBytes,compressedBytes,estimatedBytes:compressedBytes*3+decodedBytes*7+64*1024}});
    }
    sources=[];bytes=0;activeKey=null;
  };
  for(const row of rows){const key=groupKey(row),size=bytesOf(row);
    if(sources.length&&(key!==activeKey||sources.length>=maxSources||bytes+size>byteBudget))flush();
    if(!sources.length)activeKey=key;sources.push(row);bytes+=size;
  }
  flush();return result;
}
export function globeStrokePacketDecodedBytes(packet){
  return 20+packet.points.byteLength+packet.endpointIndices.byteLength+packet.widths.byteLength+packet.ownerGroups.byteLength;
}
