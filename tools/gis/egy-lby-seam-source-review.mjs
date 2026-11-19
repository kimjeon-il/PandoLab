import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';

export const egyLbySeamMethod='exact-original-egy-lby-readonly-counterpart-seam';
const id='state:EGY', version='state:EGY:natural-earth-5.1.1';
const date=null;
const status='raw-source-only-not-display-approved';
const base='assets/data/territorial-entities/source/';
const prior='exact-original-retained-coast-arcs-current-batch';
const rdir='reports/borders/validation/modern-raw-source-20261110/egy-med-coast-20261114/';
const priorReview={reference:rdir+'review.json',sha256:'a6f756c3ed17b8904e946709a0330c07de5719be73244c6d365493be691802d1'};
const priorPolicy={reference:rdir+'policy.json',sha256:'fa5521dd41d5e339d252d2011ebccd5cf693c57b0b2d2f5041fc9b2c7ce2cc5e'};
const priorPartition={reference:rdir+'partition-proof.json',sha256:'b500cfa2bc0579863052d691d74a219d316a8b7d96238780d04ba8da10584d97'};
const priorOriginal={reference:rdir+'original.json',sha256:'c1913f919399a505b3beb5a3fd6d5557d908cc14c3a73968dde5fd7e94b0c973'};
const priorGeometryDomain='f0dd70bc0e71349b138b18b3eb89e05dc9e57b91a02a16bf1a12510ab65fb990';
const priorGeometryCas='dd0bc41dce74554fa57f70baa7c42da174fb75ee4fa15773b85e34545112d682';
const priorHistory=[];
export function assertExactPreviousCoastPoints(old,next,raw,operations,ranges,newOperation){
 const oldRing=old.coordinates[0][0],nextRing=next.coordinates[0][0],source=raw.coordinates[0][0];
 if(!Array.isArray(operations)||!Array.isArray(ranges)||operations.length!==ranges.length||newOperation.polygonIndex!==0||newOperation.ringIndex!==0)fail('previous coast operations and exact limits required');
 let inserted=0;
 for(const [i,op] of operations.entries()){
  const a=op.raw,[lo,hi]=ranges[i];
  if(op.polygonIndex!==0||op.ringIndex!==0||a?.polygonIndex!==0||a.ringIndex!==0||!Number.isSafeInteger(lo)||!Number.isSafeInteger(hi)||lo<0||hi>=newOperation.startIndex||lo>=hi)fail('prior coastline not outside selected clearance');
  const points=exactCyclicChain(source,a.startIndex,a.endIndex,a.direction);
  if(points.length!==hi-lo+1||!eq(oldRing.slice(lo,hi+1),points)||!eq(nextRing.slice(lo,hi+1),points))fail('previous Mediterranean coast changed');
  inserted+=points.length-2;
 }
 return inserted;
}
function assertPriorMediterraneanCoast(old,next,read,ranges,op){
 const r=JSON.parse(bytes(read,priorReview.reference,priorReview.sha256));
 const pp=JSON.parse(bytes(read,priorPartition.reference,priorPartition.sha256));
 const raw=JSON.parse(bytes(read,priorOriginal.reference,priorOriginal.sha256));
 if(r.method!==prior||r.geometryResourceSha256!==priorGeometryCas||r.geometrySha256!==priorGeometryDomain||r.operations.length!==300||!eq(r.source,priorOriginal)||!eq(r.policy,priorPolicy)||
  pp.operationCount!==300||pp.insertedVertexCount!==3730||!eq(pp.operations,r.operations)||raw.rawWkbSha256!=='b21708f6060665431477d41917f2de74642c7dd184dae03e65e546ee51712edf'||
  raw.featureId!=='953efe22-01f1-4613-add9-16c086af943f')fail('exact archived 300-operation prior coast required');
 bytes(read,priorPolicy.reference,priorPolicy.sha256);
 const blob=Buffer.from(raw.rawBlobBase64,'base64');dig(hash(blob),raw.rawBlobSha256,'old Egyptian coastline GPKG');
 const rawG=decodeOriginalBlobGeometry(blob,{expectedWkbSha256:raw.rawWkbSha256});
 if(assertExactPreviousCoastPoints(old,next,rawG,r.operations,ranges,op)!==3730)fail('all 3730 previously inserted coast points must stay exact');
}

export function assertExactlyUnselectedEgyPoints(previous,next,operation,pointCount){
 const rings=g=>g.type==='Polygon'?[g.coordinates]:g.type==='MultiPolygon'?g.coordinates:null;
 const a=rings(previous),b=rings(next);
 const p=a?.[operation.polygonIndex]?.[operation.ringIndex],n=b?.[operation.polygonIndex]?.[operation.ringIndex];
 if(!p||!n||a.length!==b.length||operation.startIndex>=operation.endIndex||
  !eq(p.slice(0,operation.startIndex+1),n.slice(0,operation.startIndex+1))||
  !eq(p.slice(operation.endIndex),n.slice(operation.startIndex+pointCount-1))||
  a.some((poly,i)=>poly.length!==b[i]?.length||poly.some((ring,j)=>(i!==operation.polygonIndex||j!==operation.ringIndex)&&!eq(ring,b[i][j]))))
 fail('any points outside the registered western arc, including coast and policy boundaries, must stay exact');
 return true;
}

const hash=b=>createHash('sha256').update(b).digest('hex');
const domain=g=>hash(JSON.stringify([g.type,g.coordinates]));
const fail=message=>{throw Error('EGY/LBY exact current seam: '+message);};
const keys=(o,names)=>o&&eq(Object.keys(o).sort(),[...names].sort());
const omit=(o,...names)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!names.includes(k)));
const active=e=>e.geometryVersions.filter(x=>x.validTo===null);
const preserved=e=>({...e,sourceInfo:omit(e.sourceInfo,'geometrySha256','geometryVersionId'),
 geometryVersions:e.geometryVersions.map(x=>x.versionId===version?omit(x,'geometry','modernBoundarySupplement'):x)});
const dig=(a,b,label)=>{if(a!==b)fail(label+' digest mismatch');};
const bytes=(read,p,h)=>{const x=read(p);if(!Buffer.isBuffer(x))fail(p+' exact archived bytes required');dig(hash(x),h,p);return x;};
export const hasEgyLbySeam=e=>e?.entityId===id&&e?.geometryVersions?.some(x=>x.validTo===null&&x.modernBoundarySupplement?.adoptionMode===egyLbySeamMethod)===true;

export function assertEgyLbyTopology(p,b,peers){
 const {openRingVertexCount,...lbyArc}=p.LBYDonor??{};
 if(p.pin!==b.sourcePin||p.newPairDE9IM!=='FF2F11212'||p.newOverlapKm2!==0||p.newPositiveOverlapPolygonCount!==0||
  p.oldCoverageLossKm2!==0||p.oldCoverageLossPolygonCount!==0||p.allArcEdgesExactReciprocal!==true||
  !p.sequentialPrior||!eq(p.sequentialPrior.history,priorHistory)||p.sequentialPrior.pointwiseOutsideChosenArc!==true||p.sequentialPrior.halaibSeparateExcluded!==true||p.sequentialPrior.sdnBoundaryExact!==true||p.sequentialPrior.retainedCoastOperationCount!==300||p.sequentialPrior.retainedCoastInsertedVertices!==3730||!eq(p.sequentialPrior.protectedZoneNames,["Hala'ib Triangle",'Bir Tawil'])||p.EGYOriginal?.wkbSha256!==b.originalEGYWkb||!eq(p.operations,[b.topologyOperation])||!eq(p.ringStarts,[b.ringStart])||!eq(lbyArc,b.lbyArc)||
  !keys(p.otherPeers,peers)||peers.some(c=>{const v=p.otherPeers[c];return v?.exactPrePostIntersectionEqual!==true||
   v.exactPrePostBoundaryShareEqual!==true||v.changeAreaKm2!==0;}))fail('reviewed zero-overlap no-loss topology and unchanged peers required');
 return true;
}

export function assertEgyLbySeam(next,previous,{prefixes,readEvidence}={}){
 const {binding,frozen,raw,descriptorPath,resourcePath}=registeredEgyLby;
 if(typeof readEvidence!=='function'||!hasEgyLbySeam(next)||previous?.entityId!==id)fail('pinned EGY archive reader and entity required');
 const nv=active(next),pv=active(previous),v=nv[0],old=pv[0],s=v?.modernBoundarySupplement;
 if(nv.length!==1||pv.length!==1||v.versionId!==version||old.versionId!==version||v.validFrom!==date||old.validFrom!==date||
  next.metadata?.representativeGeometryVersionId!==version||!eq(preserved(next),preserved(previous)))
  fail('dates, selected version, attribution, and unselected geometry must remain exact');
 if(!keys(s,['adoptionMode','status','resultRelation','wholeCountryRaw','priorPreparedAttribution','geometrySha256','seamReview'])||
  s.status!==status||s.resultRelation!=='partial-original-with-readonly-libya-seam'||s.wholeCountryRaw!==false||
  old.modernBoundarySupplement?.adoptionMode!==prior||!eq(s.priorPreparedAttribution,old.modernBoundarySupplement)||
  !eq(s.seamReview,binding.review))fail('only registered partial source and prior attribution required');
 if(!Array.isArray(prefixes)||!eq([...prefixes].sort(),[descriptorPath,resourcePath].sort()))fail('only EGY descriptor and exact new geometry may be written');
 if(!eq(old.modernBoundarySupplement?.retainedCoastReview,priorReview)||domain(old.geometry)!==priorGeometryDomain)fail('exact prior retained Mediterranean coast required');
 const r=JSON.parse(bytes(readEvidence,binding.review.reference,binding.review.sha256));
 if(r.schemaVersion!==1||r.sourcePin!==binding.sourcePin||r.method!==egyLbySeamMethod||r.status!==status||r.entityId!==id||
  r.versionId!==version||r.validFrom!==date||r.validTo!==null||r.vertexCount!==binding.vertexCount||
  !eq(r.operation,binding.operation)||!eq(r.topologyOperation,binding.topologyOperation)||!eq(r.ringStart,binding.ringStart)||!eq(r.lbyArc,binding.lbyArc))fail('fixed source review fields required');
 dig(domain(old.geometry),r.previousGeometrySha256,'prior EGY geometry');
 dig(domain(v.geometry),r.geometrySha256,'new EGY geometry');
 dig(hash(JSON.stringify(v.geometry)+'\n'),r.geometryResourceSha256,'new EGY CAS');
 if(s.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometryVersionId!==version)
  fail('current source digest attribution must be correct');
 const proof=JSON.parse(bytes(readEvidence,r.topologyProof.reference,r.topologyProof.sha256));
 const peers=Object.keys(frozen).filter(c=>c!=='LBY'&&c!=='EGY');
 assertEgyLbyTopology(proof,binding,peers);
 const originals={},current={};
 for(const c of ['LBY']){
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
 if(!eq(current.EGY,previous)||!eq(active(current.LBY)[0].geometry,originals.LBY))fail('pinned EGY and exact unchanged LBY required');
 assertPriorMediterraneanCoast(old.geometry,v.geometry,readEvidence,proof.sequentialPrior.previouslyStoredCoastRanges,binding.operation);
 const hist=previous.geometryVersions.filter(w=>w.validTo!==null).map(w=>({versionId:w.versionId,from:w.validFrom,to:w.validTo,resourceSHA:hash(JSON.stringify(w.geometry)+'\n')}));
 if(!eq(hist,priorHistory)||frozen.EGY.resourceSha256!==priorGeometryCas||frozen.EGY.geometrySha256!==priorGeometryDomain)fail('unaltered historic slots and exact prior current CAS required');
 const arc=(g,x)=>exactCyclicChain(g.coordinates[x.polygonIndex][x.ringIndex],x.startIndex,x.endIndex,x.direction);
 const op=binding.operation, points=arc(originals.LBY,op.raw);
 if(!eq(op.raw,binding.lbyArc)||op.ringIndex!==0||op.raw.ringIndex!==0||binding.lbyArc.ringIndex!==0||points.length!==binding.vertexCount||
  !eq(points,arc(originals.LBY,binding.lbyArc))||points.slice(1).some((p,i)=>eq(p,points[i])))fail('one exact reciprocal LSIB exterior arc required');
 assertExactlyUnselectedEgyPoints(old.geometry,v.geometry,op,binding.vertexCount);
 if(!eq(replayRetainedCoast(old.geometry,originals.LBY,[op],[binding.ringStart]),v.geometry))
  fail('candidate must be exact replay with all other rings and polygons preserved');
 return 1;
}

const registeredEgyLby=Object.freeze({"binding":{"sourcePin":"e4a7b3883b9ade9dc921fd4e90b3e15378817b97","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/egy-lby-original-frontier-20261115/review.json","sha256":"a941010071e042640acc2a4abb63d7749b82f9aaa076d3cce34d049ea4363795"},"operation":{"polygonIndex":0,"ringIndex":0,"startIndex":5215,"endIndex":5279,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":13475,"endIndex":12224,"direction":-1}},"topologyOperation":{"polygonIndex":0,"ringIndex":0,"startIndex":5215,"endIndex":5279,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":16469,"endIndex":17720,"direction":1}},"ringStart":{"polygonIndex":0,"ringIndex":0,"startIndex":0},"lbyArc":{"polygonIndex":0,"ringIndex":0,"startIndex":13475,"endIndex":12224,"direction":-1},"vertexCount":1252,"originalEGYWkb":"b21708f6060665431477d41917f2de74642c7dd184dae03e65e546ee51712edf"},"frozen":{"EGY":{"descriptorSha256":"b1b9cdfa45d5d28817940221de7fd79a6206bbf08c0f7c6ec3ede7d3ba4758b8","geometrySha256":"f0dd70bc0e71349b138b18b3eb89e05dc9e57b91a02a16bf1a12510ab65fb990","resourceSha256":"dd0bc41dce74554fa57f70baa7c42da174fb75ee4fa15773b85e34545112d682"},"LBY":{"descriptorSha256":"ceb3ffada9ae759270612861d0f198e87d1dfa7b0e50d3cf33a744a2a955e88e","geometrySha256":"a9d2011d31c271650132447ab0e0fa7af79b5db355206b07cca26b751b16f06f","resourceSha256":"bd919defe47e011ed4b6c69b9255099f0f6558955fe7f95c38cbb9675274c8e5"},"SDN":{"descriptorSha256":"3dd6378957c056be7a0fa6d30cbbe18eb475504c5fe04c9fd7884bac6d24d2b5","geometrySha256":"7502e2f1f95c1622eb6ee8f8d80e68350757dae73ec1da48f0fdda89dfb02690","resourceSha256":"782a2e915d188ca1795bdefae600196834c23e2cde8683b50ef8baf1e53a88c9"},"BRT":{"descriptorSha256":"2be93e04d2debb3358ba729c0508411c54b6bb7727a970f43b988c39a0558020","geometrySha256":"5b285e17de01ee320d0d2cdcdba398572b3db8923e0ee8ed0ac9a2bd793299ca","resourceSha256":"aab6545be0b74bfa540f8be06482e4f510f212713d036a40ca83157dcf40d4e6"},"SDS":{"descriptorSha256":"53a7af48af8b6c1cba5342778c0e9e0c09bea4c23abe198ab5dee6a3b9440160","geometrySha256":"0cbeeb74a30bed9f81fce1d38abc3813c26ae2999dab0b07e128a781f9c0d000","resourceSha256":"3a513755c58d8e293dd6a7eb1b0852a3826fe896b13833a7af43e7a4ad2f7455"},"TCD":{"descriptorSha256":"73821f8ef5454ca15fb4b0f3593ae38f8e1623e60703278cc0bcb4f9a2bba536","geometrySha256":"36621e26185aa0874a412cb229bb98c9d5706b281fc07fff22269e496b8308f6","resourceSha256":"6640940231fd1412245cac08996d0561a0521d6794c30f29613e230a30c74537"},"NER":{"descriptorSha256":"10b26af51d7a51bfc8f32e9f8776d21509757ac18587b803f0cb1e431392e175","geometrySha256":"a10e314b0b4857eda53b4f2dafa515b2eab843a23de4169f77f8142d10717aab","resourceSha256":"672e36202dfe4001fb098c34231e2d1faf489c52344c5fc8d4b9608b2ecf0e8f"},"TUN":{"descriptorSha256":"6dcf15b5eda5cf957235f2489381cca691f7bf587d573302aaf77ed748f31e98","geometrySha256":"266eecf0d6673cab690c4639ff7ccc43bef15900d5700af50f933a80b1d2ace6","resourceSha256":"d8192164308ebbec7ce4fb9f78511ed0e09c01855ed3311f9a25bd6fbd9285e6"},"DZA":{"descriptorSha256":"5ca130852a4ee52f4a5846959735358c594d033eeadacd0e147fa027a0b6ecd6","geometrySha256":"e67d37cc83d1bc3343ff657a961be05d9665cd4f02a796250e6a68f880c208b5","resourceSha256":"8cb3fa1b39c5cf8d4d62056bb5cfcbc32e478994048e88e1bd18bb0822afadc8"},"CYP":{"descriptorSha256":"b19b36b77f0b604242a8d156d3939bdb317a87e0ca5f6f8fdab958d037f60d35","geometrySha256":"5ad9291a31ac4894e4bc14d74fec6bc76cd0ef51b1365d373ac19e807d9aa893","resourceSha256":"b0ab324d5c3322420ecd7bae5a9b2543b0182c61e9fa5538b23d7ddadfede990"},"GRC":{"descriptorSha256":"7eb6ed6981619e853cde5b254b04f985376160200a7957dc54b6b922e09ac29f","geometrySha256":"717eef1f29df8169182972e0be438686a2ee5533779a90380960291218531e10","resourceSha256":"60548c28ae57a492df83bb845dfbca7b08f376ffddaa9a1338b82a82b9cb920b"},"TUR":{"descriptorSha256":"2f93315eca2fa88a2f81ea95a30c66170e170ab46757966076746af09214da0a","geometrySha256":"42c841e80c88f0af39eade07f739e4d27996a49d85dcc6f79ffca9e11ec54894","resourceSha256":"92b804ee918e3cddceab797d885d25884a41928a44839056e2ba4bfbe7ecb024"},"ISR":{"descriptorSha256":"da510fb72fe17ee405fe329805ed0a2949ab8d772e5c1b51fe599611e9537c85","geometrySha256":"1f467ba0a3b2cef6413a5eebc30213be600ae5bea70e45f951cf42992de791ca","resourceSha256":"a0cff20aeaac2c9d1da26be65132a49ca7756a248349d18fb9aa233fa6b65d5a"},"PSX":{"descriptorSha256":"374f69422ce8a0e48328abae77fad6e256e4ed7ea80453b342d921925d1a1694","geometrySha256":"4bb1d057fb8c837739a51ac532684ca1c3076194489d31e1913d3ebb82ce8352","resourceSha256":"fb80b7ee519e880e96b6d73c3cbd1cca277ba3aa71bf0934277c22c10edc592c"},"SAU":{"descriptorSha256":"3aa073707684b718f7014c8907e84b18db07d1b12ed28b0e3ebefb5445d5806c","geometrySha256":"15a9a1df6c6869252a5f508c5e98c4b4c6d3304f894865fefb111bdde8b7d287","resourceSha256":"2ca76e4e36ce4e4e6ed753c54deee727185a05daea64afa91ed9e8eff5ba75cc"}},"raw":{"LBY":{"path":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-mediterranean-africa-20261113/originals/LBY-original.json","sha256":"70d69db757b27dec00d0289865f8d8c757b89c1e33998a515e6abbe1907b1087","feature":"8167bba7-29bc-4f2b-901d-14b0c5165bc5","wkb":"71e366f4b5bf0a62700935ce4dd5d59a2ccaafd902cf2272eade91a79d63f6af"}},"resourcePath":"assets/data/territorial-entities/source/geometries/sha256-ac7e5f58b848bd69df58a7f104801a1b13edabb7ac033ccad0d789c3eefe709e.json","descriptorPath":"assets/data/territorial-entities/source/countries/state-EGY.json"});
