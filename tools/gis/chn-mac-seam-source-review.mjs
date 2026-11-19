import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';

export const chnMacSeamMethod='exact-original-chn-mac-readonly-counterpart-seam';
const id='state:CHN', version='state:CHN:paektu-lsib-11.4';
const status='raw-source-only-not-display-approved';
const base='assets/data/territorial-entities/source/';
const priorKazMethod='exact-original-chn-kaz-readonly-counterpart-seam';
const priorAfgMethod='exact-original-chn-afg-readonly-counterpart-seam';
const prior='exact-original-chn-hkg-readonly-counterpart-seam';
const priorMngMethod='exact-original-chn-mng-readonly-counterpart-seam';
const rr='reports/borders/validation/modern-raw-source-20261110/';
const priorKazReview={reference:rr+'chn-kaz-original-frontier-20261115/review.json',sha256:'6a77837f4be1e1cc137f094a886d98712ece60a4706334bd697f3c85ef8bbe96'};
const priorKazTopology={reference:rr+'chn-kaz-original-frontier-20261115/topology-proof.json',sha256:'d5caef69934bcf68f0a1e0b7e8b51f34bdb290c5ee9147bbe7bab9e2723981ae'};
const priorMngReview={reference:rr+'chn-mng-shared-frontier-20261114/review.json',sha256:'35d1c8083fc7367f7b67d5f0ab12a14702eac2a17cbd5ee1b0c5af444a0b1848'};
const priorMngTopology={reference:rr+'chn-mng-shared-frontier-20261114/topology-proof.json',sha256:'0c878e291fbe6a06703082507f59236b1933c3d38a7db6bb3317de43b562f9d9'};
const priorMngPeer={reference:rr+'chn-mng-shared-frontier-20261114/latest-peer-proof.json',sha256:'be19dd8c4ee1b32bec99131f14260ea00e94aa977aca98709c91a83ae73e4d32'};
const priorKazArc={polygonIndex:7,ringIndex:0,startIndex:44147,endIndex:112279,direction:-1};
const priorMngArc={polygonIndex:0,ringIndex:0,startIndex:22109,endIndex:0,direction:-1};
const priorHkgCas='12b0166d5c20f6cfc7c628fe41caee25444a43aa811d06d25cb32e21bb12ef4e';
const priorHkgDomain='915d9fbbf6891c3f0d173bba9d5b9d75a5c677c2e70468fecb92a70221f84263';
const priorHkgArc={polygonIndex:83,ringIndex:0,startIndex:11976,endIndex:10822,direction:-1};
const priorAfgCas='f1114e1701a764f5ecab977b94deba5df47aa0e77c5e3435d016a5b454adcc03';
const priorAfgDomain='922e1afb5840630a3f53a2db477c78125b12dbce77af5038c70a4c457a40d12c';
const priorAfgArc={polygonIndex:0,ringIndex:0,startIndex:1222,endIndex:0,direction:-1};
const priorKazCas='db80e8ef3c0d3bf2e37ad528a5fd9b3d791cb125a83435deeec9a9e113f2f5ac';
const priorKazDomain='cb57c1a9655fc843c7749585400c039a6710a2f654d0f04ac155fc9810a0471e';
const priorMngCas='012e3e5575f07aeb61e6f32e9f7bf7803c0ee1c91e2e46e6bc7b9507029366de';
const priorMngDomain='7fa30835644d8706e7768459cffe2f855c805043793543ac61ca7b7244a7442d';
function assertInheritedChina(old,previous,read){
 const h=old.modernBoundarySupplement,a=h?.priorPreparedAttribution,k=a?.priorPreparedAttribution,m=k?.priorPreparedAttribution;
 const hr={reference:rr+'chn-hkg-original-frontier-20261116/review.json',sha256:'9212397896e50f4adf14eab8e57b74e288f6b86a6077666b4d3502cf1c64b8f8'};
 const hv=JSON.parse(bytes(read,hr.reference,hr.sha256));
 const ht=JSON.parse(bytes(read,hv.topologyProof.reference,hv.topologyProof.sha256));
 if(!eq(h?.seamReview,hr)||h?.geometrySha256!==priorHkgDomain||a?.adoptionMode!==priorAfgMethod||hv.method!==prior||hv.geometryResourceSha256!==priorHkgCas||hv.geometrySha256!==priorHkgDomain||hv.previousGeometrySha256!==priorAfgDomain||!eq(hv.hkgArc,priorHkgArc)||ht.newOverlapKm2!==0||ht.oldCoverageLossKm2!==0||ht.newPairDE9IM!=='FF2F11212')fail('exact prior Hong Kong accepted receipt required');
 const priorAfgR={reference:rr+'chn-afg-original-frontier-20261116/review.json',sha256:'d7845e9969f4305899b9fc5ddbfae4738b698f37b9b4b1fc9aec2ff06dadce97'};
 const priorAfgT={reference:rr+'chn-afg-original-frontier-20261116/topology-proof.json',sha256:'9619e3f481ec751a0e1b8403b98c50b5ec37dcc49a234d2e6e4a5b3ecfffe392'};
 const ar=JSON.parse(bytes(read,priorAfgR.reference,priorAfgR.sha256)),at=JSON.parse(bytes(read,priorAfgT.reference,priorAfgT.sha256));
 if(!eq(a?.seamReview,priorAfgR)||a?.geometrySha256!==priorAfgDomain||k?.geometrySha256!==priorKazDomain||k?.adoptionMode!==priorKazMethod||ar.method!==priorAfgMethod||ar.geometryResourceSha256!==priorAfgCas||ar.geometrySha256!==priorAfgDomain||ar.previousGeometrySha256!==priorKazDomain||!eq(ar.afgArc,priorAfgArc)||!eq(ar.topologyProof,priorAfgT)||at.newOverlapKm2!==0||at.oldCoverageLossKm2!==0||at.newPairDE9IM!=='FF2F11212')fail('exact prior Afghanistan accepted receipt required');
 if(!eq(k?.seamReview,priorKazReview)||domain(old.geometry)!==priorHkgDomain||m?.adoptionMode!==priorMngMethod||m.geometrySha256!==priorMngDomain||!eq(m.seamReview,priorMngReview)||previous.geometryVersions.length!==1)fail('exact prior Kazakhstan/Mongolia approvals and unsplit history required');
 const kr=JSON.parse(bytes(read,priorKazReview.reference,priorKazReview.sha256)),kt=JSON.parse(bytes(read,priorKazTopology.reference,priorKazTopology.sha256));
 const mr=JSON.parse(bytes(read,priorMngReview.reference,priorMngReview.sha256));
 if(kr.method!==priorKazMethod||kr.geometryResourceSha256!==priorKazCas||kr.geometrySha256!==priorKazDomain||kr.previousGeometrySha256!==priorMngDomain||!eq(kr.kazArc,priorKazArc)||!eq(kr.topologyProof,priorKazTopology)||
  kt.newOverlapKm2!==0||kt.oldCoverageLossKm2!==0||kt.newPairDE9IM!=='FF2F11212'||
  mr.method!==priorMngMethod||mr.geometryResourceSha256!==priorMngCas||mr.geometrySha256!==priorMngDomain||!eq(mr.mngArc,priorMngArc)||!eq(mr.topologyProof,priorMngTopology)||!eq(mr.latestPeerProof,priorMngPeer))fail('prior approved source receipts do not match');
 for(const r of [priorMngTopology,priorMngPeer])bytes(read,r.reference,r.sha256);
}
export function assertPriorChinaArc(old,next,donor,arc,before,after,count){
 const points=exactCyclicChain(donor.coordinates[arc.polygonIndex][arc.ringIndex],arc.startIndex,arc.endIndex,arc.direction);
 if(points.length!==count||!eq(old.coordinates[0][0].slice(before,before+count),points)||!eq(next.coordinates[0][0].slice(after,after+count),points))fail('previous native Kazakhstan/Mongolia pointwise frontier changed');
 return true;
}

const hash=b=>createHash('sha256').update(b).digest('hex');
const domain=g=>hash(JSON.stringify([g.type,g.coordinates]));
const fail=message=>{throw Error('CHN/MAC exact current seam: '+message);};
const keys=(o,names)=>o&&eq(Object.keys(o).sort(),[...names].sort());
const omit=(o,...names)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!names.includes(k)));
const active=e=>e.geometryVersions.filter(x=>x.validTo===null);
const preserved=e=>({...e,sourceInfo:omit(e.sourceInfo,'geometrySha256','geometryVersionId'),
 geometryVersions:e.geometryVersions.map(x=>x.versionId===version?omit(x,'geometry','modernBoundarySupplement'):x)});
const dig=(a,b,label)=>{if(a!==b)fail(label+' digest mismatch');};
const bytes=(read,p,h)=>{const x=read(p);if(!Buffer.isBuffer(x))fail(p+' exact archived bytes required');dig(hash(x),h,p);return x;};
export const hasChnMacSeam=e=>e?.entityId===id&&e?.geometryVersions?.some(x=>x.validTo===null&&x.modernBoundarySupplement?.adoptionMode===chnMacSeamMethod)===true;

export function assertChnMacTopology(p,b,peers){
 const {openRingVertexCount,...macArc}=p.MACDonor??{};
 if(p.pin!==b.sourcePin||p.newPairDE9IM!=='FF2F11212'||p.newOverlapKm2!==0||p.newPositiveOverlapPolygonCount!==0||
  p.oldCoverageLossKm2!==0||p.oldCoverageLossPolygonCount!==0||p.allArcEdgesExactReciprocal!==true||
  !p.protectedPrior||p.protectedPrior.priorKAZExact!==true||p.protectedPrior.priorMNGExact!==true||p.protectedPrior.priorAFGExact!==true||p.protectedPrior.hkgUnchanged!==true||!eq(p.alreadyExactNoOp,{old:[290,0,4,1],donor:[3,0,72,70,-1],count:3})||p.CHNOriginal?.wkbSha256!==b.originalCHNWkb||!eq(p.operations,[b.topologyOperation])||!eq(p.ringStarts,[b.ringStart])||!eq(macArc,b.macArc)||
  !keys(p.otherPeers,peers)||peers.some(c=>{const v=p.otherPeers[c];return v?.exactPrePostIntersectionEqual!==true||
   v.exactPrePostBoundaryShareEqual!==true||v.changeAreaKm2!==0||v.deltaEmpty!==true;}))fail('reviewed zero-overlap no-loss topology and unchanged peers required');
 return true;
}

export function assertChnMacSeam(next,previous,{prefixes,readEvidence}={}){
 const {binding,frozen,raw,descriptorPath,resourcePath}=registeredChnMac;
 if(typeof readEvidence!=='function'||!hasChnMacSeam(next)||previous?.entityId!==id)fail('pinned CHN archive reader and entity required');
 const nv=active(next),pv=active(previous),v=nv[0],old=pv[0],s=v?.modernBoundarySupplement;
 if(nv.length!==1||pv.length!==1||v.versionId!==version||old.versionId!==version||v.validFrom!==null||old.validFrom!==null||
  next.metadata?.representativeGeometryVersionId!==version||!eq(preserved(next),preserved(previous)))
  fail('dates, selected version, attribution, and unselected geometry must remain exact');
 if(!keys(s,['adoptionMode','status','resultRelation','wholeCountryRaw','priorPreparedAttribution','geometrySha256','seamReview'])||
  s.status!==status||s.resultRelation!=='partial-original-with-readonly-macao-seam'||s.wholeCountryRaw!==false||
  old.modernBoundarySupplement?.adoptionMode!==prior||!eq(s.priorPreparedAttribution,old.modernBoundarySupplement)||
  !eq(s.seamReview,binding.review))fail('only registered partial source and prior attribution required');
 if(!Array.isArray(prefixes)||!eq([...prefixes].sort(),[descriptorPath,resourcePath].sort()))fail('only CHN descriptor and exact new geometry may be written');
 assertInheritedChina(old,previous,readEvidence);
 const r=JSON.parse(bytes(readEvidence,binding.review.reference,binding.review.sha256));
 if(r.schemaVersion!==1||r.sourcePin!==binding.sourcePin||r.method!==chnMacSeamMethod||r.status!==status||r.entityId!==id||
  r.versionId!==version||r.validFrom!==null||r.validTo!==null||r.vertexCount!==binding.vertexCount||
  !eq(r.operation,binding.operation)||!eq(r.topologyOperation,binding.topologyOperation)||!eq(r.ringStart,binding.ringStart)||!eq(r.macArc,binding.macArc))fail('fixed source review fields required');
 dig(domain(old.geometry),r.previousGeometrySha256,'prior CHN geometry');
 dig(domain(v.geometry),r.geometrySha256,'new CHN geometry');
 dig(hash(JSON.stringify(v.geometry)+'\n'),r.geometryResourceSha256,'new CHN CAS');
 if(s.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometryVersionId!==version)
  fail('current source digest attribution must be correct');
 const proof=JSON.parse(bytes(readEvidence,r.topologyProof.reference,r.topologyProof.sha256));
 bytes(readEvidence,proof.archiveScopeSummary.path,proof.archiveScopeSummary.sha256);
 const peers=Object.keys(frozen).filter(c=>c!=='MAC'&&c!=='CHN');
 assertChnMacTopology(proof,binding,peers);
 const originals={},current={};
 for(const c of ['MAC']){
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
 if(!eq(current.CHN,previous)||!eq(active(current.MAC)[0].geometry,originals.MAC))fail('pinned CHN and exact unchanged MAC required');
 if(frozen.CHN.resourceSha256!==priorHkgCas||frozen.CHN.geometrySha256!==priorHkgDomain||!current.AFG||!current.HKG||!current.KAS||!current.PAK||!current.TJK||!current.KAZ||!current.MNG)fail('exact frozen country preimage and protected neighbors required');
 assertPriorChinaArc(old.geometry,v.geometry,active(current.KAZ)[0].geometry,priorKazArc,4269,4269,44151);
 assertPriorChinaArc(old.geometry,v.geometry,active(current.MNG)[0].geometry,priorMngArc,48456,48456,22110);
 assertPriorChinaArc(old.geometry,v.geometry,active(current.AFG)[0].geometry,priorAfgArc,2099,2099,1223);
 assertPriorChinaArc(old.geometry,v.geometry,active(current.HKG)[0].geometry,priorHkgArc,89929,89929,1155);
 const arc=(g,x)=>exactCyclicChain(g.coordinates[x.polygonIndex][x.ringIndex],x.startIndex,x.endIndex,x.direction);
 const already={polygonIndex:290,ringIndex:0,startIndex:4,endIndex:1,direction:1};
 const donor={polygonIndex:3,ringIndex:0,startIndex:72,endIndex:70,direction:-1};
 const witnessed=arc(old.geometry,already);
 if(old.geometry.coordinates[290][0].length!==6||witnessed.length!==3||!eq(witnessed,arc(originals.MAC,donor))||!eq(old.geometry.coordinates[290],v.geometry.coordinates[290]))fail('already exact Macau component cannot be rotated or edited');
 const op=binding.operation, points=arc(originals.MAC,op.raw);
 if(!eq(op.raw,binding.macArc)||op.ringIndex!==0||op.raw.ringIndex!==0||binding.macArc.ringIndex!==0||points.length!==binding.vertexCount||
  !eq(points,arc(originals.MAC,binding.macArc))||points.slice(1).some((p,i)=>eq(p,points[i])))fail('one exact reciprocal LSIB exterior arc required');
 if(!eq(replayRetainedCoast(old.geometry,originals.MAC,[op],[binding.ringStart]),v.geometry))
  fail('candidate must be exact replay with all other rings and polygons preserved');
 return 1;
}

const registeredChnMac=Object.freeze({"binding":{"sourcePin":"2b609a887919b96783b77b53c5b743d01b8c6183","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/chn-mac-original-frontier-20261116/review.json","sha256":"0aad0ebf628221b39fb12aa165a174c973c659e6824fe6f0e2ffc5708171c8b2"},"operation":{"polygonIndex":0,"ringIndex":0,"startIndex":91689,"endIndex":91696,"raw":{"polygonIndex":2,"ringIndex":0,"startIndex":418,"endIndex":352,"direction":-1}},"topologyOperation":{"polygonIndex":0,"ringIndex":0,"startIndex":91689,"endIndex":91696,"raw":{"polygonIndex":234,"ringIndex":0,"startIndex":592604,"endIndex":592670,"direction":1}},"ringStart":{"polygonIndex":0,"ringIndex":0,"startIndex":0},"macArc":{"polygonIndex":2,"ringIndex":0,"startIndex":418,"endIndex":352,"direction":-1},"vertexCount":67,"originalCHNWkb":"405272f2ab2134d4401f8218e267a8b6bf6918ff22673d0a223aef01d27b906c"},"frozen":{"CHN":{"descriptorSha256":"871048188d92864390b58e3ada4b106a17babea3155e1c6d1c4a4e55684e1465","geometrySha256":"915d9fbbf6891c3f0d173bba9d5b9d75a5c677c2e70468fecb92a70221f84263","resourceSha256":"12b0166d5c20f6cfc7c628fe41caee25444a43aa811d06d25cb32e21bb12ef4e"},"MAC":{"descriptorSha256":"44f60fbadfcb40ef6647486c7959d5c544e9b0a8733133fd0ac8447c8c30c2d7","geometrySha256":"27c462a32a8c04d0a5f80dcfedb8b80fab1a0d7ad0aefd7eff866f3253f3692f","resourceSha256":"37a8a465bab04db0c8a38c2807635581703c5103d608c12382e0beee03dadef2"},"HKG":{"descriptorSha256":"77d6e31ae1fac296c2f46f3ffdf08597ab16889627ac3ed9e6672e87db9aafb1","geometrySha256":"788e8b5ce738e406862939c905789d3c46cf4719e43892ca9eabf1d9deca4d92","resourceSha256":"71bde142112494139afdd626769828904627bb44118814ab792d185f66d6d1c3"},"AFG":{"descriptorSha256":"92aa6ff9d72fab84205d41794645c385025574e2938fe79165e70dad56612673","geometrySha256":"52095d69a0e57368089d4a916ed94fa67aa72a525bb1079c9bf3e4b0132c9db5","resourceSha256":"9e8169d42915b2a2a756e6372b7e066f52b66b46c535378457eca5890f2a70ec"},"KAZ":{"descriptorSha256":"466f8a4aedc6271c0a9db3c2fa1ee4244aeda1bad30101149ededce0faf21962","geometrySha256":"0d4cdc27fcd2a78145ec4aff1c35bc1b999b04000d2c61864a0b26c8f3aeed70","resourceSha256":"47de235c3a3e07fa5fa40d7ba0805a5ddbe757d5857534439c37903aa0db46ae"},"MNG":{"descriptorSha256":"d7e67adde7c998fe4886811b432aabc08063dbfdef353bb29b94330dfdf71cc8","geometrySha256":"f77ec0aa475978894d8995da93c429579add7bb470cb8813af46ad3b8f698440","resourceSha256":"476459922561c7f96ae33b864421f506436d6eba925ef423b29a052ca27c806a"},"TWN":{"descriptorSha256":"c2d50f5e60596ed7712ba58cf9f128523ea59d51bac5ad9f7506252b3c3e55fa","geometrySha256":"05620c3ab6e3a16bb5525de31e716547489d69618996f6d01484b7f5a54f7405","resourceSha256":"c20159fe4dc86c5f3bb31a9899256795b6d91e869f084cd3c7fe1226d7f3c4aa"},"KAS":{"descriptorSha256":"cc54544e2cc74babe45b43dda8acea7ddbde4dfeba5412d5aa67e16cfacf1cb8","geometrySha256":"00238ed92de0e11a41b39f9e0d89e0310a01b9a3ee35bcc29f10667420b4f21d","resourceSha256":"0e7cf134851fec4bbdbc91763e16840e88f7bd958580bff68b52a52b7a15027a"},"PAK":{"descriptorSha256":"83e86188a88579f6a7a40ec1004a139686f5794597aea8294847a08692a5e925","geometrySha256":"8420e84bd58de625fa3ea7ed37f52ff2ca7e6aec291907ecf29f232ac6ef64e5","resourceSha256":"a47942dd6800bcc4babd62b04ccdd90f8f8d49d93de5c3bf2e7d3347813157fd"},"TJK":{"descriptorSha256":"1859a5e32592afa3119e250025935859ed7ec88e4309e0040ed61cda94bc318b","geometrySha256":"6feab00b43ee19bf3a68baa3f2682107d8eec8035362b90847781130e2255b72","resourceSha256":"3c9120bdb628c8a7d7f311523d5fd905b63d58661895ec36a625c417dd8729eb"}},"raw":{"MAC":{"path":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-dependent-three-20261113/originals/MAC-original.json","sha256":"08b49bd8f759a8ce2ebb2dc72d46d6a802473eaca102b5c632dda41aca516cac","feature":"942a1f06-0142-4010-bfc8-4f140ba2f7a3","wkb":"63934f8498f2ad2fbc15eabe4aaf94fd7722f9c19642c6443d7b583bfa182a8e"}},"resourcePath":"assets/data/territorial-entities/source/geometries/sha256-57f5bdcc36f3b7c03f9108c08cb65bb00aad82c47217b3cdb98bafd7aa39ce41.json","descriptorPath":"assets/data/territorial-entities/source/countries/state-CHN.json"});
