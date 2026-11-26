import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {runInNewContext} from 'node:vm';
import {readResolvedBuiltinGeometry} from './builtin-geometry-packs.mjs';
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
 const features=readResolvedBuiltinGeometry({index,month,readGeometryAssets});
 const signatures=Object.fromEntries(features.map(f=>[f.id,countryGeometrySignature(f)]));
 const labelAnchors=Object.fromEntries(features.flatMap(feature=>{const point=computeLabelAnchor(feature);return Array.isArray(point)&&point.length===2&&point.every(Number.isFinite)?[[feature.id,{signature:signatures[feature.id],coordinates:Array.from(point)}]]:[];}));
 const segments=serializeCountrySharedBoundarySegments(buildCountrySharedBoundarySegments(features));
 const decoded=Buffer.from(JSON.stringify({version:1,quality:'canonical',signatures,segments,labelAnchors})),bytes=gzipSync(decoded,{level:9,mtime:0}),sha256=hash(bytes),url='assets/data/display-boundaries/sha256-'+sha256+'.json.gz';
 const result={spec:{url,sha256,encoding:'gzip',compressedBytes:bytes.length,decodedBytes:decoded.length,territorialCatalogSha256:catalogSha256,algorithmSha256,month,labelAnchors},bytes};retained={key,result};return result;
}
