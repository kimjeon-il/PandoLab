import {createHash} from 'node:crypto';
import {gunzipSync,gzipSync} from 'node:zlib';
import {geometryDeltaLayout,geometryDeltaPath,reconstructGeometryBytes} from '../../src/data/historical-geometry-delta.js';
import {resolveBuiltinWorldGeometry} from '../../src/data/builtin-world-loader.js';
import {parseTemporal,compareTemporalKeys} from '../../src/document/temporal.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const array=bytes=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
const refKey=ref=>JSON.stringify([ref.id,ref.version]);
const MiB=1024*1024;

// Rolling byte hash finds common coordinate runs even when an insertion
// shifts every subsequent JSON byte. Candidates are always byte-compared.
export function createGeometryByteDelta(base,target){
 const width=32,step=32,index=new Map(),factor=16777619;
 let power=1;for(let i=1;i<width;i++)power=Math.imul(power,factor);
 const windowHash=(bytes,at)=>{let h=0;for(let i=0;i<width;i++)h=(Math.imul(h,factor)+bytes[at+i])>>>0;return h;};
 for(let i=0;i+width<=base.length;i+=step){
  const h=windowHash(base,i),hits=index.get(h);
  if(!hits)index.set(h,[i]);else if(hits.length<4)hits.push(i);
 }
 const segments=[];let start=0,i=0,h=target.length>=width?windowHash(target,0):0;
 while(i+width<=target.length){
  let length=0,offset=0;
  for(const at of index.get(h)||[]){
   if(!base.subarray(at,at+width).equals(target.subarray(i,i+width)))continue;
   let n=width;
   while(at+n+4<=base.length&&i+n+4<=target.length&&base.readUInt32LE(at+n)===target.readUInt32LE(i+n))n+=4;
   while(at+n<base.length&&i+n<target.length&&base[at+n]===target[i+n])n++;
   if(n>length){length=n;offset=at;}
   if(length>=1024*1024)break;
  }
  if(length){
   if(i>start)segments.push({literal:target.subarray(start,i)});
   segments.push({offset,length});i+=length;start=i;
   if(i+width<=target.length)h=windowHash(target,i);
  }else{
   if(i+width<target.length)h=(Math.imul((h-Math.imul(target[i],power))>>>0,factor)+target[i+width])>>>0;
   i++;
  }
 }
 if(start<target.length)segments.push({literal:target.subarray(start)});
 const patch=Buffer.alloc(20+segments.reduce((n,s)=>n+(s.literal?8+s.literal.length:12),0));
 patch.writeUInt32LE(0x50444d31,0);patch.writeUInt32LE(1,4);
 patch.writeUInt32LE(base.length,8);patch.writeUInt32LE(target.length,12);patch.writeUInt32LE(segments.length,16);
 let pos=20;
 for(const s of segments){
  patch.writeUInt32LE(s.literal?1:0,pos);pos+=4;
  if(s.literal){patch.writeUInt32LE(s.literal.length,pos);pos+=4;s.literal.copy(patch,pos);pos+=s.literal.length;}
  else{patch.writeUInt32LE(s.offset,pos);patch.writeUInt32LE(s.length,pos+4);pos+=8;}
 }
 return patch;
}
export function buildBuiltinGeometryDeltas({index,month,catalogSha256,readGeometryAssets}){
 const assets=new Map(),receipt={layout:geometryDeltaLayout,catalogSha256,entries:[]};
 const byRef=new Map(index.geometryAssets.map(asset=>[refKey(asset),asset]));
 const active=new Set(resolveBuiltinWorldGeometry(index,index.readIndex,month).map(({asset})=>asset.sha256));
 const grouped=new Map();
 for(const row of index.readIndex.records.geometryBindings){
  let rows=grouped.get(row.objectRef.id);
  if(!rows){rows=[];grouped.set(row.objectRef.id,rows);}
  rows.push({asset:byRef.get(refKey(row.geometryRef)),start:row.validFrom?parseTemporal(row.validFrom,{nullable:false}).startKey:null});
 }
 const candidates=new Map();
 function consider(base,target){
  if(!base||!target||base.sha256===target.sha256||base.type!==target.type
   ||target.compressedBytes<8192||Math.max(base.decodedBytes,target.decodedBytes)>4*MiB
   ||base.decodedBytes<target.decodedBytes/2||base.decodedBytes>target.decodedBytes*2)return;
  const key=base.sha256+target.sha256;
  if(!candidates.has(key))candidates.set(key,{base,target,rank:active.has(base.sha256)?1:0});
 }
 for(const rows of grouped.values()){
  rows.sort((a,b)=>a.start===null?(b.start===null?0:-1):b.start===null?1:compareTemporalKeys(a.start,b.start));
  for(let i=1;i<rows.length;i++){consider(rows[i-1].asset,rows[i].asset);consider(rows[i].asset,rows[i-1].asset);}
 }
 const selected=[],files=new Map();let inputBytes=0,decodedBytes=0;
 for(const pair of [...candidates.values()].sort((a,b)=>b.rank-a.rank||b.target.compressedBytes-a.target.compressedBytes||a.target.sha256.localeCompare(b.target.sha256))){
  if(selected.length>=48)break;
  const extra=[pair.base,pair.target].filter(asset=>!files.has(asset.file));
  const stored=extra.reduce((n,a)=>n+a.compressedBytes,0),decoded=extra.reduce((n,a)=>n+a.decodedBytes,0);
  if(inputBytes+stored>8*MiB||decodedBytes+decoded>32*MiB)continue;
  selected.push(pair);for(const asset of extra)files.set(asset.file,asset);
  inputBytes+=stored;decodedBytes+=decoded;
 }
 if(!selected.length)return {receipt,assets};
 const stored=readGeometryAssets([...files.keys()]),raw=new Map();
 const read=asset=>{
  if(raw.has(asset.file))return raw.get(asset.file);
  const bytes=stored.get(asset.file);
  if(!Buffer.isBuffer(bytes)||bytes.length!==asset.compressedBytes||hash(bytes)!==asset.sha256)throw Error('Historical geometry input differs from catalog: '+asset.file);
  const decoded=gunzipSync(bytes,{maxOutputLength:asset.decodedBytes});
  if(decoded.length!==asset.decodedBytes||hash(decoded)!==asset.contentSha256)throw Error('Historical geometry decoded content mismatch');
  raw.set(asset.file,decoded);return decoded;
 };
 const best=new Map();
 for(const {base,target} of selected){
  const original=read(base),expected=read(target),patch=createGeometryByteDelta(original,expected);
  if(patch.length>expected.length+MiB)continue;
  const bytes=gzipSync(patch,{level:9,mtime:0});
  // Include receipt overhead; never publish a delta that is not materially smaller.
  if(bytes.length+2048>=target.compressedBytes*.7)continue;
  if(!Buffer.from(reconstructGeometryBytes(array(original),array(patch),target)).equals(expected))throw Error('Historical delta changed canonical bytes');
  const prior=best.get(target.sha256);
  if(!prior||bytes.length<prior.bytes.length)best.set(target.sha256,{base,target,bytes,decodedBytes:patch.length});
 }
 for(const {base,target,bytes,decodedBytes} of best.values()){
  const sha256=hash(bytes),url=geometryDeltaPath(sha256);
  assets.set(url,bytes);receipt.entries.push({target:target.sha256,base:base.sha256,replacement:{url,sha256,encoding:'gzip',compressedBytes:bytes.length,decodedBytes}});
 }
 return {receipt,assets};
}
