import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';

export const chnMngSeamMethod='exact-original-chn-mng-readonly-counterpart-seam';
export const chnMngSeamRelation='partial-original-with-readonly-mongolia-seam';
const id='state:CHN', versionId='state:CHN:paektu-lsib-11.4';
const priorMethod='lossless-original-shared-arc';
const status='raw-source-only-not-display-approved';
const sourceBase='assets/data/territorial-entities/source/';
const reportBase='reports/borders/validation/modern-raw-source-20261110/';
const expectedPeers=Object.freeze(['AFG','BTN','IND','KAS','KAZ','KOR','LAO','MMR','MNG','NPL','PAK','PRK','RUS','TWN','VNM']);
const digest=g=>hash(JSON.stringify([g.type,g.coordinates]));
const hash=b=>createHash('sha256').update(b).digest('hex');
const sha64=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=message=>{throw Error('CHN/MNG exact current seam: '+message);};
const polys=g=>g?.type==='Polygon'?[g.coordinates]:g?.type==='MultiPolygon'?g.coordinates:fail('polygon preimage required');
const eqXY=(a,b)=>a[0]===b[0]&&a[1]===b[1];
const sameKeys=(o,keys)=>o&&typeof o==='object'&&equal(Object.keys(o).sort(),[...keys].sort());
function sameHash(actual,expected,label){if(!sha64(expected)||actual!==expected)fail(label+' digest mismatch');}
const editableFields=new Set(['geometry','modernBoundarySupplement']);
const sourceDigestFields=new Set(['geometrySha256','geometryVersionId']);
export const hasChnMngSeam=e=>e?.geometryVersions?.some(v=>v.modernBoundarySupplement?.adoptionMode===chnMngSeamMethod)===true;

function preserveEntity(entity){
 const filter=(v,fieldSet)=>Object.fromEntries(Object.entries(v||{}).filter(([k])=>!fieldSet.has(k)));
 return {...entity,sourceInfo:filter(entity.sourceInfo,sourceDigestFields),
  geometryVersions:entity.geometryVersions.map(v=>v.versionId===versionId?filter(v,editableFields):v)};
}

/** Pure second-stage admission. The caller pins the immutable expected review
 * receipt, reads the exact raw MNG original from archived WKB, and reads all
 * peers from the same Git pin. The separate reviewed GEOS locality/overlap proof
 * is a prerequisite to registering the exact receipt, not a claim proved here.
 * This function only supports one anchored mainland exterior replacement.
 */
export function assertChnMngSeamReplay(next,previous,{prefixes,readEvidence,binding,originalGeometry,peers,
 replayRetainedCoast,exactCyclicChain}={}){
 if(next?.entityId!==id||previous?.entityId!==id||!Array.isArray(next.geometryVersions)||!Array.isArray(previous.geometryVersions))
  fail('one existing China source required');
 if(typeof readEvidence!=='function'||typeof replayRetainedCoast!=='function'||typeof exactCyclicChain!=='function')
  fail('canonical reader and arc replay required');
 const nr=next.geometryVersions.filter(v=>v.validTo===null),pr=previous.geometryVersions.filter(v=>v.validTo===null);
 if(nr.length!==1||pr.length!==1||nr[0].versionId!==versionId||pr[0].versionId!==versionId||
   nr[0].validFrom!==null||pr[0].validFrom!==null||next.metadata?.representativeGeometryVersionId!==versionId||
   previous.metadata?.representativeGeometryVersionId!==versionId||!equal(preserveEntity(next),preserveEntity(previous)))
  fail('dates, selected version, identity, source attributes, and unselected geometry must remain exact');
 const v=nr[0],old=pr[0],s=v.modernBoundarySupplement;
 if(!sameKeys(s,['adoptionMode','status','resultRelation','wholeCountryRaw','priorPreparedAttribution','geometrySha256','seamReview'])||
   old.modernBoundarySupplement?.adoptionMode!==priorMethod||!equal(s.priorPreparedAttribution,old.modernBoundarySupplement)||
   s.adoptionMode!==chnMngSeamMethod||s.status!==status||s.resultRelation!==chnMngSeamRelation||s.wholeCountryRaw!==false)
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
 if(r.schemaVersion!==1||r.method!==chnMngSeamMethod||r.status!==status||r.entityId!==id||r.versionId!==versionId||
   r.validFrom!==null||r.validTo!==null||r.sourcePin!==binding.sourcePin)
  fail('review identity and pinned source version required');
 sameHash(digest(old.geometry),r.previousGeometrySha256,'old CHN');
 sameHash(digest(v.geometry),r.geometrySha256,'new CHN');
 sameHash(digest(originalGeometry),r.originalGeometrySha256,'official raw MNG');
 const resourceHash=hash(JSON.stringify(v.geometry)+'\n');
 sameHash(resourceHash,r.geometryResourceSha256,'new CHN CAS');
 if(s.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometryVersionId!==versionId)
  fail('current attribution digest mismatch');
 const scope=[sourceBase+'countries/state-CHN.json',sourceBase+'geometries/sha256-'+resourceHash+'.json'];
 if(!Array.isArray(prefixes)||!equal([...prefixes].sort(),scope.sort()))fail('only exact CHN descriptor and new CAS may be written');
 if(!(peers instanceof Map)||!equal([...peers.keys()].sort(),expectedPeers)||!sameKeys(r.peerGeometrySha256,expectedPeers))
  fail('all fixed current peer geometries must be read');
 for(const code of expectedPeers)sameHash(digest(peers.get(code)),r.peerGeometrySha256[code],code+' read-only preimage');
 if(!binding.operation||!binding.ringStart||!binding.mngArc||!equal(r.operations,[binding.operation])||
   !equal(r.ringStarts,[binding.ringStart])||!equal(r.mngArc,binding.mngArc))
  fail('one exact registered mainland and reciprocal arc required');
 const op=r.operations[0], counterpart=r.mngArc;
 if(op.ringIndex!==0||op.raw?.ringIndex!==0||counterpart.ringIndex!==0)
  fail('mainland exterior slots only');
 if(!equal(replayRetainedCoast(old.geometry,originalGeometry,r.operations,r.ringStarts),v.geometry))
  fail('candidate must equal exact replay, including all other rings and components');
 const rawRing=polys(originalGeometry)[op.raw.polygonIndex][0];
 const arc=exactCyclicChain(rawRing,op.raw.startIndex,op.raw.endIndex,op.raw.direction);
 if(arc.slice(1).some((p,i)=>eqXY(p,arc[i])))fail('zero-length boundary edge');
 const counterpartGeometry=peers.get('MNG');
 if(!equal(originalGeometry,counterpartGeometry))fail('frozen Mongolia polygon must be the exact official raw geometry');
 const peerRing=polys(counterpartGeometry)[counterpart.polygonIndex]?.[counterpart.ringIndex];
 const reciprocal=exactCyclicChain(peerRing,counterpart.startIndex,counterpart.endIndex,counterpart.direction);
 if(!equal(reciprocal,arc))fail('new seam does not match exact reciprocal frozen Mongolian arc');
 const beforeRing=polys(old.geometry)[op.polygonIndex][0];
 const beforeArc=exactCyclicChain(beforeRing,op.startIndex,op.endIndex,1);
 const edge=(a,b)=>{const x=JSON.stringify(a),y=JSON.stringify(b);return x<y?x+'|'+y:y+'|'+x;};
 const keys=points=>new Set(points.slice(1).map((p,i)=>edge(points[i],p)));
 const oldEdges=keys(beforeArc),newEdges=keys(arc);
 const changed=new Set([...oldEdges].filter(e=>!newEdges.has(e)).concat([...newEdges].filter(e=>!oldEdges.has(e))));
 if(!changed.size)fail('no boundary edge change proved');
 for(const code of expectedPeers.filter(c=>c!=='MNG')){
  for(const poly of polys(peers.get(code)))for(const ring of poly)for(let i=1;i<ring.length;i++)
   if(changed.has(edge(ring[i-1],ring[i])))fail('protected shared edges changed for '+code);
 }
 return 1;
}


const registeredChnMng = Object.freeze({"binding":{"sourcePin":"b54ae76c2c26f0a0cc3e485a3c1e2b7b68bb442a","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/chn-mng-shared-frontier-20261114/review.json","sha256":"35d1c8083fc7367f7b67d5f0ab12a14702eac2a17cbd5ee1b0c5af444a0b1848"},"operation":{"polygonIndex":0,"ringIndex":0,"startIndex":4095,"endIndex":5259,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":22109,"endIndex":0,"direction":-1}},"ringStart":{"polygonIndex":0,"ringIndex":0,"startIndex":0},"mngArc":{"polygonIndex":0,"ringIndex":0,"startIndex":22109,"endIndex":0,"direction":-1}},"frozen":{"CHN":{"descriptorSha256":"a7b93e8c2d55937c4d72c855c5d57f8736f8cb14002faadb09627c9282dc89e6","geometrySha256":"b7dc0fa34814e861cfd9747cc3dfa54fa13b44015324415ad58f69dd62b93192","resourceSha256":"bdb896baa43229e2c6d29c678132a1c7c1f15810a56b1370b9c980ad50683b50"},"AFG":{"descriptorSha256":"92aa6ff9d72fab84205d41794645c385025574e2938fe79165e70dad56612673","geometrySha256":"52095d69a0e57368089d4a916ed94fa67aa72a525bb1079c9bf3e4b0132c9db5","resourceSha256":"9e8169d42915b2a2a756e6372b7e066f52b66b46c535378457eca5890f2a70ec"},"BTN":{"descriptorSha256":"bbb89f515afee505080cbd02204ca07c44d948c0f563a0a157cd44e7ac2c7a48","geometrySha256":"fada38b3d5d583854e155739d693e5462dae5836c9ccf50e0a720de30754f60a","resourceSha256":"4c597a25fae08e17fe02846b21e7916168e011983fc7b92bf9a1bf7799d8ce96"},"IND":{"descriptorSha256":"17ffd0ffc1ab0717c9677efb7e16ecadc0efde16371941c43c4ad42f4b307e3c","geometrySha256":"3726c0bf09bc4a7116ce718e91cf008623cac175b8c9924c849c355995777e43","resourceSha256":"2b1733eae965d2a3cbd9cb6ff209c734bfe6c3b8ff726c3d844ab2055131416a"},"KAS":{"descriptorSha256":"cc54544e2cc74babe45b43dda8acea7ddbde4dfeba5412d5aa67e16cfacf1cb8","geometrySha256":"00238ed92de0e11a41b39f9e0d89e0310a01b9a3ee35bcc29f10667420b4f21d","resourceSha256":"0e7cf134851fec4bbdbc91763e16840e88f7bd958580bff68b52a52b7a15027a"},"KAZ":{"descriptorSha256":"466f8a4aedc6271c0a9db3c2fa1ee4244aeda1bad30101149ededce0faf21962","geometrySha256":"0d4cdc27fcd2a78145ec4aff1c35bc1b999b04000d2c61864a0b26c8f3aeed70","resourceSha256":"47de235c3a3e07fa5fa40d7ba0805a5ddbe757d5857534439c37903aa0db46ae"},"KOR":{"descriptorSha256":"9fdde05f8b755c6e7b5278fbd7b5052124fe883d3ff6c443b20164988682df9d","geometrySha256":"b58b8033be3daa4a12c7a470498a683b145f3bd857676db5bb0aba672eb527f8","resourceSha256":"7b19986b6584cb08e92ce9e7777f75de1b10475898ebd661dcc3f21637446c94"},"LAO":{"descriptorSha256":"7ffef29ea030e1e9c8b3f30fbfa3dd08a58eaa380b815886567005dfe8490d86","geometrySha256":"761a845ae4479ba70711e418ccafc8fc6399c2c966821d9792d7b0bfc40718cf","resourceSha256":"5a6eff454092694a9b5c1675b97a238ba41a8462c64085cf03ff1b7291f93003"},"MMR":{"descriptorSha256":"848d45edd780e5b9be9e5ce2dc8a1309d2defec5d003c66d590d0fd21dcf9d93","geometrySha256":"776fa77249f38f397f9b40c4e80acd883d3851013ae59d944d59c192d78bfb67","resourceSha256":"f04681da37aafd08d30cf189055cb849be366402443da930a4ce2f216a76ac79"},"MNG":{"descriptorSha256":"d7e67adde7c998fe4886811b432aabc08063dbfdef353bb29b94330dfdf71cc8","geometrySha256":"f77ec0aa475978894d8995da93c429579add7bb470cb8813af46ad3b8f698440","resourceSha256":"476459922561c7f96ae33b864421f506436d6eba925ef423b29a052ca27c806a"},"NPL":{"descriptorSha256":"99cf879f59c13f19746a9d6904c964d1c09dabe925345afe529bf7b51d420615","geometrySha256":"12b14b720d640e03d4fb4169e876f846d4611d2e1f852da74c28947820bea211","resourceSha256":"d7865d9b3349d9a212fbb81ad581ac402e30fd9dbc82210625acac352a0d69ce"},"PAK":{"descriptorSha256":"c607c7c30df1827466fc2a98af90ac2e50a0f3f798e14d679a53b25aa16e64ad","geometrySha256":"0cb8f5867a67a63b9789e7451ead75cf22f2acefe831914415f3fa8085f370b6","resourceSha256":"99e003b50ec1c6c024e45d5889fab022c51827fb19f2811a9ec2309d8e613086"},"PRK":{"descriptorSha256":"0f2a33b509862413a607fed53df2bf628272dc302abe0b381b422e2195d7ad29","geometrySha256":"7477c2eddf1fd8f900973c0d7956bc51ecbf67691d7191f2ff3891f2f930b5b2","resourceSha256":"c7c8493d65399361ea6e1092d133ebf212c5a217d27b8c092fee5b6d3879a50c"},"RUS":{"descriptorSha256":"164076e1e23c027a01af649f9d9d67c3754456d77ab6497e973237664b9c63e8","geometrySha256":"9607237f7eaca4a130976c5d1d18f569b278980aa471d43c58d7970feb35abc3","resourceSha256":"50c4cfffb961813a6a2a155c022aaab1ffe5881a65aba51cd74131dffc04ef29"},"TWN":{"descriptorSha256":"c2d50f5e60596ed7712ba58cf9f128523ea59d51bac5ad9f7506252b3c3e55fa","geometrySha256":"05620c3ab6e3a16bb5525de31e716547489d69618996f6d01484b7f5a54f7405","resourceSha256":"c20159fe4dc86c5f3bb31a9899256795b6d91e869f084cd3c7fe1226d7f3c4aa"},"VNM":{"descriptorSha256":"d2162fe0a0f986ad2b138448b8b52fcf7820a80da7385078623d794b952bf39a","geometrySha256":"95bb44b6f0db104c3588b262b9e7efb4a2763e0f6b02f60c3da318671b1a1599","resourceSha256":"557d72ea749c4696230857283afca8a4903b4005722d69a599ae89de4c1c251b"}},"rawReceipt":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-current-four-20261113/originals/MNG-original.json","resourcePath":"assets/data/territorial-entities/source/geometries/sha256-012e3e5575f07aeb61e6f32e9f7bf7803c0ee1c91e2e46e6bc7b9507029366de.json","descriptorPath":"assets/data/territorial-entities/source/countries/state-CHN.json"});
const originalReceiptSha='8e55db9cbc7f4bf451bc0f7842c72af39f0fca7f289655fb1b682317e67465bd';
export function assertChnMngSeam(next,previous,{prefixes,readEvidence}={}){
 if(typeof readEvidence!=='function')fail('pinned archive reader required');
 const {binding,frozen,rawReceipt}=registeredChnMng;
 if(!equal(next?.geometryVersions?.find(v=>v.validTo===null)?.modernBoundarySupplement?.seamReview,binding.review))
  fail('only registered reviewed seam may be stored');
 const review=readEvidence(binding.review.reference);
 sameHash(hash(review),binding.review.sha256,'fixed registered review');
 const rec=JSON.parse(review);
 const exactProof=ref=>{const b=readEvidence(ref.reference);sameHash(hash(b),ref.sha256,'topology/peer proof');return JSON.parse(b);};
 const topology=exactProof(rec.topologyProof), latest=exactProof(rec.latestPeerProof);
 if(topology.newRelation!=='FF2F11212'||topology.newOverlapKm2!==0||topology.oldCoverageLossKm2!==0||
     topology.allExistingHolesUnchanged!==true||topology.allNewArcEdgesExactPinnedMongolianCounterpart!==true||
     latest.latestReadback!==binding.sourcePin||latest.repairedRussiaCheck?.exactIntersectionBeforeAfterEqual!==true||
     latest.repairedRussiaCheck?.exactBoundaryIntersectionsEqual!==true||latest.repairedRussiaCheck?.candidateDeltaTouchAreaKm2!==0)
  fail('approved no-overlap no-loss topology and latest Russian readback required');
 const rawBytes=readEvidence(rawReceipt);
 sameHash(hash(rawBytes),originalReceiptSha,'fixed raw Mongolia source receipt');
 const raw=JSON.parse(rawBytes);
 if(raw.featureId!=='155de18e-f167-4ad2-b383-1fb75b14a100'||raw.rawWkbSha256!==latest.MongoliaExactSharedDonor?.originalWkbSha256)
  fail('fixed raw Mongolia original required');
 const blob=Buffer.from(raw.rawBlobBase64,'base64');
 sameHash(hash(blob),raw.rawBlobSha256,'raw Mongolia blob');
 const originalGeometry=decodeOriginalBlobGeometry(blob,{expectedWkbSha256:raw.rawWkbSha256});
 const peers=new Map();
 for(const code of ['CHN',...expectedPeers]){
  const b=readEvidence(sourceBase+'countries/state-'+code+'.json');sameHash(hash(b),frozen[code].descriptorSha256,code+' descriptor');
  const descriptor=JSON.parse(b), entity=decodeTerritorialSource(descriptor,p=>readEvidence(sourceBase+p));
  const current=entity.geometryVersions.filter(v=>v.validTo===null);
  if(current.length!==1)fail('fixed current version required for '+code);
  sameHash(digest(current[0].geometry),frozen[code].geometrySha256,code+' original pinned geometry');
  if(code==='CHN'){
   if(!equal(entity,previous))fail('previous China must be actual pinned descriptor');
  }else peers.set(code,current[0].geometry);
 }
 return assertChnMngSeamReplay(next,previous,{prefixes,readEvidence,binding,originalGeometry,peers,replayRetainedCoast,exactCyclicChain});
}
