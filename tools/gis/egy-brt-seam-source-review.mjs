import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {exactCyclicChain,replayRetainedCoast} from './retained-coast-source-review.mjs';
import {egyLbySeamMethod,assertExactPreviousCoastPoints} from './egy-lby-seam-source-review.mjs';
const base='assets/data/territorial-entities/source/',id='state:EGY',version='state:EGY:natural-earth-5.1.1',rp='reports/borders/validation/modern-raw-source-20261110/';
const sha=b=>createHash('sha256').update(b).digest('hex'),domain=g=>sha(JSON.stringify([g.type,g.coordinates])),cas=g=>sha(JSON.stringify(g)+'\n');
const fail=m=>{throw Error('EGY/BRT exact current source: '+m)};
const read=(f,r)=>{const b=f(r.reference);if(!Buffer.isBuffer(b)||sha(b)!==r.sha256)fail('archive bytes differ: '+r.reference);return JSON.parse(b);};
const op={polygonIndex:0,ringIndex:0,startIndex:5197,endIndex:5198,raw:{polygonIndex:0,ringIndex:0,startIndex:16254,endIndex:16257,direction:1}}, origin={polygonIndex:0,ringIndex:0,startIndex:0};
const donor={polygonIndex:0,ringIndex:0,startIndex:3,endIndex:0,direction:-1};
const lbyCas='ac7e5f58b848bd69df58a7f104801a1b13edabb7ac033ccad0d789c3eefe709e';
const medCas='dd0bc41dce74554fa57f70baa7c42da174fb75ee4fa15773b85e34545112d682';
const oldLby={reference:rp+'egy-lby-original-frontier-20261115/review.json',sha256:'a941010071e042640acc2a4abb63d7749b82f9aaa076d3cce34d049ea4363795'};
const oldLbyTopo={reference:rp+'egy-lby-original-frontier-20261115/topology-proof.json',sha256:'684567ef50982ff4a75e5457a22f90c2a46b8226a88a09cab247580ec6d286f7'};
const medDir=rp+'egy-med-coast-20261114/';
const medReview={reference:medDir+'review.json',sha256:'a6f756c3ed17b8904e946709a0330c07de5719be73244c6d365493be691802d1'};
const medPolicy={reference:medDir+'policy.json',sha256:'fa5521dd41d5e339d252d2011ebccd5cf693c57b0b2d2f5041fc9b2c7ce2cc5e'};
const medPartition={reference:medDir+'partition-proof.json',sha256:'b500cfa2bc0579863052d691d74a219d316a8b7d96238780d04ba8da10584d97'};
const status='raw-source-only-not-display-approved',relation='partial-original-with-readonly-bir-tawil-seam';
export const egyBrtSeamMethod='exact-original-egy-brt-readonly-counterpart-seam';
export const hasEgyBrtSeam=e=>e?.entityId===id&&e.geometryVersions?.some(v=>v.validTo===null&&v.modernBoundarySupplement?.adoptionMode===egyBrtSeamMethod)===true;
const arc=(g,k)=>exactCyclicChain(g.coordinates[k.polygonIndex][k.ringIndex],k.startIndex,k.endIndex,k.direction);
export function assertBirTawilLocalProof(t){
 const coords=[[34.08062140000004,22.000008000000037],[33.17240820000006,22.000000100000022]], ps=t.protectedPeers;
 if(t.newOverlapKm2!==0||t.newPositiveArea!==0||t.newPairDE9IM!=='FF2F11212'||t.oldLandLossSqDegrees!==0||t.newLandGainSqDegrees!==0||t.allOtherPolygonsUnchanged!==74||
 t.archivedEgyptMedCoastArcsUnchanged!==300||t.archivedEgyptMedCoastPositionsUnchanged!==4330||t.archivedEgyptLibyaPositionsUnchanged!==1252||
 !eq(Object.keys(ps??{}).sort(),['HALAIB_NATIVE','ISR','JOR','LBY','PSX','SAU','SDN'])||Object.values(ps).some(x=>x.exactIntersectionAndSharedBoundaryUnchanged!==true)||
 !eq(ps.SDN.deltaContact,{type:'MultiPoint',coordinates:[coords[1],coords[0]]})||!eq(ps.HALAIB_NATIVE.deltaContact,{type:'Point',coordinates:coords[0]})||
 ['ISR','JOR','LBY','PSX','SAU'].some(c=>ps[c].deltaContact!==null))fail('fixed peer, point-only SDN and Halaib anchor topology required');
}
const omit=(o,...names)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!names.includes(k)));
const stable=e=>({...e,sourceInfo:omit(e.sourceInfo,'geometrySha256','geometryVersionId'),geometryVersions:e.geometryVersions.map(x=>x.versionId===version?omit(x,'geometry','modernBoundarySupplement'):x)});
function source(readEvidence,record,genc){
 const o=read(readEvidence,record),b=Buffer.from(o.rawBlobBase64,'base64');
 if(o.featureId!==record.feature||o.properties?.GENC_3!==genc||o.rawWkbSha256!==record.wkb||sha(b)!==o.rawBlobSha256||o.sourceFileReceipt?.gpkgSha256!=='55fab422ef09e35eb48d68141b9ece0ace86d4276dfe332a04dfd401c0bfc80c')fail('exact original coordinate-only evidence required');
 return decodeOriginalBlobGeometry(b,{expectedWkbSha256:record.wkb});
}
export function assertEgyBrtSeam(next,previous,{prefixes,readEvidence}={}){
 const {binding,frozen,originalEgy,originalBrt,retainedBrtReceipts,descriptorPath,resourcePath}=registration;
 if(typeof readEvidence!=='function'||!hasEgyBrtSeam(next)||previous?.entityId!==id||previous.geometryVersions.length!==1||next.geometryVersions.length!==1)fail('fixed current EGY source required');
 const old=previous.geometryVersions[0],v=next.geometryVersions[0],s=v.modernBoundarySupplement,oldS=old.modernBoundarySupplement;
 if(![old,v].every(x=>x.versionId===version&&x.validFrom===null&&x.validTo===null)||!eq(stable(previous),stable(next))||next.metadata?.representativeGeometryVersionId!==version)fail('date, identity, attribution or history changed');
 if(oldS?.adoptionMode!==egyLbySeamMethod||!eq(oldS.seamReview,oldLby)||!eq(oldS.priorPreparedAttribution?.retainedCoastReview,medReview)||cas(old.geometry)!==lbyCas)fail('exact earlier Libya overlap repair and Mediterranean approval preimage required');
 if(!eq(s,{adoptionMode:egyBrtSeamMethod,status,resultRelation:relation,wholeCountryRaw:false,priorPreparedAttribution:oldS,geometrySha256:domain(v.geometry),seamReview:binding.review})||next.sourceInfo?.geometryVersionId!==version||next.sourceInfo?.geometrySha256!==s.geometrySha256)fail('only fixed source-only addition permitted');
 if(!Array.isArray(prefixes)||!eq([...prefixes].sort(),[descriptorPath,resourcePath].sort()))fail('only Egypt coordinates and descriptor paths permitted');
 const r=read(readEvidence,binding.review),p=read(readEvidence,r.topologyProof);
 if(r.sourcePin!==binding.sourcePin||p.dataPin!==binding.sourcePin||r.method!==egyBrtSeamMethod||r.entityId!==id||r.versionId!==version||r.validFrom!==null||r.validTo!==null||r.previousGeometrySha256!==domain(old.geometry)||r.geometrySha256!==domain(v.geometry)||r.geometryResourceSha256!==cas(v.geometry)||!eq(r.operation,op))fail('exact staged policy, preimage and candidate CAS required');
 assertBirTawilLocalProof(p.topology);
 const native=source(readEvidence,originalEgy,'EGY'),brtOriginal=source(readEvidence,originalBrt,'QX2');
 for(const x of retainedBrtReceipts)read(readEvidence,x);
 const cur={};
 for(const [c,x] of Object.entries(frozen)){
  const d=read(readEvidence,{reference:base+'countries/state-'+c+'.json',sha256:x.descriptorSha256});
  const e=decodeTerritorialSource(d,k=>readEvidence(base+k)),vs=e.geometryVersions.filter(z=>z.validTo===null),q=vs[0];
  if(vs.length!==1||c!==e.entityId.slice(6)||!eq([q.versionId,q.validFrom,q.validTo,cas(q.geometry)],[x.versionId,x.validFrom,x.validTo,x.sha256]))fail('frozen peer date or geometry changed: '+c);
  cur[c]={e,q};
 }
 if(!eq(cur.EGY.e,previous)||!eq(cur.BRT.q.geometry,brtOriginal))fail('exact Egypt preimage and unchanged Bir Tawil territorial geometry required');
 const points=arc(native,op.raw);
 if(points.length!==4||!eq(points,arc(cur.BRT.q.geometry,donor))||!eq(points,arc(brtOriginal,donor))||!eq(points,p.operation.exactCoordinates)||!eq(replayRetainedCoast(old.geometry,native,[op],[origin]),v.geometry))fail('only existing exact native two-point insert and fixed BRT boundary are allowed');
 const mr=read(readEvidence,medReview),mp=read(readEvidence,medPartition);read(readEvidence,medPolicy);
 const lr=read(readEvidence,oldLby),lt=read(readEvidence,oldLbyTopo);
 if(lr.method!==egyLbySeamMethod||lr.geometryResourceSha256!==lbyCas||!eq(lr.topologyProof,oldLbyTopo)||lr.vertexCount!==1252||lt.newOverlapKm2!==0||lt.oldCoverageLossKm2!==0||mr.geometryResourceSha256!==medCas||!eq(mr.policy,medPolicy)||!eq(mr.operations,mp.operations)||mr.operations.length!==300)fail('earlier coast and Libya approvals must remain exact');
 if(assertExactPreviousCoastPoints(old.geometry,v.geometry,native,mr.operations,lt.sequentialPrior.previouslyStoredCoastRanges,op)!==3730)fail('prior Mediterranean points changed');
 const l=arc(native,lr.topologyOperation.raw), j=lr.operation.startIndex;
 if(j!==5215||l.length!==1252||!eq(l,arc(cur.LBY.q.geometry,lr.lbyArc))||!eq(l,old.geometry.coordinates[0][0].slice(j,j+1252))||!eq(l,v.geometry.coordinates[0][0].slice(j+2,j+1254)))fail('previous Libya seam points must stay exact');
 return 1;
}

const registration={"binding":{"sourcePin":"e5c8107d2a3a3e432d11c6735725d5c63a99fac7","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/egy-brt-original-frontier-20261116/review.json","sha256":"a82cba314c4a41f6a7e8b52a9f8f0bba2cb8e393c2b8f12d8f601b0cd5e7d4b3"}},"frozen":{"EGY":{"descriptorSha256":"4101c0784638994e205c1cda4a90e442705285d0e8d0ea96f001d9a8bf05a3f4","sha256":"ac7e5f58b848bd69df58a7f104801a1b13edabb7ac033ccad0d789c3eefe709e","versionId":"state:EGY:natural-earth-5.1.1","validFrom":null,"validTo":null},"BRT":{"descriptorSha256":"2be93e04d2debb3358ba729c0508411c54b6bb7727a970f43b988c39a0558020","sha256":"aab6545be0b74bfa540f8be06482e4f510f212713d036a40ca83157dcf40d4e6","versionId":"state:BRT:natural-earth-5.1.1","validFrom":null,"validTo":null},"SDN":{"descriptorSha256":"3dd6378957c056be7a0fa6d30cbbe18eb475504c5fe04c9fd7884bac6d24d2b5","sha256":"782a2e915d188ca1795bdefae600196834c23e2cde8683b50ef8baf1e53a88c9","versionId":"state:SDN:2011-07-09-post-secession-r1","validFrom":"2011-07-09","validTo":null},"LBY":{"descriptorSha256":"ceb3ffada9ae759270612861d0f198e87d1dfa7b0e50d3cf33a744a2a955e88e","sha256":"bd919defe47e011ed4b6c69b9255099f0f6558955fe7f95c38cbb9675274c8e5","versionId":"state:LBY:natural-earth-5.1.1","validFrom":null,"validTo":null},"ISR":{"descriptorSha256":"da510fb72fe17ee405fe329805ed0a2949ab8d772e5c1b51fe599611e9537c85","sha256":"a0cff20aeaac2c9d1da26be65132a49ca7756a248349d18fb9aa233fa6b65d5a","versionId":"state:ISR:natural-earth-5.1.1","validFrom":null,"validTo":null},"PSX":{"descriptorSha256":"374f69422ce8a0e48328abae77fad6e256e4ed7ea80453b342d921925d1a1694","sha256":"fb80b7ee519e880e96b6d73c3cbd1cca277ba3aa71bf0934277c22c10edc592c","versionId":"state:PSX:natural-earth-5.1.1","validFrom":null,"validTo":null},"JOR":{"descriptorSha256":"fa206caab944fa7d0b42609dcaa434897cfc49aaace6f6030836531323e855e9","sha256":"50bbea1fdafb39ab7014c4898244ccbee453bc6b6902193e5a607097d04c3b8f","versionId":"state:JOR:natural-earth-5.1.1","validFrom":null,"validTo":null},"SAU":{"descriptorSha256":"3aa073707684b718f7014c8907e84b18db07d1b12ed28b0e3ebefb5445d5806c","sha256":"2ca76e4e36ce4e4e6ed753c54deee727185a05daea64afa91ed9e8eff5ba75cc","versionId":"state:SAU:natural-earth-5.1.1","validFrom":null,"validTo":null}},"originalEgy":{"reference":"reports/borders/validation/modern-raw-source-20261110/egy-med-coast-20261114/original.json","sha256":"c1913f919399a505b3beb5a3fd6d5557d908cc14c3a73968dde5fd7e94b0c973","feature":"953efe22-01f1-4613-add9-16c086af943f","wkb":"b21708f6060665431477d41917f2de74642c7dd184dae03e65e546ee51712edf"},"originalBrt":{"reference":"reports/borders/validation/modern-raw-source-20261110/fixed-four-original-scope-20261113/originals/BRT-original.json","sha256":"fa460b9ded7dfa54337060f01a1a5833c79ba767137a35d78ebea50d7e15771d","feature":"dffff183-4f74-4043-91ab-335c32ec4cc0","wkb":"56996ceb28d7ef3008237996869eb139fdabbf533f1c4d6b4207d55c3018052f"},"retainedBrtReceipts":[{"reference":"reports/borders/validation/modern-raw-source-20261110/fixed-four-original-scope-20261113/BRT-existing-scope.json","sha256":"4999f77b5c96bfd494593b84265cbcebc0f5448cc2ced7df98817d8cd40c6dee"},{"reference":"reports/borders/validation/modern-raw-source-20261110/fixed-four-original-scope-20261113/BRT-review.json","sha256":"4fe03e8c9ffa9775bf07c85fd8d13bf7d91ccb97fe7ff3d18dac717df63b70b8"}],"descriptorPath":"assets/data/territorial-entities/source/countries/state-EGY.json","resourcePath":"assets/data/territorial-entities/source/geometries/sha256-f683a4b9b3a7e1fe3d0c4818dddc207536c76d69736126738f7a8137464ecd52.json"};
