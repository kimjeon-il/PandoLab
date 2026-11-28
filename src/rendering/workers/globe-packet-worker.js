import '../../runtime/workers/worker-rpc-host.js';
import { decodeStoredBuffer, validateAssetLength } from '../../data/asset-decompression.js';
import { decodeGlobeMesh, decodeGlobeStrokes, createGlobeStrokeBatchBuilder } from '../globe-mesh.js';
import { prepareGlobeSpatialPacket } from '../globe-spatial-partition.js';
import { indexGlobeOutlineChunks } from '../globe-outline-index.js';
import { GLOBE_HISTORY_CATALOG_VERSION } from '../globe-history-catalog.js';
import { GLOBE_SPATIAL_CATALOG_VERSION } from '../globe-spatial-catalog.js';
import { GLOBE_LODS } from '../globe-lod.js';
import { createGlobeRiverJunctionGuard,simplifyGlobeRiverPacket } from '../globe-river-simplification.js';

const rpc = self.PandoLabWorkerRpc;
function transfer(value) {
  const buffers = new Set(), visited = new Set();
  function visit(row) {
    if (!row||typeof row!=='object'||visited.has(row))return;
    visited.add(row);
    if (ArrayBuffer.isView(row))buffers.add(row.buffer);
    else if (row instanceof ArrayBuffer)buffers.add(row);
    else for (const child of Object.values(row))visit(child);
  }
  visit(value); return rpc.transferResult(value, [...buffers]);
}
async function decodePacket({kind,bytes,spec,ownerCount,outlineOwners,identityCount,spatial = true},context) {
  context.throwIfCancelled();
  const decoded = await decodeStoredBuffer(bytes,spec,'worker','globe','지도 패킷',context.signal);
  validateAssetLength(decoded,spec,'지도 패킷');
  context.throwIfCancelled();
  let value;
  switch (kind) {
    case 'mesh':value = prepareGlobeSpatialPacket(decodeGlobeMesh(decoded.buffer)); break;
    case 'stroke':
      value = decodeGlobeStrokes(decoded.buffer);
      if (ownerCount!==undefined&&(value.ownerGroups.length!==value.count||value.ownerGroups.some(group => group>=ownerCount)))
        throw Error('Invalid globe outline owners');
      if (spatial)value = prepareGlobeSpatialPacket(value,{outline:ownerCount!==undefined});
      if (outlineOwners) {
        if (outlineOwners.length!==ownerCount)throw Error('Invalid outline owner table');
        value = {...value,outlineIndex:indexGlobeOutlineChunks(value,outlineOwners)};
      }
      break;
    case 'catalog':
      value = JSON.parse(new TextDecoder().decode(decoded.buffer));
      if (value?.version!==GLOBE_HISTORY_CATALOG_VERSION||!Array.isArray(value.pages))
        throw Error('Invalid Three.js history directory');
      break;
    case 'catalog-page':
      value=JSON.parse(new TextDecoder().decode(decoded.buffer));
      if (value?.version!==GLOBE_HISTORY_CATALOG_VERSION||!Array.isArray(value.entries))
        throw Error('Invalid Three.js history catalog page');
      break;
    case 'spatial-catalog-page':
      value=JSON.parse(new TextDecoder().decode(decoded.buffer));
      if (value?.version!==GLOBE_SPATIAL_CATALOG_VERSION||!Array.isArray(value.entries))
        throw Error('Invalid Three.js spatial catalog page');
      break;
    case 'hydro':
      value = JSON.parse(new TextDecoder().decode(decoded.buffer));
      if (!Array.isArray(value)||value.length!==identityCount)throw Error('Invalid globe hydro identities');
      break;
    default:throw Error('Unsupported globe packet kind: '+kind);
  }
  context.throwIfCancelled();
  return {value,transferable:kind!=='hydro'&&kind!=='catalog'&&kind!=='catalog-page'&&kind!=='spatial-catalog-page'};
}
rpc.install({handlers:{
  'globe.aggregate-stored-strokes':async({packets,lod=0,errorScale=16,maxRun=512,protectedBounds=null},context)=>{
    if(!Array.isArray(packets)||packets.length<2||packets.length>32||lod!==0||!Number.isFinite(errorScale)||errorScale<1||errorScale>64||
      !Number.isInteger(maxRun)||maxRun<32||maxRun>512||protectedBounds!==null&&(!Array.isArray(protectedBounds)||protectedBounds.length!==6||!protectedBounds.every(Number.isFinite)))
      throw Error('Invalid hierarchical river aggregate request');
    const maxPoints=packets.reduce((sum,row)=>sum+Math.floor(row.spec.decodedBytes/24),0);
    const decodedPackets=await Promise.all(packets.map(async row=>{
      context.throwIfCancelled();const decoded=await decodeStoredBuffer(row.bytes,row.spec,'worker','river-aggregate','하천 공간 집계',context.signal);
      validateAssetLength(decoded,row.spec,'하천 공간 집계');return decodeGlobeStrokes(decoded.buffer);
    }));
    context.throwIfCancelled();const guard=createGlobeRiverJunctionGuard(decodedPackets),builder=createGlobeStrokeBatchBuilder(maxPoints);
    for(const packet of decodedPackets){context.throwIfCancelled();builder.append(packet);}
    const simplified=simplifyGlobeRiverPacket(builder.finish(),GLOBE_LODS[lod],guard,{maxRun,errorScale,protectedBounds});
    context.throwIfCancelled();return transfer(prepareGlobeSpatialPacket(simplified));
  },
  'globe.combine-stored-strokes':async({packets}, context) => {
    const maxPoints = packets.reduce((sum, row) => sum+Math.floor(row.spec.decodedBytes/24),0);
    const builder = createGlobeStrokeBatchBuilder(maxPoints);
    const decodedPackets = await Promise.all(packets.map(async row => {
      context.throwIfCancelled();
      const decoded = await decodeStoredBuffer(row.bytes,row.spec,'worker','border-batch','역사 국경선',context.signal);
      validateAssetLength(decoded,row.spec,'역사 국경선');
      return decodeGlobeStrokes(decoded.buffer);
    }));
    context.throwIfCancelled();
    for (const packet of decodedPackets)builder.append(packet);
    // The combined stroke packet receives its spatial index before it leaves the Worker.
    return transfer(prepareGlobeSpatialPacket(builder.finish()));
  },
  'globe.decode-packet':async(packet,context) => {
    const {value,transferable} = await decodePacket(packet,context);
    return transferable?transfer(value):value;
  },
  'globe.decode-packet-batch':async({packets},context) => {
    if (!Array.isArray(packets)||packets.length<2||packets.length>8)throw Error('Invalid globe spatial packet batch');
    // Start independent decompression jobs together. Spatial trees are
    // built immediately after each packet is decoded, before any result is
    // transferred back to the main thread.
    const rows = await Promise.all(packets.map(async packet => {
      context.throwIfCancelled();
      try {
        if (!['mesh','stroke'].includes(packet.kind)||packet.ownerCount!==undefined||packet.outlineOwners)
          throw Error('Unsupported globe packet in spatial batch');
        const {value,transferable} = await decodePacket(packet,context);
        if (!transferable)throw Error('Spatial packet batch must contain transferable packets');
        return {ok:true,value};
      }catch(error) {
        context.throwIfCancelled();
        return {ok:false,error:{name:error?.name||'Error',message:error?.message||String(error)}};
      }
    }));
    context.throwIfCancelled();
    return transfer(rows);
  },
}});
