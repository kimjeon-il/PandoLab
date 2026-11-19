import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';

export const ukrBlrSeamMethod='exact-original-ukr-blr-readonly-counterpart-seam';
const id='state:UKR', version='state:UKR:2014-03-18-post-crimea-r1';
const date='2014-03-18';
const status='raw-source-only-not-display-approved';
const base='assets/data/territorial-entities/source/';
const prior='complete-prepared-current-geometry; no additional simplification';
const hash=b=>createHash('sha256').update(b).digest('hex');
const domain=g=>hash(JSON.stringify([g.type,g.coordinates]));
const fail=message=>{throw Error('UKR/BLR exact current seam: '+message);};
const keys=(o,names)=>o&&eq(Object.keys(o).sort(),[...names].sort());
const omit=(o,...names)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!names.includes(k)));
const active=e=>e.geometryVersions.filter(x=>x.validTo===null);
const preserved=e=>({...e,sourceInfo:omit(e.sourceInfo,'geometrySha256','geometryVersionId'),
 geometryVersions:e.geometryVersions.map(x=>x.versionId===version?omit(x,'geometry','modernBoundarySupplement'):x)});
const dig=(a,b,label)=>{if(a!==b)fail(label+' digest mismatch');};
const bytes=(read,p,h)=>{const x=read(p);if(!Buffer.isBuffer(x))fail(p+' exact archived bytes required');dig(hash(x),h,p);return x;};
export const hasUkrBlrSeam=e=>e?.entityId===id&&e?.geometryVersions?.some(x=>x.validTo===null&&x.modernBoundarySupplement?.adoptionMode===ukrBlrSeamMethod)===true;

export function assertUkrBlrTopology(p,b,peers){
 const {openRingVertexCount,...blrArc}=p.BLRDonor??{};
 if(p.pin!==b.sourcePin||p.newPairDE9IM!=='FF2F11212'||p.newOverlapKm2!==0||p.newPositiveOverlapPolygonCount!==0||
  p.oldCoverageLossKm2!==0||p.oldCoverageLossPolygonCount!==0||p.allArcEdgesExactReciprocal!==true||
  p.UKROriginal?.wkbSha256!==b.originalUKRWkb||!eq(p.operations,[b.topologyOperation])||!eq(p.ringStarts,[b.ringStart])||!eq(blrArc,b.blrArc)||
  !keys(p.otherPeers,peers)||peers.some(c=>{const v=p.otherPeers[c];return v?.exactPrePostIntersectionEqual!==true||
   v.exactPrePostBoundaryShareEqual!==true||v.changeAreaKm2!==0;}))fail('reviewed zero-overlap no-loss topology and unchanged peers required');
 return true;
}

export function assertUkrBlrSeam(next,previous,{prefixes,readEvidence}={}){
 const {binding,frozen,raw,descriptorPath,resourcePath}=registeredUkrBlr;
 if(typeof readEvidence!=='function'||!hasUkrBlrSeam(next)||previous?.entityId!==id)fail('pinned UKR archive reader and entity required');
 const nv=active(next),pv=active(previous),v=nv[0],old=pv[0],s=v?.modernBoundarySupplement;
 if(nv.length!==1||pv.length!==1||v.versionId!==version||old.versionId!==version||v.validFrom!==date||old.validFrom!==date||
  next.metadata?.representativeGeometryVersionId!==version||!eq(preserved(next),preserved(previous)))
  fail('dates, selected version, attribution, and unselected geometry must remain exact');
 if(!keys(s,['adoptionMode','status','resultRelation','wholeCountryRaw','priorPreparedAttribution','geometrySha256','seamReview'])||
  s.status!==status||s.resultRelation!=='partial-original-with-readonly-belarus-seam'||s.wholeCountryRaw!==false||
  old.modernBoundarySupplement?.adoptionMode!==prior||!eq(s.priorPreparedAttribution,old.modernBoundarySupplement)||
  !eq(s.seamReview,binding.review))fail('only registered partial source and prior attribution required');
 if(!Array.isArray(prefixes)||!eq([...prefixes].sort(),[descriptorPath,resourcePath].sort()))fail('only UKR descriptor and exact new geometry may be written');
 const r=JSON.parse(bytes(readEvidence,binding.review.reference,binding.review.sha256));
 if(r.schemaVersion!==1||r.sourcePin!==binding.sourcePin||r.method!==ukrBlrSeamMethod||r.status!==status||r.entityId!==id||
  r.versionId!==version||r.validFrom!==date||r.validTo!==null||r.vertexCount!==binding.vertexCount||
  !eq(r.operation,binding.operation)||!eq(r.topologyOperation,binding.topologyOperation)||!eq(r.ringStart,binding.ringStart)||!eq(r.blrArc,binding.blrArc))fail('fixed source review fields required');
 dig(domain(old.geometry),r.previousGeometrySha256,'prior UKR geometry');
 dig(domain(v.geometry),r.geometrySha256,'new UKR geometry');
 dig(hash(JSON.stringify(v.geometry)+'\n'),r.geometryResourceSha256,'new UKR CAS');
 if(s.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometryVersionId!==version)
  fail('current source digest attribution must be correct');
 const proof=JSON.parse(bytes(readEvidence,r.topologyProof.reference,r.topologyProof.sha256));
 const peers=Object.keys(frozen).filter(c=>c!=='BLR'&&c!=='UKR');
 assertUkrBlrTopology(proof,binding,peers);
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
 if(!eq(current.UKR,previous)||!eq(active(current.BLR)[0].geometry,originals.BLR))fail('pinned UKR and exact unchanged BLR required');
 const arc=(g,x)=>exactCyclicChain(g.coordinates[x.polygonIndex][x.ringIndex],x.startIndex,x.endIndex,x.direction);
 const op=binding.operation, points=arc(originals.BLR,op.raw);
 if(!eq(op.raw,binding.blrArc)||op.ringIndex!==0||op.raw.ringIndex!==0||binding.blrArc.ringIndex!==0||points.length!==binding.vertexCount||
  !eq(points,arc(originals.BLR,binding.blrArc))||points.slice(1).some((p,i)=>eq(p,points[i])))fail('one exact reciprocal LSIB exterior arc required');
 if(!eq(replayRetainedCoast(old.geometry,originals.BLR,[op],[binding.ringStart]),v.geometry))
  fail('candidate must be exact replay with all other rings and polygons preserved');
 return 1;
}

const registeredUkrBlr=Object.freeze({"binding":{"sourcePin":"1de55927ed43ef195f6b9742e426892b27a21727","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/ukr-blr-original-frontier-20261115/review.json","sha256":"29691cc8c0a6ed1baf2c4369c878eed099c9b9d4eada297cf314df6ba1cf7cf5"},"operation":{"polygonIndex":24,"ringIndex":0,"startIndex":3924,"endIndex":4471,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":42816,"endIndex":31943,"direction":-1}},"topologyOperation":{"polygonIndex":24,"ringIndex":0,"startIndex":3924,"endIndex":4471,"raw":{"polygonIndex":69,"ringIndex":0,"startIndex":211629,"endIndex":222502,"direction":1}},"ringStart":{"polygonIndex":24,"ringIndex":0,"startIndex":0},"blrArc":{"polygonIndex":0,"ringIndex":0,"startIndex":42816,"endIndex":31943,"direction":-1},"vertexCount":10874,"originalUKRWkb":"45d0e3cf0e49358b6d20d2c61b456c09b09a2eb281899c4d44f369549131cd31"},"frozen":{"UKR":{"descriptorSha256":"28e0846374f3ee3d2213b0ad81d3279e5a128d42b6e3aafda1914d99ff42b36f","geometrySha256":"3e95abd26dbcbc47380eed99af5815f6e75bcf9c69b12bbf77e6e3d40b3f6786","resourceSha256":"ce7e601f044ec04ab9a6ef3a7339351d80cacf94bba6b1bc03540f2a6be80f10"},"BLR":{"descriptorSha256":"b428bfd7d801ec5d142d70ce8ae390c615cb48199f97eb95b15c60fa3bed12ab","geometrySha256":"b62c1f32988ed51f2768d617b361d3a8f010a2b6fff8c58d1a1a3ba422d0c7cf","resourceSha256":"e1bcd7c8c1ee79363d33698197984484e4e3a05372ae784f642ce7c01549cfbb"},"RUS":{"descriptorSha256":"1e5c0e11e240d9d5f1c1f88d9762c14c10c72f579c217686db99a642f5ad42b8","geometrySha256":"0e22251b5b4ca838334df0abe604e888e6c3c5ddbc15437bb08f353193595e18","resourceSha256":"f7e92b439ff7afd3fd504a27fc88cbb2e2059c63fe8ed15c4eeb2e633d24cb15"},"POL":{"descriptorSha256":"be1b06ae66b5463a123a2455fc17bdef6e863b80b3131196acf77f0439b4ff49","geometrySha256":"454329d6c9a654c4cc4bee1692bd19787ea27779608d9c3c79e00782065b45f0","resourceSha256":"ccdfef130607c3c858b4f3458a0775ca9b7f87b34cfa312f5f9b15e0897c271e"},"LTU":{"descriptorSha256":"57bc42f8824495a654e8f0fbf1b70c1c9c640256eac58a579973a47415d183e8","geometrySha256":"0104c51a2a483cd10b00fc324e0f8f73d23fb9dc36422b41a791f11f20c18fb8","resourceSha256":"8ae8b03af3ce3dac3567a273c88073b8eff5199cb4247ead3052da1bde8434a7"},"LVA":{"descriptorSha256":"9ef8a6dba3a4c963f797b4b1bebc8262f68fe7c8c63e279147296a56761de45b","geometrySha256":"d331d69ce2bf3992146f50be6482d1688466c270f468d293c86b0c4442958a3b","resourceSha256":"20cf314ae2721811e5ea99fb3f3322da0118af60de6b60ecf3865b0e1e621b33"},"SVK":{"descriptorSha256":"c7bb3d2826481e01610afa67285e988d234fcf1f03f06fedf105bb92b17a33e7","geometrySha256":"f3b493e28ba67ca6c4256b0740511a4c1865adb0bdba11ae7d9b2afaf9f9df6a","resourceSha256":"80a174f6d86458398bea14ca555d191696b344cc56581f227e753ea754fccf16"},"HUN":{"descriptorSha256":"6ee420981d092323371b10b549cfa2a3a5960b199f8e721700dfe599b7e4d98d","geometrySha256":"1abdfe6af7e0220cbb547c50c3ba00dadb6e2199313b2f4952773a14295be216","resourceSha256":"2a7fc8dee1ab9725db6fc7125c07298db162679db76082d392efd077def56452"},"ROU":{"descriptorSha256":"f733a5d896c0bd853cf0361a3253652cd114743008fefdd4bcc6e1b3b04b27b1","geometrySha256":"391a9f8a94b151ed61e5c3b5d6283c39aff2f8bdc5a185e07f1f506b93a9c4de","resourceSha256":"5c47d588cd02de32ab4a619b8f5cc9004d4e0c2113c11fce089be19403878fc6"},"MDA":{"descriptorSha256":"ba97fac0a70e90a3cbc469a6134f19fed14b57d0f924e733d6b83d8abbdd91f0","geometrySha256":"a73451c6fdc9fb8f8b36f3fc1e24eb2e3f8fda9bee933c1049fede9205d3fc07","resourceSha256":"353f10aec4300a3f3ceebb2f8d148a06da9fad529d8bb65b935eaa90ecc755d1"}},"raw":{"BLR":{"path":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-post-soviet-current-20261113/originals/BLR-original.json","sha256":"8db320c0d6b8fb170ead04a3f0ffc3cde56f49b9cb3de7abcb1475c7e053327e","feature":"d794a6fa-0959-41a3-a22c-ed4dbe086730","wkb":"da56e090afcd5ba0e429a668e549527d281df3c58c1dafd222ccc5a8f178ad3d"}},"resourcePath":"assets/data/territorial-entities/source/geometries/sha256-8223b54a3f6ce969be38d36e8e1bcb09741e2441499de54fa7a186e974ac69ad.json","descriptorPath":"assets/data/territorial-entities/source/countries/state-UKR.json"});
