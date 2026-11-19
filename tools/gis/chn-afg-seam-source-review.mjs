import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';

export const chnAfgSeamMethod='exact-original-chn-afg-readonly-counterpart-seam';
const id='state:CHN', version='state:CHN:paektu-lsib-11.4';
const status='raw-source-only-not-display-approved';
const base='assets/data/territorial-entities/source/';
const prior='exact-original-chn-kaz-readonly-counterpart-seam';
const priorMngMethod='exact-original-chn-mng-readonly-counterpart-seam';
const rr='reports/borders/validation/modern-raw-source-20261110/';
const priorKazReview={reference:rr+'chn-kaz-original-frontier-20261115/review.json',sha256:'6a77837f4be1e1cc137f094a886d98712ece60a4706334bd697f3c85ef8bbe96'};
const priorKazTopology={reference:rr+'chn-kaz-original-frontier-20261115/topology-proof.json',sha256:'d5caef69934bcf68f0a1e0b7e8b51f34bdb290c5ee9147bbe7bab9e2723981ae'};
const priorMngReview={reference:rr+'chn-mng-shared-frontier-20261114/review.json',sha256:'35d1c8083fc7367f7b67d5f0ab12a14702eac2a17cbd5ee1b0c5af444a0b1848'};
const priorMngTopology={reference:rr+'chn-mng-shared-frontier-20261114/topology-proof.json',sha256:'0c878e291fbe6a06703082507f59236b1933c3d38a7db6bb3317de43b562f9d9'};
const priorMngPeer={reference:rr+'chn-mng-shared-frontier-20261114/latest-peer-proof.json',sha256:'be19dd8c4ee1b32bec99131f14260ea00e94aa977aca98709c91a83ae73e4d32'};
const priorKazArc={polygonIndex:7,ringIndex:0,startIndex:44147,endIndex:112279,direction:-1};
const priorMngArc={polygonIndex:0,ringIndex:0,startIndex:22109,endIndex:0,direction:-1};
const priorKazCas='db80e8ef3c0d3bf2e37ad528a5fd9b3d791cb125a83435deeec9a9e113f2f5ac';
const priorKazDomain='cb57c1a9655fc843c7749585400c039a6710a2f654d0f04ac155fc9810a0471e';
const priorMngCas='012e3e5575f07aeb61e6f32e9f7bf7803c0ee1c91e2e46e6bc7b9507029366de';
const priorMngDomain='7fa30835644d8706e7768459cffe2f855c805043793543ac61ca7b7244a7442d';
function assertInheritedChina(old,previous,read){
 const k=old.modernBoundarySupplement,m=k?.priorPreparedAttribution;
 if(!eq(k?.seamReview,priorKazReview)||domain(old.geometry)!==priorKazDomain||m?.adoptionMode!==priorMngMethod||m.geometrySha256!==priorMngDomain||!eq(m.seamReview,priorMngReview)||previous.geometryVersions.length!==1)fail('exact prior Kazakhstan/Mongolia approvals and unsplit history required');
 const kr=JSON.parse(bytes(read,priorKazReview.reference,priorKazReview.sha256)),kt=JSON.parse(bytes(read,priorKazTopology.reference,priorKazTopology.sha256));
 const mr=JSON.parse(bytes(read,priorMngReview.reference,priorMngReview.sha256));
 if(kr.method!==prior||kr.geometryResourceSha256!==priorKazCas||kr.geometrySha256!==priorKazDomain||kr.previousGeometrySha256!==priorMngDomain||!eq(kr.kazArc,priorKazArc)||!eq(kr.topologyProof,priorKazTopology)||
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
const fail=message=>{throw Error('CHN/AFG exact current seam: '+message);};
const keys=(o,names)=>o&&eq(Object.keys(o).sort(),[...names].sort());
const omit=(o,...names)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!names.includes(k)));
const active=e=>e.geometryVersions.filter(x=>x.validTo===null);
const preserved=e=>({...e,sourceInfo:omit(e.sourceInfo,'geometrySha256','geometryVersionId'),
 geometryVersions:e.geometryVersions.map(x=>x.versionId===version?omit(x,'geometry','modernBoundarySupplement'):x)});
const dig=(a,b,label)=>{if(a!==b)fail(label+' digest mismatch');};
const bytes=(read,p,h)=>{const x=read(p);if(!Buffer.isBuffer(x))fail(p+' exact archived bytes required');dig(hash(x),h,p);return x;};
export const hasChnAfgSeam=e=>e?.entityId===id&&e?.geometryVersions?.some(x=>x.validTo===null&&x.modernBoundarySupplement?.adoptionMode===chnAfgSeamMethod)===true;

export function assertChnAfgTopology(p,b,peers){
 const {openRingVertexCount,...afgArc}=p.AFGDonor??{};
 if(p.pin!==b.sourcePin||p.newPairDE9IM!=='FF2F11212'||p.newOverlapKm2!==0||p.newPositiveOverlapPolygonCount!==0||
  p.oldCoverageLossKm2!==0||p.oldCoverageLossPolygonCount!==0||p.allArcEdgesExactReciprocal!==true||
  !p.protectedPrior||p.protectedPrior.priorKAZExact!==true||p.protectedPrior.priorMNGExact!==true||p.protectedPrior.pakTjkTripointsExact!==true||p.protectedPrior.kasBoundaryUnchanged!==true||p.CHNOriginal?.wkbSha256!==b.originalCHNWkb||!eq(p.operations,[b.topologyOperation])||!eq(p.ringStarts,[b.ringStart])||!eq(afgArc,b.afgArc)||
  !keys(p.otherPeers,peers)||peers.some(c=>{const v=p.otherPeers[c];return v?.exactPrePostIntersectionEqual!==true||
   v.exactPrePostBoundaryShareEqual!==true||v.changeAreaKm2!==0;}))fail('reviewed zero-overlap no-loss topology and unchanged peers required');
 return true;
}

export function assertChnAfgSeam(next,previous,{prefixes,readEvidence}={}){
 const {binding,frozen,raw,descriptorPath,resourcePath}=registeredChnAfg;
 if(typeof readEvidence!=='function'||!hasChnAfgSeam(next)||previous?.entityId!==id)fail('pinned CHN archive reader and entity required');
 const nv=active(next),pv=active(previous),v=nv[0],old=pv[0],s=v?.modernBoundarySupplement;
 if(nv.length!==1||pv.length!==1||v.versionId!==version||old.versionId!==version||v.validFrom!==null||old.validFrom!==null||
  next.metadata?.representativeGeometryVersionId!==version||!eq(preserved(next),preserved(previous)))
  fail('dates, selected version, attribution, and unselected geometry must remain exact');
 if(!keys(s,['adoptionMode','status','resultRelation','wholeCountryRaw','priorPreparedAttribution','geometrySha256','seamReview'])||
  s.status!==status||s.resultRelation!=='partial-original-with-readonly-afghanistan-seam'||s.wholeCountryRaw!==false||
  old.modernBoundarySupplement?.adoptionMode!==prior||!eq(s.priorPreparedAttribution,old.modernBoundarySupplement)||
  !eq(s.seamReview,binding.review))fail('only registered partial source and prior attribution required');
 if(!Array.isArray(prefixes)||!eq([...prefixes].sort(),[descriptorPath,resourcePath].sort()))fail('only CHN descriptor and exact new geometry may be written');
 assertInheritedChina(old,previous,readEvidence);
 const r=JSON.parse(bytes(readEvidence,binding.review.reference,binding.review.sha256));
 if(r.schemaVersion!==1||r.sourcePin!==binding.sourcePin||r.method!==chnAfgSeamMethod||r.status!==status||r.entityId!==id||
  r.versionId!==version||r.validFrom!==null||r.validTo!==null||r.vertexCount!==binding.vertexCount||
  !eq(r.operation,binding.operation)||!eq(r.topologyOperation,binding.topologyOperation)||!eq(r.ringStart,binding.ringStart)||!eq(r.afgArc,binding.afgArc))fail('fixed source review fields required');
 dig(domain(old.geometry),r.previousGeometrySha256,'prior CHN geometry');
 dig(domain(v.geometry),r.geometrySha256,'new CHN geometry');
 dig(hash(JSON.stringify(v.geometry)+'\n'),r.geometryResourceSha256,'new CHN CAS');
 if(s.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometryVersionId!==version)
  fail('current source digest attribution must be correct');
 const proof=JSON.parse(bytes(readEvidence,r.topologyProof.reference,r.topologyProof.sha256));
 const peers=Object.keys(frozen).filter(c=>c!=='AFG'&&c!=='CHN');
 assertChnAfgTopology(proof,binding,peers);
 const originals={},current={};
 for(const c of ['AFG']){
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
 if(!eq(current.CHN,previous)||!eq(active(current.AFG)[0].geometry,originals.AFG))fail('pinned CHN and exact unchanged AFG required');
 if(frozen.CHN.resourceSha256!==priorKazCas||frozen.CHN.geometrySha256!==priorKazDomain||!current.KAS||!current.PAK||!current.TJK||!current.KAZ||!current.MNG)fail('exact frozen country preimage and protected neighbors required');
 assertPriorChinaArc(old.geometry,v.geometry,active(current.KAZ)[0].geometry,priorKazArc,3106,4269,44151);
 assertPriorChinaArc(old.geometry,v.geometry,active(current.MNG)[0].geometry,priorMngArc,47293,48456,22110);
 const arc=(g,x)=>exactCyclicChain(g.coordinates[x.polygonIndex][x.ringIndex],x.startIndex,x.endIndex,x.direction);
 const op=binding.operation, points=arc(originals.AFG,op.raw);
 if(!eq(op.raw,binding.afgArc)||op.ringIndex!==0||op.raw.ringIndex!==0||binding.afgArc.ringIndex!==0||points.length!==binding.vertexCount||
  !eq(points,arc(originals.AFG,binding.afgArc))||points.slice(1).some((p,i)=>eq(p,points[i])))fail('one exact reciprocal LSIB exterior arc required');
 if(!eq(replayRetainedCoast(old.geometry,originals.AFG,[op],[binding.ringStart]),v.geometry))
  fail('candidate must be exact replay with all other rings and polygons preserved');
 return 1;
}

const registeredChnAfg=Object.freeze({"binding":{"sourcePin":"6b26d90d8763c9d925334e7549af64569a8ac352","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/chn-afg-original-frontier-20261116/review.json","sha256":"d7845e9969f4305899b9fc5ddbfae4738b698f37b9b4b1fc9aec2ff06dadce97"},"operation":{"polygonIndex":0,"ringIndex":0,"startIndex":2099,"endIndex":2158,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":1222,"endIndex":0,"direction":-1}},"topologyOperation":{"polygonIndex":0,"ringIndex":0,"startIndex":2099,"endIndex":2158,"raw":{"polygonIndex":234,"ringIndex":0,"startIndex":920213,"endIndex":921435,"direction":1}},"ringStart":{"polygonIndex":0,"ringIndex":0,"startIndex":0},"afgArc":{"polygonIndex":0,"ringIndex":0,"startIndex":1222,"endIndex":0,"direction":-1},"vertexCount":1223,"originalCHNWkb":"405272f2ab2134d4401f8218e267a8b6bf6918ff22673d0a223aef01d27b906c"},"frozen":{"CHN":{"descriptorSha256":"e73ae8acd1df89fd5a6e0cc2948d5218783751f4dfe11c8500378dfd0d31e357","geometrySha256":"cb57c1a9655fc843c7749585400c039a6710a2f654d0f04ac155fc9810a0471e","resourceSha256":"db80e8ef3c0d3bf2e37ad528a5fd9b3d791cb125a83435deeec9a9e113f2f5ac"},"AFG":{"descriptorSha256":"92aa6ff9d72fab84205d41794645c385025574e2938fe79165e70dad56612673","geometrySha256":"52095d69a0e57368089d4a916ed94fa67aa72a525bb1079c9bf3e4b0132c9db5","resourceSha256":"9e8169d42915b2a2a756e6372b7e066f52b66b46c535378457eca5890f2a70ec"},"KAS":{"descriptorSha256":"cc54544e2cc74babe45b43dda8acea7ddbde4dfeba5412d5aa67e16cfacf1cb8","geometrySha256":"00238ed92de0e11a41b39f9e0d89e0310a01b9a3ee35bcc29f10667420b4f21d","resourceSha256":"0e7cf134851fec4bbdbc91763e16840e88f7bd958580bff68b52a52b7a15027a"},"PAK":{"descriptorSha256":"c607c7c30df1827466fc2a98af90ac2e50a0f3f798e14d679a53b25aa16e64ad","geometrySha256":"0cb8f5867a67a63b9789e7451ead75cf22f2acefe831914415f3fa8085f370b6","resourceSha256":"99e003b50ec1c6c024e45d5889fab022c51827fb19f2811a9ec2309d8e613086"},"TJK":{"descriptorSha256":"1859a5e32592afa3119e250025935859ed7ec88e4309e0040ed61cda94bc318b","geometrySha256":"6feab00b43ee19bf3a68baa3f2682107d8eec8035362b90847781130e2255b72","resourceSha256":"3c9120bdb628c8a7d7f311523d5fd905b63d58661895ec36a625c417dd8729eb"},"IND":{"descriptorSha256":"739b6986129533dc1c92b69d72c713287105c87582fec5a7ab257535faffa03a","geometrySha256":"f4d54214a05887f1aa82f4fef21128a490aea32258d86ea5aad0e90e67754d81","resourceSha256":"fd27183b80c6a113026db208fed364590d8916322cbc87c39aba37fd3391ee4a"},"KGZ":{"descriptorSha256":"385e9a3b1811fce7037b8343d919a5c6ca73a973a13346fb1ba0b56022f8800a","geometrySha256":"c282a18d26aa3aae9da9c3c917ca6ab6cb18f1b0401e879e15e596a1e86b3baf","resourceSha256":"c15a45050b4a3a87acb81d6d2699065c8bc07533958fe561020587b8b0f4c227"},"NPL":{"descriptorSha256":"99cf879f59c13f19746a9d6904c964d1c09dabe925345afe529bf7b51d420615","geometrySha256":"12b14b720d640e03d4fb4169e876f846d4611d2e1f852da74c28947820bea211","resourceSha256":"d7865d9b3349d9a212fbb81ad581ac402e30fd9dbc82210625acac352a0d69ce"},"KAZ":{"descriptorSha256":"466f8a4aedc6271c0a9db3c2fa1ee4244aeda1bad30101149ededce0faf21962","geometrySha256":"0d4cdc27fcd2a78145ec4aff1c35bc1b999b04000d2c61864a0b26c8f3aeed70","resourceSha256":"47de235c3a3e07fa5fa40d7ba0805a5ddbe757d5857534439c37903aa0db46ae"},"MMR":{"descriptorSha256":"848d45edd780e5b9be9e5ce2dc8a1309d2defec5d003c66d590d0fd21dcf9d93","geometrySha256":"776fa77249f38f397f9b40c4e80acd883d3851013ae59d944d59c192d78bfb67","resourceSha256":"f04681da37aafd08d30cf189055cb849be366402443da930a4ce2f216a76ac79"},"RUS":{"descriptorSha256":"5c46aa078bdb782864d0789f4d126bfa148ef1f06478846b67a33c64055fcfa2","geometrySha256":"2ab7a05ab44229d67f0d317b392402f53e64f0a130e02c4c8c9947e1283cc2ef","resourceSha256":"87b24be2294a611c06f36d0b6d6f500821dffaa2980e5174954ec2caaf3b6838"},"MNG":{"descriptorSha256":"d7e67adde7c998fe4886811b432aabc08063dbfdef353bb29b94330dfdf71cc8","geometrySha256":"f77ec0aa475978894d8995da93c429579add7bb470cb8813af46ad3b8f698440","resourceSha256":"476459922561c7f96ae33b864421f506436d6eba925ef423b29a052ca27c806a"},"PRK":{"descriptorSha256":"0f2a33b509862413a607fed53df2bf628272dc302abe0b381b422e2195d7ad29","geometrySha256":"7477c2eddf1fd8f900973c0d7956bc51ecbf67691d7191f2ff3891f2f930b5b2","resourceSha256":"c7c8493d65399361ea6e1092d133ebf212c5a217d27b8c092fee5b6d3879a50c"},"BTN":{"descriptorSha256":"bbb89f515afee505080cbd02204ca07c44d948c0f563a0a157cd44e7ac2c7a48","geometrySha256":"fada38b3d5d583854e155739d693e5462dae5836c9ccf50e0a720de30754f60a","resourceSha256":"4c597a25fae08e17fe02846b21e7916168e011983fc7b92bf9a1bf7799d8ce96"},"VNM":{"descriptorSha256":"d2162fe0a0f986ad2b138448b8b52fcf7820a80da7385078623d794b952bf39a","geometrySha256":"95bb44b6f0db104c3588b262b9e7efb4a2763e0f6b02f60c3da318671b1a1599","resourceSha256":"557d72ea749c4696230857283afca8a4903b4005722d69a599ae89de4c1c251b"},"LAO":{"descriptorSha256":"7ffef29ea030e1e9c8b3f30fbfa3dd08a58eaa380b815886567005dfe8490d86","geometrySha256":"761a845ae4479ba70711e418ccafc8fc6399c2c966821d9792d7b0bfc40718cf","resourceSha256":"5a6eff454092694a9b5c1675b97a238ba41a8462c64085cf03ff1b7291f93003"},"KOR":{"descriptorSha256":"9fdde05f8b755c6e7b5278fbd7b5052124fe883d3ff6c443b20164988682df9d","geometrySha256":"b58b8033be3daa4a12c7a470498a683b145f3bd857676db5bb0aba672eb527f8","resourceSha256":"7b19986b6584cb08e92ce9e7777f75de1b10475898ebd661dcc3f21637446c94"},"TWN":{"descriptorSha256":"c2d50f5e60596ed7712ba58cf9f128523ea59d51bac5ad9f7506252b3c3e55fa","geometrySha256":"05620c3ab6e3a16bb5525de31e716547489d69618996f6d01484b7f5a54f7405","resourceSha256":"c20159fe4dc86c5f3bb31a9899256795b6d91e869f084cd3c7fe1226d7f3c4aa"},"HKG":{"descriptorSha256":"77d6e31ae1fac296c2f46f3ffdf08597ab16889627ac3ed9e6672e87db9aafb1","geometrySha256":"788e8b5ce738e406862939c905789d3c46cf4719e43892ca9eabf1d9deca4d92","resourceSha256":"71bde142112494139afdd626769828904627bb44118814ab792d185f66d6d1c3"},"MAC":{"descriptorSha256":"44f60fbadfcb40ef6647486c7959d5c544e9b0a8733133fd0ac8447c8c30c2d7","geometrySha256":"27c462a32a8c04d0a5f80dcfedb8b80fab1a0d7ad0aefd7eff866f3253f3692f","resourceSha256":"37a8a465bab04db0c8a38c2807635581703c5103d608c12382e0beee03dadef2"}},"raw":{"AFG":{"path":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-south-asia-20261113/originals/AFG-original.json","sha256":"afb4cb230c706872ccd11147bcc82031e1d638ea56bdde0befe865911f5f6948","feature":"5c56cf7d-c485-4659-9399-5c17e9003112","wkb":"83fa3ab3dd4f7c6ea2871aa7c004fc0413e47c234360bb8cbe0fed66cadb73fd"}},"resourcePath":"assets/data/territorial-entities/source/geometries/sha256-f1114e1701a764f5ecab977b94deba5df47aa0e77c5e3435d016a5b454adcc03.json","descriptorPath":"assets/data/territorial-entities/source/countries/state-CHN.json"});
