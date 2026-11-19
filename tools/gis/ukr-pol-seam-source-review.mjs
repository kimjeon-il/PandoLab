import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';

export const ukrPolSeamMethod='exact-original-ukr-pol-readonly-counterpart-seam';
const id='state:UKR', version='state:UKR:2014-03-18-post-crimea-r1';
const date='2014-03-18';
const status='raw-source-only-not-display-approved';
const base='assets/data/territorial-entities/source/';
const prior='exact-original-ukr-mda-readonly-counterpart-seam';
const priorBlrMethod='exact-original-ukr-blr-readonly-counterpart-seam';
const priorMdaSourcePin='8ae278ebaf17f05531de0f07e5a3dcd1385ef2ee';
const priorMdaReview={reference:'reports/borders/validation/modern-raw-source-20261110/ukr-mda-original-frontier-20261115/review.json',sha256:'3b620faa9b67607cec3a75c57034ea63b546e649c4affbd596e5dd59dac4da98'};
const priorMdaTopology={reference:'reports/borders/validation/modern-raw-source-20261110/ukr-mda-original-frontier-20261115/topology-proof.json',sha256:'290749982feaa4064f39ec37d65f7dabd56e9a26dff76802b5d27cd37e691afe'};
const priorMdaArc={polygonIndex:0,ringIndex:0,startIndex:0,endIndex:45499,direction:-1};
const priorMdaCas='5fe28f6386468c30ec8f49c09bdccf8244e0757c7ac87a7a57d148c5d4638b66';
const priorMdaDomain='a0d0917e70d102dad4cd5659bb29e470be97101ded8d55a285e97f1c9a928bff';
const priorMdaDonorCas='353f10aec4300a3f3ceebb2f8d148a06da9fad529d8bb65b935eaa90ecc755d1';

const priorPin='1de55927ed43ef195f6b9742e426892b27a21727';
const priorReview={reference:'reports/borders/validation/modern-raw-source-20261110/ukr-blr-original-frontier-20261115/review.json',sha256:'29691cc8c0a6ed1baf2c4369c878eed099c9b9d4eada297cf314df6ba1cf7cf5'};
const priorTopology={reference:'reports/borders/validation/modern-raw-source-20261110/ukr-blr-original-frontier-20261115/topology-proof.json',sha256:'27c6f52abb91e0d02b771f64ef1fc64f86579b267a177a07619146cb70b7f232'};
const priorBlrArc={polygonIndex:0,ringIndex:0,startIndex:42816,endIndex:31943,direction:-1};
const priorGeometryDomain='9cb75fe8a17684065528776e388cf56686438525f0c62164bac20d509f180e49';
const priorGeometryCas='8223b54a3f6ce969be38d36e8e1bcb09741e2441499de54fa7a186e974ac69ad';
const priorHistory=[{versionId:'state:ukraine:1991-2014-r1',from:'1991-08-24',to:'2014-03-17',resourceSHA:'c2ba09faefaa062e0fbb947109d01e5ade145e49a151a82a134e0049a7a8ca0a'}];
export function assertPriorBlrArc(previous,next,donor,arc,scope){
 const points=exactCyclicChain(donor.coordinates[arc.polygonIndex][arc.ringIndex],arc.startIndex,arc.endIndex,arc.direction);
 const p=previous.coordinates[scope.polygonIndex]?.[scope.ringIndex], n=next.coordinates[scope.polygonIndex]?.[scope.ringIndex];
 if(points.length!==scope.length||!p||!n||!eq(p.slice(scope.beforeStart,scope.beforeStart+scope.length),points)||
  !eq(n.slice(scope.afterStart,scope.afterStart+scope.length),points))fail('previously approved Belarus seam vertices changed');
 return true;
}

const hash=b=>createHash('sha256').update(b).digest('hex');
const domain=g=>hash(JSON.stringify([g.type,g.coordinates]));
const fail=message=>{throw Error('UKR/POL exact current seam: '+message);};
const keys=(o,names)=>o&&eq(Object.keys(o).sort(),[...names].sort());
const omit=(o,...names)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!names.includes(k)));
const active=e=>e.geometryVersions.filter(x=>x.validTo===null);
const preserved=e=>({...e,sourceInfo:omit(e.sourceInfo,'geometrySha256','geometryVersionId'),
 geometryVersions:e.geometryVersions.map(x=>x.versionId===version?omit(x,'geometry','modernBoundarySupplement'):x)});
const dig=(a,b,label)=>{if(a!==b)fail(label+' digest mismatch');};
const bytes=(read,p,h)=>{const x=read(p);if(!Buffer.isBuffer(x))fail(p+' exact archived bytes required');dig(hash(x),h,p);return x;};
export const hasUkrPolSeam=e=>e?.entityId===id&&e?.geometryVersions?.some(x=>x.validTo===null&&x.modernBoundarySupplement?.adoptionMode===ukrPolSeamMethod)===true;

export function assertUkrPolTopology(p,b,peers){
 const {openRingVertexCount,...polArc}=p.POLDonor??{};
 if(p.pin!==b.sourcePin||p.newPairDE9IM!=='FF2F11212'||p.newOverlapKm2!==0||p.newPositiveOverlapPolygonCount!==0||
  p.oldCoverageLossKm2!==0||p.oldCoverageLossPolygonCount!==0||p.allArcEdgesExactReciprocal!==true||
  !eq(p.sequentialPrior?.history,priorHistory)||p.sequentialPrior?.blrOverlapKm2!==0||p.sequentialPrior?.blrBoundaryExact!==true||p.sequentialPrior?.pointwiseOutsideChosenArc!==true||p.sequentialPrior.mdaOverlapKm2!==0||p.sequentialPrior.mdaBoundaryExact!==true||p.sequentialPrior.blrShareKm!==1100.2778006725011||p.sequentialPrior.mdaShareKm!==1223.0725269960208||p.sequentialPrior.tripointsExact!==true||p.UKROriginal?.wkbSha256!==b.originalUKRWkb||!eq(p.operations,[b.topologyOperation])||!eq(p.ringStarts,[b.ringStart])||!eq(polArc,b.polArc)||
  !keys(p.otherPeers,peers)||peers.some(c=>{const v=p.otherPeers[c];return v?.exactPrePostIntersectionEqual!==true||
   v.exactPrePostBoundaryShareEqual!==true||v.changeAreaKm2!==0;}))fail('reviewed zero-overlap no-loss topology and unchanged peers required');
 return true;
}

export function assertUkrPolSeam(next,previous,{prefixes,readEvidence}={}){
 const {binding,frozen,raw,descriptorPath,resourcePath}=registeredUkrPol;
 if(typeof readEvidence!=='function'||!hasUkrPolSeam(next)||previous?.entityId!==id)fail('pinned UKR archive reader and entity required');
 const nv=active(next),pv=active(previous),v=nv[0],old=pv[0],s=v?.modernBoundarySupplement;
 if(nv.length!==1||pv.length!==1||v.versionId!==version||old.versionId!==version||v.validFrom!==date||old.validFrom!==date||
  next.metadata?.representativeGeometryVersionId!==version||!eq(preserved(next),preserved(previous)))
  fail('dates, selected version, attribution, and unselected geometry must remain exact');
 if(!keys(s,['adoptionMode','status','resultRelation','wholeCountryRaw','priorPreparedAttribution','geometrySha256','seamReview'])||
  s.status!==status||s.resultRelation!=='partial-original-with-readonly-poland-seam'||s.wholeCountryRaw!==false||
  old.modernBoundarySupplement?.adoptionMode!==prior||!eq(s.priorPreparedAttribution,old.modernBoundarySupplement)||
  !eq(s.seamReview,binding.review))fail('only registered partial source and prior attribution required');
 if(!Array.isArray(prefixes)||!eq([...prefixes].sort(),[descriptorPath,resourcePath].sort()))fail('only UKR descriptor and exact new geometry may be written');
 if(!eq(old.modernBoundarySupplement?.seamReview,priorMdaReview)||domain(old.geometry)!==priorMdaDomain||old.modernBoundarySupplement?.priorPreparedAttribution?.adoptionMode!==priorBlrMethod||!eq(old.modernBoundarySupplement.priorPreparedAttribution.seamReview,priorReview))fail('exact prior Moldova and nested Belarus approval required');
 const r=JSON.parse(bytes(readEvidence,binding.review.reference,binding.review.sha256));
 if(r.schemaVersion!==1||r.sourcePin!==binding.sourcePin||r.method!==ukrPolSeamMethod||r.status!==status||r.entityId!==id||
  r.versionId!==version||r.validFrom!==date||r.validTo!==null||r.vertexCount!==binding.vertexCount||
  !eq(r.operation,binding.operation)||!eq(r.topologyOperation,binding.topologyOperation)||!eq(r.ringStart,binding.ringStart)||!eq(r.polArc,binding.polArc))fail('fixed source review fields required');
 dig(domain(old.geometry),r.previousGeometrySha256,'prior UKR geometry');
 dig(domain(v.geometry),r.geometrySha256,'new UKR geometry');
 dig(hash(JSON.stringify(v.geometry)+'\n'),r.geometryResourceSha256,'new UKR CAS');
 if(s.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometryVersionId!==version)
  fail('current source digest attribution must be correct');
 const proof=JSON.parse(bytes(readEvidence,r.topologyProof.reference,r.topologyProof.sha256));
 const peers=Object.keys(frozen).filter(c=>c!=='POL'&&c!=='UKR');
 assertUkrPolTopology(proof,binding,peers);
 const originals={},current={};
 for(const c of ['POL']){
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
 if(!eq(current.UKR,previous)||!eq(active(current.POL)[0].geometry,originals.POL))fail('pinned UKR and exact unchanged POL required');
 const priorProof=JSON.parse(bytes(readEvidence,priorReview.reference,priorReview.sha256));
 if(priorProof.method!==priorBlrMethod||priorProof.sourcePin!==priorPin||priorProof.geometryResourceSha256!==priorGeometryCas||priorProof.geometrySha256!==priorGeometryDomain||!eq(priorProof.blrArc,priorBlrArc)||!eq(priorProof.topologyProof,priorTopology))fail('exact prior Belarus approval required');
 const pt=JSON.parse(bytes(readEvidence,priorTopology.reference,priorTopology.sha256));
 if(pt.newOverlapKm2!==0||pt.oldCoverageLossKm2!==0||pt.newPairDE9IM!=='FF2F11212'||pt.allArcEdgesExactReciprocal!==true)fail('bad original Belarus topology invariant');
 const hist=previous.geometryVersions.filter(w=>w.validTo!==null).map(w=>({versionId:w.versionId,from:w.validFrom,to:w.validTo,resourceSHA:hash(JSON.stringify(w.geometry)+'\n')}));
 if(!eq(hist,priorHistory))fail('unchanged historical slots and CAS required');
 if(frozen.UKR.resourceSha256!==priorMdaCas||frozen.UKR.geometrySha256!==priorMdaDomain||!current.BLR||frozen.MDA?.resourceSha256!==priorMdaDonorCas)fail('frozen previous active CAS and Belarus donor required');
 assertPriorBlrArc(old.geometry,v.geometry,active(current.BLR)[0].geometry,priorBlrArc,{polygonIndex:24,ringIndex:0,beforeStart:11255,afterStart:18037,length:10874});
 const mr=JSON.parse(bytes(readEvidence,priorMdaReview.reference,priorMdaReview.sha256));
 const mt=JSON.parse(bytes(readEvidence,priorMdaTopology.reference,priorMdaTopology.sha256));
 if(mr.method!==prior||mr.sourcePin!==priorMdaSourcePin||mr.geometryResourceSha256!==priorMdaCas||mr.geometrySha256!==priorMdaDomain||!eq(mr.mdaArc,priorMdaArc)||!eq(mr.topologyProof,priorMdaTopology)||mt.newOverlapKm2!==0||mt.oldCoverageLossKm2!==0||mt.newPairDE9IM!=='FF2F11212'||mt.allArcEdgesExactReciprocal!==true||mt.sequentialPrior?.blrBoundaryExact!==true||mt.sequentialPrior?.blrOverlapKm2!==0)fail('exact archived Moldova approval required');
 assertPriorBlrArc(old.geometry,v.geometry,active(current.MDA)[0].geometry,priorMdaArc,{polygonIndex:24,ringIndex:0,beforeStart:2629,afterStart:2629,length:7862});
 const arc=(g,x)=>exactCyclicChain(g.coordinates[x.polygonIndex][x.ringIndex],x.startIndex,x.endIndex,x.direction);
 const op=binding.operation, points=arc(originals.POL,op.raw);
 if(!eq(op.raw,binding.polArc)||op.ringIndex!==0||op.raw.ringIndex!==0||binding.polArc.ringIndex!==0||points.length!==binding.vertexCount||
  !eq(points,arc(originals.POL,binding.polArc))||points.slice(1).some((p,i)=>eq(p,points[i])))fail('one exact reciprocal LSIB exterior arc required');
 if(!eq(replayRetainedCoast(old.geometry,originals.POL,[op],[binding.ringStart]),v.geometry))
  fail('candidate must be exact replay with all other rings and polygons preserved');
 return 1;
}

const registeredUkrPol=Object.freeze({"binding":{"sourcePin":"70662aaa1d08eff9493b239c79cf1c5d272b5cea","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/ukr-pol-original-frontier-20261115/review.json","sha256":"5440b94541f8d59709b9fcfe90e1ddabd33ec41193b574b030332117e5572038"},"operation":{"polygonIndex":24,"ringIndex":0,"startIndex":10892,"endIndex":11255,"raw":{"polygonIndex":38,"ringIndex":0,"startIndex":51717,"endIndex":44572,"direction":-1}},"topologyOperation":{"polygonIndex":24,"ringIndex":0,"startIndex":10892,"endIndex":11255,"raw":{"polygonIndex":69,"ringIndex":0,"startIndex":204484,"endIndex":211629,"direction":1}},"ringStart":{"polygonIndex":24,"ringIndex":0,"startIndex":0},"polArc":{"polygonIndex":38,"ringIndex":0,"startIndex":51717,"endIndex":44572,"direction":-1},"vertexCount":7146,"originalUKRWkb":"45d0e3cf0e49358b6d20d2c61b456c09b09a2eb281899c4d44f369549131cd31"},"frozen":{"UKR":{"descriptorSha256":"3c87590cf32af2f0502dfce9c62222ed8ea346e1ed6dc5400836819800e340c0","geometrySha256":"a0d0917e70d102dad4cd5659bb29e470be97101ded8d55a285e97f1c9a928bff","resourceSha256":"5fe28f6386468c30ec8f49c09bdccf8244e0757c7ac87a7a57d148c5d4638b66"},"POL":{"descriptorSha256":"be1b06ae66b5463a123a2455fc17bdef6e863b80b3131196acf77f0439b4ff49","geometrySha256":"454329d6c9a654c4cc4bee1692bd19787ea27779608d9c3c79e00782065b45f0","resourceSha256":"ccdfef130607c3c858b4f3458a0775ca9b7f87b34cfa312f5f9b15e0897c271e"},"ROU":{"descriptorSha256":"f733a5d896c0bd853cf0361a3253652cd114743008fefdd4bcc6e1b3b04b27b1","geometrySha256":"391a9f8a94b151ed61e5c3b5d6283c39aff2f8bdc5a185e07f1f506b93a9c4de","resourceSha256":"5c47d588cd02de32ab4a619b8f5cc9004d4e0c2113c11fce089be19403878fc6"},"BLR":{"descriptorSha256":"b428bfd7d801ec5d142d70ce8ae390c615cb48199f97eb95b15c60fa3bed12ab","geometrySha256":"b62c1f32988ed51f2768d617b361d3a8f010a2b6fff8c58d1a1a3ba422d0c7cf","resourceSha256":"e1bcd7c8c1ee79363d33698197984484e4e3a05372ae784f642ce7c01549cfbb"},"RUS":{"descriptorSha256":"1e5c0e11e240d9d5f1c1f88d9762c14c10c72f579c217686db99a642f5ad42b8","geometrySha256":"0e22251b5b4ca838334df0abe604e888e6c3c5ddbc15437bb08f353193595e18","resourceSha256":"f7e92b439ff7afd3fd504a27fc88cbb2e2059c63fe8ed15c4eeb2e633d24cb15"},"MDA":{"descriptorSha256":"ba97fac0a70e90a3cbc469a6134f19fed14b57d0f924e733d6b83d8abbdd91f0","geometrySha256":"a73451c6fdc9fb8f8b36f3fc1e24eb2e3f8fda9bee933c1049fede9205d3fc07","resourceSha256":"353f10aec4300a3f3ceebb2f8d148a06da9fad529d8bb65b935eaa90ecc755d1"},"SVK":{"descriptorSha256":"c7bb3d2826481e01610afa67285e988d234fcf1f03f06fedf105bb92b17a33e7","geometrySha256":"f3b493e28ba67ca6c4256b0740511a4c1865adb0bdba11ae7d9b2afaf9f9df6a","resourceSha256":"80a174f6d86458398bea14ca555d191696b344cc56581f227e753ea754fccf16"},"HUN":{"descriptorSha256":"6ee420981d092323371b10b549cfa2a3a5960b199f8e721700dfe599b7e4d98d","geometrySha256":"1abdfe6af7e0220cbb547c50c3ba00dadb6e2199313b2f4952773a14295be216","resourceSha256":"2a7fc8dee1ab9725db6fc7125c07298db162679db76082d392efd077def56452"},"LTU":{"descriptorSha256":"57bc42f8824495a654e8f0fbf1b70c1c9c640256eac58a579973a47415d183e8","geometrySha256":"0104c51a2a483cd10b00fc324e0f8f73d23fb9dc36422b41a791f11f20c18fb8","resourceSha256":"8ae8b03af3ce3dac3567a273c88073b8eff5199cb4247ead3052da1bde8434a7"},"CZE":{"descriptorSha256":"6ee4fcb7896b1c108a8345aefa53c894601efdbf11cec5242e8818bbddcbf1ad","geometrySha256":"bdec036510782801896b9a78c75d458d3a1bf3bbd544662b8ff08edf7b7c44c7","resourceSha256":"8b9bd00631f326b2682e54e09051d8af94696116cea2794e15d1029952feec65"},"DEU":{"descriptorSha256":"f2bf22fd63dbefbd181eae55a6ab0ad10d736f7c77b5529ffed7915ce307f14e","geometrySha256":"719b6d84bea4cd0cfcadbbfabecc0fb79f066446c61abdc7d3d57a9a80191bd7","resourceSha256":"503f41377852b9783c2be99dd30b00555858c225f99ab3190214030e73b73de1"},"AUT":{"descriptorSha256":"e82e7d36d0c4ae7c6df0e600be12c6720687a7c713766afdd9207191c5e4bba7","geometrySha256":"0456a43e9ee98aa4104ce5d81222fcca2388af0dc0ba136eee15157e6ef12696","resourceSha256":"194534ed6b3efbb2b22fe21e778d0351495a91eea720219b2dfc9ca17823171a"},"LVA":{"descriptorSha256":"9ef8a6dba3a4c963f797b4b1bebc8262f68fe7c8c63e279147296a56761de45b","geometrySha256":"d331d69ce2bf3992146f50be6482d1688466c270f468d293c86b0c4442958a3b","resourceSha256":"20cf314ae2721811e5ea99fb3f3322da0118af60de6b60ecf3865b0e1e621b33"}},"raw":{"POL":{"path":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-nordic-central-20261113/originals/POL-original.json","sha256":"b0e6d89935f3a86127e526430ccf96cd7b607aae218be6a21b58ee77f6d51a37","feature":"21aa2481-05e4-4dc2-9faf-47c7e3dfc031","wkb":"4ac7ca419af8349625c9ccf3d9e81e812974549c13d846586437015b5c133e29"}},"resourcePath":"assets/data/territorial-entities/source/geometries/sha256-d2cd0b5bff81ee65c860956a5a8a075502dd80425de40f7dc51ba6881b21e0e1.json","descriptorPath":"assets/data/territorial-entities/source/countries/state-UKR.json"});
