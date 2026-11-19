import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {loadPhysicalLandGeometry} from '../../src/data/physical-land-patch.js';
import {dissolvePhysicalLand} from '../../src/rendering/physical-land-display.js';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const shaPattern=/^[a-f0-9]{64}$/;
export const physicalLandDisplayAlgorithmVersion='physical-display-union-v1';

/** Publish display derivatives of the selected catalog only; original data stays immutable. */
export async function buildPhysicalLandDisplayAssets({catalog,readPinnedData,algorithmSha256,union}){
 if(!shaPattern.test(algorithmSha256||'')||typeof readPinnedData!=='function'||typeof union!=='function')
  throw new TypeError('Invalid physical display build dependencies');
 const sources=[catalog?.asset,...(catalog?.waterObjects?.geometries||[]).map(row=>row.land).filter(Boolean)];
 const selected=new Map(),decoded=new Map(),assets=new Map(),specs={};
 for(const spec of sources){
  if(!shaPattern.test(spec?.sha256||''))throw new TypeError('Invalid physical land source identity');
  if(!selected.has(spec.sha256))selected.set(spec.sha256,spec);
 }
 const load=async spec=>{
  if(!shaPattern.test(spec?.sha256||'')||!['gzip','identity'].includes(spec.encoding)
   ||typeof spec.url!=='string'||!spec.url.startsWith('assets/data/')||/[?#\\]/.test(spec.url)
   ||spec.url.split('/').some(part=>!part||part==='.'||part==='..')
   ||!Number.isSafeInteger(spec.compressedBytes)||spec.compressedBytes<1
   ||!Number.isSafeInteger(spec.decodedBytes)||spec.decodedBytes<1)
   throw new TypeError('Invalid physical land asset receipt');
  if(!decoded.has(spec.sha256))decoded.set(spec.sha256,(async()=>{
   const bytes=Buffer.from(await readPinnedData(spec.url));
   if(bytes.length!==spec.compressedBytes||hash(bytes)!==spec.sha256)throw new Error('Physical land source integrity mismatch: '+spec.url);
   const json=spec.encoding==='gzip'?gunzipSync(bytes):bytes;
   if(json.length!==spec.decodedBytes)throw new Error('Physical land decoded length mismatch: '+spec.url);
   return {value:JSON.parse(json.toString('utf8')),compressedBytes:bytes.length,decodedBytes:json.length};
  })());
  const cached=await decoded.get(spec.sha256);
  if(cached.compressedBytes!==spec.compressedBytes||cached.decodedBytes!==spec.decodedBytes)
   throw new Error('Physical land cached receipt mismatch: '+spec.url);
  return cached.value;
 };
 for(const [sourceSha256,source]of selected){
  const geometry=await loadPhysicalLandGeometry(source,{loadGeometry:load,loadPatch:load});
  const display=await dissolvePhysicalLand(geometry,{union});
  // Reject malformed kernel output before it becomes trusted publication metadata.
  if(!display.coordinates.length||display.coordinates.some(polygon=>!Array.isArray(polygon)||!polygon.length
   ||polygon.some(ring=>!Array.isArray(ring)||ring.length<4
    ||ring.some(point=>!Array.isArray(point)||point.length<2||!point.every(Number.isFinite))
    ||ring[0][0]!==ring.at(-1)[0]||ring[0][1]!==ring.at(-1)[1])))
   throw new Error('Invalid physical display geometry');
  const json=Buffer.from(JSON.stringify(display)),bytes=gzipSync(json,{level:9});
  bytes[9]=10; // Match the deterministic physical-data publication gzip header.
  const sha256=hash(bytes),url='assets/data/display-land/sha256-'+sha256+'.json.gz';
  assets.set(url,bytes);
  specs[sourceSha256]={sourceSha256,algorithmVersion:physicalLandDisplayAlgorithmVersion,algorithmSha256,
   url,encoding:'gzip',compressedBytes:bytes.length,decodedBytes:json.length,sha256};
 }
 return {specs,assets};
}
