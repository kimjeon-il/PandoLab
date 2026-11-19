import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';

export const rusBlrSeamMethod='exact-original-rus-blr-readonly-counterpart-seam';
const id='state:RUS', version='state:RUS:natural-earth-5.1.1';
const date='2014-03-18';
const status='raw-source-only-not-display-approved';
const base='assets/data/territorial-entities/source/';
const prior='exact-original-rus-mng-terminal-chord';
const hash=b=>createHash('sha256').update(b).digest('hex');
const domain=g=>hash(JSON.stringify([g.type,g.coordinates]));
const fail=message=>{throw Error('RUS/BLR exact current seam: '+message);};
const keys=(o,names)=>o&&eq(Object.keys(o).sort(),[...names].sort());
const omit=(o,...names)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!names.includes(k)));
const active=e=>e.geometryVersions.filter(x=>x.validTo===null);
const preserved=e=>({...e,sourceInfo:omit(e.sourceInfo,'geometrySha256','geometryVersionId'),
 geometryVersions:e.geometryVersions.map(x=>x.versionId===version?omit(x,'geometry','modernBoundarySupplement'):x)});
const dig=(a,b,label)=>{if(a!==b)fail(label+' digest mismatch');};
const bytes=(read,p,h)=>{const x=read(p);if(!Buffer.isBuffer(x))fail(p+' exact archived bytes required');dig(hash(x),h,p);return x;};
export const hasRusBlrSeam=e=>e?.entityId===id&&e?.geometryVersions?.some(x=>x.validTo===null&&x.modernBoundarySupplement?.adoptionMode===rusBlrSeamMethod)===true;

export function replayRusBlrJoint(previous,donor,op,ringStart,enclave){
 if(previous?.type!=='MultiPolygon'||donor?.type!=='MultiPolygon'||op.polygonIndex===enclave.polygonIndex||op.ringIndex!==0||
  enclave.ringIndex!==0||enclave.donorRingIndex<1||(enclave.donorDirection!==1&&enclave.donorDirection!==-1))fail('separate registered mainland and existing enclave required');
 const old=previous.coordinates[enclave.polygonIndex],source=donor.coordinates[enclave.donorPolygonIndex]?.[enclave.donorRingIndex];
 if(old?.length!==1||old[0]?.length!==enclave.previousClosedCount||!eq(old[0][0],old[0].at(-1))||
  source?.length!==enclave.newClosedCount||!eq(source[0],source.at(-1))||!Number.isInteger(enclave.donorStartIndex)||
  enclave.donorStartIndex<0||enclave.donorStartIndex>=source.length-1)fail('exact enclave preimage and whole donor hole required');
 const n=source.length-1,start=enclave.donorStartIndex,dir=enclave.donorDirection;
 const next=Array.from({length:n},(_,i)=>source[(start+dir*i+n)%n]);
 if(new Set(next.map(x=>JSON.stringify(x))).size!==n)fail('unique complete enclave donor ring required');
 const main=replayRetainedCoast(previous,donor,[op],[ringStart]);
 const changed=main.coordinates.slice();
 changed[enclave.polygonIndex]=[[...next,next[0]]];
 return {...main,coordinates:changed};
}

export function assertRusBlrTopology(p,b,peers){
 const {openRingVertexCount,...blrArc}=p.BLRDonor??{};
 if(p.pin!==b.sourcePin||p.newPairDE9IM!=='FF2F11212'||p.newOverlapKm2!==0||p.newPositiveOverlapPolygonCount!==0||
  p.oldCoverageLossKm2!==0||p.oldCoverageLossPolygonCount!==0||p.allArcEdgesExactReciprocal!==true||
  p.RUSOriginal?.wkbSha256!==b.originalRUSWkb||!eq(p.operations,b.topologyOperations)||!eq(p.ringStarts,[b.ringStart])||!eq(blrArc,b.blrArc)||
  !keys(p.otherPeers,peers)||peers.some(c=>{const v=p.otherPeers[c];return v?.exactPrePostIntersectionEqual!==true||
   v.exactPrePostBoundaryShareEqual!==true||v.changeAreaKm2!==0;}))fail('reviewed zero-overlap no-loss topology and unchanged peers required');
 return true;
}

export function assertRusBlrSeam(next,previous,{prefixes,readEvidence}={}){
 const {binding,frozen,raw,descriptorPath,resourcePath}=registeredRusBlr;
 if(typeof readEvidence!=='function'||!hasRusBlrSeam(next)||previous?.entityId!==id)fail('pinned RUS archive reader and entity required');
 const nv=active(next),pv=active(previous),v=nv[0],old=pv[0],s=v?.modernBoundarySupplement;
 if(nv.length!==1||pv.length!==1||v.versionId!==version||old.versionId!==version||v.validFrom!==date||old.validFrom!==date||
  next.metadata?.representativeGeometryVersionId!==version||!eq(preserved(next),preserved(previous)))
  fail('dates, selected version, attribution, and unselected geometry must remain exact');
 if(!keys(s,['adoptionMode','status','resultRelation','wholeCountryRaw','priorPreparedAttribution','geometrySha256','seamReview'])||
  s.status!==status||s.resultRelation!=='partial-original-with-readonly-belarus-seam'||s.wholeCountryRaw!==false||
  old.modernBoundarySupplement?.adoptionMode!==prior||!eq(s.priorPreparedAttribution,old.modernBoundarySupplement)||
  !eq(s.seamReview,binding.review))fail('only registered partial source and prior attribution required');
 if(!Array.isArray(prefixes)||!eq([...prefixes].sort(),[descriptorPath,resourcePath].sort()))fail('only RUS descriptor and exact new geometry may be written');
 const r=JSON.parse(bytes(readEvidence,binding.review.reference,binding.review.sha256));
 if(r.schemaVersion!==1||r.sourcePin!==binding.sourcePin||r.method!==rusBlrSeamMethod||r.status!==status||r.entityId!==id||
  r.versionId!==version||r.validFrom!==date||r.validTo!==null||r.vertexCount!==binding.vertexCount||
  !eq(r.operation,binding.operation)||!eq(r.topologyOperations,binding.topologyOperations)||!eq(r.enclave,binding.enclave)||!eq(r.ringStart,binding.ringStart)||!eq(r.blrArc,binding.blrArc))fail('fixed source review fields required');
 dig(domain(old.geometry),r.previousGeometrySha256,'prior RUS geometry');
 dig(domain(v.geometry),r.geometrySha256,'new RUS geometry');
 dig(hash(JSON.stringify(v.geometry)+'\n'),r.geometryResourceSha256,'new RUS CAS');
 if(s.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometryVersionId!==version)
  fail('current source digest attribution must be correct');
 const proof=JSON.parse(bytes(readEvidence,r.topologyProof.reference,r.topologyProof.sha256));
 const peers=Object.keys(frozen).filter(c=>c!=='BLR'&&c!=='RUS');
 assertRusBlrTopology(proof,binding,peers);
 const originals={},current={};
 for(const c of ['BLR']){
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
 if(!eq(current.RUS,previous)||!eq(active(current.BLR)[0].geometry,originals.BLR))fail('pinned RUS and exact unchanged BLR required');
 const arc=(g,x)=>exactCyclicChain(g.coordinates[x.polygonIndex][x.ringIndex],x.startIndex,x.endIndex,x.direction);
 const op=binding.operation, points=arc(originals.BLR,op.raw);
 if(!eq(op.raw,binding.blrArc)||op.ringIndex!==0||op.raw.ringIndex!==0||binding.blrArc.ringIndex!==0||points.length!==binding.vertexCount||
  !eq(points,arc(originals.BLR,binding.blrArc))||points.slice(1).some((p,i)=>eq(p,points[i])))fail('one exact reciprocal LSIB exterior arc required');
 if(!eq(replayRusBlrJoint(old.geometry,originals.BLR,op,binding.ringStart,binding.enclave),v.geometry))
  fail('candidate must be exact replay with all other rings and polygons preserved');
 return 1;
}

const registeredRusBlr=Object.freeze({"binding":{"sourcePin":"4257b96429f534bc1e683e1f1df768c0f5fa4495","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/rus-blr-original-frontier-20261115/review.json","sha256":"1a31343b0e862923a93a1b2510f7d7df840bad08e668334b5f199357e03937e6"},"operation":{"polygonIndex":3289,"ringIndex":0,"startIndex":119365,"endIndex":120258,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":31943,"endIndex":9077,"direction":-1}},"topologyOperations":[{"polygonIndex":3289,"ringIndex":0,"startIndex":119365,"endIndex":120258,"raw":{"polygonIndex":14550,"ringIndex":0,"startIndex":2781463,"endIndex":2804329,"direction":1}},{"polygonIndex":0,"ringIndex":0,"previousClosedCount":8,"newClosedCount":61,"donorPolygonIndex":0,"donorRingIndex":1,"donorStartIndex":45,"donorDirection":-1,"first":[31.576369000000057,52.48198190000005],"raw":{"polygonIndex":485,"ringIndex":0,"startIndex":0,"direction":1,"openLength":60}}],"enclave":{"polygonIndex":0,"ringIndex":0,"previousClosedCount":8,"newClosedCount":61,"donorPolygonIndex":0,"donorRingIndex":1,"donorStartIndex":45,"donorDirection":-1,"first":[31.576369000000057,52.48198190000005],"raw":{"polygonIndex":485,"ringIndex":0,"startIndex":0,"direction":1,"openLength":60}},"ringStart":{"polygonIndex":3289,"ringIndex":0,"startIndex":0},"blrArc":{"polygonIndex":0,"ringIndex":0,"startIndex":31943,"endIndex":9077,"direction":-1},"vertexCount":22867,"originalRUSWkb":"707b022fc4049577b58685185b1c42fe0e27dbabdd50f1e2a64496ac4532004e"},"frozen":{"RUS":{"descriptorSha256":"79e94fab9f09f2728ae35763535d9e65e89950985545949410805a819b7a9229","geometrySha256":"54ff0b884412a38a6d15e8116a2e9160a4aef8f455bf00eb714b53917d3f951f","resourceSha256":"568d06adc74671c7083dae27b77cb080bf52174177bb9c7da5018d9ff30adb8e"},"BLR":{"descriptorSha256":"b428bfd7d801ec5d142d70ce8ae390c615cb48199f97eb95b15c60fa3bed12ab","geometrySha256":"b62c1f32988ed51f2768d617b361d3a8f010a2b6fff8c58d1a1a3ba422d0c7cf","resourceSha256":"e1bcd7c8c1ee79363d33698197984484e4e3a05372ae784f642ce7c01549cfbb"},"UKR":{"descriptorSha256":"28e0846374f3ee3d2213b0ad81d3279e5a128d42b6e3aafda1914d99ff42b36f","geometrySha256":"3e95abd26dbcbc47380eed99af5815f6e75bcf9c69b12bbf77e6e3d40b3f6786","resourceSha256":"ce7e601f044ec04ab9a6ef3a7339351d80cacf94bba6b1bc03540f2a6be80f10"},"LVA":{"descriptorSha256":"9ef8a6dba3a4c963f797b4b1bebc8262f68fe7c8c63e279147296a56761de45b","geometrySha256":"d331d69ce2bf3992146f50be6482d1688466c270f468d293c86b0c4442958a3b","resourceSha256":"20cf314ae2721811e5ea99fb3f3322da0118af60de6b60ecf3865b0e1e621b33"},"LTU":{"descriptorSha256":"57bc42f8824495a654e8f0fbf1b70c1c9c640256eac58a579973a47415d183e8","geometrySha256":"0104c51a2a483cd10b00fc324e0f8f73d23fb9dc36422b41a791f11f20c18fb8","resourceSha256":"8ae8b03af3ce3dac3567a273c88073b8eff5199cb4247ead3052da1bde8434a7"},"POL":{"descriptorSha256":"be1b06ae66b5463a123a2455fc17bdef6e863b80b3131196acf77f0439b4ff49","geometrySha256":"454329d6c9a654c4cc4bee1692bd19787ea27779608d9c3c79e00782065b45f0","resourceSha256":"ccdfef130607c3c858b4f3458a0775ca9b7f87b34cfa312f5f9b15e0897c271e"},"EST":{"descriptorSha256":"4af605358c4edcc2474e010bc7328a859b96b30626d47830a9e021ef052eb4ae","geometrySha256":"79eec602da2604460a2c5b21d2f9bda2a7d5a1ec92cfb1096ffb04143591baaf","resourceSha256":"be7b295f2b35ee0372fb17b77320103d25b9178a52ed221168af4306558ab5b9"}},"raw":{"BLR":{"path":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-post-soviet-current-20261113/originals/BLR-original.json","sha256":"8db320c0d6b8fb170ead04a3f0ffc3cde56f49b9cb3de7abcb1475c7e053327e","feature":"d794a6fa-0959-41a3-a22c-ed4dbe086730","wkb":"da56e090afcd5ba0e429a668e549527d281df3c58c1dafd222ccc5a8f178ad3d"}},"resourcePath":"assets/data/territorial-entities/source/geometries/sha256-f7e92b439ff7afd3fd504a27fc88cbb2e2059c63fe8ed15c4eeb2e633d24cb15.json","descriptorPath":"assets/data/territorial-entities/source/countries/state-RUS.json"});
