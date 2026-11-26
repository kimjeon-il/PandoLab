import {hash,domain,keys,active,hasActiveSeam,createSeamReviewChecks} from './seam-source-review-common.mjs';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';

export const somEthSeamMethod='exact-original-som-eth-readonly-counterpart-seam';
const id='state:SOM', version='state:SOM:natural-earth-5.1.1';
const status='raw-source-only-not-display-approved';
const base='assets/data/territorial-entities/source/';
const prior='complete-prepared-current-geometry; no additional simplification';
const rr='reports/borders/validation/modern-raw-source-20261110/';
const edir=rr+'next-east-africa-scope-review-46/',solDir=rr+'sol-northern-retained-coast-20261114/';
const pairedReceipt={reference:edir+'ken-eth-som-candidate-proof-20261111.json',sha256:'425a383a96e7c3ea47d3461e8e7e4445ae485362d0319b7339269530aadb68f4'};
const prerequisiteReceipt={reference:edir+'ken-eth-som-prerequisite-peer-proof-20261112.json',sha256:'e277a1f7ada50edf70ae9874af6e70b3173128aa4470bd9f868f9d7e99b41673'};
const solReceipt={reference:solDir+'review.json',sha256:'41c8295413f621f786360550e4c8fd7b3047b4aeaa769f6eb9556f966c2f4c90'};
const solPolicy={reference:solDir+'policy.json',sha256:'e2939ade22f54bbfd5bde48bae1b69e201c5859bb8c7172e4003aaf54d9af66d'};
const solPartition={reference:solDir+'partition-proof.json',sha256:'9edd4547e5ecaf079757f748c4b8e246eb2f795ed4b3b57a32667991adffc119'};
const somNative={reference:solDir+'original-coordinate-donor.json',sha256:'c1a86f960d6e9d5fe1f2343145b8adb958d759ba2efe07f5f96e04eeb059ce4e'};
const previousSomCas='83e64b26cf6f42d2198e5e46f52e4ea8abf06cbfb4584d3711994892559fb18a';
const previousSomDomain='9c6421b9303da79c6fc3dbc1407fb022924692f7db78a3e8ec70f14dc3a2f501';
const previousSolCas='22b4cf876ae7e19df685a8fbe81b1ba4a8a463cce800fcb432c496d04e624962';
const latestSdsCas='b3ff003ccc29516e52fc2d899db9f60571990c62bef42723095d1a0fe1d8e537';
const kenyaArc={pair:['KEN','SOM'],code:'SOM',polygon:1,ring:0,inputRange:[846,851],rawPolygon:156,rawRange:[19534,19812],vertices:279,hypotheticalRange:[846,1124]};
function assertPreviousSomalia(old,previous,read){
 const m=old.modernBoundarySupplement,p=m?.pairedSourceReview;
 if(previous.geometryVersions.length!==1||domain(old.geometry)!==previousSomDomain||m?.sourceId!=='mixed-prepared-and-original-lsib-shared-arcs'||
  !p||p.wholeCountryRaw!==false||p.method!=='exact-original-shared-arc-splice'||!eq(p.group,['KEN','ETH','SOM'])||!eq(p.arcs,[kenyaArc])||
  p.proofReference!==pairedReceipt.reference||p.proofSha256!==pairedReceipt.sha256||p.prerequisitePeerProofReference!==prerequisiteReceipt.reference||p.prerequisitePeerProofSha256!==prerequisiteReceipt.sha256)fail('existing Kenya/Ethiopia/Somalia project receipt or dates changed');
}
function assertFrozenSomPartition(sol,archive,read){
 const v=active(sol)?.[0],s=v?.modernBoundarySupplement;
 if(v?.validFrom!==null||v?.validTo!==null||s?.wholeCountryRaw!==false||!eq(s.retainedCoastReview,solReceipt))fail('unchanged Somaliland separate outline and dates required');
 const r=JSON.parse(bytes(read,solReceipt.reference,solReceipt.sha256));
 const p=JSON.parse(bytes(read,solPartition.reference,solPartition.sha256));
 if(r.geometryResourceSha256!==previousSolCas||!eq(r.source,somNative)||!eq(r.policy,solPolicy)||p.scope?.noPoliticalPartition!==true||p.scope?.existingSOLAttributionRetained!==true||p.scope?.wholeSomaliaAdoption!==false)fail('existing political partition proof only');
 const n=Object.entries(archive??{});if(n.length!==8)fail('all original scope authorities must exist');for(const [ref,sha] of n)bytes(read,ref,sha);
}
function readNativeSom(read){
 const src=JSON.parse(bytes(read,somNative.reference,somNative.sha256));
 if(src.featureId!=='d534a349-948c-42d1-ba00-d7ebd949c80d'||src.rawWkbSha256!=='2c8c32b82869ef7521fc58c440db0ba7147377170327589cdf1350c5b92316a4')fail('exact original Somalia coordinate donor binding required');
 const b=Buffer.from(src.rawBlobBase64,'base64');dig(hash(b),src.rawBlobSha256,'Somalia original source');
 return decodeOriginalBlobGeometry(b,{expectedWkbSha256:src.rawWkbSha256});
}
function indexed(g,o){return exactCyclicChain(g.coordinates[o.polygonIndex][o.ringIndex],o.startIndex,o.endIndex,o.direction)}
export function assertSomOrderedOriginal(old,next,som,eth,op,raw,count,existingKenya={lo:846,hi:1124,source:{polygonIndex:156,ringIndex:0,startIndex:19534,endIndex:19812,direction:1},size:279}){
 const s=indexed(som,raw),e=indexed(eth,op.raw),ken=indexed(som,existingKenya.source);
 const a=old.coordinates[op.polygonIndex][op.ringIndex],b=next.coordinates[op.polygonIndex][op.ringIndex],prior=a.slice(op.startIndex,op.endIndex+1);
 let i=0;for(const q of s)if(i<prior.length&&eq(q,prior[i]))i++;
 if(s.length!==count||!eq(s,e)||!eq(b.slice(op.startIndex,op.startIndex+count),s)||i!==prior.length)fail('original reciprocal Ethiopia/Somalia coordinates and existing vertices must be exact');
 if(ken.length!==existingKenya.size||!eq(a.slice(existingKenya.lo,existingKenya.hi+1),ken)||!eq(b.slice(existingKenya.lo,existingKenya.hi+1),ken))fail('separately approved Kenya frontier changed pointwise');
 return true;
}

const fail=message=>{throw Error('SOM/ETH exact current seam: '+message);};
const {preserved,dig,bytes}=createSeamReviewChecks(version,fail);
export const hasSomEthSeam=e=>hasActiveSeam(e,id,somEthSeamMethod);

export function assertSomEthTopology(p,b,peers){
 const {openRingVertexCount,...ethArc}=p.ETHDonor??{};
 if(p.pin!==b.sourcePin||p.newPairDE9IM!=='FF2F11212'||p.newOverlapKm2!==0||p.newPositiveOverlapPolygonCount!==0||
  p.oldCoverageLossKm2!==0||p.oldCoverageLossPolygonCount!==0||p.allArcEdgesExactReciprocal!==true||
  !p.partitionPrior||p.partitionPrior.solPartitionExact!==true||p.partitionPrior.kenPriorTripointExact!==true||p.partitionPrior.newSdsPreimageConfirmed!==true||p.SOMOriginal?.wkbSha256!==b.originalSOMWkb||!eq(p.operations,[b.topologyOperation])||!eq(p.ringStarts,[b.ringStart])||!eq(ethArc,b.ethArc)||
  !keys(p.otherPeers,peers)||peers.some(c=>{const v=p.otherPeers[c];return v?.exactPrePostIntersectionEqual!==true||
   v.exactPrePostBoundaryShareEqual!==true||v.changeAreaKm2!==0;}))fail('reviewed zero-overlap no-loss topology and unchanged peers required');
 return true;
}

export function assertSomEthSeam(next,previous,{prefixes,readEvidence}={}){
 const {binding,frozen,raw,descriptorPath,resourcePath}=registeredSomEth;
 if(typeof readEvidence!=='function'||!hasSomEthSeam(next)||previous?.entityId!==id)fail('pinned SOM archive reader and entity required');
 const nv=active(next),pv=active(previous),v=nv[0],old=pv[0],s=v?.modernBoundarySupplement;
 if(nv.length!==1||pv.length!==1||v.versionId!==version||old.versionId!==version||v.validFrom!==null||old.validFrom!==null||
  next.metadata?.representativeGeometryVersionId!==version||!eq(preserved(next),preserved(previous)))
  fail('dates, selected version, attribution, and unselected geometry must remain exact');
 if(!keys(s,['adoptionMode','status','resultRelation','wholeCountryRaw','priorPreparedAttribution','geometrySha256','seamReview'])||
  s.status!==status||s.resultRelation!=='partial-original-with-readonly-ethiopia-seam'||s.wholeCountryRaw!==false||
  old.modernBoundarySupplement?.adoptionMode!==prior||!eq(s.priorPreparedAttribution,old.modernBoundarySupplement)||
  !eq(s.seamReview,binding.review))fail('only registered partial source and prior attribution required');
 if(!Array.isArray(prefixes)||!eq([...prefixes].sort(),[descriptorPath,resourcePath].sort()))fail('only SOM descriptor and exact new geometry may be written');
 assertPreviousSomalia(old,previous,readEvidence);
 const r=JSON.parse(bytes(readEvidence,binding.review.reference,binding.review.sha256));
 if(r.schemaVersion!==1||r.sourcePin!==binding.sourcePin||r.method!==somEthSeamMethod||r.status!==status||r.entityId!==id||
  r.versionId!==version||r.validFrom!==null||r.validTo!==null||r.vertexCount!==binding.vertexCount||
  !eq(r.operation,binding.operation)||!eq(r.topologyOperation,binding.topologyOperation)||!eq(r.ringStart,binding.ringStart)||!eq(r.ethArc,binding.ethArc))fail('fixed source review fields required');
 dig(domain(old.geometry),r.previousGeometrySha256,'prior SOM geometry');
 dig(domain(v.geometry),r.geometrySha256,'new SOM geometry');
 dig(hash(JSON.stringify(v.geometry)+'\n'),r.geometryResourceSha256,'new SOM CAS');
 if(s.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometryVersionId!==version)
  fail('current source digest attribution must be correct');
 const proof=JSON.parse(bytes(readEvidence,r.topologyProof.reference,r.topologyProof.sha256));
 const peers=Object.keys(frozen).filter(c=>c!=='ETH'&&c!=='SOM');
 assertSomEthTopology(proof,binding,peers);
 const originals={},current={};
 for(const c of ['ETH']){
  const src=raw[c], rec=JSON.parse(bytes(readEvidence,src.path,src.sha256));
  if(rec.featureId!==src.feature||rec.rawWkbSha256!==src.wkb||proof[c+'Original']?.wkbSha256!==src.wkb)fail('fixed LSIB original required');
  const blob=Buffer.from(rec.rawBlobBase64,'base64');dig(hash(blob),rec.rawBlobSha256,c+' archived GPKG geometry');
  originals[c]=decodeOriginalBlobGeometry(blob,{expectedWkbSha256:src.wkb});
 }
 for(const [c,item] of Object.entries(frozen)){
  const desc=JSON.parse(bytes(readEvidence,base+'countries/state-'+c+'.json',item.descriptorSha256));
  const entity=decodeTerritorialSource(desc,p=>readEvidence(base+p));
  const matches=active(entity);
  if(matches.length!==1)fail('one active version required for '+c);
  const activeV=matches[0], dv=desc.geometryVersions.find(v=>v.versionId===activeV.versionId);
  dig(dv?.geometryResource?.sha256,item.resourceSha256,c+' frozen resource');
  dig(domain(activeV.geometry),item.geometrySha256,c+' frozen geometry');
  current[c]=entity;
 }
 if(!eq(current.SOM,previous)||!eq(active(current.ETH)[0].geometry,originals.ETH))fail('pinned SOM and exact unchanged ETH required');
 if(frozen.SOM.resourceSha256!==previousSomCas||frozen.SOM.geometrySha256!==previousSomDomain||frozen.SOL?.resourceSha256!==previousSolCas||frozen.SDS?.resourceSha256!==latestSdsCas||!current.KEN)fail('frozen current SOM/SOL/SDS scopes and historic metadata required');
 assertFrozenSomPartition(current.SOL,proof.archiveReceipts,readEvidence);
 const nativeSom=readNativeSom(readEvidence);
 assertSomOrderedOriginal(old.geometry,v.geometry,nativeSom,originals.ETH,binding.operation,binding.topologyOperation.raw,binding.vertexCount);
 const arc=(g,x)=>exactCyclicChain(g.coordinates[x.polygonIndex][x.ringIndex],x.startIndex,x.endIndex,x.direction);
 const op=binding.operation, points=arc(originals.ETH,op.raw);
 if(!eq(op.raw,binding.ethArc)||op.ringIndex!==0||op.raw.ringIndex!==0||binding.ethArc.ringIndex!==0||points.length!==binding.vertexCount||
  !eq(points,arc(originals.ETH,binding.ethArc))||points.slice(1).some((p,i)=>eq(p,points[i])))fail('one exact reciprocal LSIB exterior arc required');
 if(!eq(replayRetainedCoast(old.geometry,originals.ETH,[op],[binding.ringStart]),v.geometry))
  fail('candidate must be exact replay with all other rings and polygons preserved');
 return 1;
}

const registeredSomEth=Object.freeze({"binding":{"sourcePin":"2a4253a43cdc244efc16be8f9970ae5441bd91a6","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/som-eth-original-frontier-20261116/review.json","sha256":"d8195e40731b6da05b55c13bf4b032682dec25f8b56579f9256a9324a83c758f"},"operation":{"polygonIndex":1,"ringIndex":0,"startIndex":1124,"endIndex":1191,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":3532,"endIndex":2464,"direction":-1}},"topologyOperation":{"polygonIndex":1,"ringIndex":0,"startIndex":1124,"endIndex":1191,"raw":{"polygonIndex":156,"ringIndex":0,"startIndex":19812,"endIndex":20880,"direction":1}},"ringStart":{"polygonIndex":1,"ringIndex":0,"startIndex":0},"ethArc":{"polygonIndex":0,"ringIndex":0,"startIndex":3532,"endIndex":2464,"direction":-1},"vertexCount":1069,"originalSOMWkb":"2c8c32b82869ef7521fc58c440db0ba7147377170327589cdf1350c5b92316a4"},"frozen":{"SOM":{"descriptorSha256":"41b142d5f0cff03b4fe37b3121158bab862cf2b53fd8d49e545c134909540958","geometrySha256":"9c6421b9303da79c6fc3dbc1407fb022924692f7db78a3e8ec70f14dc3a2f501","resourceSha256":"83e64b26cf6f42d2198e5e46f52e4ea8abf06cbfb4584d3711994892559fb18a"},"ETH":{"descriptorSha256":"b3ec88e2f59d652312bf9e3c4535360cc682116077b4398a7154a0121719a36a","geometrySha256":"11fc7878eeb542f413c9765f61c9bda0a5040d356b2331e2670e58596e302825","resourceSha256":"1762c21831738bf172889805dae53a2199efcc1caee3242c7cb0f41038b4f9ea"},"SOL":{"descriptorSha256":"77aadd590b2b2f2ff032f0ee5459fdffc3482d2e43f4318fb12b4acb359a338b","geometrySha256":"e5780dee985b302ce1d6c48ee841320448a876f248c059c758ebd12b4cad485f","resourceSha256":"22b4cf876ae7e19df685a8fbe81b1ba4a8a463cce800fcb432c496d04e624962"},"DJI":{"descriptorSha256":"b57c5beeaf0fdac6e1f77b27c68b34dc541cdb5dda33311045464caaf81adf46","geometrySha256":"b0c8a67ab4c25357351ff2c50e7598ac7521ced987ed736d53471889ddea3584","resourceSha256":"f573cf2c9cfb7b310bdedfd4bf044aa62fde8513b090594c615fe4c49ac47871"},"KEN":{"descriptorSha256":"634a1e2e2fd7e7723b8945d3f93d5e61504d73e11a879f077a04df6b9172e7d2","geometrySha256":"1d1022c882a515cf5e37eb0393b15140d72c268544ec1f296b7ea98805780c50","resourceSha256":"b6591eaf9d70a0e7f6f99c2799108d654019774d44102bb04dd8fc81431794c2"},"SDS":{"descriptorSha256":"950871ad8335c8b75065824b3999edc6b0826fbf536610ec5e031931a863798a","geometrySha256":"488d2371284c3b7c7efb39b0c468d5013136f8310f4c60c4581bbb32a8539bb1","resourceSha256":"b3ff003ccc29516e52fc2d899db9f60571990c62bef42723095d1a0fe1d8e537"},"ERI":{"descriptorSha256":"a3dba97c9b6cc2a8011601ce99b3e9b2d42ab09dd91a23c0d7f8331f96d3b249","geometrySha256":"ba634f5e43cdbe932bb66648b9648eed925deb54655e1c696be8a589f02af712","resourceSha256":"81921c1836ad4d61bac66e271b9af1061d5f3b778a707601b0aa2be6fc9a7ee0"},"YEM":{"descriptorSha256":"7e3b6bf8eab929488c9197ad6593ec0e59a33b555c752beded0376b290fb17f2","geometrySha256":"27d290bf0b457d4d61cbed12a5bb6dcffeefedc5c8c11ea7fd8e5d73eb55892c","resourceSha256":"6b34e5b316562cf3908f75a2c75b7cea56097b08b789fed8bfa7be328b30168a"},"SDN":{"descriptorSha256":"3dd6378957c056be7a0fa6d30cbbe18eb475504c5fe04c9fd7884bac6d24d2b5","geometrySha256":"7502e2f1f95c1622eb6ee8f8d80e68350757dae73ec1da48f0fdda89dfb02690","resourceSha256":"782a2e915d188ca1795bdefae600196834c23e2cde8683b50ef8baf1e53a88c9"}},"raw":{"ETH":{"path":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-mediterranean-africa-20261113/originals/ETH-original.json","sha256":"8641546a0525c08bc05c5efd8ae93953c96e92fe80b305c9f021570a05e14680","feature":"786d458b-f6b6-4b02-b13f-cabad0e768e1","wkb":"c15a6794c14efe0a55b1851acd24a33988e03a58c78b92008f20a0559a0eba16"}},"resourcePath":"assets/data/territorial-entities/source/geometries/sha256-5cbe054ef6e14f1186dedd345fe43769179cb637b1deea83141c574c7d32f7c9.json","descriptorPath":"assets/data/territorial-entities/source/countries/state-SOM.json"});
