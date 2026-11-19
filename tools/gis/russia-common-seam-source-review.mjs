import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeOriginalBlobGeometry as standardDecoder} from '../data/chunked-original-source.mjs';
export const method='retained-current-original-common-seam';
export const baseRevision='a3c495bb3d4a3d5961303a91de44cff00196d0fb';
const base='assets/data/territorial-entities/source/';
export const descriptor=base+'countries/state-RUS.json';
export const versionId='state:RUS:natural-earth-5.1.1';
const prefix='reports/borders/validation/modern-raw-source-20261110/';
export const SHA=b=>createHash('sha256').update(b).digest('hex');
export const geometrySHA=g=>SHA(JSON.stringify([g.type,g.coordinates]));
const fixed=Object.freeze({
 descriptor:'28986a146e6b859e2f952cd91d4204d80db7fb21c521156f63aec4a60a06b024',
 resource:'697b8e0eead5324e5787f5139a00efb1f487a0f6984c4330659594b1da431a98',
 after:'50c4cfffb961813a6a2a155c022aaab1ffe5881a65aba51cd74131dffc04ef29',
 result:'9607237f7eaca4a130976c5d1d18f569b278980aa471d43c58d7970feb35abc3',
 ops:'647f37d26645647d8648b3db0346e91a40828cb680f4056beb853933e4cc1bd6',
 topology:'4453c5be06d52e244842d2a7b7737d915d8b6c0a180814706b8d71d40cd2eaec',
 sourceWkb:'707b022fc4049577b58685185b1c42fe0e27dbabdd50f1e2a64496ac4532004e',
 sourceBlob:'dd7318632d77ee7650089ae735c63f94d14bb8792eae82fa596b8e8a355d8ca7',
});
export const resource=base+'geometries/sha256-'+fixed.after+'.json';
export const operationsPath=prefix+'rus-kaz-mng-common-seam-20261114/indexed-operations.json';
export const topologyPath=prefix+'rus-kaz-mng-common-seam-20261114/topology.json';
const originalPath=k=>prefix+'whole-original-region-current-four-20261113/originals/'+k+'-original.json';
export const donorsFixed=Object.freeze({
 KAZ:{source:'6614379d2869ddfb259f556432c31d72058784927427a2ea7ea4e4ec2461fd8c',id:'7f1674ad-e097-48c8-829b-a60281d4230f',wkb:'5870d328e9e29e6647cfb3b4dd8651d117041011a04b3003740860f321b60652',blob:'9e5494978c0c7bcc07a0c590f98fbe04c11c152754b9e59ff43dbb31c03867c0',descriptor:'466f8a4aedc6271c0a9db3c2fa1ee4244aeda1bad30101149ededce0faf21962',resource:'47de235c3a3e07fa5fa40d7ba0805a5ddbe757d5857534439c37903aa0db46ae'},
 MNG:{source:'8e55db9cbc7f4bf451bc0f7842c72af39f0fca7f289655fb1b682317e67465bd',id:'155de18e-f167-4ad2-b383-1fb75b14a100',wkb:'d3c2ede1203fd882c15b869ec674d4f66306042bb822035c2a648e2856c0ab79',blob:'a3313d02a037a23ca503589a0b6c2963c760f52123294d977671ac2c8f67e462',descriptor:'d7e67adde7c998fe4886811b432aabc08063dbfdef353bb29b94330dfdf71cc8',resource:'476459922561c7f96ae33b864421f506436d6eba925ef423b29a052ca27c806a'},
 CHN:{descriptor:'a7b93e8c2d55937c4d72c855c5d57f8736f8cb14002faadb09627c9282dc89e6',resource:'bdb896baa43229e2c6d29c678132a1c7c1f15810a56b1370b9c980ad50683b50'},
});
const check=(x,msg)=>{if(!x)throw Error('Russia common seam: '+msg);};
const bytes=(read,p,sha)=>{const b=read(p);check(Buffer.isBuffer(b)&&SHA(b)===sha,'pinned receipt mismatch: '+p);return b;};
const iso=k=>base+'countries/state-'+k+'.json';
const isCandidate=v=>v?.modernBoundarySupplement?.adoptionMode===method;
export const hasRussiaSeam=x=>x?.geometryVersions?.some(isCandidate)===true;
const point=(x,y)=>Array.isArray(x)&&Array.isArray(y)&&x.length===2&&y.length===2&&x[0]===y[0]&&x[1]===y[1];
const ring=(g,p,r)=>g?.type==='MultiPolygon' ? g.coordinates?.[p]?.[r] : p===0&&g?.type==='Polygon'?g.coordinates?.[r]:null;
const numbered=({polygonIndex,ringIndex,startIndex,endIndex,direction},g)=>{
 const rr=ring(g,polygonIndex,ringIndex);
 check(Array.isArray(rr)&&Number.isInteger(startIndex)&&Number.isInteger(endIndex)&&startIndex>=0&&endIndex>=0&&startIndex<rr.length&&endIndex<rr.length&&[-1,1].includes(direction)&&Math.sign(endIndex-startIndex)===direction,'raw chain index');
 return direction===1?rr.slice(startIndex,endIndex+1):rr.slice(endIndex,startIndex+1).reverse();
};
export function replayRussiaSeam(before,donors,indexed){
 const old=ring(before,3289,0), out=[];
 check(before.coordinates?.length===6843&&old?.length===64474&&point(old[0],indexed.rusRingStart)&&point(old[0],old.at(-1)),'old exact ring preimage');
 check(indexed.coalescedSpanCount===193&&indexed.originalSpanCount===4107&&indexed.basePin===baseRevision&&indexed.ops?.length===193,'fixed operation inventory');
 check(indexed.rusGeometrySha256===fixed.resource&&indexed.rusDescriptorSha256===fixed.descriptor&&indexed.rusRawWkbSha256===fixed.sourceWkb&&indexed.rusRawBlobSha256===fixed.sourceBlob&&indexed.rusUuid==='47aaa6b3-b456-4723-9317-e661720b4332','Russia original provenance');
 let last=0,totals={KAZ:0,MNG:0};
 for(const op of indexed.ops){
  const {peer,oldPolygonIndex,oldRingIndex,oldStartIndex:i,oldEndIndex:j}=op;
  check(Object.hasOwn(totals,peer)&&oldPolygonIndex===3289&&oldRingIndex===0&&Number.isInteger(i)&&Number.isInteger(j)&&i>=last&&j>i&&j<old.length-1,'old indexed nonoverlapping span');
  const d=numbered(op.peerOriginal,donors[peer]),r=op.rusOriginal;
  check(r.polygonIndex===14550&&r.ringIndex===0&&Math.abs(r.endIndex-r.startIndex)===d.length-1&&Math.sign(r.endIndex-r.startIndex)===r.direction,'recorded original Russia chain indices');
  check(point(old[i],op.oldStart)&&point(old[j],op.oldEnd)&&point(old[i],d[0])&&point(old[j],d.at(-1))&&d.length===op.newCoordinates?.length&&d.every((p,k)=>point(p,op.newCoordinates[k])),'exact indexed original replay');
  for(let k=last;k<i;k++)out.push(old[k]);
  for(let k=0;k<d.length-1;k++)out.push(d[k]);
  last=j;totals[peer]++;
 }
 for(let k=last;k<old.length;k++)out.push(old[k]);
 check(totals.KAZ===147&&totals.MNG===46&&out.length===120584&&point(out[0],out.at(-1)),'replay output inventory');
 const geometry={...before,coordinates:before.coordinates.map((v,i)=>i===3289?[out,...v.slice(1)]:v)};
 check(geometrySHA(geometry)===fixed.result&&SHA(JSON.stringify(geometry)+'\n')===fixed.after,'replay coordinate and CAS digest');
 return geometry;
}
function evidence(read,decode){
 check(typeof read==='function'&&typeof decode==='function','pinned evidence and GPKG decoder required');
 const ix=JSON.parse(bytes(read,operationsPath,fixed.ops)),t=JSON.parse(bytes(read,topologyPath,fixed.topology));
 check(t.baseline===baseRevision&&t.russianCandidateSHA256==='e4a4739b713fe40d4183a4ecb8ac1b7aa087fb43136ddff7027cab512852a6c1'&&t.beforeCoverageLostSqDegrees===0&&t.targetPeers.KAZ.newOverlapSqDegrees===0&&t.targetPeers.MNG.newOverlapSqDegrees===1.0693949415991823e-7&&t.targetPeers.MNG.newPositiveOutsideOldSqDegrees===0&&t.checkedOverlappingPeers.length===1&&t.checkedOverlappingPeers[0].code==='CHN'&&t.checkedOverlappingPeers[0].pointsetEqual===true&&t.checkedOverlappingPeers[0].sharedBoundaryEqual===true,'fixed topology evidence');
 const donors={};
 for(const [k,f] of Object.entries(donorsFixed)){
  const p=JSON.parse(bytes(read,iso(k),f.descriptor)),v=p.geometryVersions.find(v=>v.validTo===null&&v.geometryResource.sha256===f.resource);
  check(p.entityId==='state:'+k&&v?.geometryResource.file==='geometries/sha256-'+f.resource+'.json','exact live peer resource '+k);
  bytes(read,base+v.geometryResource.file,f.resource);
  if(!f.source)continue;
  const o=JSON.parse(bytes(read,originalPath(k),f.source)),b=Buffer.from(o.rawBlobBase64,'base64');
  check(o.featureId===f.id&&o.properties?.WP_ID===f.id&&o.properties?.GENC_3===k&&o.rawWkbSha256===f.wkb&&o.rawBlobSha256===f.blob&&SHA(b)===f.blob,'exact original peer WKB '+k);
  donors[k]=decode(b,{expectedWkbSha256:f.wkb});
 }
 return {ix,t,donors};
}
const supplement=old=>({adoptionMode:method,status:'partial-original-common-seam',wholeCountryRaw:false,geometrySha256:fixed.result,
 originalCommonSeam:{operations:{reference:operationsPath,sha256:fixed.ops},topology:{reference:topologyPath,sha256:fixed.topology}},priorPreparedAttribution:old});
function derive(previous,read,decoder){
 check(previous?.entityId==='state:RUS'&&previous.lifetime?.validFrom==='1991-12-25'&&previous.lifetime.validTo===null,'Russia identity/lifetime');
 const before=previous.geometryVersions.find(v=>v.versionId===versionId);
 check(before?.validTo===null&&!isCandidate(before)&&SHA(JSON.stringify(before.geometry)+'\n')===fixed.resource,'exact old coordinate preimage');
 const {ix,donors}=evidence(read,decoder);
 const geometry=replayRussiaSeam(before.geometry,donors,ix),v={...before,geometry,modernBoundarySupplement:supplement(before.modernBoundarySupplement)};
 return {...previous,geometryVersions:previous.geometryVersions.map(x=>x===before?v:x),sourceInfo:{...previous.sourceInfo,geometrySha256:fixed.result,geometryVersionId:versionId}};
}
export function assertRussiaSeam(next,previous,{prefixes,readEvidence,decodeOriginalBlobGeometry=standardDecoder}={}){
 if(!hasRussiaSeam(next)&&!hasRussiaSeam(previous))return 0;
 if(hasRussiaSeam(previous)&&eq(previous,next))return 0;
 check(hasRussiaSeam(next)&&!hasRussiaSeam(previous),'requires new exact source-only adoption');
 check(Array.isArray(prefixes)&&prefixes.length===2&&new Set(prefixes).size===2&&prefixes.includes(descriptor)&&prefixes.includes(resource),'exact RUS descriptor/CAS storage scope');
 check(eq(next,derive(previous,readEvidence,decodeOriginalBlobGeometry)),'no other geometry, versions, dates, attribution or metadata changes permitted');
 return 1;
}
export function buildRussiaSeamPayload({sourceRevision,readPinned,opsBytes,proofBytes,decodeOriginalBlobGeometry,decodeTerritorialSource,encodeTerritorialSource}){
 check(/^[a-f0-9]{40}$/.test(sourceRevision),'exact audited or caller-verified rebound immutable revision');
 const proofs=new Map([[operationsPath,opsBytes],[topologyPath,proofBytes]]);
 const lookup=p=>proofs.has(p)?proofs.get(p):readPinned(p);
 const old=JSON.parse(bytes(readPinned,descriptor,fixed.descriptor));
 const previous=decodeTerritorialSource(old,p=>readPinned(base+p));
 const next=derive(previous,lookup,decodeOriginalBlobGeometry);
 const encoded=encodeTerritorialSource(next), geo=encoded.geometries.get(resource.slice(base.length));
 check(geo&&SHA(geo)===fixed.after,'canonical coordinate resource bytes');
 const updates=new Map([[descriptor,Buffer.from(JSON.stringify(encoded.descriptor)+'\n')],[resource,geo]]);
 return {updates,proofs,next,previous,descriptorSHA256:SHA(updates.get(descriptor)),resourceSHA256:fixed.after,geometrySHA256:fixed.result};
}
