import '../../runtime/workers/worker-rpc-host.js';
import {decodeStoredBuffer,validateAssetLength} from '../../data/asset-decompression.js';
import {decodeGlobeMesh,decodeGlobeStrokes,combineGlobeStrokePackets} from '../globe-mesh.js';
import {prepareGlobeSpatialPacket} from '../globe-spatial-partition.js';

const rpc=self.PandoLabWorkerRpc;
function transfer(value){
 const buffers=new Set(),visited=new Set();
 function visit(row){
  if(!row||typeof row!=='object'||visited.has(row))return;
  visited.add(row);
  if(ArrayBuffer.isView(row))buffers.add(row.buffer);
  else if(row instanceof ArrayBuffer)buffers.add(row);
  else for(const child of Object.values(row))visit(child);
 }
 visit(value);return rpc.transferResult(value,[...buffers]);
}
rpc.install({handlers:{
 'globe.combine-strokes':({packets},context)=>{
  context.throwIfCancelled();
  const value=prepareGlobeSpatialPacket(combineGlobeStrokePackets(packets));
  context.throwIfCancelled();
  return transfer(value);
 },
 'globe.decode-packet':async({kind,bytes,spec,ownerCount,identityCount,spatial=true},context)=>{
  context.throwIfCancelled();
  const decoded=await decodeStoredBuffer(bytes,spec,'worker','globe','지도 패킷',context.signal);
  validateAssetLength(decoded,spec,'지도 패킷');
  context.throwIfCancelled();
  let value;
  switch(kind){
   case 'mesh':value=prepareGlobeSpatialPacket(decodeGlobeMesh(decoded.buffer));break;
   case 'stroke':
    value=decodeGlobeStrokes(decoded.buffer);
    if(ownerCount!==undefined&&(value.ownerGroups.length!==value.count||value.ownerGroups.some(group=>group>=ownerCount)))
     throw Error('Invalid globe outline owners');
    if(spatial)value=prepareGlobeSpatialPacket(value,{outline:ownerCount!==undefined});
    break;
   case 'hydro':
    value=JSON.parse(new TextDecoder().decode(decoded.buffer));
    if(!Array.isArray(value)||value.length!==identityCount)throw Error('Invalid Three.js hydro identities');
    break;
   default:throw Error('Unsupported globe packet kind: '+kind);
  }
  context.throwIfCancelled();
  return kind==='hydro'?value:transfer(value);
 },
}});
