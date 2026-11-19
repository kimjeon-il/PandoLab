import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';

export const chnKazSeamMethod='exact-original-chn-kaz-readonly-counterpart-seam';
const id='state:CHN', version='state:CHN:paektu-lsib-11.4';
const status='raw-source-only-not-display-approved';
const base='assets/data/territorial-entities/source/';
const prior='exact-original-chn-mng-readonly-counterpart-seam';
const hash=b=>createHash('sha256').update(b).digest('hex');
const domain=g=>hash(JSON.stringify([g.type,g.coordinates]));
const fail=message=>{throw Error('CHN/KAZ exact current seam: '+message);};
const keys=(o,names)=>o&&eq(Object.keys(o).sort(),[...names].sort());
const omit=(o,...names)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!names.includes(k)));
const active=e=>e.geometryVersions.filter(x=>x.validTo===null);
const preserved=e=>({...e,sourceInfo:omit(e.sourceInfo,'geometrySha256','geometryVersionId'),
 geometryVersions:e.geometryVersions.map(x=>x.versionId===version?omit(x,'geometry','modernBoundarySupplement'):x)});
const dig=(a,b,label)=>{if(a!==b)fail(label+' digest mismatch');};
const bytes=(read,p,h)=>{const x=read(p);if(!Buffer.isBuffer(x))fail(p+' exact archived bytes required');dig(hash(x),h,p);return x;};
export const hasChnKazSeam=e=>e?.entityId===id&&e?.geometryVersions?.some(x=>x.validTo===null&&x.modernBoundarySupplement?.adoptionMode===chnKazSeamMethod)===true;

export function assertChnKazTopology(p,b,peers){
 const {openRingVertexCount,...kazArc}=p.KAZDonor??{};
 if(p.pin!==b.sourcePin||p.newPairDE9IM!=='FF2F11212'||p.newOverlapKm2!==0||p.newPositiveOverlapPolygonCount!==0||
  p.oldCoverageLossKm2!==0||p.oldCoverageLossPolygonCount!==0||p.allArcEdgesExactReciprocal!==true||
  p.CHNOriginal?.wkbSha256!==b.originalCHNWkb||!eq(p.operations,[b.topologyOperation])||!eq(p.ringStarts,[b.ringStart])||!eq(kazArc,b.kazArc)||
  !keys(p.otherPeers,peers)||peers.some(c=>{const v=p.otherPeers[c];return v?.exactPrePostIntersectionEqual!==true||
   v.exactPrePostBoundaryShareEqual!==true||v.changeAreaKm2!==0;}))fail('reviewed zero-overlap no-loss topology and unchanged peers required');
 return true;
}

export function assertChnKazSeam(next,previous,{prefixes,readEvidence}={}){
 const {binding,frozen,raw,descriptorPath,resourcePath}=registeredChnKaz;
 if(typeof readEvidence!=='function'||!hasChnKazSeam(next)||previous?.entityId!==id)fail('pinned CHN archive reader and entity required');
 const nv=active(next),pv=active(previous),v=nv[0],old=pv[0],s=v?.modernBoundarySupplement;
 if(nv.length!==1||pv.length!==1||v.versionId!==version||old.versionId!==version||v.validFrom!==null||old.validFrom!==null||
  next.metadata?.representativeGeometryVersionId!==version||!eq(preserved(next),preserved(previous)))
  fail('dates, selected version, attribution, and unselected geometry must remain exact');
 if(!keys(s,['adoptionMode','status','resultRelation','wholeCountryRaw','priorPreparedAttribution','geometrySha256','seamReview'])||
  s.status!==status||s.resultRelation!=='partial-original-with-readonly-kazakhstan-seam'||s.wholeCountryRaw!==false||
  old.modernBoundarySupplement?.adoptionMode!==prior||!eq(s.priorPreparedAttribution,old.modernBoundarySupplement)||
  !eq(s.seamReview,binding.review))fail('only registered partial source and prior attribution required');
 if(!Array.isArray(prefixes)||!eq([...prefixes].sort(),[descriptorPath,resourcePath].sort()))fail('only CHN descriptor and exact new geometry may be written');
 const r=JSON.parse(bytes(readEvidence,binding.review.reference,binding.review.sha256));
 if(r.schemaVersion!==1||r.sourcePin!==binding.sourcePin||r.method!==chnKazSeamMethod||r.status!==status||r.entityId!==id||
  r.versionId!==version||r.validFrom!==null||r.validTo!==null||r.vertexCount!==binding.vertexCount||
  !eq(r.operation,binding.operation)||!eq(r.topologyOperation,binding.topologyOperation)||!eq(r.ringStart,binding.ringStart)||!eq(r.kazArc,binding.kazArc))fail('fixed source review fields required');
 dig(domain(old.geometry),r.previousGeometrySha256,'prior CHN geometry');
 dig(domain(v.geometry),r.geometrySha256,'new CHN geometry');
 dig(hash(JSON.stringify(v.geometry)+'\n'),r.geometryResourceSha256,'new CHN CAS');
 if(s.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometryVersionId!==version)
  fail('current source digest attribution must be correct');
 const proof=JSON.parse(bytes(readEvidence,r.topologyProof.reference,r.topologyProof.sha256));
 const peers=Object.keys(frozen).filter(c=>c!=='KAZ'&&c!=='CHN');
 assertChnKazTopology(proof,binding,peers);
 const originals={},current={};
 for(const c of ['KAZ']){
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
 if(!eq(current.CHN,previous)||!eq(active(current.KAZ)[0].geometry,originals.KAZ))fail('pinned CHN and exact unchanged KAZ required');
 const arc=(g,x)=>exactCyclicChain(g.coordinates[x.polygonIndex][x.ringIndex],x.startIndex,x.endIndex,x.direction);
 const op=binding.operation, points=arc(originals.KAZ,op.raw);
 if(!eq(op.raw,binding.kazArc)||op.ringIndex!==0||op.raw.ringIndex!==0||binding.kazArc.ringIndex!==0||points.length!==binding.vertexCount||
  !eq(points,arc(originals.KAZ,binding.kazArc))||points.slice(1).some((p,i)=>eq(p,points[i])))fail('one exact reciprocal LSIB exterior arc required');
 if(!eq(replayRetainedCoast(old.geometry,originals.KAZ,[op],[binding.ringStart]),v.geometry))
  fail('candidate must be exact replay with all other rings and polygons preserved');
 return 1;
}

const registeredChnKaz=Object.freeze({"binding":{"sourcePin":"20a59696b5c281ee7f844e846cf32f20f279f037","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/chn-kaz-original-frontier-20261115/review.json","sha256":"6a77837f4be1e1cc137f094a886d98712ece60a4706334bd697f3c85ef8bbe96"},"operation":{"polygonIndex":0,"ringIndex":0,"startIndex":3106,"endIndex":4058,"raw":{"polygonIndex":7,"ringIndex":0,"startIndex":44147,"endIndex":112279,"direction":-1}},"topologyOperation":{"polygonIndex":0,"ringIndex":0,"startIndex":3106,"endIndex":4058,"raw":{"polygonIndex":234,"ringIndex":0,"startIndex":952175,"endIndex":996325,"direction":1}},"ringStart":{"polygonIndex":0,"ringIndex":0,"startIndex":0},"kazArc":{"polygonIndex":7,"ringIndex":0,"startIndex":44147,"endIndex":112279,"direction":-1},"vertexCount":44151,"originalCHNWkb":"405272f2ab2134d4401f8218e267a8b6bf6918ff22673d0a223aef01d27b906c"},"frozen":{"CHN":{"descriptorSha256":"00408992fa6256cb08fa13cf904a6005c7e8d6ebc2a7251dbb65e35c17850430","geometrySha256":"7fa30835644d8706e7768459cffe2f855c805043793543ac61ca7b7244a7442d","resourceSha256":"012e3e5575f07aeb61e6f32e9f7bf7803c0ee1c91e2e46e6bc7b9507029366de"},"KAZ":{"descriptorSha256":"466f8a4aedc6271c0a9db3c2fa1ee4244aeda1bad30101149ededce0faf21962","geometrySha256":"0d4cdc27fcd2a78145ec4aff1c35bc1b999b04000d2c61864a0b26c8f3aeed70","resourceSha256":"47de235c3a3e07fa5fa40d7ba0805a5ddbe757d5857534439c37903aa0db46ae"},"RUS":{"descriptorSha256":"79e94fab9f09f2728ae35763535d9e65e89950985545949410805a819b7a9229","geometrySha256":"54ff0b884412a38a6d15e8116a2e9160a4aef8f455bf00eb714b53917d3f951f","resourceSha256":"568d06adc74671c7083dae27b77cb080bf52174177bb9c7da5018d9ff30adb8e"},"KGZ":{"descriptorSha256":"385e9a3b1811fce7037b8343d919a5c6ca73a973a13346fb1ba0b56022f8800a","geometrySha256":"c282a18d26aa3aae9da9c3c917ca6ab6cb18f1b0401e879e15e596a1e86b3baf","resourceSha256":"c15a45050b4a3a87acb81d6d2699065c8bc07533958fe561020587b8b0f4c227"},"MNG":{"descriptorSha256":"d7e67adde7c998fe4886811b432aabc08063dbfdef353bb29b94330dfdf71cc8","geometrySha256":"f77ec0aa475978894d8995da93c429579add7bb470cb8813af46ad3b8f698440","resourceSha256":"476459922561c7f96ae33b864421f506436d6eba925ef423b29a052ca27c806a"},"TJK":{"descriptorSha256":"1859a5e32592afa3119e250025935859ed7ec88e4309e0040ed61cda94bc318b","geometrySha256":"6feab00b43ee19bf3a68baa3f2682107d8eec8035362b90847781130e2255b72","resourceSha256":"3c9120bdb628c8a7d7f311523d5fd905b63d58661895ec36a625c417dd8729eb"},"AFG":{"descriptorSha256":"92aa6ff9d72fab84205d41794645c385025574e2938fe79165e70dad56612673","geometrySha256":"52095d69a0e57368089d4a916ed94fa67aa72a525bb1079c9bf3e4b0132c9db5","resourceSha256":"9e8169d42915b2a2a756e6372b7e066f52b66b46c535378457eca5890f2a70ec"},"PAK":{"descriptorSha256":"c607c7c30df1827466fc2a98af90ac2e50a0f3f798e14d679a53b25aa16e64ad","geometrySha256":"0cb8f5867a67a63b9789e7451ead75cf22f2acefe831914415f3fa8085f370b6","resourceSha256":"99e003b50ec1c6c024e45d5889fab022c51827fb19f2811a9ec2309d8e613086"},"KAS":{"descriptorSha256":"cc54544e2cc74babe45b43dda8acea7ddbde4dfeba5412d5aa67e16cfacf1cb8","geometrySha256":"00238ed92de0e11a41b39f9e0d89e0310a01b9a3ee35bcc29f10667420b4f21d","resourceSha256":"0e7cf134851fec4bbdbc91763e16840e88f7bd958580bff68b52a52b7a15027a"},"IND":{"descriptorSha256":"17ffd0ffc1ab0717c9677efb7e16ecadc0efde16371941c43c4ad42f4b307e3c","geometrySha256":"3726c0bf09bc4a7116ce718e91cf008623cac175b8c9924c849c355995777e43","resourceSha256":"2b1733eae965d2a3cbd9cb6ff209c734bfe6c3b8ff726c3d844ab2055131416a"},"UZB":{"descriptorSha256":"78ce65f012c1f11cd0e34e7537bc72a56e25a8d1f0360e25b27c2c23f9c9bceb","geometrySha256":"c061d312f0bcf288a09647526f8870d3deba7522f4a07a4be404ad229f18fd72","resourceSha256":"8fe960fc8149a9624c360f98b01de1590dbe4b3e2c8c128b48a451e4e134c2c5"},"NPL":{"descriptorSha256":"99cf879f59c13f19746a9d6904c964d1c09dabe925345afe529bf7b51d420615","geometrySha256":"12b14b720d640e03d4fb4169e876f846d4611d2e1f852da74c28947820bea211","resourceSha256":"d7865d9b3349d9a212fbb81ad581ac402e30fd9dbc82210625acac352a0d69ce"},"BTN":{"descriptorSha256":"bbb89f515afee505080cbd02204ca07c44d948c0f563a0a157cd44e7ac2c7a48","geometrySha256":"fada38b3d5d583854e155739d693e5462dae5836c9ccf50e0a720de30754f60a","resourceSha256":"4c597a25fae08e17fe02846b21e7916168e011983fc7b92bf9a1bf7799d8ce96"},"MMR":{"descriptorSha256":"848d45edd780e5b9be9e5ce2dc8a1309d2defec5d003c66d590d0fd21dcf9d93","geometrySha256":"776fa77249f38f397f9b40c4e80acd883d3851013ae59d944d59c192d78bfb67","resourceSha256":"f04681da37aafd08d30cf189055cb849be366402443da930a4ce2f216a76ac79"}},"raw":{"KAZ":{"path":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-current-four-20261113/originals/KAZ-original.json","sha256":"6614379d2869ddfb259f556432c31d72058784927427a2ea7ea4e4ec2461fd8c","feature":"7f1674ad-e097-48c8-829b-a60281d4230f","wkb":"5870d328e9e29e6647cfb3b4dd8651d117041011a04b3003740860f321b60652"}},"resourcePath":"assets/data/territorial-entities/source/geometries/sha256-db80e8ef3c0d3bf2e37ad528a5fd9b3d791cb125a83435deeec9a9e113f2f5ac.json","descriptorPath":"assets/data/territorial-entities/source/countries/state-CHN.json"});
