import {hash,domain,keys,active,hasActiveSeam,createSeamReviewChecks} from './seam-source-review-common.mjs';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';

export const sdnEriSeamMethod='exact-original-sdn-eri-readonly-counterpart-seam';
const id='state:SDN', version='state:SDN:2011-07-09-post-secession-r1';
const date='2011-07-09';
const status='raw-source-only-not-display-approved';
const base='assets/data/territorial-entities/source/';
const prior='exact-original-sdn-tcd-readonly-counterpart-seam';
const coastMethod='exact-original-retained-coast-arcs-current-batch';
const priorChadReview={reference:'reports/borders/validation/modern-raw-source-20261110/sdn-tcd-original-frontier-20261115/review.json',sha256:'52ae9a95c98a58df6430cf2dca62331239ac407081dcba9892fb7a6bda09f44e'};
const priorChadTopology={reference:'reports/borders/validation/modern-raw-source-20261110/sdn-tcd-original-frontier-20261115/topology-proof.json',sha256:'507a867ebd9246c6daf832d93627d84d4e9e1f816355d3f62cc137d7c59e1baf'};
const priorChadArc={polygonIndex:0,ringIndex:0,startIndex:12964,endIndex:4190,direction:-1};
const priorChadCas='3276afc69f5bf36c38ef7153df951c80bd56c1c2153097babf2e4ec97ae3af43';
const priorChadDomain='d7555e887566896bbed2dcd711e80219257fd96c08433ddcd5b799d847495b08';
const priorChadDonorCas='6640940231fd1412245cac08996d0561a0521d6794c30f29613e230a30c74537';
export function assertPriorChadArc(previous,next,donor,arc,scope){
 const ps=g=>g?.type==='Polygon'?[g.coordinates]:g?.coordinates;
 const points=exactCyclicChain(ps(donor)[arc.polygonIndex][arc.ringIndex],arc.startIndex,arc.endIndex,arc.direction);
 const p=ps(previous)?.[scope.polygonIndex]?.[scope.ringIndex],n=ps(next)?.[scope.polygonIndex]?.[scope.ringIndex];
 if(points.length!==scope.length||!p||!n||!eq(p.slice(scope.start,scope.start+scope.length),points)||!eq(n.slice(scope.start,scope.start+scope.length),points))fail('previous exact Chad arc lost');
 return true;
}

const rdir='reports/borders/validation/modern-raw-source-20261110/ken-sdn-coast-candidates-20261113/';
const priorReview={reference:rdir+'SDN-review.json',sha256:'6836211514ed7c9695e86b076b67ce07ccf12c1e65b2adb92db871876ba9f76a'};
const priorPolicy={reference:rdir+'SDN-policy.json',sha256:'0055c5e2633f46160a1a0b8f328b129db79e1a2f8783c8c48585122220c10f7c'};
const priorPartition={reference:rdir+'SDN-full-policy-proof.json',sha256:'fb9900a11fe38844df5091126dda4422d6c6d087533e3e315476e3d1c84b9d2c'};
const priorGeometryDomain='f98d340fd003dedd514adf69820f077c8f68877973c4f9073c905cd2000bb540';
const priorGeometryCas='e4626804a638143fe5d3e103d8b5df93770ca90caa8d17d89c2b0dbc460992e3';
const priorHistory=[{versionId:'state:sudan:1956-2011-r1',from:'1956-01-01',to:'2011-07-08',resourceSHA:'d6c9d52c96abb4b1ec4e90655c53859fac91db1a01e98009fd32376c22a7193f'}];
export function assertExactlyUnselectedSdnPoints(previous,next,operation,pointCount){
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

const fail=message=>{throw Error('SDN/ERI exact current seam: '+message);};
const {preserved,dig,bytes}=createSeamReviewChecks(version,fail);
export const hasSdnEriSeam=e=>hasActiveSeam(e,id,sdnEriSeamMethod);

export function assertSdnEriTopology(p,b,peers){
 const {openRingVertexCount,...eriArc}=p.ERIDonor??{};
 if(p.pin!==b.sourcePin||p.newPairDE9IM!=='FF2F11212'||p.newOverlapKm2!==0||p.newPositiveOverlapPolygonCount!==0||
  p.oldCoverageLossKm2!==0||p.oldCoverageLossPolygonCount!==0||p.allArcEdgesExactReciprocal!==true||
  !p.sequentialPrior||!eq(p.sequentialPrior.history,priorHistory)||p.sequentialPrior.pointwiseOutsideChosenArc!==true||p.sequentialPrior.halaibSeparateExcluded!==true||p.sequentialPrior.sdsBoundaryExact!==true||!eq(p.sequentialPrior.protectedZoneNames,['Abyei','Bir Tawil'])||p.sequentialPrior.chadArcExact!==true||p.sequentialPrior.chadOverlapKm2!==0||p.sequentialPrior.chadSharedKm!==1410.175376092946||p.sequentialPrior.ethTripointExact!==true||p.SDNOriginal?.wkbSha256!==b.originalSDNWkb||!eq(p.operations,[b.topologyOperation])||!eq(p.ringStarts,[b.ringStart])||!eq(eriArc,b.eriArc)||
  !keys(p.otherPeers,peers)||peers.some(c=>{const v=p.otherPeers[c];return v?.exactPrePostIntersectionEqual!==true||
   v.exactPrePostBoundaryShareEqual!==true||v.changeAreaKm2!==0;}))fail('reviewed zero-overlap no-loss topology and unchanged peers required');
 return true;
}

export function assertSdnEriSeam(next,previous,{prefixes,readEvidence}={}){
 const {binding,frozen,raw,descriptorPath,resourcePath}=registeredSdnEri;
 if(typeof readEvidence!=='function'||!hasSdnEriSeam(next)||previous?.entityId!==id)fail('pinned SDN archive reader and entity required');
 const nv=active(next),pv=active(previous),v=nv[0],old=pv[0],s=v?.modernBoundarySupplement;
 if(nv.length!==1||pv.length!==1||v.versionId!==version||old.versionId!==version||v.validFrom!==date||old.validFrom!==date||
  next.metadata?.representativeGeometryVersionId!==version||!eq(preserved(next),preserved(previous)))
  fail('dates, selected version, attribution, and unselected geometry must remain exact');
 if(!keys(s,['adoptionMode','status','resultRelation','wholeCountryRaw','priorPreparedAttribution','geometrySha256','seamReview'])||
  s.status!==status||s.resultRelation!=='partial-original-with-readonly-eritrea-seam'||s.wholeCountryRaw!==false||
  old.modernBoundarySupplement?.adoptionMode!==prior||!eq(s.priorPreparedAttribution,old.modernBoundarySupplement)||
  !eq(s.seamReview,binding.review))fail('only registered partial source and prior attribution required');
 if(!Array.isArray(prefixes)||!eq([...prefixes].sort(),[descriptorPath,resourcePath].sort()))fail('only SDN descriptor and exact new geometry may be written');
 if(!eq(old.modernBoundarySupplement?.seamReview,priorChadReview)||domain(old.geometry)!==priorChadDomain||old.modernBoundarySupplement?.priorPreparedAttribution?.adoptionMode!==coastMethod||!eq(old.modernBoundarySupplement.priorPreparedAttribution.retainedCoastReview,priorReview))fail('exact prior Chad frontier and nested Red Sea coast required');
 const r=JSON.parse(bytes(readEvidence,binding.review.reference,binding.review.sha256));
 if(r.schemaVersion!==1||r.sourcePin!==binding.sourcePin||r.method!==sdnEriSeamMethod||r.status!==status||r.entityId!==id||
  r.versionId!==version||r.validFrom!==date||r.validTo!==null||r.vertexCount!==binding.vertexCount||
  !eq(r.operation,binding.operation)||!eq(r.topologyOperation,binding.topologyOperation)||!eq(r.ringStart,binding.ringStart)||!eq(r.eriArc,binding.eriArc))fail('fixed source review fields required');
 dig(domain(old.geometry),r.previousGeometrySha256,'prior SDN geometry');
 dig(domain(v.geometry),r.geometrySha256,'new SDN geometry');
 dig(hash(JSON.stringify(v.geometry)+'\n'),r.geometryResourceSha256,'new SDN CAS');
 if(s.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometryVersionId!==version)
  fail('current source digest attribution must be correct');
 const proof=JSON.parse(bytes(readEvidence,r.topologyProof.reference,r.topologyProof.sha256));
 const peers=Object.keys(frozen).filter(c=>c!=='ERI'&&c!=='SDN');
 assertSdnEriTopology(proof,binding,peers);
 const originals={},current={};
 for(const c of ['ERI']){
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
 if(!eq(current.SDN,previous)||!eq(active(current.ERI)[0].geometry,originals.ERI))fail('pinned SDN and exact unchanged ERI required');
 const pr=JSON.parse(bytes(readEvidence,priorReview.reference,priorReview.sha256));
 if(pr.method!==coastMethod||pr.geometryResourceSha256!==priorGeometryCas||pr.geometrySha256!==priorGeometryDomain||pr.operations.length!==336||!eq(pr.policy,priorPolicy))fail('prior retained Red Sea coast approval must be exact');
 const policy=JSON.parse(bytes(readEvidence,priorPolicy.reference,priorPolicy.sha256));
 if(policy.method!=='existing-political-partition-coast-only'||!eq(policy.partitionProof,priorPartition))fail('fixed political boundary protection required');
 try{bytes(readEvidence,priorPartition.reference,priorPartition.sha256)}catch(e){fail('protected partition proof changed: '+e.message)}
 const hist=previous.geometryVersions.filter(w=>w.validTo!==null).map(w=>({versionId:w.versionId,from:w.validFrom,to:w.validTo,resourceSHA:hash(JSON.stringify(w.geometry)+'\n')}));
 if(!eq(hist,priorHistory)||frozen.SDN.resourceSha256!==priorChadCas||frozen.SDN.geometrySha256!==priorChadDomain||frozen.TCD?.resourceSha256!==priorChadDonorCas)fail('unaltered historic slots and exact prior current CAS required');
 const cr=JSON.parse(bytes(readEvidence,priorChadReview.reference,priorChadReview.sha256));
 const ct=JSON.parse(bytes(readEvidence,priorChadTopology.reference,priorChadTopology.sha256));
 if(cr.method!==prior||cr.geometryResourceSha256!==priorChadCas||cr.geometrySha256!==priorChadDomain||!eq(cr.tcdArc,priorChadArc)||!eq(cr.topologyProof,priorChadTopology)||ct.newOverlapKm2!==0||ct.oldCoverageLossKm2!==0||ct.newPairDE9IM!=='FF2F11212'||ct.allArcEdgesExactReciprocal!==true)fail('exact archived Chad approval required');
 assertPriorChadArc(old.geometry,v.geometry,active(current.TCD)[0].geometry,priorChadArc,{polygonIndex:0,ringIndex:0,start:563,length:8775});
 const arc=(g,x)=>exactCyclicChain(g.coordinates[x.polygonIndex][x.ringIndex],x.startIndex,x.endIndex,x.direction);
 const op=binding.operation, points=arc(originals.ERI,op.raw);
 if(!eq(op.raw,binding.eriArc)||op.ringIndex!==0||op.raw.ringIndex!==0||binding.eriArc.ringIndex!==0||points.length!==binding.vertexCount||
  !eq(points,arc(originals.ERI,binding.eriArc))||points.slice(1).some((p,i)=>eq(p,points[i])))fail('one exact reciprocal LSIB exterior arc required');
 assertExactlyUnselectedSdnPoints(old.geometry,v.geometry,op,binding.vertexCount);
 if(!eq(replayRetainedCoast(old.geometry,originals.ERI,[op],[binding.ringStart]),v.geometry))
  fail('candidate must be exact replay with all other rings and polygons preserved');
 return 1;
}

const registeredSdnEri=Object.freeze({"binding":{"sourcePin":"ff7316dfabedacaa5b882dee6b9911b3f53ea0b6","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/sdn-eri-original-frontier-20261115/review.json","sha256":"afd3b4a36f63b4e339bb53f021f6ccc03c775efc3b7cbfb8412b5505ab7275b1"},"operation":{"polygonIndex":0,"ringIndex":0,"startIndex":11128,"endIndex":11378,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":23590,"endIndex":14795,"direction":-1}},"topologyOperation":{"polygonIndex":0,"ringIndex":0,"startIndex":11128,"endIndex":11378,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":5833,"endIndex":14628,"direction":1}},"ringStart":{"polygonIndex":0,"ringIndex":0,"startIndex":0},"eriArc":{"polygonIndex":0,"ringIndex":0,"startIndex":23590,"endIndex":14795,"direction":-1},"vertexCount":8796,"originalSDNWkb":"6d93149fc412f339987cea97bc7648e1fdc790c3ed6f3eecb005fa6a3c4ab933"},"frozen":{"SDN":{"descriptorSha256":"175198b2952ad9d79bbc7f2c87d0f4c502ca4ff0466536501b05fbbb281092bf","geometrySha256":"d7555e887566896bbed2dcd711e80219257fd96c08433ddcd5b799d847495b08","resourceSha256":"3276afc69f5bf36c38ef7153df951c80bd56c1c2153097babf2e4ec97ae3af43"},"ERI":{"descriptorSha256":"a3dba97c9b6cc2a8011601ce99b3e9b2d42ab09dd91a23c0d7f8331f96d3b249","geometrySha256":"ba634f5e43cdbe932bb66648b9648eed925deb54655e1c696be8a589f02af712","resourceSha256":"81921c1836ad4d61bac66e271b9af1061d5f3b778a707601b0aa2be6fc9a7ee0"},"CAF":{"descriptorSha256":"48c06dee942ec7918ed4cc1196e572236187b67b7ff7a07ecff0a56b427b340f","geometrySha256":"03961da63bed83a8abcfd3a44cf990a6c0167b6fcc0cf427824d67c2373c2294","resourceSha256":"c7e0b97f8a5e22639f1d6d59895e707bb65c84476123f43ecb35950d573cc51b"},"LBY":{"descriptorSha256":"ceb3ffada9ae759270612861d0f198e87d1dfa7b0e50d3cf33a744a2a955e88e","geometrySha256":"a9d2011d31c271650132447ab0e0fa7af79b5db355206b07cca26b751b16f06f","resourceSha256":"bd919defe47e011ed4b6c69b9255099f0f6558955fe7f95c38cbb9675274c8e5"},"SDS":{"descriptorSha256":"53a7af48af8b6c1cba5342778c0e9e0c09bea4c23abe198ab5dee6a3b9440160","geometrySha256":"0cbeeb74a30bed9f81fce1d38abc3813c26ae2999dab0b07e128a781f9c0d000","resourceSha256":"3a513755c58d8e293dd6a7eb1b0852a3826fe896b13833a7af43e7a4ad2f7455"},"EGY":{"descriptorSha256":"b1b9cdfa45d5d28817940221de7fd79a6206bbf08c0f7c6ec3ede7d3ba4758b8","geometrySha256":"f0dd70bc0e71349b138b18b3eb89e05dc9e57b91a02a16bf1a12510ab65fb990","resourceSha256":"dd0bc41dce74554fa57f70baa7c42da174fb75ee4fa15773b85e34545112d682"},"BRT":{"descriptorSha256":"2be93e04d2debb3358ba729c0508411c54b6bb7727a970f43b988c39a0558020","geometrySha256":"5b285e17de01ee320d0d2cdcdba398572b3db8923e0ee8ed0ac9a2bd793299ca","resourceSha256":"aab6545be0b74bfa540f8be06482e4f510f212713d036a40ca83157dcf40d4e6"},"ETH":{"descriptorSha256":"b3ec88e2f59d652312bf9e3c4535360cc682116077b4398a7154a0121719a36a","geometrySha256":"11fc7878eeb542f413c9765f61c9bda0a5040d356b2331e2670e58596e302825","resourceSha256":"1762c21831738bf172889805dae53a2199efcc1caee3242c7cb0f41038b4f9ea"},"TCD":{"descriptorSha256":"73821f8ef5454ca15fb4b0f3593ae38f8e1623e60703278cc0bcb4f9a2bba536","geometrySha256":"36621e26185aa0874a412cb229bb98c9d5706b281fc07fff22269e496b8308f6","resourceSha256":"6640940231fd1412245cac08996d0561a0521d6794c30f29613e230a30c74537"},"SAU":{"descriptorSha256":"3aa073707684b718f7014c8907e84b18db07d1b12ed28b0e3ebefb5445d5806c","geometrySha256":"15a9a1df6c6869252a5f508c5e98c4b4c6d3304f894865fefb111bdde8b7d287","resourceSha256":"2ca76e4e36ce4e4e6ed753c54deee727185a05daea64afa91ed9e8eff5ba75cc"},"YEM":{"descriptorSha256":"7e3b6bf8eab929488c9197ad6593ec0e59a33b555c752beded0376b290fb17f2","geometrySha256":"27d290bf0b457d4d61cbed12a5bb6dcffeefedc5c8c11ea7fd8e5d73eb55892c","resourceSha256":"6b34e5b316562cf3908f75a2c75b7cea56097b08b789fed8bfa7be328b30168a"},"DJI":{"descriptorSha256":"b57c5beeaf0fdac6e1f77b27c68b34dc541cdb5dda33311045464caaf81adf46","geometrySha256":"b0c8a67ab4c25357351ff2c50e7598ac7521ced987ed736d53471889ddea3584","resourceSha256":"f573cf2c9cfb7b310bdedfd4bf044aa62fde8513b090594c615fe4c49ac47871"},"UGA":{"descriptorSha256":"29138906fc8319dc0558f2854dc0876f706d049a2abb735039de4a751e419162","geometrySha256":"6455d8e903087c36765c38e45829e763d5abf3994e02704f7c70d8af67332e9c","resourceSha256":"a2f008cb77924cf34c86147be0d5f7b7a235d34a8fb32a040a54f15a34dbf097"},"KEN":{"descriptorSha256":"634a1e2e2fd7e7723b8945d3f93d5e61504d73e11a879f077a04df6b9172e7d2","geometrySha256":"1d1022c882a515cf5e37eb0393b15140d72c268544ec1f296b7ea98805780c50","resourceSha256":"b6591eaf9d70a0e7f6f99c2799108d654019774d44102bb04dd8fc81431794c2"},"SOM":{"descriptorSha256":"41b142d5f0cff03b4fe37b3121158bab862cf2b53fd8d49e545c134909540958","geometrySha256":"9c6421b9303da79c6fc3dbc1407fb022924692f7db78a3e8ec70f14dc3a2f501","resourceSha256":"83e64b26cf6f42d2198e5e46f52e4ea8abf06cbfb4584d3711994892559fb18a"},"SOL":{"descriptorSha256":"77aadd590b2b2f2ff032f0ee5459fdffc3482d2e43f4318fb12b4acb359a338b","geometrySha256":"e5780dee985b302ce1d6c48ee841320448a876f248c059c758ebd12b4cad485f","resourceSha256":"22b4cf876ae7e19df685a8fbe81b1ba4a8a463cce800fcb432c496d04e624962"}},"raw":{"ERI":{"path":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-mediterranean-africa-20261113/originals/ERI-original.json","sha256":"9e3861d85502ffa8dbcb81826b191217800eff71a09828ccc541644f3f23c6e3","feature":"dccea47c-f509-4ba0-a2a1-13137a49c8f6","wkb":"6947c47b7a22fe0c2e253f99a5d93735f1bd9712febdaecce627b7a02af139d3"}},"resourcePath":"assets/data/territorial-entities/source/geometries/sha256-782a2e915d188ca1795bdefae600196834c23e2cde8683b50ef8baf1e53a88c9.json","descriptorPath":"assets/data/territorial-entities/source/countries/state-SDN.json"});
