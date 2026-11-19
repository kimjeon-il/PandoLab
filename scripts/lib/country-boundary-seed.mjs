import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {runInNewContext} from 'node:vm';
import {resolveBuiltinWorldGeometry} from '../../src/data/builtin-world-loader.js';
import {validateBuiltinReadIndex} from '../../src/data/builtin-country-files.js';
import {buildCountrySharedBoundarySegments,serializeCountrySharedBoundarySegments} from '../../src/geometry/boundary-topology.js';
import {countryGeometrySignature} from '../../src/rendering/country-shared-boundary-cache.js';
let retained;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function createCountryLabelAnchorComputer({d3Source,workerSource}){
 const context={self:{}};runInNewContext(String(d3Source),context);context.self.d3=context.d3;
 runInNewContext(String(workerSource),context);return context.self.PandoLabLabelAnchorCore.computeFeatureLabelAnchor;
}
export function buildCountryBoundarySeed({index,month,catalogSha256,algorithmSha256,readGeometryAssets,computeLabelAnchor}){
 const key=JSON.stringify([month,catalogSha256,algorithmSha256]);if(retained?.key===key)return retained.result;
 const selected=resolveBuiltinWorldGeometry(index,validateBuiltinReadIndex(index),month).sort((a,b)=>a.owner.localeCompare(b.owner));
 const inputs=readGeometryAssets([...new Set(selected.map(row=>row.asset.file))]);
 const features=selected.map(({owner,asset})=>{const bytes=inputs.get(asset.file);if(!bytes||hash(bytes)!==asset.sha256)throw Error('Boundary seed geometry bytes differ from catalog');const decoded=gunzipSync(bytes);if(decoded.length!==asset.decodedBytes||hash(decoded)!==asset.contentSha256)throw Error('Boundary seed decoded geometry differs from catalog');return {id:owner,geometry:JSON.parse(decoded)};});
 const signatures=Object.fromEntries(features.map(f=>[f.id,countryGeometrySignature(f)]));
 const labelAnchors=Object.fromEntries(features.flatMap(feature=>{const point=computeLabelAnchor(feature);return Array.isArray(point)&&point.length===2&&point.every(Number.isFinite)?[[feature.id,{signature:signatures[feature.id],coordinates:Array.from(point)}]]:[];}));
 const segments=serializeCountrySharedBoundarySegments(buildCountrySharedBoundarySegments(features));
 const decoded=Buffer.from(JSON.stringify({version:1,quality:'canonical',signatures,segments,labelAnchors})),bytes=gzipSync(decoded,{level:9,mtime:0}),sha256=hash(bytes),url='assets/data/display-boundaries/sha256-'+sha256+'.json.gz';
 const result={spec:{url,sha256,encoding:'gzip',compressedBytes:bytes.length,decodedBytes:decoded.length,territorialCatalogSha256:catalogSha256,algorithmSha256,month,labelAnchors},bytes};retained={key,result};return result;
}
