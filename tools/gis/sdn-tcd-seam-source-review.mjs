import {hash,domain,keys,active,hasActiveSeam,createSeamReviewChecks} from './seam-source-review-common.mjs';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';

export const sdnTcdSeamMethod='exact-original-sdn-tcd-readonly-counterpart-seam';
const id='state:SDN', version='state:SDN:2011-07-09-post-secession-r1';
const date='2011-07-09';
const status='raw-source-only-not-display-approved';
const base='assets/data/territorial-entities/source/';
const prior='exact-original-retained-coast-arcs-current-batch';
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

const fail=message=>{throw Error('SDN/TCD exact current seam: '+message);};
const {preserved,dig,bytes}=createSeamReviewChecks(version,fail);
export const hasSdnTcdSeam=e=>hasActiveSeam(e,id,sdnTcdSeamMethod);

export function assertSdnTcdTopology(p,b,peers){
 const {openRingVertexCount,...tcdArc}=p.TCDDonor??{};
 if(p.pin!==b.sourcePin||p.newPairDE9IM!=='FF2F11212'||p.newOverlapKm2!==0||p.newPositiveOverlapPolygonCount!==0||
  p.oldCoverageLossKm2!==0||p.oldCoverageLossPolygonCount!==0||p.allArcEdgesExactReciprocal!==true||
  !p.sequentialPrior||!eq(p.sequentialPrior.history,priorHistory)||p.sequentialPrior.pointwiseOutsideChosenArc!==true||p.sequentialPrior.halaibSeparateExcluded!==true||p.sequentialPrior.sdsBoundaryExact!==true||!eq(p.sequentialPrior.protectedZoneNames,['Abyei','Bir Tawil'])||p.SDNOriginal?.wkbSha256!==b.originalSDNWkb||!eq(p.operations,[b.topologyOperation])||!eq(p.ringStarts,[b.ringStart])||!eq(tcdArc,b.tcdArc)||
  !keys(p.otherPeers,peers)||peers.some(c=>{const v=p.otherPeers[c];return v?.exactPrePostIntersectionEqual!==true||
   v.exactPrePostBoundaryShareEqual!==true||v.changeAreaKm2!==0;}))fail('reviewed zero-overlap no-loss topology and unchanged peers required');
 return true;
}

export function assertSdnTcdSeam(next,previous,{prefixes,readEvidence}={}){
 const {binding,frozen,raw,descriptorPath,resourcePath}=registeredSdnTcd;
 if(typeof readEvidence!=='function'||!hasSdnTcdSeam(next)||previous?.entityId!==id)fail('pinned SDN archive reader and entity required');
 const nv=active(next),pv=active(previous),v=nv[0],old=pv[0],s=v?.modernBoundarySupplement;
 if(nv.length!==1||pv.length!==1||v.versionId!==version||old.versionId!==version||v.validFrom!==date||old.validFrom!==date||
  next.metadata?.representativeGeometryVersionId!==version||!eq(preserved(next),preserved(previous)))
  fail('dates, selected version, attribution, and unselected geometry must remain exact');
 if(!keys(s,['adoptionMode','status','resultRelation','wholeCountryRaw','priorPreparedAttribution','geometrySha256','seamReview'])||
  s.status!==status||s.resultRelation!=='partial-original-with-readonly-chad-seam'||s.wholeCountryRaw!==false||
  old.modernBoundarySupplement?.adoptionMode!==prior||!eq(s.priorPreparedAttribution,old.modernBoundarySupplement)||
  !eq(s.seamReview,binding.review))fail('only registered partial source and prior attribution required');
 if(!Array.isArray(prefixes)||!eq([...prefixes].sort(),[descriptorPath,resourcePath].sort()))fail('only SDN descriptor and exact new geometry may be written');
 if(!eq(old.modernBoundarySupplement?.retainedCoastReview,priorReview)||domain(old.geometry)!==priorGeometryDomain)fail('exact prior retained Red Sea coast required');
 const r=JSON.parse(bytes(readEvidence,binding.review.reference,binding.review.sha256));
 if(r.schemaVersion!==1||r.sourcePin!==binding.sourcePin||r.method!==sdnTcdSeamMethod||r.status!==status||r.entityId!==id||
  r.versionId!==version||r.validFrom!==date||r.validTo!==null||r.vertexCount!==binding.vertexCount||
  !eq(r.operation,binding.operation)||!eq(r.topologyOperation,binding.topologyOperation)||!eq(r.ringStart,binding.ringStart)||!eq(r.tcdArc,binding.tcdArc))fail('fixed source review fields required');
 dig(domain(old.geometry),r.previousGeometrySha256,'prior SDN geometry');
 dig(domain(v.geometry),r.geometrySha256,'new SDN geometry');
 dig(hash(JSON.stringify(v.geometry)+'\n'),r.geometryResourceSha256,'new SDN CAS');
 if(s.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometryVersionId!==version)
  fail('current source digest attribution must be correct');
 const proof=JSON.parse(bytes(readEvidence,r.topologyProof.reference,r.topologyProof.sha256));
 const peers=Object.keys(frozen).filter(c=>c!=='TCD'&&c!=='SDN');
 assertSdnTcdTopology(proof,binding,peers);
 const originals={},current={};
 for(const c of ['TCD']){
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
 if(!eq(current.SDN,previous)||!eq(active(current.TCD)[0].geometry,originals.TCD))fail('pinned SDN and exact unchanged TCD required');
 const pr=JSON.parse(bytes(readEvidence,priorReview.reference,priorReview.sha256));
 if(pr.method!==prior||pr.geometryResourceSha256!==priorGeometryCas||pr.geometrySha256!==priorGeometryDomain||pr.operations.length!==336||!eq(pr.policy,priorPolicy))fail('prior retained Red Sea coast approval must be exact');
 const policy=JSON.parse(bytes(readEvidence,priorPolicy.reference,priorPolicy.sha256));
 if(policy.method!=='existing-political-partition-coast-only'||!eq(policy.partitionProof,priorPartition))fail('fixed political boundary protection required');
 try{bytes(readEvidence,priorPartition.reference,priorPartition.sha256)}catch(e){fail('protected partition proof changed: '+e.message)}
 const hist=previous.geometryVersions.filter(w=>w.validTo!==null).map(w=>({versionId:w.versionId,from:w.validFrom,to:w.validTo,resourceSHA:hash(JSON.stringify(w.geometry)+'\n')}));
 if(!eq(hist,priorHistory)||frozen.SDN.resourceSha256!==priorGeometryCas||frozen.SDN.geometrySha256!==priorGeometryDomain)fail('unaltered historic slots and exact prior current CAS required');
 const arc=(g,x)=>exactCyclicChain(g.coordinates[x.polygonIndex][x.ringIndex],x.startIndex,x.endIndex,x.direction);
 const op=binding.operation, points=arc(originals.TCD,op.raw);
 if(!eq(op.raw,binding.tcdArc)||op.ringIndex!==0||op.raw.ringIndex!==0||binding.tcdArc.ringIndex!==0||points.length!==binding.vertexCount||
  !eq(points,arc(originals.TCD,binding.tcdArc))||points.slice(1).some((p,i)=>eq(p,points[i])))fail('one exact reciprocal LSIB exterior arc required');
 assertExactlyUnselectedSdnPoints(old.geometry,v.geometry,op,binding.vertexCount);
 if(!eq(replayRetainedCoast(old.geometry,originals.TCD,[op],[binding.ringStart]),v.geometry))
  fail('candidate must be exact replay with all other rings and polygons preserved');
 return 1;
}

const registeredSdnTcd=Object.freeze({"binding":{"sourcePin":"57181a14b521b57c33dfa8618866ae22d7568959","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/sdn-tcd-original-frontier-20261115/review.json","sha256":"52ae9a95c98a58df6430cf2dca62331239ac407081dcba9892fb7a6bda09f44e"},"operation":{"polygonIndex":0,"ringIndex":0,"startIndex":563,"endIndex":913,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":12964,"endIndex":4190,"direction":-1}},"topologyOperation":{"polygonIndex":0,"ringIndex":0,"startIndex":563,"endIndex":913,"raw":{"polygonIndex":0,"ringIndex":0,"startIndex":31310,"endIndex":40084,"direction":1}},"ringStart":{"polygonIndex":0,"ringIndex":0,"startIndex":0},"tcdArc":{"polygonIndex":0,"ringIndex":0,"startIndex":12964,"endIndex":4190,"direction":-1},"vertexCount":8775,"originalSDNWkb":"6d93149fc412f339987cea97bc7648e1fdc790c3ed6f3eecb005fa6a3c4ab933"},"frozen":{"SDN":{"descriptorSha256":"1a203c788267473003b1de1e663d63f98b3afa1080307678f7596d9b8d97d87b","geometrySha256":"f98d340fd003dedd514adf69820f077c8f68877973c4f9073c905cd2000bb540","resourceSha256":"e4626804a638143fe5d3e103d8b5df93770ca90caa8d17d89c2b0dbc460992e3"},"TCD":{"descriptorSha256":"73821f8ef5454ca15fb4b0f3593ae38f8e1623e60703278cc0bcb4f9a2bba536","geometrySha256":"36621e26185aa0874a412cb229bb98c9d5706b281fc07fff22269e496b8308f6","resourceSha256":"6640940231fd1412245cac08996d0561a0521d6794c30f29613e230a30c74537"},"CAF":{"descriptorSha256":"48c06dee942ec7918ed4cc1196e572236187b67b7ff7a07ecff0a56b427b340f","geometrySha256":"03961da63bed83a8abcfd3a44cf990a6c0167b6fcc0cf427824d67c2373c2294","resourceSha256":"c7e0b97f8a5e22639f1d6d59895e707bb65c84476123f43ecb35950d573cc51b"},"LBY":{"descriptorSha256":"ceb3ffada9ae759270612861d0f198e87d1dfa7b0e50d3cf33a744a2a955e88e","geometrySha256":"a9d2011d31c271650132447ab0e0fa7af79b5db355206b07cca26b751b16f06f","resourceSha256":"bd919defe47e011ed4b6c69b9255099f0f6558955fe7f95c38cbb9675274c8e5"},"SDS":{"descriptorSha256":"53a7af48af8b6c1cba5342778c0e9e0c09bea4c23abe198ab5dee6a3b9440160","geometrySha256":"0cbeeb74a30bed9f81fce1d38abc3813c26ae2999dab0b07e128a781f9c0d000","resourceSha256":"3a513755c58d8e293dd6a7eb1b0852a3826fe896b13833a7af43e7a4ad2f7455"},"EGY":{"descriptorSha256":"b1b9cdfa45d5d28817940221de7fd79a6206bbf08c0f7c6ec3ede7d3ba4758b8","geometrySha256":"f0dd70bc0e71349b138b18b3eb89e05dc9e57b91a02a16bf1a12510ab65fb990","resourceSha256":"dd0bc41dce74554fa57f70baa7c42da174fb75ee4fa15773b85e34545112d682"},"BRT":{"descriptorSha256":"2be93e04d2debb3358ba729c0508411c54b6bb7727a970f43b988c39a0558020","geometrySha256":"5b285e17de01ee320d0d2cdcdba398572b3db8923e0ee8ed0ac9a2bd793299ca","resourceSha256":"aab6545be0b74bfa540f8be06482e4f510f212713d036a40ca83157dcf40d4e6"},"ETH":{"descriptorSha256":"b3ec88e2f59d652312bf9e3c4535360cc682116077b4398a7154a0121719a36a","geometrySha256":"11fc7878eeb542f413c9765f61c9bda0a5040d356b2331e2670e58596e302825","resourceSha256":"1762c21831738bf172889805dae53a2199efcc1caee3242c7cb0f41038b4f9ea"},"ERI":{"descriptorSha256":"a3dba97c9b6cc2a8011601ce99b3e9b2d42ab09dd91a23c0d7f8331f96d3b249","geometrySha256":"ba634f5e43cdbe932bb66648b9648eed925deb54655e1c696be8a589f02af712","resourceSha256":"81921c1836ad4d61bac66e271b9af1061d5f3b778a707601b0aa2be6fc9a7ee0"},"NER":{"descriptorSha256":"10b26af51d7a51bfc8f32e9f8776d21509757ac18587b803f0cb1e431392e175","geometrySha256":"a10e314b0b4857eda53b4f2dafa515b2eab843a23de4169f77f8142d10717aab","resourceSha256":"672e36202dfe4001fb098c34231e2d1faf489c52344c5fc8d4b9608b2ecf0e8f"},"CMR":{"descriptorSha256":"0aa60815088b5560b738f98df7acc9cf1a7d13e6258cf9cb1031844c3bb28157","geometrySha256":"ffc8b41a93de95c8a881ad65c35afe23385441afe69c4e9d59a73227d60f54b8","resourceSha256":"84031f2263eef642d298cf366fceaffacf3e9eff694a8a9fc2002e84275599f0"},"NGA":{"descriptorSha256":"de087b03aff6177839ea3cb46a28afceddf4cfd1a0f688d652e670984f33fd6d","geometrySha256":"d4d442e8d1044d214d3fe95cb423d597e1924d56c6b9d3643aba5e90453edd8f","resourceSha256":"64cb609deaa6c8a9a8914919965a748f4c1c75e30b7149393bda7576d26f8367"},"COD":{"descriptorSha256":"9a66aea1130689e7909ce37866a4573f7802ead6c982715d6e4a04dc54f2249a","geometrySha256":"cfd47bd4e42222a8f0529a4fc8af3294a357a85db33c21121f700a7d55916e80","resourceSha256":"9cc9f468a6de45edd285b916e2f1d13ac9e05e4ca9d5e640a74c454796f9c7dd"},"COG":{"descriptorSha256":"1ee63942748f7136e6a0b23f8e7f818cf8df030b90769c70a2a1fb982792fde4","geometrySha256":"44560177c98e2719312c9abe2ca65a2a924f8672cc64390401037935f62ee1ab","resourceSha256":"091e624cd49c0e026f81b06fd6764e9e0f796380f582a4f22bb56ab4dd39b65a"},"SAU":{"descriptorSha256":"3aa073707684b718f7014c8907e84b18db07d1b12ed28b0e3ebefb5445d5806c","geometrySha256":"15a9a1df6c6869252a5f508c5e98c4b4c6d3304f894865fefb111bdde8b7d287","resourceSha256":"2ca76e4e36ce4e4e6ed753c54deee727185a05daea64afa91ed9e8eff5ba75cc"}},"raw":{"TCD":{"path":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-mediterranean-africa-20261113/originals/TCD-original.json","sha256":"6315f5c33c89c462562dedf3ef4b42606f55fba6e161be735716096931fe9c52","feature":"8b30342d-0c16-46fd-bf8a-b19bc851c133","wkb":"15489f20324dd5d71ae3046b672702590edc4dbf7e10e822c7c922a1ec45d3f1"}},"resourcePath":"assets/data/territorial-entities/source/geometries/sha256-3276afc69f5bf36c38ef7153df951c80bd56c1c2153097babf2e4ec97ae3af43.json","descriptorPath":"assets/data/territorial-entities/source/countries/state-SDN.json"});
