import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';

export const sdsUgaSeamMethod='exact-original-sds-uga-readonly-counterpart-seam';
const id='state:SDS', version='state:SDS:2011-07-09-independence-r1';
const date='2011-07-09';
const status='raw-source-only-not-display-approved';
const base='assets/data/territorial-entities/source/';
const prior='exact-original-sds-eth-readonly-counterpart-seam';
const previousWestern='exact-sds-current-western-paired-original-arcs';
const priorEthReportBase='reports/borders/validation/modern-raw-source-20261110/';
const priorEthReview={reference:priorEthReportBase+'sds-eth-original-frontier-20261116/review.json',sha256:'2796c863ed93a590d394862515d159c38bfa8d2c34be391017a9a7842a38b2f5'};
const priorEthTopology={reference:priorEthReportBase+'sds-eth-original-frontier-20261116/topology-proof.json',sha256:'4477970aa23e167b9d0b390ae4f0bef290ea00cdf83fbd68e18dc9b2edbd817e'};
const priorEthCas='96106c661f6f92184cd6ed8fbad3089ec13cf01db9c0b66d8b64a9f464c3c5f3';
const priorEthDomain='2fbcff3211c1e87a3d13725788cb59a1a112f90e8a99b8269faea3240cdd56bb';
const priorEthDonorCas='1762c21831738bf172889805dae53a2199efcc1caee3242c7cb0f41038b4f9ea';
const priorEthArc={polygonIndex:0,ringIndex:0,startIndex:30282,endIndex:7402,direction:-1};
const indices=(g,x)=>exactCyclicChain(g.coordinates[x.polygonIndex][x.ringIndex],x.startIndex,x.endIndex,x.direction);
export function assertPriorWesternWithNine(old,next,raw,ops,ranges,newOps,counts){
 if(ops.length!==ranges.length)fail('exact prior western scope required');
 const o=old.coordinates[1][0],v=next.coordinates[1][0],by={CAF:0,UGA:0};let inserted=0;
 for(const [i,op] of ops.entries()){
  const row=ranges[i],point=indices(raw,op.raw),[s,e]=row.old,[t,u]=row.candidate;
  const advance=newOps.reduce((z,w,j)=>z+(w.endIndex<=s?counts[j]-2:0),0);
  if(op.polygonIndex!==1||op.ringIndex!==0||!(op.peer in by)||row.peer!==op.peer||!eq(row.source,[op.raw.startIndex,op.raw.endIndex])||
   point.length!==op.inserted+2||e-s+1!==point.length||u-t+1!==point.length||t!==s+advance||
   newOps.some(w=>Math.max(s,w.startIndex)<Math.min(e,w.endIndex))||
   !eq(o.slice(s,e+1),point)||!eq(v.slice(t,u+1),point))fail('existing CAF/UGA pointwise scope changed');
  by[op.peer]++;inserted+=op.inserted;
 }
 return {by,inserted};
}
function assertInheritedSds(old,next,eth,read,ranges,ops,counts){
 const r=JSON.parse(bytes(read,priorEthReview.reference,priorEthReview.sha256)),top=JSON.parse(bytes(read,priorEthTopology.reference,priorEthTopology.sha256));
 if(r.method!==prior||r.geometryResourceSha256!==priorEthCas||r.geometrySha256!==priorEthDomain||!eq(r.ethArc,priorEthArc)||!eq(r.topologyProof,priorEthTopology)||top.newOverlapKm2!==0||top.oldCoverageLossKm2!==0||top.sequentialPrior?.westernOperationCount!==325)fail('exact earlier Ethiopia frontier authority required');
 const ethPoints=indices(active(eth)[0].geometry,priorEthArc);
 if(ethPoints.length!==22881||!eq(old.coordinates[1][0].slice(10251,33132),ethPoints)||!eq(next.coordinates[1][0].slice(13578,36459),ethPoints))fail('exact existing Ethiopia frontier coordinates changed');
 const p=JSON.parse(bytes(read,priorReview.reference,priorReview.sha256)),s=JSON.parse(bytes(read,priorSource.reference,priorSource.sha256));
 const pol=bytes(read,protectedPolicy.reference,protectedPolicy.sha256);
 if(!pol.includes('Existing Ilemi/Halaib and localized Kafia Kingi attribution retained.')||p.operations.length!==325||p.inserted!==8900||p.candidateValid!==true||
  s.featureId!=='65f20b50-a947-4f2c-86c6-f221b5539314'||s.rawWkbSha256!=='ebd17db3e43f32906d3de3de5e0f50815063777c687828578a7374646c9e5bac')fail('existing protected SDS and 325-operation source receipts required');
 const b=Buffer.from(s.rawBlobBase64,'base64');dig(hash(b),s.rawBlobSha256,'old South Sudan GPKG source');
 const g=decodeOriginalBlobGeometry(b,{expectedWkbSha256:s.rawWkbSha256});
 const q=assertPriorWesternWithNine(old,next,g,p.operations,ranges,ops,counts);
 if(q.by.CAF!==209||q.by.UGA!==116||q.inserted!==8900)fail('all 325 previously accepted western operations must remain exact');
 return g;
}
export function assertNewUgandaNine(old,next,raw,uga,ops,official,starts,counts){
 const sizes=[138,69,44,32,378,547,423,408,1306];
 if(ops.length!==9||official.length!==9||!eq(counts,sizes)||!eq(starts,[{polygonIndex:1,ringIndex:0,startIndex:0}])||
  ops.some((o,i)=>o.polygonIndex!==1||o.ringIndex!==0||o.endIndex!==o.startIndex+1||(i&&o.startIndex<ops[i-1].endIndex)))fail('nine fixed distinct adjacent-edge replacements required');
 for(const [i,o] of ops.entries()){
  const a=indices(raw,official[i].raw),b=indices(uga,o.raw);
  if(a.length!==sizes[i]||!eq(a,b)||a.slice(1).some((v,j)=>eq(v,a[j])))fail('native Sudan/Uganda ordered reciprocal points required');
 }
 if(!eq(replayRetainedCoast(old,uga,ops,starts),next))fail('exact nine-edge replay and every untouched point required');
 return true;
}

const reports='reports/borders/validation/modern-raw-source-20261110/';
const priorReview={reference:reports+'sds-western-paired-original-20261114/proof.json',sha256:'aea1e4e672d25e1790994135153b7797492df5dae7667a27e399d7d195193c91'};
const priorSource={reference:reports+'sds-western-paired-original-20261114/source.json',sha256:'efb18e746f1da39b18e88335e31300e06c5d43fcdb07de1d00d5b0d05fd37058'};
const protectedPolicy={reference:reports+'excluded-four-current-scope-review-6184fa07/outcome-summary-corrected-254.json',sha256:'40a8c6a0f22ea1d8dfc901873416d65a390b6559c6d77e5ae7e54c04a97ae3cc'};
const priorGeometryDomain='0cbeeb74a30bed9f81fce1d38abc3813c26ae2999dab0b07e128a781f9c0d000';
const priorGeometryCas='3a513755c58d8e293dd6a7eb1b0852a3826fe896b13833a7af43e7a4ad2f7455';
const priorHistory=[];
const sdnVersions=[
 {versionId:'state:sudan:1956-2011-r1',validFrom:'1956-01-01',validTo:'2011-07-08',geometrySHA256:'d6c9d52c96abb4b1ec4e90655c53859fac91db1a01e98009fd32376c22a7193f'},
 {versionId:'state:SDN:2011-07-09-post-secession-r1',validFrom:'2011-07-09',validTo:null,geometrySHA256:'782a2e915d188ca1795bdefae600196834c23e2cde8683b50ef8baf1e53a88c9'}
];
function assertFrozenSudanHistory(e,read,proof){
 if(!eq(proof,sdnVersions)||e?.entityId!=='state:SDN')fail('existing Sudan historical and current versions must be explicitly pinned');
 const actual=e.geometryVersions.map(v=>({versionId:v.versionId,validFrom:v.validFrom,validTo:v.validTo,geometrySHA256:hash(JSON.stringify(v.geometry)+'\n')}));
 if(!eq(actual,sdnVersions))fail('Sudan historical and current readback mismatch');
 for(const x of actual)bytes(read,base+'geometries/sha256-'+x.geometrySHA256+'.json',x.geometrySHA256);
}
export function assertWesternSdsPoints(old,next,raw,ops,ranges,selected,newCount){
 const ob=old.coordinates[1][0],nb=next.coordinates[1][0],q=raw.coordinates[0][0];
 if(!Array.isArray(ops)||!Array.isArray(ranges)||ops.length!==ranges.length||selected.polygonIndex!==1||selected.ringIndex!==0||selected.startIndex>=selected.endIndex)fail('prior western route and selected eastern bounds required');
 const shift=newCount-(selected.endIndex-selected.startIndex+1),counts={CAF:0,UGA:0};let inserted=0;
 for(const [i,o] of ops.entries()){
  const a=o.raw,w=ranges[i],n=o.inserted+2;
  if(o.polygonIndex!==1||o.ringIndex!==0||a?.polygonIndex!==0||a.ringIndex!==0||
   !(o.peer in counts)||w?.peer!==o.peer||n!==w.pointCount||!Number.isSafeInteger(w.old)||!Number.isSafeInteger(w.new)||w.old<0||w.new<0||
   !(w.old+n-1<selected.startIndex||w.old>selected.endIndex)||w.new!==w.old+(w.old>selected.endIndex?shift:0)||
   !eq(w.raw,[a.startIndex,a.endIndex,a.direction]))fail('prior CAF/UGA operation fell outside permitted invariants');
  const points=exactCyclicChain(q,a.startIndex,a.endIndex,a.direction);
  if(points.length!==n||!eq(ob.slice(w.old,w.old+n),points)||!eq(nb.slice(w.new,w.new+n),points))fail('previous CAF/UGA vertices changed pointwise');
  counts[o.peer]++;inserted+=n-2;
 }
 return {counts,inserted};
}
function assertExistingWesternArcs(old,next,read,ranges,selected){
 const p=JSON.parse(bytes(read,priorReview.reference,priorReview.sha256));
 const s=JSON.parse(bytes(read,priorSource.reference,priorSource.sha256));
 const pol=bytes(read,protectedPolicy.reference,protectedPolicy.sha256);
 if(!pol.includes('Existing Ilemi/Halaib and localized Kafia Kingi attribution retained.')||p.operations.length!==325||p.inserted!==8900||p.candidateValid!==true||s.genCode!=='SSD'||s.featureId!=='65f20b50-a947-4f2c-86c6-f221b5539314'||
  s.rawWkbSha256!=='ebd17db3e43f32906d3de3de5e0f50815063777c687828578a7374646c9e5bac')fail('fixed prior western operations and political retention policy required');
 const raw=Buffer.from(s.rawBlobBase64,'base64');dig(hash(raw),s.rawBlobSha256,'old SDS GPKG source');
 const g=decodeOriginalBlobGeometry(raw,{expectedWkbSha256:s.rawWkbSha256});
 const q=assertWesternSdsPoints(old,next,g,p.operations,ranges,selected,22881);
 if(q.counts.CAF!==209||q.counts.UGA!==116||q.inserted!==8900)fail('all 325 earlier CAF/UGA operations must remain exact');
}
export function assertOutsideSdsReplay(old,next,o,count){
 const a=old.type==='MultiPolygon'?old.coordinates:null,b=next.type==='MultiPolygon'?next.coordinates:null;
 const p=a?.[1]?.[0],q=b?.[1]?.[0];
 if(!p||!q||o.polygonIndex!==1||o.ringIndex!==0||a.length!==b.length||
  !eq(p.slice(0,o.startIndex+1),q.slice(0,o.startIndex+1))||!eq(p.slice(o.endIndex),q.slice(o.startIndex+count-1))||
  a.some((poly,i)=>poly.length!==b[i]?.length||poly.some((r,j)=>(i!==1||j!==0)&&!eq(r,b[i][j]))))fail('old Ilemi/Kafia and all points outside the selected eastern arc must remain exact');
 return true;
}

const hash=b=>createHash('sha256').update(b).digest('hex');
const domain=g=>hash(JSON.stringify([g.type,g.coordinates]));
const fail=message=>{throw Error('SDS/UGA exact current seam: '+message);};
const keys=(o,names)=>o&&eq(Object.keys(o).sort(),[...names].sort());
const omit=(o,...names)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!names.includes(k)));
const active=e=>e.geometryVersions.filter(x=>x.validTo===null);
const preserved=e=>({...e,sourceInfo:omit(e.sourceInfo,'geometrySha256','geometryVersionId'),
 geometryVersions:e.geometryVersions.map(x=>x.versionId===version?omit(x,'geometry','modernBoundarySupplement'):x)});
const dig=(a,b,label)=>{if(a!==b)fail(label+' digest mismatch');};
const bytes=(read,p,h)=>{const x=read(p);if(!Buffer.isBuffer(x))fail(p+' exact archived bytes required');dig(hash(x),h,p);return x;};
export const hasSdsUgaSeam=e=>e?.entityId===id&&e?.geometryVersions?.some(x=>x.validTo===null&&x.modernBoundarySupplement?.adoptionMode===sdsUgaSeamMethod)===true;

export function assertSdsUgaTopology(p,b,peers){
 const ugaArcs=p.UGADonors;
 if(p.pin!==b.sourcePin||p.newPairDE9IM!=='FF2F11212'||p.newOverlapKm2!==0||p.newPositiveOverlapPolygonCount!==0||
  p.oldCoverageLossKm2!==0||p.oldCoverageLossPolygonCount!==0||p.allArcEdgesExactReciprocal!==true||
  !p.sequentialPrior||!eq(p.sequentialPrior.history,priorHistory)||p.sequentialPrior.outsideExact!==true||p.sequentialPrior.protectedIlemiKafia!==true||p.sequentialPrior.originalSdnKenTripoints!==true||p.sequentialPrior.ethFullPreserved!==true||p.sequentialPrior.ethOldOverlapKm2!==0||p.sequentialPrior.noNewContact!==true||p.sequentialPrior.westernOperationCount!==325||p.sequentialPrior.westernInserted!==8900||p.SDSOriginal?.wkbSha256!==b.originalSDSWkb||!eq(p.operations,b.topologyOperations)||!eq(p.ringStarts,b.ringStarts)||!eq(ugaArcs,b.ugaArcs)||
  !keys(p.otherPeers,peers)||peers.some(c=>{const v=p.otherPeers[c];return v?.exactPrePostIntersectionEqual!==true||
   v.exactPrePostBoundaryShareEqual!==true||v.changeAreaKm2!==0;}))fail('reviewed zero-overlap no-loss topology and unchanged peers required');
 return true;
}

export function assertSdsUgaSeam(next,previous,{prefixes,readEvidence}={}){
 const {binding,frozen,raw,descriptorPath,resourcePath}=registeredSdsUga;
 if(typeof readEvidence!=='function'||!hasSdsUgaSeam(next)||previous?.entityId!==id)fail('pinned SDS archive reader and entity required');
 const nv=active(next),pv=active(previous),v=nv[0],old=pv[0],s=v?.modernBoundarySupplement;
 if(nv.length!==1||pv.length!==1||v.versionId!==version||old.versionId!==version||v.validFrom!==date||old.validFrom!==date||
  next.metadata?.representativeGeometryVersionId!==version||!eq(preserved(next),preserved(previous)))
  fail('dates, selected version, attribution, and unselected geometry must remain exact');
 if(!keys(s,['adoptionMode','status','resultRelation','wholeCountryRaw','priorPreparedAttribution','geometrySha256','seamReview'])||
  s.status!==status||s.resultRelation!=='partial-original-with-readonly-uganda-seam'||s.wholeCountryRaw!==false||
  old.modernBoundarySupplement?.adoptionMode!==prior||!eq(s.priorPreparedAttribution,old.modernBoundarySupplement)||
  !eq(s.seamReview,binding.review))fail('only registered partial source and prior attribution required');
 if(!Array.isArray(prefixes)||!eq([...prefixes].sort(),[descriptorPath,resourcePath].sort()))fail('only SDS descriptor and exact new geometry may be written');
 if(!eq(old.modernBoundarySupplement?.seamReview,priorEthReview)||domain(old.geometry)!==priorEthDomain||old.modernBoundarySupplement?.priorPreparedAttribution?.adoptionMode!==previousWestern||!eq(old.modernBoundarySupplement?.priorPreparedAttribution?.sourceAdoptionReview,priorReview))fail('exact previously approved CAF/UGA replay required');
 const r=JSON.parse(bytes(readEvidence,binding.review.reference,binding.review.sha256));
 if(r.schemaVersion!==1||r.sourcePin!==binding.sourcePin||r.method!==sdsUgaSeamMethod||r.status!==status||r.entityId!==id||
  r.versionId!==version||r.validFrom!==date||r.validTo!==null||!eq(r.vertexCounts,binding.vertexCounts)||
  !eq(r.operations,binding.operations)||!eq(r.topologyOperations,binding.topologyOperations)||!eq(r.ringStarts,binding.ringStarts)||!eq(r.ugaArcs,binding.ugaArcs))fail('fixed source review fields required');
 dig(domain(old.geometry),r.previousGeometrySha256,'prior SDS geometry');
 dig(domain(v.geometry),r.geometrySha256,'new SDS geometry');
 dig(hash(JSON.stringify(v.geometry)+'\n'),r.geometryResourceSha256,'new SDS CAS');
 if(s.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometryVersionId!==version)
  fail('current source digest attribution must be correct');
 const proof=JSON.parse(bytes(readEvidence,r.topologyProof.reference,r.topologyProof.sha256));
 const peers=Object.keys(frozen).filter(c=>c!=='UGA'&&c!=='SDS');
 assertSdsUgaTopology(proof,binding,peers);
 const originals={},current={};
 for(const c of ['UGA']){
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
 if(!eq(current.SDS,previous)||!eq(active(current.UGA)[0].geometry,originals.UGA))fail('pinned SDS and exact unchanged UGA required');
 const rawSds=assertInheritedSds(old.geometry,v.geometry,current.ETH,readEvidence,proof.sequentialPrior.westernRanges,binding.operations,binding.vertexCounts);
 assertFrozenSudanHistory(current.SDN,readEvidence,proof.sequentialPrior.sdnHistory);
 assertNewUgandaNine(old.geometry,v.geometry,rawSds,originals.UGA,binding.operations,binding.topologyOperations,binding.ringStarts,binding.vertexCounts);
 return 1;
}

const registeredSdsUga=Object.freeze({"binding":{"sourcePin":"5a8bda140835ef997627a4f4e377b92606cf4083","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/sds-uga-original-frontier-20261116/review.json","sha256":"bd33ac9cc8ff96959db904c40fcdbc5c8779f9cfc2958c327f7681a8f22b151f"},"operations":[{"polygonIndex":1,"ringIndex":0,"startIndex":13,"endIndex":14,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":31710,"endIndex":31573,"direction":-1}},{"polygonIndex":1,"ringIndex":0,"startIndex":14,"endIndex":15,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":31573,"endIndex":31505,"direction":-1}},{"polygonIndex":1,"ringIndex":0,"startIndex":15,"endIndex":16,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":31505,"endIndex":31462,"direction":-1}},{"polygonIndex":1,"ringIndex":0,"startIndex":16,"endIndex":17,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":31462,"endIndex":31431,"direction":-1}},{"polygonIndex":1,"ringIndex":0,"startIndex":4093,"endIndex":4094,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":27355,"endIndex":26978,"direction":-1}},{"polygonIndex":1,"ringIndex":0,"startIndex":5968,"endIndex":5969,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":25104,"endIndex":24558,"direction":-1}},{"polygonIndex":1,"ringIndex":0,"startIndex":7238,"endIndex":7239,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":23289,"endIndex":22867,"direction":-1}},{"polygonIndex":1,"ringIndex":0,"startIndex":8062,"endIndex":8063,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":22044,"endIndex":21637,"direction":-1}},{"polygonIndex":1,"ringIndex":0,"startIndex":8063,"endIndex":8064,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":21637,"endIndex":20332,"direction":-1}}],"topologyOperations":[{"polygonIndex":1,"ringIndex":0,"startIndex":13,"endIndex":14,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":40143,"endIndex":40280,"direction":1}},{"polygonIndex":1,"ringIndex":0,"startIndex":14,"endIndex":15,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":40280,"endIndex":40348,"direction":1}},{"polygonIndex":1,"ringIndex":0,"startIndex":15,"endIndex":16,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":40348,"endIndex":40391,"direction":1}},{"polygonIndex":1,"ringIndex":0,"startIndex":16,"endIndex":17,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":40391,"endIndex":40422,"direction":1}},{"polygonIndex":1,"ringIndex":0,"startIndex":4093,"endIndex":4094,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":44498,"endIndex":44875,"direction":1}},{"polygonIndex":1,"ringIndex":0,"startIndex":5968,"endIndex":5969,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":46749,"endIndex":47295,"direction":1}},{"polygonIndex":1,"ringIndex":0,"startIndex":7238,"endIndex":7239,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":48564,"endIndex":48986,"direction":1}},{"polygonIndex":1,"ringIndex":0,"startIndex":8062,"endIndex":8063,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":49809,"endIndex":50216,"direction":1}},{"polygonIndex":1,"ringIndex":0,"startIndex":8063,"endIndex":8064,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":50216,"endIndex":51521,"direction":1}}],"ringStarts":[{"polygonIndex":1,"ringIndex":0,"startIndex":0}],"ugaArcs":[{"polygonIndex":0,"ringIndex":0,"startIndex":31710,"endIndex":31573,"direction":-1},{"polygonIndex":0,"ringIndex":0,"startIndex":31573,"endIndex":31505,"direction":-1},{"polygonIndex":0,"ringIndex":0,"startIndex":31505,"endIndex":31462,"direction":-1},{"polygonIndex":0,"ringIndex":0,"startIndex":31462,"endIndex":31431,"direction":-1},{"polygonIndex":0,"ringIndex":0,"startIndex":27355,"endIndex":26978,"direction":-1},{"polygonIndex":0,"ringIndex":0,"startIndex":25104,"endIndex":24558,"direction":-1},{"polygonIndex":0,"ringIndex":0,"startIndex":23289,"endIndex":22867,"direction":-1},{"polygonIndex":0,"ringIndex":0,"startIndex":22044,"endIndex":21637,"direction":-1},{"polygonIndex":0,"ringIndex":0,"startIndex":21637,"endIndex":20332,"direction":-1}],"vertexCounts":[138,69,44,32,378,547,423,408,1306],"originalSDSWkb":"ebd17db3e43f32906d3de3de5e0f50815063777c687828578a7374646c9e5bac"},"frozen":{"SDS":{"descriptorSha256":"cf09c898d35905664d110407cee9b92e01f6bf70998fc5c87b87ccff29964b73","geometrySha256":"2fbcff3211c1e87a3d13725788cb59a1a112f90e8a99b8269faea3240cdd56bb","resourceSha256":"96106c661f6f92184cd6ed8fbad3089ec13cf01db9c0b66d8b64a9f464c3c5f3"},"UGA":{"descriptorSha256":"29138906fc8319dc0558f2854dc0876f706d049a2abb735039de4a751e419162","geometrySha256":"6455d8e903087c36765c38e45829e763d5abf3994e02704f7c70d8af67332e9c","resourceSha256":"a2f008cb77924cf34c86147be0d5f7b7a235d34a8fb32a040a54f15a34dbf097"},"ETH":{"descriptorSha256":"b3ec88e2f59d652312bf9e3c4535360cc682116077b4398a7154a0121719a36a","geometrySha256":"11fc7878eeb542f413c9765f61c9bda0a5040d356b2331e2670e58596e302825","resourceSha256":"1762c21831738bf172889805dae53a2199efcc1caee3242c7cb0f41038b4f9ea"},"KEN":{"descriptorSha256":"634a1e2e2fd7e7723b8945d3f93d5e61504d73e11a879f077a04df6b9172e7d2","geometrySha256":"1d1022c882a515cf5e37eb0393b15140d72c268544ec1f296b7ea98805780c50","resourceSha256":"b6591eaf9d70a0e7f6f99c2799108d654019774d44102bb04dd8fc81431794c2"},"SDN":{"descriptorSha256":"3dd6378957c056be7a0fa6d30cbbe18eb475504c5fe04c9fd7884bac6d24d2b5","geometrySha256":"7502e2f1f95c1622eb6ee8f8d80e68350757dae73ec1da48f0fdda89dfb02690","resourceSha256":"782a2e915d188ca1795bdefae600196834c23e2cde8683b50ef8baf1e53a88c9"},"CAF":{"descriptorSha256":"48c06dee942ec7918ed4cc1196e572236187b67b7ff7a07ecff0a56b427b340f","geometrySha256":"03961da63bed83a8abcfd3a44cf990a6c0167b6fcc0cf427824d67c2373c2294","resourceSha256":"c7e0b97f8a5e22639f1d6d59895e707bb65c84476123f43ecb35950d573cc51b"},"COD":{"descriptorSha256":"9a66aea1130689e7909ce37866a4573f7802ead6c982715d6e4a04dc54f2249a","geometrySha256":"cfd47bd4e42222a8f0529a4fc8af3294a357a85db33c21121f700a7d55916e80","resourceSha256":"9cc9f468a6de45edd285b916e2f1d13ac9e05e4ca9d5e640a74c454796f9c7dd"}},"raw":{"UGA":{"path":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-mediterranean-africa-20261113/originals/UGA-original.json","sha256":"468a1463514b973d72c4cbf5467986160d8d025fc45e63c1b85ada3d36784a75","feature":"6c945c1e-2775-4d6f-88c5-fd7b70112546","wkb":"2c21f457f736b0eff648f34a52717c1c6f916877855bb6ee5e31e187ef66bb0c"}},"resourcePath":"assets/data/territorial-entities/source/geometries/sha256-b3ff003ccc29516e52fc2d899db9f60571990c62bef42723095d1a0fe1d8e537.json","descriptorPath":"assets/data/territorial-entities/source/countries/state-SDS.json"});
