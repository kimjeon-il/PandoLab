const sha256=/^[a-f0-9]{64}$/;
export const BUILTIN_GEOMETRY_PACK_COUNT=4;
export const BUILTIN_GEOMETRY_PACK_MEMBER_LIMIT=256*1024;
export const builtinGeometryPackPath=hash=>`assets/world-geometry/sha256-${hash}.bin`;

export function resolveBuiltinGeometryPacks(receipt,catalogSha256,geometryAssets){
 if(receipt?.catalogSha256!==catalogSha256||!Array.isArray(receipt.packs)||receipt.packs.length>BUILTIN_GEOMETRY_PACK_COUNT)
  throw Error('Invalid builtin geometry pack catalog receipt');
 const catalog=new Map(geometryAssets.map(asset=>[asset.sha256,asset])),seen=new Set();
 return receipt.packs.map(pack=>{
  if(!sha256.test(pack.sha256)||pack.url!==builtinGeometryPackPath(pack.sha256)||pack.encoding!=='identity'
   ||!Array.isArray(pack.members)||!pack.members.length)throw Error('Invalid builtin geometry pack receipt');
  let offset=0;
  const members=pack.members.map(hash=>{
   const asset=catalog.get(hash);
   if(!asset||seen.has(hash)||asset.compressedBytes>BUILTIN_GEOMETRY_PACK_MEMBER_LIMIT)throw Error('Invalid builtin geometry pack member');
   seen.add(hash);
   const start=offset;offset+=asset.compressedBytes;
   return {asset,start,end:offset};
  });
  if(!Number.isSafeInteger(offset)||offset!==pack.compressedBytes||offset!==pack.decodedBytes)
   throw Error('Invalid builtin geometry pack size');
  return {spec:pack,members};
 });
}
