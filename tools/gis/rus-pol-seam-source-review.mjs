import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';

export const rusPolSeamMethod='exact-original-rus-pol-readonly-counterpart-seam';
const id='state:RUS', version='state:RUS:natural-earth-5.1.1';
const date='2014-03-18';
const status='raw-source-only-not-display-approved';
const base='assets/data/territorial-entities/source/';
const prior='exact-original-rus-lva-readonly-counterpart-seam';
const previousEstMethod='exact-original-rus-est-readonly-counterpart-seam';
const priorLvaReview={reference:'reports/borders/validation/modern-raw-source-20261110/rus-lva-original-frontier-20261115/review.json',sha256:'d32af7e73948c9383f72f689fcb0335af5671a3f56f114fe757b166f04567d8f'};
const priorLvaTopology={reference:'reports/borders/validation/modern-raw-source-20261110/rus-lva-original-frontier-20261115/topology-proof.json',sha256:'9dd6e26e866f9f18891b7b21d2ae3d595f9d34138527478eae2f9ae4149a6957'};
const priorLvaArc={polygonIndex:32,ringIndex:0,startIndex:42763,endIndex:34031,direction:-1};
const priorLvaCas='d23a87a9ee0b74d3b2317c810b24cd8698fb92031f58714cc86e5bc69918464c';
const priorLvaDomain='f36f49e1532c030d9ee6d386acdf4a9c95e8fe3d88696a062e9047313834e6de';
const priorLvaDonorCas='20cf314ae2721811e5ea99fb3f3322da0118af60de6b60ecf3865b0e1e621b33';
function assertLatviaApproval(s,g,read){
 if(s?.adoptionMode!==prior||domain(g)!==priorLvaDomain||s.geometrySha256!==priorLvaDomain||!eq(s.seamReview,priorLvaReview))fail('exact previous Latvia frontier approval required');
 const t=JSON.parse(bytes(read,priorLvaReview.reference,priorLvaReview.sha256));
 const p=JSON.parse(bytes(read,priorLvaTopology.reference,priorLvaTopology.sha256));
 if(t.method!==prior||t.geometryResourceSha256!==priorLvaCas||t.geometrySha256!==priorLvaDomain||!eq(t.lvaArc,priorLvaArc)||!eq(t.topologyProof,priorLvaTopology)||p.newOverlapKm2!==0||p.oldCoverageLossKm2!==0||p.newPairDE9IM!=='FF2F11212'||p.sequentialPrior?.estOverlapKm2!==0||p.sequentialPrior?.azeOverlapKm2!==0)fail('exact Latvia receipt and its prior zero-overlap borders required');
}
function assertPriorLvaArc(old,next,donor,arc){
 const points=exactCyclicChain(donor.coordinates[arc.polygonIndex][arc.ringIndex],arc.startIndex,arc.endIndex,arc.direction);
 const a=old.coordinates[3289][0],b=next.coordinates[3289][0];
 if(points.length!==8733||!eq(a.slice(151586,160319),points)||!eq(b.slice(151586,160319),points))fail('original prior Latvia arc changed');
}
export function assertKaliningradReplay(old,next,donor,operations,starts,arcs,counts){
 if(old.type!=='MultiPolygon'||next.type!=='MultiPolygon'||donor.type!=='MultiPolygon'||
 !eq(operations.map(o=>o.polygonIndex),[1,11])||!eq(starts,operations.map(o=>({polygonIndex:o.polygonIndex,ringIndex:0,startIndex:0})))||
 !eq(operations.map(o=>o.raw),arcs)||!eq(counts,[5,646])||
 operations.some(o=>o.ringIndex!==0||o.raw?.ringIndex!==0))fail('exact two existing Kaliningrad mainland arcs required');
 if(!eq(old.coordinates[3289],next.coordinates[3289]))fail('full historically scoped Russian mainland changed');
 for(const [i,o] of operations.entries()){
  const {polygonIndex,ringIndex,startIndex,endIndex,direction}=o.raw;
  const points=exactCyclicChain(donor.coordinates[polygonIndex][ringIndex],startIndex,endIndex,direction);
  if(points.length!==counts[i]||points.slice(1).some((p,j)=>eq(p,points[j])))fail('original Poland arcs must retain exact order and vertices');
 }
 if(!eq(replayRetainedCoast(old,donor,operations,starts),next))fail('unselected geometry or exact two-arc replay changed');
 return true;
}

const previousAzeMethod='exact-original-rus-aze-readonly-counterpart-seam';
const priorEstReview={reference:'reports/borders/validation/modern-raw-source-20261110/rus-est-original-frontier-20261115/review.json',sha256:'3268676c6f1a3feb39a8c3b146c901befe3eb7afb99cba83c61e40e6b07a5a1d'};
const priorEstTopology={reference:'reports/borders/validation/modern-raw-source-20261110/rus-est-original-frontier-20261115/topology-proof.json',sha256:'0e776927818f6524f1f348a4fd343480771e0c7a42e759ebbb5105956d1740fe'};
const priorEstArc={polygonIndex:600,ringIndex:0,startIndex:44367,endIndex:39575,direction:-1};
const priorEstCas='e26478ed624402c11ee52cfe92f1fb656f216f72bf4200f6b28ef2acc34413e1';
const priorEstDomain='d3cf087399a867e952c1b87e0cbf15cef67526e45c9e1104760f0e58685d7038';
const priorEstDonorCas='be7b295f2b35ee0372fb17b77320103d25b9178a52ed221168af4306558ab5b9';
export function assertPriorEstArc(previous,next,donor,arc,scope){
 const points=exactCyclicChain(donor.coordinates[arc.polygonIndex][arc.ringIndex],arc.startIndex,arc.endIndex,arc.direction);
 const p=previous.coordinates[scope.polygonIndex]?.[scope.ringIndex],n=next.coordinates[scope.polygonIndex]?.[scope.ringIndex];
 if(points.length!==scope.length||!p||!n||!eq(p.slice(scope.before,scope.before+scope.length),points)||!eq(n.slice(scope.after,scope.after+scope.length),points))fail('original prior Estonia arc changed');
 return true;
}

const previousBlrMethod='exact-original-rus-blr-readonly-counterpart-seam';
const priorAzeReview={reference:'reports/borders/validation/modern-raw-source-20261110/rus-aze-original-frontier-20261115/review.json',sha256:'97cb3d74ada19ef70a470e124f99253741150df33f705c0b0332c3255a25a8c2'};
const priorAzeTopology={reference:'reports/borders/validation/modern-raw-source-20261110/rus-aze-original-frontier-20261115/topology-proof.json',sha256:'f567cc2e01dd0e4f60001b7618b591067d1d88fb3c25f57f96b2f013b309a05a'};
const priorAzeArc={polygonIndex:2,ringIndex:0,startIndex:31892,endIndex:22317,direction:-1};
const priorAzeCas='1666af4d0dfcca1d6a0f93b901a439c68c8ff0dacd9914ae0c6c26e38b37cd56';
const priorAzeDomain='183d4b5b292791aed2b9d7847798f3fdcaa450f22a1f20ba51d8d6d9f2e88e84';
const priorAzeDonorCas='54acfc4e0ec3237a581434984e25e8c39d2250630d0dccdd9ad151e47063d71a';
export function assertPriorAzeArc(previous,next,donor,arc,scope){
 const points=exactCyclicChain(donor.coordinates[arc.polygonIndex][arc.ringIndex],arc.startIndex,arc.endIndex,arc.direction);
 const p=previous.coordinates[scope.polygonIndex]?.[scope.ringIndex],n=next.coordinates[scope.polygonIndex]?.[scope.ringIndex];
 if(points.length!==scope.length||!p||!n||!eq(p.slice(scope.start,scope.start+scope.length),points)||!eq(n.slice(scope.start,scope.start+scope.length),points))fail('original prior Azerbaijan arc changed');
 return true;
}

const root='reports/borders/validation/modern-raw-source-20261110/';
const receipt=(dir,name,sha256)=>({reference:root+dir+'/'+name+'.json',sha256});
const blrReview=receipt('rus-blr-original-frontier-20261115','review','1a31343b0e862923a93a1b2510f7d7df840bad08e668334b5f199357e03937e6');
const blrTopo=receipt('rus-blr-original-frontier-20261115','topology-proof','bae15020f9ad09cb6ff7bff5373967a9556457e7a27563dff57dd270b83e4f0c');
const mngReview=receipt('rus-mng-terminal-junction-20261114','review','b7a6a731ad898067477300e99a804ffd3280b5892045234cc3df28816065048b');
const mngTopo=receipt('rus-mng-terminal-junction-20261114','topology-proof','4c464d835eeaaf04c4c52edb68366af3de206ced2c13a2cc6e0f664e73e1bf48');
const jointTopo=receipt('rus-kaz-mng-common-seam-20261114','topology','4453c5be06d52e244842d2a7b7737d915d8b6c0a180814706b8d71d40cd2eaec');
const jointOps=receipt('rus-kaz-mng-common-seam-20261114','indexed-operations','647f37d26645647d8648b3db0346e91a40828cb680f4056beb853933e4cc1bd6');
const priorCas='f7e92b439ff7afd3fd504a27fc88cbb2e2059c63fe8ed15c4eeb2e633d24cb15';
const priorDomain='0e22251b5b4ca838334df0abe604e888e6c3c5ddbc15437bb08f353193595e18';
const priorHistory=[{versionId:'state:RUS:post-soviet-existing-coordinates',from:'1991-12-25',to:'2014-03-17',resourceSHA:'dcb6476f67e6d76306d64d5233f73daecb6dd9793651c0e5c4af6cff1350d7a5'}];
function assertInheritedRussia(old,readEvidence){
 const lva=old.modernBoundarySupplement,latest=lva?.priorPreparedAttribution,current=latest?.priorPreparedAttribution,b=current?.priorPreparedAttribution,m=b?.priorPreparedAttribution,j=m?.priorPreparedAttribution;
 assertLatviaApproval(lva,old.geometry,readEvidence);
 if(latest?.adoptionMode!==previousEstMethod||latest.geometrySha256!==priorEstDomain||!eq(latest.seamReview,priorEstReview))fail('exact previous Estonia approval required');
 const er=JSON.parse(bytes(readEvidence,priorEstReview.reference,priorEstReview.sha256)),et=JSON.parse(bytes(readEvidence,priorEstTopology.reference,priorEstTopology.sha256));
 if(er.method!==previousEstMethod||er.geometrySha256!==priorEstDomain||er.geometryResourceSha256!==priorEstCas||!eq(er.estArc,priorEstArc)||!eq(er.topologyProof,priorEstTopology)||et.newOverlapKm2!==0||et.oldCoverageLossKm2!==0||et.newPairDE9IM!=='FF2F11212'||et.sequentialPrior?.priorBordersExact!==true||et.sequentialPrior?.azeOverlapKm2!==0)fail('exact previous Estonia receipt and zero-overlap topology required');
 if(current?.adoptionMode!==previousAzeMethod||current.geometrySha256!==priorAzeDomain||!eq(current.seamReview,priorAzeReview))fail('exact previous Azerbaijan approved frontier required');
 const ar=JSON.parse(bytes(readEvidence,priorAzeReview.reference,priorAzeReview.sha256)),at=JSON.parse(bytes(readEvidence,priorAzeTopology.reference,priorAzeTopology.sha256));
 if(ar.method!==previousAzeMethod||ar.geometrySha256!==priorAzeDomain||ar.geometryResourceSha256!==priorAzeCas||!eq(ar.azeArc,priorAzeArc)||!eq(ar.topologyProof,priorAzeTopology)||at.newOverlapKm2!==0||at.oldCoverageLossKm2!==0||at.newPairDE9IM!=='FF2F11212'||at.sequentialPrior?.priorBordersExact!==true)fail('exact prior Azerbaijan receipt and zero-overlap topology required');
 if(b?.adoptionMode!==previousBlrMethod||b.geometrySha256!==priorDomain||!eq(b.seamReview,blrReview)||
  m?.adoptionMode!=='exact-original-rus-mng-terminal-chord'||!eq(m.seamReview,mngReview)||
  j?.adoptionMode!=='retained-current-original-common-seam'||j.geometrySha256!=='9607237f7eaca4a130976c5d1d18f569b278980aa471d43c58d7970feb35abc3')fail('exact prior Belarus/Mongolia/Kazakhstan chain required');
 const br=JSON.parse(bytes(readEvidence,blrReview.reference,blrReview.sha256));
 const tr=JSON.parse(bytes(readEvidence,mngReview.reference,mngReview.sha256));
 if(br.geometryResourceSha256!==priorCas||br.geometrySha256!==priorDomain||!eq(br.topologyProof,blrTopo)||
  tr.geometrySha256!==m.geometrySha256||!eq(tr.topologyProof,mngTopo))fail('prior receipt provenance differs');
 for(const r of [blrTopo,mngTopo,jointTopo,jointOps])bytes(readEvidence,r.reference,r.sha256);
}
export function assertUnselectedRussia(previous,next,operation,pointCount){
 const a=previous.type==='MultiPolygon'?previous.coordinates:null,b=next.type==='MultiPolygon'?next.coordinates:null;
 const p=a?.[operation.polygonIndex]?.[operation.ringIndex],n=b?.[operation.polygonIndex]?.[operation.ringIndex];
 if(!p||!n||a.length!==b.length||operation.startIndex>=operation.endIndex||
  !eq(p.slice(0,operation.startIndex+1),n.slice(0,operation.startIndex+1))||
  !eq(p.slice(operation.endIndex),n.slice(operation.startIndex+pointCount-1))||
  a.some((poly,i)=>poly.length!==b[i]?.length||poly.some((ring,j)=>(i!==operation.polygonIndex||j!==operation.ringIndex)&&!eq(ring,b[i][j]))))
 fail('all unselected coordinates, protected allocations, and other repaired frontiers must stay exact');
 return true;
}
const karabakhPath=base+'countries/state-nagorno-karabakh.json';
const karabakhSha='8c35e32ff13e15b08c0292f44189ccca57835849fa91fa0c68c651dc6d9516a6';
const karabakhVersions=[
 ['state:nagorno-karabakh:1991-2020-r1','836a0ab4827a34c4c58a3840b8365c1d42f51607a29d60c9886ad9ec4256b3df'],
 ['state:nagorno-karabakh:2020-2023-r1','cddb8fcacb77202592bbb1f6083360ec72807045f5f7edb32f4aadb0380555ff']
];
function assertArchivedCaucasus(readEvidence){
 const d=JSON.parse(bytes(readEvidence,karabakhPath,karabakhSha));
 const selected=d.geometryVersions?.filter(v=>v.geometryResource);
 if(!eq(selected?.map(v=>[v.versionId,v.geometryResource.sha256]),karabakhVersions))fail('unchanged archived Nagorno-Karabakh versions required');
 for(const v of selected)bytes(readEvidence,base+v.geometryResource.file,v.geometryResource.sha256);
}

const hash=b=>createHash('sha256').update(b).digest('hex');
const domain=g=>hash(JSON.stringify([g.type,g.coordinates]));
const fail=message=>{throw Error('RUS/POL exact current seam: '+message);};
const keys=(o,names)=>o&&eq(Object.keys(o).sort(),[...names].sort());
const omit=(o,...names)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!names.includes(k)));
const active=e=>e.geometryVersions.filter(x=>x.validTo===null);
const preserved=e=>({...e,sourceInfo:omit(e.sourceInfo,'geometrySha256','geometryVersionId'),
 geometryVersions:e.geometryVersions.map(x=>x.versionId===version?omit(x,'geometry','modernBoundarySupplement'):x)});
const dig=(a,b,label)=>{if(a!==b)fail(label+' digest mismatch');};
const bytes=(read,p,h)=>{const x=read(p);if(!Buffer.isBuffer(x))fail(p+' exact archived bytes required');dig(hash(x),h,p);return x;};
export const hasRusPolSeam=e=>e?.entityId===id&&e?.geometryVersions?.some(x=>x.validTo===null&&x.modernBoundarySupplement?.adoptionMode===rusPolSeamMethod)===true;

export function assertRusPolTopology(p,b,peers){
 const polArcs=p.POLDonors;
 if(p.pin!==b.sourcePin||p.newPairDE9IM!=='FF2F11212'||p.newOverlapKm2!==0||p.newPositiveOverlapPolygonCount!==0||
  p.oldCoverageLossKm2!==0||p.oldCoverageLossPolygonCount!==0||p.allArcEdgesExactReciprocal!==true||
  !eq(p.sequentialPrior?.history,priorHistory)||p.sequentialPrior?.pointwiseOutsideChosenArc!==true||p.sequentialPrior?.priorBordersExact!==true||p.sequentialPrior?.azeExact!==true||p.sequentialPrior?.azeOverlapKm2!==0||p.sequentialPrior?.estExact!==true||p.sequentialPrior?.estOverlapKm2!==0||p.sequentialPrior?.ltuTripointExact!==true||p.sequentialPrior?.lvaExact!==true||p.sequentialPrior?.lvaOverlapKm2!==0||p.sequentialPrior?.mainlandUntouched!==true||p.RUSOriginal?.wkbSha256!==b.originalRUSWkb||!eq(p.operations,b.topologyOperations)||!eq(p.ringStarts,b.ringStarts)||!eq(polArcs,b.polArcs)||
  !keys(p.otherPeers,peers)||peers.some(c=>{const v=p.otherPeers[c];return v?.exactPrePostIntersectionEqual!==true||
   v.exactPrePostBoundaryShareEqual!==true||v.changeAreaKm2!==0;}))fail('reviewed zero-overlap no-loss topology and unchanged peers required');
 return true;
}

export function assertRusPolSeam(next,previous,{prefixes,readEvidence}={}){
 const {binding,frozen,raw,descriptorPath,resourcePath}=registeredRusPol;
 if(typeof readEvidence!=='function'||!hasRusPolSeam(next)||previous?.entityId!==id)fail('pinned RUS archive reader and entity required');
 const nv=active(next),pv=active(previous),v=nv[0],old=pv[0],s=v?.modernBoundarySupplement;
 if(nv.length!==1||pv.length!==1||v.versionId!==version||old.versionId!==version||v.validFrom!==date||old.validFrom!==date||
  next.metadata?.representativeGeometryVersionId!==version||!eq(preserved(next),preserved(previous)))
  fail('dates, selected version, attribution, and unselected geometry must remain exact');
 if(!keys(s,['adoptionMode','status','resultRelation','wholeCountryRaw','priorPreparedAttribution','geometrySha256','seamReview'])||
  s.status!==status||s.resultRelation!=='partial-original-with-readonly-poland-seam'||s.wholeCountryRaw!==false||
  old.modernBoundarySupplement?.adoptionMode!==prior||!eq(s.priorPreparedAttribution,old.modernBoundarySupplement)||
  !eq(s.seamReview,binding.review))fail('only registered partial source and prior attribution required');
 if(!Array.isArray(prefixes)||!eq([...prefixes].sort(),[descriptorPath,resourcePath].sort()))fail('only RUS descriptor and exact new geometry may be written');
 assertInheritedRussia(old,readEvidence);
 assertArchivedCaucasus(readEvidence);
 const r=JSON.parse(bytes(readEvidence,binding.review.reference,binding.review.sha256));
 if(r.schemaVersion!==1||r.sourcePin!==binding.sourcePin||r.method!==rusPolSeamMethod||r.status!==status||r.entityId!==id||
  r.versionId!==version||r.validFrom!==date||r.validTo!==null||!eq(r.vertexCounts,binding.vertexCounts)||
  !eq(r.operations,binding.operations)||!eq(r.topologyOperations,binding.topologyOperations)||!eq(r.ringStarts,binding.ringStarts)||!eq(r.polArcs,binding.polArcs))fail('fixed source review fields required');
 dig(domain(old.geometry),r.previousGeometrySha256,'prior RUS geometry');
 dig(domain(v.geometry),r.geometrySha256,'new RUS geometry');
 dig(hash(JSON.stringify(v.geometry)+'\n'),r.geometryResourceSha256,'new RUS CAS');
 if(s.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometryVersionId!==version)
  fail('current source digest attribution must be correct');
 const proof=JSON.parse(bytes(readEvidence,r.topologyProof.reference,r.topologyProof.sha256));
 const peers=Object.keys(frozen).filter(c=>c!=='POL'&&c!=='RUS');
 assertRusPolTopology(proof,binding,peers);
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
 if(!eq(current.RUS,previous)||!eq(active(current.POL)[0].geometry,originals.POL))fail('pinned RUS and exact unchanged POL required');
 const hist=previous.geometryVersions.filter(w=>w.validTo!==null).map(w=>({versionId:w.versionId,from:w.validFrom,to:w.validTo,resourceSHA:hash(JSON.stringify(w.geometry)+'\n')}));
 if(!eq(hist,priorHistory)||frozen.RUS.resourceSha256!==priorLvaCas||frozen.RUS.geometrySha256!==priorLvaDomain||frozen.LVA?.resourceSha256!==priorLvaDonorCas||frozen.EST?.resourceSha256!==priorEstDonorCas||frozen.AZE?.resourceSha256!==priorAzeDonorCas)fail('unchanged prior source and exact historical CAS required');
 assertPriorAzeArc(old.geometry,v.geometry,active(current.AZE)[0].geometry,priorAzeArc,{polygonIndex:3289,ringIndex:0,start:116435,length:9576});
 assertPriorEstArc(old.geometry,v.geometry,active(current.EST)[0].geometry,priorEstArc,{polygonIndex:3289,ringIndex:0,before:160318,after:160318,length:4793});
 assertKaliningradReplay(old.geometry,v.geometry,originals.POL,binding.operations,binding.ringStarts,binding.polArcs,binding.vertexCounts);
 assertPriorLvaArc(old.geometry,v.geometry,active(current.LVA)[0].geometry,priorLvaArc);
 return 1;
}

const registeredRusPol=Object.freeze({"binding":{"sourcePin":"affe90dfcfd5ff783da8a270c7622bafc74fb5ed","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/rus-pol-original-frontier-20261115/review.json","sha256":"a8262c2ca60b7bee508f033e90ebec1b5f8310ae17101d78a1149cde4e88db41"},"operations":[{"polygonIndex":1,"ringIndex":0,"startIndex":10,"endIndex":13,"raw":{"polygonIndex":38,"ringIndex":0,"startIndex":33068,"endIndex":33064,"direction":-1}},{"polygonIndex":11,"ringIndex":0,"startIndex":411,"endIndex":448,"raw":{"polygonIndex":38,"ringIndex":0,"startIndex":38283,"endIndex":37638,"direction":-1}}],"topologyOperations":[{"polygonIndex":1,"ringIndex":0,"startIndex":10,"endIndex":13,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":1600,"endIndex":1604,"direction":1}},{"polygonIndex":11,"ringIndex":0,"startIndex":411,"endIndex":448,"raw":{"polygonIndex":28,"ringIndex":0,"startIndex":38618,"endIndex":39263,"direction":1}}],"ringStarts":[{"polygonIndex":1,"ringIndex":0,"startIndex":0},{"polygonIndex":11,"ringIndex":0,"startIndex":0}],"polArcs":[{"polygonIndex":38,"ringIndex":0,"startIndex":33068,"endIndex":33064,"direction":-1},{"polygonIndex":38,"ringIndex":0,"startIndex":38283,"endIndex":37638,"direction":-1}],"vertexCounts":[5,646],"originalRUSWkb":"707b022fc4049577b58685185b1c42fe0e27dbabdd50f1e2a64496ac4532004e"},"frozen":{"RUS":{"descriptorSha256":"3b90560aa33f12b2ccac3388f888a88a4af372d2c5384d1891e3407073550f85","geometrySha256":"f36f49e1532c030d9ee6d386acdf4a9c95e8fe3d88696a062e9047313834e6de","resourceSha256":"d23a87a9ee0b74d3b2317c810b24cd8698fb92031f58714cc86e5bc69918464c"},"POL":{"descriptorSha256":"be1b06ae66b5463a123a2455fc17bdef6e863b80b3131196acf77f0439b4ff49","geometrySha256":"454329d6c9a654c4cc4bee1692bd19787ea27779608d9c3c79e00782065b45f0","resourceSha256":"ccdfef130607c3c858b4f3458a0775ca9b7f87b34cfa312f5f9b15e0897c271e"},"LTU":{"descriptorSha256":"57bc42f8824495a654e8f0fbf1b70c1c9c640256eac58a579973a47415d183e8","geometrySha256":"0104c51a2a483cd10b00fc324e0f8f73d23fb9dc36422b41a791f11f20c18fb8","resourceSha256":"8ae8b03af3ce3dac3567a273c88073b8eff5199cb4247ead3052da1bde8434a7"},"DEU":{"descriptorSha256":"f2bf22fd63dbefbd181eae55a6ab0ad10d736f7c77b5529ffed7915ce307f14e","geometrySha256":"719b6d84bea4cd0cfcadbbfabecc0fb79f066446c61abdc7d3d57a9a80191bd7","resourceSha256":"503f41377852b9783c2be99dd30b00555858c225f99ab3190214030e73b73de1"},"BLR":{"descriptorSha256":"b428bfd7d801ec5d142d70ce8ae390c615cb48199f97eb95b15c60fa3bed12ab","geometrySha256":"b62c1f32988ed51f2768d617b361d3a8f010a2b6fff8c58d1a1a3ba422d0c7cf","resourceSha256":"e1bcd7c8c1ee79363d33698197984484e4e3a05372ae784f642ce7c01549cfbb"},"LVA":{"descriptorSha256":"9ef8a6dba3a4c963f797b4b1bebc8262f68fe7c8c63e279147296a56761de45b","geometrySha256":"d331d69ce2bf3992146f50be6482d1688466c270f468d293c86b0c4442958a3b","resourceSha256":"20cf314ae2721811e5ea99fb3f3322da0118af60de6b60ecf3865b0e1e621b33"},"EST":{"descriptorSha256":"4af605358c4edcc2474e010bc7328a859b96b30626d47830a9e021ef052eb4ae","geometrySha256":"79eec602da2604460a2c5b21d2f9bda2a7d5a1ec92cfb1096ffb04143591baaf","resourceSha256":"be7b295f2b35ee0372fb17b77320103d25b9178a52ed221168af4306558ab5b9"},"SWE":{"descriptorSha256":"2cf4a40ef63c1c54b27609fadda35f5c060d72e1ba9a4fbf7fdb9bf21c189ffc","geometrySha256":"ce40305ff936a73920ebedbba87b8e3de293d65020399be5afc46c4ed43643a5","resourceSha256":"9b857b5ebcf85e38852dfc89c3d79fec2cb4bf8ed2996ed1707055235e62da61"},"DNK":{"descriptorSha256":"9b29a2df25a75f7bc0456dbdc316acd1a2e37b216fb4b49a9ee5893a204ceff7","geometrySha256":"edeeae5ce75a8bb8c72165bca9554971d8ce12dff68e01ae227b3530fb46b296","resourceSha256":"e88d07b0266fa0bc197fa599de8cfc1c99e05fa9a80194a1b7ff83501329fa03"},"FIN":{"descriptorSha256":"1068a04b4c0926518c99e32df9515d7a92a85fdbf3320d1c5952cb7cd6433f76","geometrySha256":"67964ab3fb421748a795f740778919272eb7d3901a6ee29264a4842ce9bc6228","resourceSha256":"cd0a7cd7ce06a571d6a2952dcc2e286ce7577b205b45d7c38d941a13c5a0269b"},"AZE":{"descriptorSha256":"393c6df95285cad48390a11d426bccdc1e78fb503ba2efe7462839fd21dc1c6f","geometrySha256":"ee680a6913e4d3408a5ddb6cd09b224765d24e02c9de73abca9699a15f9437e1","resourceSha256":"54acfc4e0ec3237a581434984e25e8c39d2250630d0dccdd9ad151e47063d71a"},"GEO":{"descriptorSha256":"1ddead98444b04832e68ca09dfd0d7a2c0c422a1112bce3b8e1eef9719f51c20","geometrySha256":"865e00ac077a2cd6cc8ef73c9ffa0f8a4d5dbd04925bf07cde04e6c164051126","resourceSha256":"b5d443edaab17852f4dba37f8efcebd45993a376e96a49cd838b23b95ec4ca73"},"UKR":{"descriptorSha256":"ad1d4076b911f4bb8648c4d63013f9024fb2f6d36e2c0fac51b6db92d72a2b93","geometrySha256":"7e3dc7ad1496eda7dcad294946df1e2853ad04d243e2cc3f7dfacb743440e002","resourceSha256":"d2cd0b5bff81ee65c860956a5a8a075502dd80425de40f7dc51ba6881b21e0e1"}},"raw":{"POL":{"path":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-nordic-central-20261113/originals/POL-original.json","sha256":"b0e6d89935f3a86127e526430ccf96cd7b607aae218be6a21b58ee77f6d51a37","feature":"21aa2481-05e4-4dc2-9faf-47c7e3dfc031","wkb":"4ac7ca419af8349625c9ccf3d9e81e812974549c13d846586437015b5c133e29"}},"resourcePath":"assets/data/territorial-entities/source/geometries/sha256-87b24be2294a611c06f36d0b6d6f500821dffaa2980e5174954ec2caaf3b6838.json","descriptorPath":"assets/data/territorial-entities/source/countries/state-RUS.json"});
