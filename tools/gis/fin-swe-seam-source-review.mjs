import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {exactCyclicChain,replayRetainedCoast} from './retained-coast-source-review.mjs';
import {finDetachedMethod,finDetachedProof} from './fin-detached-original-source-review.mjs';
const base='assets/data/territorial-entities/source/',id='state:FIN',version='state:FIN:natural-earth-5.1.1';
const oldCas='cd0a7cd7ce06a571d6a2952dcc2e286ce7577b205b45d7c38d941a13c5a0269b';
const originGp='55fab422ef09e35eb48d68141b9ece0ace86d4276dfe332a04dfd401c0bfc80c';
export const finSweSeamMethod='exact-original-fin-swe-readonly-counterpart-seam';
const status='raw-source-only-not-display-approved',relation='partial-original-with-readonly-sweden-seam';
const fail=m=>{throw Error('FIN/SWE exact original seam: '+m)};
const h=b=>createHash('sha256').update(b).digest('hex'),domain=g=>h(JSON.stringify([g.type,g.coordinates]));
const omit=(o,...x)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!x.includes(k)));
const stable=e=>({...e,sourceInfo:omit(e.sourceInfo,'geometrySha256','geometryVersionId'),geometryVersions:e.geometryVersions.map(x=>x.versionId===version?omit(x,'geometry','modernBoundarySupplement'):x)});
const read=(f,r)=>{const b=f(r.reference);if(!Buffer.isBuffer(b)||h(b)!==r.sha256)fail('fixed archived bytes required: '+r.reference);return JSON.parse(b)};
export const hasFinSweSeam=e=>e?.entityId===id&&e.geometryVersions?.some(x=>x.validTo===null&&x.modernBoundarySupplement?.adoptionMode===finSweSeamMethod)===true;
export const operations=Object.freeze([
 {polygonIndex:87,ringIndex:0,startIndex:8,endIndex:4,raw:{polygonIndex:253,ringIndex:0,startIndex:12,endIndex:24,direction:1}},
 {polygonIndex:2854,ringIndex:0,startIndex:3,endIndex:4,raw:{polygonIndex:17047,ringIndex:0,startIndex:56,endIndex:58,direction:1}}
]);
const origins=[{polygonIndex:87,ringIndex:0,startIndex:8},{polygonIndex:2854,ringIndex:0,startIndex:0}];
const donors=[{polygonIndex:11753,ringIndex:0,startIndex:30,endIndex:19,direction:-1},{polygonIndex:14158,ringIndex:0,startIndex:314,endIndex:312,direction:-1}];
const arc=(g,a)=>exactCyclicChain(g.coordinates[a.polygonIndex][a.ringIndex],a.startIndex,a.endIndex,a.direction);
export function restoreMarketOrigin(ring,anchor){
 if(!Array.isArray(ring)||ring.length<5||!eq(ring[0],ring.at(-1))||!eq(ring[3],anchor)||ring.slice(0,-1).filter(p=>eq(p,anchor)).length!==1)fail('existing Market ring origin must remain unambiguous at exact native offset');
 const open=ring.slice(0,-1);return [...open.slice(3),...open.slice(0,3),anchor];
}
export function replayFinSwe(old,original,fixedSWE){
 for(const [i,op] of operations.entries()){
   const p=arc(original,op.raw),d=arc(fixedSWE,donors[i]);
   if(p.length!==[13,3][i]||d.length!==[12,3][i]||!eq(p.slice(i===0?1:0),d))fail('exact two native arcs, including only one coast-approach edge, required');
 }
 const next=replayRetainedCoast(old,original,operations,origins);
 next.coordinates[87][0]=restoreMarketOrigin(next.coordinates[87][0],old.coordinates[87][0][0]);
 return next;
}
export function assertPreservedFinIslands(approved,old,next){
 const couples=approved?.pairs;
 if(couples?.length!==32||approved.existingALDReservedComponents!==43||new Set(couples.map(x=>x.targetIndex)).size!==32||old.coordinates.length!==3229||next.coordinates.length!==3229)fail('fixed earlier 32 islands and component counts required');
 for(const {targetIndex,coordinates} of couples){
  if([87,2854].includes(targetIndex)||!eq(old.coordinates[targetIndex],coordinates)||!eq(next.coordinates[targetIndex],coordinates))fail('earlier approved original island coordinates changed');
 }
}
const peerCodes=['ALD','DNK','EST','LTU','LVA','NOR','POL','RUS'];
export function assertFinSweTopology(p,b){
 if(p.pin!==b.sourcePin||p.newOverlapKm2!==0||p.oldCoverageLossKm2!==0||p.valid!==true||p.aldUnchanged!==true||p.prior32Exact!==true||p.unchangedComponentCount!==3227||
   !eq(p.operations,operations)||!eq(Object.keys(p.peers??{}).sort(),peerCodes)||Object.values(p.peers).some(x=>x.exactIntersection!==true||x.exactShared!==true||x.deltaDisjoint!==true))
   fail('reviewed no-overlap/no-loss topology and exact protected neighbors required');
}
export function assertFinSweSeam(next,prior,{prefixes,readEvidence}={}){
 const {binding,frozen,source,oldScope,descriptorPath,resourcePath}=registration;
 if(typeof readEvidence!=='function'||!hasFinSweSeam(next)||prior?.entityId!==id||next.geometryVersions.length!==1||prior.geometryVersions.length!==1)fail('fixed current Finland source required');
 const v=next.geometryVersions[0],o=prior.geometryVersions[0],s=v.modernBoundarySupplement;
 if(![v,o].every(x=>x.versionId===version&&x.validFrom===null&&x.validTo===null)||!eq(stable(next),stable(prior))||next.metadata?.representativeGeometryVersionId!==version)fail('fixed dates, attribution, identity, and histories required');
 if(frozen.FIN.resourceSha256!==oldCas||h(JSON.stringify(o.geometry)+'\n')!==oldCas||o.modernBoundarySupplement?.adoptionMode!==finDetachedMethod||!eq(o.modernBoundarySupplement.sourceAdoptionReview,finDetachedProof)||!o.modernBoundarySupplement.pairedSourceReview)fail('current previously approved detached FIN geometry required');
 if(!eq(s,{adoptionMode:finSweSeamMethod,status,resultRelation:relation,wholeCountryRaw:false,priorPreparedAttribution:o.modernBoundarySupplement,geometrySha256:domain(v.geometry),seamReview:binding.review})||next.sourceInfo?.geometryVersionId!==version||next.sourceInfo?.geometrySha256!==s.geometrySha256)fail('prior approved attribution retained verbatim');
 if(!Array.isArray(prefixes)||!eq([...prefixes].sort(),[descriptorPath,resourcePath].sort()))fail('exact two Finland source paths required');
 const scope=read(readEvidence,oldScope);if(!scope)fail('earlier Finland/?land restoration approval required');
 const review=read(readEvidence,binding.review),p=read(readEvidence,review.topologyProof);
 if(review.method!==finSweSeamMethod||review.entityId!==id||review.versionId!==version||review.validFrom!==null||review.validTo!==null||review.sourcePin!==binding.sourcePin||review.previousGeometrySha256!==domain(o.geometry)||review.geometrySha256!==domain(v.geometry)||review.geometryResourceSha256!==h(JSON.stringify(v.geometry)+'\n'))fail('exact registered review and candidate CAS required');
 assertFinSweTopology(p,binding);
 const originals=read(readEvidence,source),blob=Buffer.from(originals.rawBlobBase64,'base64');
 if(originals.featureId!==source.feature||originals.rawWkbSha256!==source.wkb||originals.sourceFileReceipt?.gpkgSha256!==originGp||h(blob)!==originals.rawBlobSha256)fail('immutable native Finland source required');
 const native=decodeOriginalBlobGeometry(blob,{expectedWkbSha256:source.wkb});
 const current={};
 for(const [c,x] of Object.entries(frozen)){
  const desc=read(readEvidence,{reference:base+'countries/state-'+c+'.json',sha256:x.descriptorSha256});
  const e=decodeTerritorialSource(desc,path=>readEvidence(base+path)),old=e.geometryVersions.find(z=>z.validTo===null),d=desc.geometryVersions.find(z=>z.versionId===old?.versionId);
  if(!old||d.geometryResource.sha256!==x.resourceSha256||domain(old.geometry)!==x.geometrySha256||e.entityId!=='state:'+c)fail('fixed regional version or geography changed: '+c);
  current[c]={e,old};
 }
 if(!eq(current.FIN.e,prior)||!current.ALD||!current.SWE)fail('exact fixed FIN/SWE/ALD preimages required');
 assertPreservedFinIslands(read(readEvidence,finDetachedProof),o.geometry,v.geometry);
 if(!eq(replayFinSwe(o.geometry,native,current.SWE.old.geometry),v.geometry))fail('every unselected shoreline/island/ring coordinate must remain exact');
 return 1;
}

const registration={"binding":{"sourcePin":"25633449a37ca5a83fad8cd1fef3d4a08ab4ad32","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/fin-swe-original-frontier-20261116/review.json","sha256":"980fbaca7f5eeef45d83001021263d8425a3169b039148d4aad203022e4d48e9"}},"frozen":{"FIN":{"descriptorSha256":"1068a04b4c0926518c99e32df9515d7a92a85fdbf3320d1c5952cb7cd6433f76","resourceSha256":"cd0a7cd7ce06a571d6a2952dcc2e286ce7577b205b45d7c38d941a13c5a0269b","geometrySha256":"67964ab3fb421748a795f740778919272eb7d3901a6ee29264a4842ce9bc6228"},"SWE":{"descriptorSha256":"2cf4a40ef63c1c54b27609fadda35f5c060d72e1ba9a4fbf7fdb9bf21c189ffc","resourceSha256":"9b857b5ebcf85e38852dfc89c3d79fec2cb4bf8ed2996ed1707055235e62da61","geometrySha256":"ce40305ff936a73920ebedbba87b8e3de293d65020399be5afc46c4ed43643a5"},"ALD":{"descriptorSha256":"2933e80d6aab8b139046d96a82fb73629a458444821bb1f9446d03bee2074a27","resourceSha256":"d9e695be011d172e565682946860120f6e0b65bb4b72f199a59a673f8e87eeab","geometrySha256":"d33959cd79c879810ad79c894ad4d9ef5c368cde3c0a63ec864e5a3f4197bf96"},"NOR":{"descriptorSha256":"b053388640262bd43fde695b50a1f67948ad2c25707e816b04abb20502ad723f","resourceSha256":"c0dfe4bdfb94e114c54b49ce71a18125301d03768a48635cec13dd5ebbe26355","geometrySha256":"a17f5d1658472685aabe1eefae5bdee9474067069db0dcdc44e2c748bd4ac47b"},"RUS":{"descriptorSha256":"5c46aa078bdb782864d0789f4d126bfa148ef1f06478846b67a33c64055fcfa2","resourceSha256":"87b24be2294a611c06f36d0b6d6f500821dffaa2980e5174954ec2caaf3b6838","geometrySha256":"2ab7a05ab44229d67f0d317b392402f53e64f0a130e02c4c8c9947e1283cc2ef"},"EST":{"descriptorSha256":"4af605358c4edcc2474e010bc7328a859b96b30626d47830a9e021ef052eb4ae","resourceSha256":"be7b295f2b35ee0372fb17b77320103d25b9178a52ed221168af4306558ab5b9","geometrySha256":"79eec602da2604460a2c5b21d2f9bda2a7d5a1ec92cfb1096ffb04143591baaf"},"LVA":{"descriptorSha256":"9ef8a6dba3a4c963f797b4b1bebc8262f68fe7c8c63e279147296a56761de45b","resourceSha256":"20cf314ae2721811e5ea99fb3f3322da0118af60de6b60ecf3865b0e1e621b33","geometrySha256":"d331d69ce2bf3992146f50be6482d1688466c270f468d293c86b0c4442958a3b"},"LTU":{"descriptorSha256":"57bc42f8824495a654e8f0fbf1b70c1c9c640256eac58a579973a47415d183e8","resourceSha256":"8ae8b03af3ce3dac3567a273c88073b8eff5199cb4247ead3052da1bde8434a7","geometrySha256":"0104c51a2a483cd10b00fc324e0f8f73d23fb9dc36422b41a791f11f20c18fb8"},"DNK":{"descriptorSha256":"9b29a2df25a75f7bc0456dbdc316acd1a2e37b216fb4b49a9ee5893a204ceff7","resourceSha256":"e88d07b0266fa0bc197fa599de8cfc1c99e05fa9a80194a1b7ff83501329fa03","geometrySha256":"edeeae5ce75a8bb8c72165bca9554971d8ce12dff68e01ae227b3530fb46b296"},"POL":{"descriptorSha256":"be1b06ae66b5463a123a2455fc17bdef6e863b80b3131196acf77f0439b4ff49","resourceSha256":"ccdfef130607c3c858b4f3458a0775ca9b7f87b34cfa312f5f9b15e0897c271e","geometrySha256":"454329d6c9a654c4cc4bee1692bd19787ea27779608d9c3c79e00782065b45f0"}},"source":{"reference":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-nordic-central-20261113/originals/FIN-original.json","sha256":"54559b0dc8f907d09e6e7be87fc8db41d06f4c5609c08d5f0be5b049c6b08aaf","feature":"c8102863-0429-4035-87d0-f55faace2498","wkb":"7fc6767494385c9281e9143f3cdeea99d06d98dabaad5efa20a0831edc7adbe3"},"oldScope":{"reference":"reports/borders/validation/modern-raw-source-20261110/fin-ald-scope-correction-20261113/FIN-correction-review.json","sha256":"9bf29ae32c0d78e73ae1b175e256a167822d6c6081f051a55ec1f3fd86219079"},"descriptorPath":"assets/data/territorial-entities/source/countries/state-FIN.json","resourcePath":"assets/data/territorial-entities/source/geometries/sha256-05d93c70c2fc34c47388ad8a212eeeb99364b4716d3df600d33e718a99a4200f.json"};
