import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry,readChunkedOriginalBlob} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain,sharedExactEdges} from './retained-coast-source-review.mjs';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';

export const indBgdSeamMethod='exact-original-ind-bgd-readonly-counterpart-seam';
export const indBgdSeamRelation='partial-original-with-readonly-bangladesh-seam';
const id='state:IND', versionId='state:IND:natural-earth-5.1.1';
const priorMethod='exact-original-retained-coast-arcs-current-batch';
const status='raw-source-only-not-display-approved';
const sourceBase='assets/data/territorial-entities/source/';
const reportBase='reports/borders/validation/modern-raw-source-20261110/';
const expectedPeers=Object.freeze(['AFG','BGD','BTN','CHN','KAS','LKA','MDV','MMR','NPL','PAK']);
const digest=g=>hash(JSON.stringify([g.type,g.coordinates]));
const hash=b=>createHash('sha256').update(b).digest('hex');
const sha64=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=message=>{throw Error('IND/BGD exact current seam: '+message);};
const polys=g=>g?.type==='Polygon'?[g.coordinates]:g?.type==='MultiPolygon'?g.coordinates:fail('polygon preimage required');
const eqXY=(a,b)=>a[0]===b[0]&&a[1]===b[1];
const sameKeys=(o,keys)=>o&&typeof o==='object'&&equal(Object.keys(o).sort(),[...keys].sort());
function sameHash(actual,expected,label){if(!sha64(expected)||actual!==expected)fail(label+' digest mismatch');}
const editableFields=new Set(['geometry','modernBoundarySupplement']);
const sourceDigestFields=new Set(['geometrySha256','geometryVersionId']);
export const hasIndBgdSeam=e=>e?.geometryVersions?.some(v=>v.modernBoundarySupplement?.adoptionMode===indBgdSeamMethod)===true;

const edge=(a,b)=>{const x=JSON.stringify(a),y=JSON.stringify(b);return x<y?x+'|'+y:y+'|'+x;};
const ringEdges=r=>r.slice(1).map((p,i)=>edge(r[i],p));
const edgeSet=g=>new Set(polys(g).flatMap(p=>p.flatMap(ringEdges)));
function verifyHole(expected,old,original,bgd,op,policy,receipt){
 if(!policy){if(receipt!==undefined)fail('unexpected additional ring');return;}
 if(!sameKeys(policy,['targetRingIndex','originalRingIndex','bgdPolygonIndex','oldVertexCount','newVertexCount'])||
   policy.targetRingIndex!==1||policy.originalRingIndex!==1||
   !sameKeys(receipt,[...Object.keys(policy),'rawStartIndex','rawDirection'])||
   !Object.entries(policy).every(([k,v])=>receipt[k]===v))fail('one fixed existing enclave ring receipt required');
 const raw=polys(original)[op.raw.polygonIndex]?.[policy.originalRingIndex];
 const previous=polys(old)[op.polygonIndex]?.[policy.targetRingIndex];
 const peer=polys(bgd)[policy.bgdPolygonIndex];
 if(!raw||!previous||!peer||peer.length!==1||previous.length!==policy.oldVertexCount+1||raw.length!==policy.newVertexCount+1||
   policy.oldVertexCount<3||policy.newVertexCount<=policy.oldVertexCount||!eqXY(raw[0],raw.at(-1))||!eqXY(previous[0],previous.at(-1))||
   !Number.isSafeInteger(receipt.rawStartIndex)||receipt.rawStartIndex<0||receipt.rawStartIndex>=raw.length-1||
   ![1,-1].includes(receipt.rawDirection))fail('bounded old, raw, and frozen Bangladesh ring required');
 const n=raw.length-1,start=receipt.rawStartIndex,direction=receipt.rawDirection;
 const replacement=Array.from({length:n},(_,i)=>raw[((start+i*direction)%n+n)%n]);
 replacement.push(replacement[0]);
 if(!eqXY(previous[0],replacement[0]))fail('existing ring start vertex not preserved');
 let cursor=0;
 for(const coordinate of replacement)if(cursor<previous.length&&eqXY(coordinate,previous[cursor]))cursor++;
 if(cursor!==previous.length)fail('existing enclave vertices must remain in order');
 const selectedEdges=ringEdges(replacement),peerEdges=ringEdges(peer[0]);
 if(new Set(selectedEdges).size!==selectedEdges.length||!equal(selectedEdges.sort(),peerEdges.sort()))
  fail('existing ring is not the complete exact frozen Bangladesh enclave boundary');
 polys(expected)[op.polygonIndex][policy.targetRingIndex]=replacement;
}

function preserveEntity(entity){
 const filter=(v,fieldSet)=>Object.fromEntries(Object.entries(v||{}).filter(([k])=>!fieldSet.has(k)));
 return {...entity,sourceInfo:filter(entity.sourceInfo,sourceDigestFields),
  geometryVersions:entity.geometryVersions.map(v=>v.versionId===versionId?filter(v,editableFields):v)};
}

/** Pure second-stage admission. The caller pins the immutable expected review
 * receipt, reads the selected raw IND original from archived WKB, and reads all
 * peers from the same Git pin. The separate reviewed GEOS locality/overlap proof
 * is a prerequisite to registering the exact receipt, not a claim proved here.
 * This function supports one anchored mainland exterior replacement and, only
 * when a separate typed binding approves it, one existing enclave interior ring.
 */
export function assertIndBgdSeamReplay(next,previous,{prefixes,readEvidence,binding,originalGeometry,peers,
 replayRetainedCoast,exactCyclicChain,sharedExactEdges}={}){
 if(next?.entityId!==id||previous?.entityId!==id||!Array.isArray(next.geometryVersions)||!Array.isArray(previous.geometryVersions))
  fail('one existing India source required');
 if(typeof readEvidence!=='function'||typeof replayRetainedCoast!=='function'||typeof exactCyclicChain!=='function'||typeof sharedExactEdges!=='function')
  fail('canonical reader and arc replay required');
 const nr=next.geometryVersions.filter(v=>v.validTo===null),pr=previous.geometryVersions.filter(v=>v.validTo===null);
 if(nr.length!==1||pr.length!==1||nr[0].versionId!==versionId||pr[0].versionId!==versionId||
   nr[0].validFrom!==null||pr[0].validFrom!==null||next.metadata?.representativeGeometryVersionId!==versionId||
   previous.metadata?.representativeGeometryVersionId!==versionId||!equal(preserveEntity(next),preserveEntity(previous)))
  fail('dates, selected version, identity, source attributes, and unselected geometry must remain exact');
 const v=nr[0],old=pr[0],s=v.modernBoundarySupplement;
 if(!sameKeys(s,['adoptionMode','status','resultRelation','wholeCountryRaw','priorPreparedAttribution','geometrySha256','seamReview'])||
   old.modernBoundarySupplement?.adoptionMode!==priorMethod||!equal(s.priorPreparedAttribution,old.modernBoundarySupplement)||
   s.adoptionMode!==indBgdSeamMethod||s.status!==status||s.resultRelation!==indBgdSeamRelation||s.wholeCountryRaw!==false)
  fail('selected source-only attribution and actual prior supplement required');
 if(typeof binding?.sourcePin!=='string'||!/^[a-f0-9]{40}$/.test(binding.sourcePin)||!binding.review||
   !sameKeys(binding.review,['reference','sha256'])||!binding.review.reference?.startsWith(reportBase)||
   !/^reports\/(?:[\w.-]+\/)*[\w.-]+\.json$/.test(binding.review.reference)||binding.review.reference.split('/').includes('..')||
   !equal(s.seamReview,binding.review))
  fail('fixed seam review reference required');
 const reviewBytes=readEvidence(binding.review.reference);
 if(!Buffer.isBuffer(reviewBytes))fail('review must be read as exact archived bytes');
 sameHash(hash(reviewBytes),binding.review.sha256,'review');
 const r=JSON.parse(reviewBytes);
 if(r.schemaVersion!==1||r.method!==indBgdSeamMethod||r.status!==status||r.entityId!==id||r.versionId!==versionId||
   r.validFrom!==null||r.validTo!==null||r.sourcePin!==binding.sourcePin)
  fail('review identity and pinned source version required');
 sameHash(digest(old.geometry),r.previousGeometrySha256,'old IND');
 sameHash(digest(v.geometry),r.geometrySha256,'new IND');
 sameHash(digest(originalGeometry),r.originalGeometrySha256,'raw IND');
 const resourceHash=hash(JSON.stringify(v.geometry)+'\n');
 sameHash(resourceHash,r.geometryResourceSha256,'new IND CAS');
 if(s.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometryVersionId!==versionId)
  fail('current attribution digest mismatch');
 const scope=[sourceBase+'countries/state-IND.json',sourceBase+'geometries/sha256-'+resourceHash+'.json'];
 if(!Array.isArray(prefixes)||!equal([...prefixes].sort(),scope.sort()))fail('only exact IND descriptor and new CAS may be written');
 if(!(peers instanceof Map)||!equal([...peers.keys()].sort(),expectedPeers)||!sameKeys(r.peerGeometrySha256,expectedPeers))
  fail('all fixed current peer geometries must be read');
 for(const code of expectedPeers)sameHash(digest(peers.get(code)),r.peerGeometrySha256[code],code+' read-only preimage');
 if(!Array.isArray(r.operations)||r.operations.length!==1||!Array.isArray(r.ringStarts)||r.ringStarts.length!==1)
  fail('one open exterior replay operation required');
 const op=r.operations[0];
 if(op.polygonIndex!==binding.targetPolygonIndex||op.ringIndex!==0||op.raw?.polygonIndex!==binding.originalPolygonIndex||op.raw?.ringIndex!==0)
  fail('mainland exterior slot changed');
 const expected=replayRetainedCoast(old.geometry,originalGeometry,r.operations,r.ringStarts);
 verifyHole(expected,old.geometry,originalGeometry,peers.get('BGD'),op,binding.hole,r.hole);
 if(!equal(expected,v.geometry))fail('candidate must equal exact replay, including all other rings and components');
 const rawRing=polys(originalGeometry)[op.raw.polygonIndex][0];
 const arc=exactCyclicChain(rawRing,op.raw.startIndex,op.raw.endIndex,op.raw.direction);
 if(arc.slice(1).some((p,i)=>eqXY(p,arc[i])))fail('zero-length boundary edge');
 const covered=edgeSet(peers.get('BGD'));
 if(arc.slice(1).some((p,i)=>!covered.has(edge(arc[i],p))))
  fail('new seam edge is not in frozen Bangladesh');
 for(const code of expectedPeers.filter(c=>c!=='BGD'))if(!equal(sharedExactEdges(old.geometry,peers.get(code)),sharedExactEdges(v.geometry,peers.get(code))))fail('protected shared edges changed for '+code);
 return 1;
}


const registeredIndBgd = Object.freeze({"binding":{"sourcePin":"a3c495bb3d4a3d5961303a91de44cff00196d0fb","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/ind-bgd-shared-frontier-20261114/review.json","sha256":"055471eae56424b08a3dbab69d1eaa46f6b4a26aa4037933ba11beaec4fa91ae"},"targetPolygonIndex":385,"originalPolygonIndex":1460,"hole":{"targetRingIndex":1,"originalRingIndex":1,"bgdPolygonIndex":89,"oldVertexCount":26,"newVertexCount":460}},"frozen":{"IND":{"descriptorSha256":"360e2e63367b436568c275db106f02c0a8744e87df59a9a20ff9b782b9b3510e","geometrySha256":"11415299b52c28b4bf03008aa6e2eea9f94c2d6724111f3cdaf924e50c6773fa","resourceSha256":"a1a0356b9dde2cd6035ef1441f02cbe9513e261f2871940573668d8f0c4bf6ab"},"AFG":{"descriptorSha256":"92aa6ff9d72fab84205d41794645c385025574e2938fe79165e70dad56612673","geometrySha256":"52095d69a0e57368089d4a916ed94fa67aa72a525bb1079c9bf3e4b0132c9db5","resourceSha256":"9e8169d42915b2a2a756e6372b7e066f52b66b46c535378457eca5890f2a70ec"},"BGD":{"descriptorSha256":"c94c4e02985fa0ee84bffe0a87b0aa4a913534128762f61439f0883bf863b3fa","geometrySha256":"f7e17e06d82c7b4465d78b6c8a87a421ee0a5c0dd1d2e9d6d78c0ec4a2b785b1","resourceSha256":"220b05c157c0b5c832f14d30279e57fd5b27abdc8e46326d3d77ce92fde6d51f"},"BTN":{"descriptorSha256":"bbb89f515afee505080cbd02204ca07c44d948c0f563a0a157cd44e7ac2c7a48","geometrySha256":"fada38b3d5d583854e155739d693e5462dae5836c9ccf50e0a720de30754f60a","resourceSha256":"4c597a25fae08e17fe02846b21e7916168e011983fc7b92bf9a1bf7799d8ce96"},"CHN":{"descriptorSha256":"a7b93e8c2d55937c4d72c855c5d57f8736f8cb14002faadb09627c9282dc89e6","geometrySha256":"b7dc0fa34814e861cfd9747cc3dfa54fa13b44015324415ad58f69dd62b93192","resourceSha256":"bdb896baa43229e2c6d29c678132a1c7c1f15810a56b1370b9c980ad50683b50"},"KAS":{"descriptorSha256":"cc54544e2cc74babe45b43dda8acea7ddbde4dfeba5412d5aa67e16cfacf1cb8","geometrySha256":"00238ed92de0e11a41b39f9e0d89e0310a01b9a3ee35bcc29f10667420b4f21d","resourceSha256":"0e7cf134851fec4bbdbc91763e16840e88f7bd958580bff68b52a52b7a15027a"},"LKA":{"descriptorSha256":"3f5747b81923709e46f87aad8dd05a550456d89179108d8f9bebe7be6cddbe93","geometrySha256":"8420192993d0e0559170fa5394ac193710a0453be922980551ad104805c4f7b3","resourceSha256":"8d3c9a7050ad59dbe8a417166c444a0a77bc7a4c7d5e2a32510d94bd4fb8cd9b"},"MDV":{"descriptorSha256":"1dd922ac6df87dcbb7020f51f0b747e7f95b0397429660c28d81f138032cb428","geometrySha256":"b79bea2491dee1b44dce6cb6ca698ecfcd57d347738053925db17bba4b6b4059","resourceSha256":"bd76b2ee6cb087309b98098fe607b5396046e8752eeef20142445a293e331c13"},"MMR":{"descriptorSha256":"848d45edd780e5b9be9e5ce2dc8a1309d2defec5d003c66d590d0fd21dcf9d93","geometrySha256":"776fa77249f38f397f9b40c4e80acd883d3851013ae59d944d59c192d78bfb67","resourceSha256":"f04681da37aafd08d30cf189055cb849be366402443da930a4ce2f216a76ac79"},"NPL":{"descriptorSha256":"99cf879f59c13f19746a9d6904c964d1c09dabe925345afe529bf7b51d420615","geometrySha256":"12b14b720d640e03d4fb4169e876f846d4611d2e1f852da74c28947820bea211","resourceSha256":"d7865d9b3349d9a212fbb81ad581ac402e30fd9dbc82210625acac352a0d69ce"},"PAK":{"descriptorSha256":"c607c7c30df1827466fc2a98af90ac2e50a0f3f798e14d679a53b25aa16e64ad","geometrySha256":"0cb8f5867a67a63b9789e7451ead75cf22f2acefe831914415f3fa8085f370b6","resourceSha256":"99e003b50ec1c6c024e45d5889fab022c51827fb19f2811a9ec2309d8e613086"}},"rawReceipt":"reports/borders/validation/modern-raw-source-20261110/south-asia-retained-coast-20261114/IND/original/source.json","resourcePath":"assets/data/territorial-entities/source/geometries/sha256-2b1733eae965d2a3cbd9cb6ff209c734bfe6c3b8ff726c3d844ab2055131416a.json","descriptorPath":"assets/data/territorial-entities/source/countries/state-IND.json"});
const originalReceiptSha='c7d30a1a90c9b26c8c3f5b2aba6b0586eb3e8048237700864f1154fc24ad92cb';
export function assertIndBgdSeam(next,previous,{prefixes,readEvidence}={}){
 if(typeof readEvidence!=='function')fail('pinned archive reader required');
 const {binding,frozen,rawReceipt}=registeredIndBgd;
 if(!equal(next?.geometryVersions?.find(v=>v.validTo===null)?.modernBoundarySupplement?.seamReview,binding.review))
  fail('only registered reviewed seam may be stored');
 const review=readEvidence(binding.review.reference);
 sameHash(hash(review),binding.review.sha256,'fixed registered review');
 const topologyRef=JSON.parse(review).topologyProof;
 const proof=readEvidence(topologyRef.reference);
 sameHash(hash(proof),topologyRef.sha256,'topology proof');
 const topology=JSON.parse(proof);
 if(topology.candidateDE9IM!=='FF2F11212'||topology.candidateOverlapSqkm!==0||topology.oldCombinedCoverageLossSqkm!==0||
     topology.allNonselectedComponentCoordinatesIdentical!==true||!Object.values(topology.otherPeers).every(p=>p.contactsIdentical===true&&p.exactLocalIntersectionsEqual===true))
  fail('approved no-overlap no-loss topology proof required');
 const rawBytes=readEvidence(rawReceipt);
 sameHash(hash(rawBytes),originalReceiptSha,'fixed raw India source receipt');
 const raw=JSON.parse(rawBytes);
 if(raw.featureId!=='d1fab3b1-73a8-4492-8513-6ef4298a134c'||raw.rawWkbSha256!==topology.officialIndia.wkbSha256)
  fail('fixed raw India original required');
 const originalGeometry=decodeOriginalBlobGeometry(readChunkedOriginalBlob(raw,readEvidence),{expectedWkbSha256:raw.rawWkbSha256});
 const peers=new Map();
 for(const code of ['IND',...expectedPeers]){
  const b=readEvidence(sourceBase+'countries/state-'+code+'.json');sameHash(hash(b),frozen[code].descriptorSha256,code+' descriptor');
  const descriptor=JSON.parse(b), entity=decodeTerritorialSource(descriptor,p=>readEvidence(sourceBase+p));
  const current=entity.geometryVersions.filter(v=>v.validTo===null);
  if(current.length!==1||current[0].validFrom!==null)fail('fixed current version required for '+code);
  sameHash(digest(current[0].geometry),frozen[code].geometrySha256,code+' original pinned geometry');
  if(code==='IND'){
   if(!equal(entity,previous))fail('previous India must be actual pinned descriptor');
  }else peers.set(code,current[0].geometry);
 }
 return assertIndBgdSeamReplay(next,previous,{prefixes,readEvidence,binding,originalGeometry,peers,replayRetainedCoast,exactCyclicChain,sharedExactEdges});
}
