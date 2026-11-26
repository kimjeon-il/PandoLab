import '../../runtime/workers/worker-rpc-host.js';
import {decodeStoredBuffer,validateAssetLength} from '../../data/asset-decompression.js';
import {decodeGlobeMesh,decodeGlobeStrokes,combineGlobeStrokePackets} from '../globe-mesh.js';
import {decodeGlobePickGrid} from '../globe-picking.js';

const rpc=self.PandoLabWorkerRpc;
rpc.install({handlers:{
 'globe.combine-strokes':({packets},context)=>{
  context.throwIfCancelled();
  const value=combineGlobeStrokePackets(packets);
  context.throwIfCancelled();
  return rpc.transferResult(value,[...new Set(Object.values(value).filter(ArrayBuffer.isView).map(array=>array.buffer))]);
 },
 'globe.decode-packet':async({kind,bytes,spec,primitiveCount,ownerCount,identityCount},context)=>{
  context.throwIfCancelled();
  const decoded=await decodeStoredBuffer(bytes,spec,'worker','globe','지도 패킷',context.signal);
  validateAssetLength(decoded,spec,'지도 패킷');
  context.throwIfCancelled();
  let value;
  switch(kind){
   case 'mesh':value=decodeGlobeMesh(decoded.buffer);break;
   case 'stroke':
    value=decodeGlobeStrokes(decoded.buffer);
    if(ownerCount!==undefined&&(value.ownerGroups.length!==value.count||value.ownerGroups.some(group=>group>=ownerCount)))
     throw Error('Invalid globe outline owners');
    break;
   case 'pick':value=decodeGlobePickGrid(decoded.buffer,primitiveCount);break;
   case 'hydro':
    value=JSON.parse(new TextDecoder().decode(decoded.buffer));
    if(!Array.isArray(value)||value.length!==identityCount)throw Error('Invalid Three.js hydro identities');
    break;
   default:throw Error('Unsupported globe packet kind: '+kind);
  }
  context.throwIfCancelled();
  const buffers=new Set();
  if(kind!=='hydro')for(const array of Object.values(value))if(ArrayBuffer.isView(array))buffers.add(array.buffer);
  return rpc.transferResult(value,[...buffers]);
 },
}});
