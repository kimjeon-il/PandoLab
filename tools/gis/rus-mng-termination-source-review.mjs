import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';

export const rusMngTerminationMethod='exact-original-rus-mng-terminal-chord';
export const rusMngTerminationRelation='partial-original-with-readonly-mongolia-terminal-chord';
const id='state:RUS', versionId='state:RUS:natural-earth-5.1.1';
const priorMethod='retained-current-original-common-seam';
const currentStart='2014-03-18';
const status='raw-source-only-not-display-approved';
const sourceBase='assets/data/territorial-entities/source/';
const reportBase='reports/borders/validation/modern-raw-source-20261110/';
const expectedPeers=Object.freeze(['CHN','MNG']);
const digest=g=>hash(JSON.stringify([g.type,g.coordinates]));
const hash=b=>createHash('sha256').update(b).digest('hex');
const sha64=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=message=>{throw Error('RUS/MNG exact terminal chord: '+message);};
const polys=g=>g?.type==='Polygon'?[g.coordinates]:g?.type==='MultiPolygon'?g.coordinates:fail('polygon preimage required');
const eqXY=(a,b)=>a[0]===b[0]&&a[1]===b[1];
const sameKeys=(o,keys)=>o&&typeof o==='object'&&equal(Object.keys(o).sort(),[...keys].sort());
function sameHash(actual,expected,label){if(!sha64(expected)||actual!==expected)fail(label+' digest mismatch');}
const editableFields=new Set(['geometry','modernBoundarySupplement']);
const sourceDigestFields=new Set(['geometrySha256','geometryVersionId']);
export const hasRusMngTermination=e=>e?.geometryVersions?.some(v=>v.modernBoundarySupplement?.adoptionMode===rusMngTerminationMethod)===true;

function preserveEntity(entity){
 const filter=(v,fieldSet)=>Object.fromEntries(Object.entries(v||{}).filter(([k])=>!fieldSet.has(k)));
 return {...entity,sourceInfo:filter(entity.sourceInfo,sourceDigestFields),
  geometryVersions:entity.geometryVersions.map(v=>v.versionId===versionId?filter(v,editableFields):v)};
}

/** Pure second-stage admission. The caller pins the immutable expected review
 * receipt, reads the exact raw MNG original from archived WKB, and reads all
 * peers from the same Git pin. The separate reviewed GEOS locality/overlap proof
 * is a prerequisite to registering the exact receipt, not a claim proved here.
 * This function only supports one exact indexed terminal chord, preserving a
 * preexisting China vertex at the explicitly reviewed endpoint.
 */
export function assertRusMngTerminationReplay(next,previous,{prefixes,readEvidence,binding,originalGeometry,peers,
 replayRetainedCoast,exactCyclicChain}={}){
 if(next?.entityId!==id||previous?.entityId!==id||!Array.isArray(next.geometryVersions)||!Array.isArray(previous.geometryVersions))
  fail('one existing Russia source required');
 if(typeof readEvidence!=='function'||typeof replayRetainedCoast!=='function'||typeof exactCyclicChain!=='function')
  fail('canonical reader and arc replay required');
 const nr=next.geometryVersions.filter(v=>v.validTo===null),pr=previous.geometryVersions.filter(v=>v.validTo===null);
 if(nr.length!==1||pr.length!==1||nr[0].versionId!==versionId||pr[0].versionId!==versionId||
   nr[0].validFrom!==currentStart||pr[0].validFrom!==currentStart||next.metadata?.representativeGeometryVersionId!==versionId||
   previous.metadata?.representativeGeometryVersionId!==versionId||!equal(preserveEntity(next),preserveEntity(previous)))
  fail('dates, selected version, identity, source attributes, and unselected geometry must remain exact');
 const v=nr[0],old=pr[0],s=v.modernBoundarySupplement;
 if(!sameKeys(s,['adoptionMode','status','resultRelation','wholeCountryRaw','priorPreparedAttribution','geometrySha256','seamReview'])||
   old.modernBoundarySupplement?.adoptionMode!==priorMethod||!equal(s.priorPreparedAttribution,old.modernBoundarySupplement)||
   s.adoptionMode!==rusMngTerminationMethod||s.status!==status||s.resultRelation!==rusMngTerminationRelation||s.wholeCountryRaw!==false)
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
 if(r.schemaVersion!==1||r.method!==rusMngTerminationMethod||r.status!==status||r.entityId!==id||r.versionId!==versionId||
   r.validFrom!==currentStart||r.validTo!==null||r.sourcePin!==binding.sourcePin)
  fail('review identity and pinned source version required');
 sameHash(digest(old.geometry),r.previousGeometrySha256,'old RUS');
 sameHash(digest(v.geometry),r.geometrySha256,'new RUS');
 sameHash(digest(originalGeometry),r.originalGeometrySha256,'official raw MNG');
 const resourceHash=hash(JSON.stringify(v.geometry)+'\n');
 sameHash(resourceHash,r.geometryResourceSha256,'new RUS CAS');
 if(s.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometryVersionId!==versionId)
  fail('current attribution digest mismatch');
 const scope=[sourceBase+'countries/state-RUS.json',sourceBase+'geometries/sha256-'+resourceHash+'.json'];
 if(!Array.isArray(prefixes)||!equal([...prefixes].sort(),scope.sort()))fail('only exact RUS descriptor and new CAS may be written');
 if(!(peers instanceof Map)||!equal([...peers.keys()].sort(),expectedPeers)||!sameKeys(r.peerGeometrySha256,expectedPeers))
  fail('all fixed current peer geometries must be read');
 for(const code of expectedPeers)sameHash(digest(peers.get(code)),r.peerGeometrySha256[code],code+' read-only preimage');
 if(!binding.operation||!binding.ringStart||!binding.mngArc||!equal(r.operations,[binding.operation])||
   !equal(r.ringStarts,[binding.ringStart])||!equal(r.mngArc,binding.mngArc)||
   !equal(r.chnTerminal,binding.chnTerminal)||r.vertexCount!==binding.vertexCount)
  fail('one exact registered mainland and reciprocal arc required');
 const op=r.operations[0], counterpart=r.mngArc, terminal=r.chnTerminal;
 if(op.ringIndex!==0||op.raw?.ringIndex!==0||counterpart.ringIndex!==0||op.endIndex-op.startIndex!==1||
   !sameKeys(terminal,['endpoint','polygonIndex','ringIndex','vertexIndex'])||!['start','end'].includes(terminal.endpoint)||
   terminal.ringIndex!==0||![terminal.polygonIndex,terminal.vertexIndex,binding.vertexCount].every(Number.isSafeInteger))
  fail('one exterior chord and a frozen China endpoint required');
 if(!equal(replayRetainedCoast(old.geometry,originalGeometry,r.operations,r.ringStarts),v.geometry))
  fail('candidate must equal exact replay, including all other rings and components');
 const rawRing=polys(originalGeometry)[op.raw.polygonIndex][0];
 const arc=exactCyclicChain(rawRing,op.raw.startIndex,op.raw.endIndex,op.raw.direction);
 if(arc.length!==binding.vertexCount||arc.length<=2)fail('exact terminal vertex inventory required');
 if(arc.slice(1).some((p,i)=>eqXY(p,arc[i])))fail('zero-length boundary edge');
 const counterpartGeometry=peers.get('MNG');
 if(!equal(originalGeometry,counterpartGeometry))fail('frozen Mongolia polygon must be the exact official raw geometry');
 const peerRing=polys(counterpartGeometry)[counterpart.polygonIndex]?.[counterpart.ringIndex];
 const reciprocal=exactCyclicChain(peerRing,counterpart.startIndex,counterpart.endIndex,counterpart.direction);
 if(!equal(reciprocal,arc))fail('new seam does not match exact reciprocal frozen Mongolian arc');
 const chinaVertex=polys(peers.get('CHN'))[terminal.polygonIndex]?.[terminal.ringIndex]?.[terminal.vertexIndex];
 const sharedEnd=terminal.endpoint==='start'?arc[0]:arc.at(-1);
 if(!chinaVertex||!eqXY(chinaVertex,sharedEnd))fail('reviewed endpoint is not an exact frozen China vertex');
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


const registeredRusMngTerminal = Object.freeze({"binding":{"sourcePin":"8dbf91890c51bd2a1eb31d685600e1b3d0786b75","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/rus-mng-terminal-junction-20261114/review.json","sha256":"b7a6a731ad898067477300e99a804ffd3280b5892045234cc3df28816065048b"},"operation":{"polygonIndex":3289,"ringIndex":0,"startIndex":55526,"endIndex":55527,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":0,"endIndex":36491,"direction":-1}},"ringStart":{"polygonIndex":3289,"ringIndex":0,"startIndex":0},"mngArc":{"polygonIndex":0,"ringIndex":0,"startIndex":0,"endIndex":36491,"direction":-1},"vertexCount":13,"chnTerminal":{"endpoint":"start","polygonIndex":0,"ringIndex":0,"vertexIndex":26204}},"frozen":{"RUS":{"descriptorSha256":"164076e1e23c027a01af649f9d9d67c3754456d77ab6497e973237664b9c63e8","geometrySha256":"9607237f7eaca4a130976c5d1d18f569b278980aa471d43c58d7970feb35abc3","resourceSha256":"50c4cfffb961813a6a2a155c022aaab1ffe5881a65aba51cd74131dffc04ef29"},"CHN":{"descriptorSha256":"00408992fa6256cb08fa13cf904a6005c7e8d6ebc2a7251dbb65e35c17850430","geometrySha256":"7fa30835644d8706e7768459cffe2f855c805043793543ac61ca7b7244a7442d","resourceSha256":"012e3e5575f07aeb61e6f32e9f7bf7803c0ee1c91e2e46e6bc7b9507029366de"},"MNG":{"descriptorSha256":"d7e67adde7c998fe4886811b432aabc08063dbfdef353bb29b94330dfdf71cc8","geometrySha256":"f77ec0aa475978894d8995da93c429579add7bb470cb8813af46ad3b8f698440","resourceSha256":"476459922561c7f96ae33b864421f506436d6eba925ef423b29a052ca27c806a"}},"rawReceipt":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-current-four-20261113/originals/MNG-original.json","resourcePath":"assets/data/territorial-entities/source/geometries/sha256-568d06adc74671c7083dae27b77cb080bf52174177bb9c7da5018d9ff30adb8e.json","descriptorPath":"assets/data/territorial-entities/source/countries/state-RUS.json"});
const originalMongoliaReceiptSha='8e55db9cbc7f4bf451bc0f7842c72af39f0fca7f289655fb1b682317e67465bd';
export function assertRusMngTermination(next,previous,{prefixes,readEvidence}={}){
 if(typeof readEvidence!=='function')fail('pinned archive reader required');
 const {binding,frozen,rawReceipt}=registeredRusMngTerminal;
 if(!equal(next?.geometryVersions?.find(v=>v.validTo===null)?.modernBoundarySupplement?.seamReview,binding.review))
  fail('only registered terminal seam may be stored');
 const review=readEvidence(binding.review.reference);
 sameHash(hash(review),binding.review.sha256,'fixed registered review');
 const rec=JSON.parse(review), topologyRef=rec.topologyProof, proof=readEvidence(topologyRef.reference);
 sameHash(hash(proof),topologyRef.sha256,'topology proof');
 const topology=JSON.parse(proof);
 if(topology.pin!==binding.sourcePin||topology.newOverlapDE9IM!=='FF2F11212'||topology.newOverlapM2!==0||
     topology.oldSourceLandCoverageLossM2!==0||topology.localAfterRUSCHNOverlapM2!==0||
     topology.allOtherRingsUnchanged!==true||topology.allOtherComponentsUnchanged!==6842||
     topology.oldAndNewBoundariesAsExactPointsetsWithCHNEqual!==true||
     topology.oldAndNewIntersectionsAsExactPointsetsWithCHNEqual!==true||
     topology.candidateCanonicalCAS!==rec.geometryResourceSha256)
  fail('approved exact-zero overlap, coverage, and fixed China topology required');
 const rawBytes=readEvidence(rawReceipt);
 sameHash(hash(rawBytes),originalMongoliaReceiptSha,'fixed raw Mongolia source receipt');
 const raw=JSON.parse(rawBytes);
 if(raw.featureId!=='155de18e-f167-4ad2-b383-1fb75b14a100'||raw.rawWkbSha256!==topology.mngRawWkb)
  fail('fixed raw Mongolia original required');
 const blob=Buffer.from(raw.rawBlobBase64,'base64');
 sameHash(hash(blob),raw.rawBlobSha256,'raw Mongolia blob');
 const originalGeometry=decodeOriginalBlobGeometry(blob,{expectedWkbSha256:raw.rawWkbSha256});
 const peers=new Map();
 for(const code of ['RUS','CHN','MNG']){
  const b=readEvidence(sourceBase+'countries/state-'+code+'.json');sameHash(hash(b),frozen[code].descriptorSha256,code+' descriptor');
  const descriptor=JSON.parse(b), entity=decodeTerritorialSource(descriptor,p=>readEvidence(sourceBase+p));
  const current=entity.geometryVersions.filter(v=>v.validTo===null);
  if(current.length!==1)fail('fixed current version required for '+code);
  sameHash(digest(current[0].geometry),frozen[code].geometrySha256,code+' pinned geometry');
  if(code==='RUS'){
   if(!equal(entity,previous))fail('previous Russia must be actual pinned descriptor');
  }else peers.set(code,current[0].geometry);
 }
 return assertRusMngTerminationReplay(next,previous,{prefixes,readEvidence,binding,originalGeometry,peers,replayRetainedCoast,exactCyclicChain});
}
