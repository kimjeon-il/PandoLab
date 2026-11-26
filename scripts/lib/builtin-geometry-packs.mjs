import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {dirname,posix} from 'node:path';
import {resolveBuiltinWorldGeometry} from '../../src/data/builtin-world-loader.js';
import {validateBuiltinReadIndex} from '../../src/data/builtin-country-files.js';
import {BUILTIN_GEOMETRY_PACK_COUNT,BUILTIN_GEOMETRY_PACK_MEMBER_LIMIT,builtinGeometryPackPath} from '../../src/data/builtin-geometry-pack-receipt.js';

const digest=bytes=>createHash('sha256').update(bytes).digest();

export function readResolvedBuiltinGeometry({index,month,readGeometryAssets,reuse=[]}){
 const rows=resolveBuiltinWorldGeometry(index,validateBuiltinReadIndex(index),month).sort((a,b)=>a.owner.localeCompare(b.owner));
 return readBuiltinGeometryRows(rows,readGeometryAssets,reuse);
}

export function readBuiltinGeometryRows(rows,readGeometryAssets,reuse=[]){
 const decodedByHash=new Map(reuse.map(({asset,geometry})=>[asset.sha256,geometry]));
 const inputs=readGeometryAssets([...new Set(rows.filter(({asset})=>!decodedByHash.has(asset.sha256)).map(({asset})=>asset.file))]);
 return rows.map(({owner,asset})=>{
  if(!decodedByHash.has(asset.sha256)){
   const bytes=inputs.get(asset.file);
   if(!Buffer.isBuffer(bytes)||bytes.length!==asset.compressedBytes||digest(bytes).toString('hex')!==asset.sha256)
    throw Error('Pinned geometry bytes differ from catalog: '+asset.file);
   const decoded=gunzipSync(bytes,{maxOutputLength:asset.decodedBytes});
   if(decoded.length!==asset.decodedBytes||digest(decoded).toString('hex')!==asset.contentSha256)
    throw Error('Pinned geometry content differs from catalog: '+asset.file);
   decodedByHash.set(asset.sha256,JSON.parse(decoded));
  }
  return {id:owner,geometry:decodedByHash.get(asset.sha256),asset};
 });
}

export function buildBuiltinGeometryPacks({index,month,catalogSha256,readGeometryAssets}){
 const read=validateBuiltinReadIndex(index);
 const rows=resolveBuiltinWorldGeometry(index,read,month).sort((a,b)=>a.owner<b.owner?-1:a.owner>b.owner?1:0);
 const buckets=Array.from({length:BUILTIN_GEOMETRY_PACK_COUNT},()=>[]),seen=new Set();
 for(const {owner,asset} of rows){
  if(asset.compressedBytes>BUILTIN_GEOMETRY_PACK_MEMBER_LIMIT||seen.has(asset.file))continue;
  seen.add(asset.file);
  buckets[digest(owner).readUInt32BE()%buckets.length].push(asset);
 }
 const inputs=readGeometryAssets([...seen]),assets=new Map();
 const packs=buckets.filter(bucket=>bucket.length).map(bucket=>{
  const stored=Buffer.concat(bucket.map(asset=>{
   const bytes=inputs.get(asset.file);
   if(!Buffer.isBuffer(bytes)||bytes.length!==asset.compressedBytes||digest(bytes).toString('hex')!==asset.sha256)
    throw Error('Pinned startup geometry bytes differ from catalog: '+asset.file);
   return bytes;
  }));
  const sha256=digest(stored).toString('hex'),url=builtinGeometryPackPath(sha256);
  assets.set(url,stored);
  return {url,sha256,encoding:'identity',compressedBytes:stored.length,decodedBytes:stored.length,members:bucket.map(asset=>asset.sha256)};
 });
 return {receipt:{catalogSha256,month,packs},assets};
}

export function readBuiltinGeometryPackInputs(catalogPath,files,readPinnedData,readPinnedDataBatch){
 const base=dirname(catalogPath).replaceAll('\\','/');
 const paths=files.map(file=>posix.join(base,file));
 const bytes=readPinnedDataBatch?.(paths)??new Map(paths.map(path=>[path,readPinnedData(path)]));
 return new Map(files.map((file,i)=>[file,bytes.get(paths[i])]));
}
