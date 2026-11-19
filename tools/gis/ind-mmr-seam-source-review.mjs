import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';

export const indMmrSeamMethod='exact-original-ind-mmr-readonly-counterpart-seam';
const id='state:IND', version='state:IND:natural-earth-5.1.1';
const status='raw-source-only-not-display-approved';
const base='assets/data/territorial-entities/source/';
const prior='exact-original-ind-bgd-readonly-counterpart-seam';
const hash=b=>createHash('sha256').update(b).digest('hex');
const domain=g=>hash(JSON.stringify([g.type,g.coordinates]));
const fail=message=>{throw Error('IND/MMR exact current seam: '+message);};
const keys=(o,names)=>o&&eq(Object.keys(o).sort(),[...names].sort());
const omit=(o,...names)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!names.includes(k)));
const active=e=>e.geometryVersions.filter(x=>x.validTo===null);
const preserved=e=>({...e,sourceInfo:omit(e.sourceInfo,'geometrySha256','geometryVersionId'),
 geometryVersions:e.geometryVersions.map(x=>x.versionId===version?omit(x,'geometry','modernBoundarySupplement'):x)});
const dig=(a,b,label)=>{if(a!==b)fail(label+' digest mismatch');};
const bytes=(read,p,h)=>{const x=read(p);if(!Buffer.isBuffer(x))fail(p+' exact archived bytes required');dig(hash(x),h,p);return x;};
export const hasIndMmrSeam=e=>e?.entityId===id&&e?.geometryVersions?.some(x=>x.validTo===null&&x.modernBoundarySupplement?.adoptionMode===indMmrSeamMethod)===true;

export function assertIndMmrTopology(p,b,peers){
 const {openRingVertexCount,...mmrArc}=p.MMRDonor??{};
 if(p.pin!==b.sourcePin||p.newPairDE9IM!=='FF2F11212'||p.newOverlapKm2!==0||p.newPositiveOverlapPolygonCount!==0||
  p.oldCoverageLossKm2!==0||p.oldCoverageLossPolygonCount!==0||p.allArcEdgesExactReciprocal!==true||
  p.INDOriginal?.wkbSha256!==b.originalINDWkb||!eq(p.operations,[b.topologyOperation])||!eq(p.ringStarts,[b.ringStart])||!eq(mmrArc,b.mmrArc)||
  !keys(p.otherPeers,peers)||peers.some(c=>{const v=p.otherPeers[c];return v?.exactPrePostIntersectionEqual!==true||
   v.exactPrePostBoundaryShareEqual!==true||v.changeAreaKm2!==0;}))fail('reviewed zero-overlap no-loss topology and unchanged peers required');
 return true;
}

export function assertIndMmrSeam(next,previous,{prefixes,readEvidence}={}){
 const {binding,frozen,raw,descriptorPath,resourcePath}=registeredIndMmr;
 if(typeof readEvidence!=='function'||!hasIndMmrSeam(next)||previous?.entityId!==id)fail('pinned IND archive reader and entity required');
 const nv=active(next),pv=active(previous),v=nv[0],old=pv[0],s=v?.modernBoundarySupplement;
 if(nv.length!==1||pv.length!==1||v.versionId!==version||old.versionId!==version||v.validFrom!==null||old.validFrom!==null||
  next.metadata?.representativeGeometryVersionId!==version||!eq(preserved(next),preserved(previous)))
  fail('dates, selected version, attribution, and unselected geometry must remain exact');
 if(!keys(s,['adoptionMode','status','resultRelation','wholeCountryRaw','priorPreparedAttribution','geometrySha256','seamReview'])||
  s.status!==status||s.resultRelation!=='partial-original-with-readonly-myanmar-seam'||s.wholeCountryRaw!==false||
  old.modernBoundarySupplement?.adoptionMode!==prior||!eq(s.priorPreparedAttribution,old.modernBoundarySupplement)||
  !eq(s.seamReview,binding.review))fail('only registered partial source and prior attribution required');
 if(!Array.isArray(prefixes)||!eq([...prefixes].sort(),[descriptorPath,resourcePath].sort()))fail('only IND descriptor and exact new geometry may be written');
 const r=JSON.parse(bytes(readEvidence,binding.review.reference,binding.review.sha256));
 if(r.schemaVersion!==1||r.sourcePin!==binding.sourcePin||r.method!==indMmrSeamMethod||r.status!==status||r.entityId!==id||
  r.versionId!==version||r.validFrom!==null||r.validTo!==null||r.vertexCount!==binding.vertexCount||
  !eq(r.operation,binding.operation)||!eq(r.topologyOperation,binding.topologyOperation)||!eq(r.ringStart,binding.ringStart)||!eq(r.mmrArc,binding.mmrArc))fail('fixed source review fields required');
 dig(domain(old.geometry),r.previousGeometrySha256,'prior IND geometry');
 dig(domain(v.geometry),r.geometrySha256,'new IND geometry');
 dig(hash(JSON.stringify(v.geometry)+'\n'),r.geometryResourceSha256,'new IND CAS');
 if(s.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometryVersionId!==version)
  fail('current source digest attribution must be correct');
 const proof=JSON.parse(bytes(readEvidence,r.topologyProof.reference,r.topologyProof.sha256));
 const peers=Object.keys(frozen).filter(c=>c!=='MMR'&&c!=='IND');
 assertIndMmrTopology(proof,binding,peers);
 const originals={},current={};
 for(const c of ['MMR']){
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
 if(!eq(current.IND,previous)||!eq(active(current.MMR)[0].geometry,originals.MMR))fail('pinned IND and exact unchanged MMR required');
 const arc=(g,x)=>exactCyclicChain(g.coordinates[x.polygonIndex][x.ringIndex],x.startIndex,x.endIndex,x.direction);
 const op=binding.operation, points=arc(originals.MMR,op.raw);
 if(!eq(op.raw,binding.mmrArc)||op.ringIndex!==0||op.raw.ringIndex!==0||binding.mmrArc.ringIndex!==0||points.length!==binding.vertexCount||
  !eq(points,arc(originals.MMR,binding.mmrArc))||points.slice(1).some((p,i)=>eq(p,points[i])))fail('one exact reciprocal LSIB exterior arc required');
 if(!eq(replayRetainedCoast(old.geometry,originals.MMR,[op],[binding.ringStart]),v.geometry))
  fail('candidate must be exact replay with all other rings and polygons preserved');
 return 1;
}

const registeredIndMmr=Object.freeze({"binding":{"sourcePin":"b2480b0f936398175e7ee5706a6b965c5636c6c2","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/ind-mmr-original-frontier-20261115/review.json","sha256":"5c14301e5fd708a2604c2da9eb0e000925b0a9ba0241e8e16d9a2ce84a4ef5d1"},"operation":{"polygonIndex":385,"ringIndex":0,"startIndex":2186,"endIndex":3197,"raw":{"polygonIndex":1035,"ringIndex":0,"startIndex":342683,"endIndex":327532,"direction":-1}},"topologyOperation":{"polygonIndex":385,"ringIndex":0,"startIndex":2186,"endIndex":3197,"raw":{"polygonIndex":1460,"ringIndex":0,"startIndex":661341,"endIndex":676492,"direction":1}},"ringStart":{"polygonIndex":385,"ringIndex":0,"startIndex":0},"mmrArc":{"polygonIndex":1035,"ringIndex":0,"startIndex":342683,"endIndex":327532,"direction":-1},"vertexCount":15152,"originalINDWkb":"91a082ab754db0f7fbba2c7a974d19cd86e1da6d97624a78f33e9c10a64f15ec"},"frozen":{"IND":{"descriptorSha256":"17ffd0ffc1ab0717c9677efb7e16ecadc0efde16371941c43c4ad42f4b307e3c","geometrySha256":"3726c0bf09bc4a7116ce718e91cf008623cac175b8c9924c849c355995777e43","resourceSha256":"2b1733eae965d2a3cbd9cb6ff209c734bfe6c3b8ff726c3d844ab2055131416a"},"MMR":{"descriptorSha256":"848d45edd780e5b9be9e5ce2dc8a1309d2defec5d003c66d590d0fd21dcf9d93","geometrySha256":"776fa77249f38f397f9b40c4e80acd883d3851013ae59d944d59c192d78bfb67","resourceSha256":"f04681da37aafd08d30cf189055cb849be366402443da930a4ce2f216a76ac79"},"BGD":{"descriptorSha256":"c94c4e02985fa0ee84bffe0a87b0aa4a913534128762f61439f0883bf863b3fa","geometrySha256":"f7e17e06d82c7b4465d78b6c8a87a421ee0a5c0dd1d2e9d6d78c0ec4a2b785b1","resourceSha256":"220b05c157c0b5c832f14d30279e57fd5b27abdc8e46326d3d77ce92fde6d51f"},"CHN":{"descriptorSha256":"e73ae8acd1df89fd5a6e0cc2948d5218783751f4dfe11c8500378dfd0d31e357","geometrySha256":"cb57c1a9655fc843c7749585400c039a6710a2f654d0f04ac155fc9810a0471e","resourceSha256":"db80e8ef3c0d3bf2e37ad528a5fd9b3d791cb125a83435deeec9a9e113f2f5ac"},"BTN":{"descriptorSha256":"bbb89f515afee505080cbd02204ca07c44d948c0f563a0a157cd44e7ac2c7a48","geometrySha256":"fada38b3d5d583854e155739d693e5462dae5836c9ccf50e0a720de30754f60a","resourceSha256":"4c597a25fae08e17fe02846b21e7916168e011983fc7b92bf9a1bf7799d8ce96"},"NPL":{"descriptorSha256":"99cf879f59c13f19746a9d6904c964d1c09dabe925345afe529bf7b51d420615","geometrySha256":"12b14b720d640e03d4fb4169e876f846d4611d2e1f852da74c28947820bea211","resourceSha256":"d7865d9b3349d9a212fbb81ad581ac402e30fd9dbc82210625acac352a0d69ce"},"PAK":{"descriptorSha256":"c607c7c30df1827466fc2a98af90ac2e50a0f3f798e14d679a53b25aa16e64ad","geometrySha256":"0cb8f5867a67a63b9789e7451ead75cf22f2acefe831914415f3fa8085f370b6","resourceSha256":"99e003b50ec1c6c024e45d5889fab022c51827fb19f2811a9ec2309d8e613086"},"KAS":{"descriptorSha256":"cc54544e2cc74babe45b43dda8acea7ddbde4dfeba5412d5aa67e16cfacf1cb8","geometrySha256":"00238ed92de0e11a41b39f9e0d89e0310a01b9a3ee35bcc29f10667420b4f21d","resourceSha256":"0e7cf134851fec4bbdbc91763e16840e88f7bd958580bff68b52a52b7a15027a"},"AFG":{"descriptorSha256":"92aa6ff9d72fab84205d41794645c385025574e2938fe79165e70dad56612673","geometrySha256":"52095d69a0e57368089d4a916ed94fa67aa72a525bb1079c9bf3e4b0132c9db5","resourceSha256":"9e8169d42915b2a2a756e6372b7e066f52b66b46c535378457eca5890f2a70ec"},"LKA":{"descriptorSha256":"3f5747b81923709e46f87aad8dd05a550456d89179108d8f9bebe7be6cddbe93","geometrySha256":"8420192993d0e0559170fa5394ac193710a0453be922980551ad104805c4f7b3","resourceSha256":"8d3c9a7050ad59dbe8a417166c444a0a77bc7a4c7d5e2a32510d94bd4fb8cd9b"},"THA":{"descriptorSha256":"f06f42310599da06a3a7862ad088b435024919cf6ba570918be028978e6c46ea","geometrySha256":"ca244cbd9ecf3ad04d77ffff38276bac9e706d660e032fe5a0511ebc96668568","resourceSha256":"8a76a7cca6f449c8b690f948b31b0034c5fcdfd4de56068f927a469294116653"}},"raw":{"MMR":{"path":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-south-asia-20261113/originals/MMR-original.json","sha256":"f5e7a6284c60bcb94f1bd2443a6bdfa2a3f99683711a1989c05edd4e80e172de","feature":"c95e80fe-e1c8-4db4-866d-315abb67baf1","wkb":"e8f7fd888a4e369c7e45ccaadcefe28bad64d2cceee4dfe8f1de96a734d45d10"}},"resourcePath":"assets/data/territorial-entities/source/geometries/sha256-fd27183b80c6a113026db208fed364590d8916322cbc87c39aba37fd3391ee4a.json","descriptorPath":"assets/data/territorial-entities/source/countries/state-IND.json"});
