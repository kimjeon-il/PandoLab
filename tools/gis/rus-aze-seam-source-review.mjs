import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';

export const rusAzeSeamMethod='exact-original-rus-aze-readonly-counterpart-seam';
const id='state:RUS', version='state:RUS:natural-earth-5.1.1';
const date='2014-03-18';
const status='raw-source-only-not-display-approved';
const base='assets/data/territorial-entities/source/';
const prior='exact-original-rus-blr-readonly-counterpart-seam';
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
 const b=old.modernBoundarySupplement,m=b?.priorPreparedAttribution,j=m?.priorPreparedAttribution;
 if(b?.adoptionMode!==prior||b.geometrySha256!==priorDomain||domain(old.geometry)!==priorDomain||!eq(b.seamReview,blrReview)||
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
const fail=message=>{throw Error('RUS/AZE exact current seam: '+message);};
const keys=(o,names)=>o&&eq(Object.keys(o).sort(),[...names].sort());
const omit=(o,...names)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!names.includes(k)));
const active=e=>e.geometryVersions.filter(x=>x.validTo===null);
const preserved=e=>({...e,sourceInfo:omit(e.sourceInfo,'geometrySha256','geometryVersionId'),
 geometryVersions:e.geometryVersions.map(x=>x.versionId===version?omit(x,'geometry','modernBoundarySupplement'):x)});
const dig=(a,b,label)=>{if(a!==b)fail(label+' digest mismatch');};
const bytes=(read,p,h)=>{const x=read(p);if(!Buffer.isBuffer(x))fail(p+' exact archived bytes required');dig(hash(x),h,p);return x;};
export const hasRusAzeSeam=e=>e?.entityId===id&&e?.geometryVersions?.some(x=>x.validTo===null&&x.modernBoundarySupplement?.adoptionMode===rusAzeSeamMethod)===true;

export function assertRusAzeTopology(p,b,peers){
 const {openRingVertexCount,...azeArc}=p.AZEDonor??{};
 if(p.pin!==b.sourcePin||p.newPairDE9IM!=='FF2F11212'||p.newOverlapKm2!==0||p.newPositiveOverlapPolygonCount!==0||
  p.oldCoverageLossKm2!==0||p.oldCoverageLossPolygonCount!==0||p.allArcEdgesExactReciprocal!==true||
  !eq(p.sequentialPrior?.history,priorHistory)||p.sequentialPrior?.pointwiseOutsideChosenArc!==true||p.sequentialPrior?.priorBordersExact!==true||p.sequentialPrior?.geoTripointExact!==true||p.RUSOriginal?.wkbSha256!==b.originalRUSWkb||!eq(p.operations,[b.topologyOperation])||!eq(p.ringStarts,[b.ringStart])||!eq(azeArc,b.azeArc)||
  !keys(p.otherPeers,peers)||peers.some(c=>{const v=p.otherPeers[c];return v?.exactPrePostIntersectionEqual!==true||
   v.exactPrePostBoundaryShareEqual!==true||v.changeAreaKm2!==0;}))fail('reviewed zero-overlap no-loss topology and unchanged peers required');
 return true;
}

export function assertRusAzeSeam(next,previous,{prefixes,readEvidence}={}){
 const {binding,frozen,raw,descriptorPath,resourcePath}=registeredRusAze;
 if(typeof readEvidence!=='function'||!hasRusAzeSeam(next)||previous?.entityId!==id)fail('pinned RUS archive reader and entity required');
 const nv=active(next),pv=active(previous),v=nv[0],old=pv[0],s=v?.modernBoundarySupplement;
 if(nv.length!==1||pv.length!==1||v.versionId!==version||old.versionId!==version||v.validFrom!==date||old.validFrom!==date||
  next.metadata?.representativeGeometryVersionId!==version||!eq(preserved(next),preserved(previous)))
  fail('dates, selected version, attribution, and unselected geometry must remain exact');
 if(!keys(s,['adoptionMode','status','resultRelation','wholeCountryRaw','priorPreparedAttribution','geometrySha256','seamReview'])||
  s.status!==status||s.resultRelation!=='partial-original-with-readonly-azerbaijan-seam'||s.wholeCountryRaw!==false||
  old.modernBoundarySupplement?.adoptionMode!==prior||!eq(s.priorPreparedAttribution,old.modernBoundarySupplement)||
  !eq(s.seamReview,binding.review))fail('only registered partial source and prior attribution required');
 if(!Array.isArray(prefixes)||!eq([...prefixes].sort(),[descriptorPath,resourcePath].sort()))fail('only RUS descriptor and exact new geometry may be written');
 assertInheritedRussia(old,readEvidence);
 assertArchivedCaucasus(readEvidence);
 const r=JSON.parse(bytes(readEvidence,binding.review.reference,binding.review.sha256));
 if(r.schemaVersion!==1||r.sourcePin!==binding.sourcePin||r.method!==rusAzeSeamMethod||r.status!==status||r.entityId!==id||
  r.versionId!==version||r.validFrom!==date||r.validTo!==null||r.vertexCount!==binding.vertexCount||
  !eq(r.operation,binding.operation)||!eq(r.topologyOperation,binding.topologyOperation)||!eq(r.ringStart,binding.ringStart)||!eq(r.azeArc,binding.azeArc))fail('fixed source review fields required');
 dig(domain(old.geometry),r.previousGeometrySha256,'prior RUS geometry');
 dig(domain(v.geometry),r.geometrySha256,'new RUS geometry');
 dig(hash(JSON.stringify(v.geometry)+'\n'),r.geometryResourceSha256,'new RUS CAS');
 if(s.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometryVersionId!==version)
  fail('current source digest attribution must be correct');
 const proof=JSON.parse(bytes(readEvidence,r.topologyProof.reference,r.topologyProof.sha256));
 const peers=Object.keys(frozen).filter(c=>c!=='AZE'&&c!=='RUS');
 assertRusAzeTopology(proof,binding,peers);
 const originals={},current={};
 for(const c of ['AZE']){
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
 if(!eq(current.RUS,previous)||!eq(active(current.AZE)[0].geometry,originals.AZE))fail('pinned RUS and exact unchanged AZE required');
 const hist=previous.geometryVersions.filter(w=>w.validTo!==null).map(w=>({versionId:w.versionId,from:w.validFrom,to:w.validTo,resourceSHA:hash(JSON.stringify(w.geometry)+'\n')}));
 if(!eq(hist,priorHistory)||frozen.RUS.resourceSha256!==priorCas||frozen.RUS.geometrySha256!==priorDomain)fail('unchanged prior source and exact historical CAS required');
 const arc=(g,x)=>exactCyclicChain(g.coordinates[x.polygonIndex][x.ringIndex],x.startIndex,x.endIndex,x.direction);
 const op=binding.operation, points=arc(originals.AZE,op.raw);
 if(!eq(op.raw,binding.azeArc)||op.ringIndex!==0||op.raw.ringIndex!==0||binding.azeArc.ringIndex!==0||points.length!==binding.vertexCount||
  !eq(points,arc(originals.AZE,binding.azeArc))||points.slice(1).some((p,i)=>eq(p,points[i])))fail('one exact reciprocal LSIB exterior arc required');
 assertUnselectedRussia(old.geometry,v.geometry,op,binding.vertexCount);
 if(!eq(replayRetainedCoast(old.geometry,originals.AZE,[op],[binding.ringStart]),v.geometry))
  fail('candidate must be exact replay with all other rings and polygons preserved');
 return 1;
}

const registeredRusAze=Object.freeze({"binding":{"sourcePin":"69a331f011401edc5b782aca9a505e5918781b1c","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/rus-aze-original-frontier-20261115/review.json","sha256":"97cb3d74ada19ef70a470e124f99253741150df33f705c0b0332c3255a25a8c2"},"operation":{"polygonIndex":3289,"ringIndex":0,"startIndex":116435,"endIndex":116655,"raw":{"polygonIndex":2,"ringIndex":0,"startIndex":31892,"endIndex":22317,"direction":-1}},"topologyOperation":{"polygonIndex":3289,"ringIndex":0,"startIndex":116435,"endIndex":116655,"raw":{"polygonIndex":14550,"ringIndex":0,"startIndex":2662576,"endIndex":2672151,"direction":1}},"ringStart":{"polygonIndex":3289,"ringIndex":0,"startIndex":0},"azeArc":{"polygonIndex":2,"ringIndex":0,"startIndex":31892,"endIndex":22317,"direction":-1},"vertexCount":9576,"originalRUSWkb":"707b022fc4049577b58685185b1c42fe0e27dbabdd50f1e2a64496ac4532004e"},"frozen":{"RUS":{"descriptorSha256":"1e5c0e11e240d9d5f1c1f88d9762c14c10c72f579c217686db99a642f5ad42b8","geometrySha256":"0e22251b5b4ca838334df0abe604e888e6c3c5ddbc15437bb08f353193595e18","resourceSha256":"f7e92b439ff7afd3fd504a27fc88cbb2e2059c63fe8ed15c4eeb2e633d24cb15"},"AZE":{"descriptorSha256":"393c6df95285cad48390a11d426bccdc1e78fb503ba2efe7462839fd21dc1c6f","geometrySha256":"ee680a6913e4d3408a5ddb6cd09b224765d24e02c9de73abca9699a15f9437e1","resourceSha256":"54acfc4e0ec3237a581434984e25e8c39d2250630d0dccdd9ad151e47063d71a"},"GEO":{"descriptorSha256":"1ddead98444b04832e68ca09dfd0d7a2c0c422a1112bce3b8e1eef9719f51c20","geometrySha256":"865e00ac077a2cd6cc8ef73c9ffa0f8a4d5dbd04925bf07cde04e6c164051126","resourceSha256":"b5d443edaab17852f4dba37f8efcebd45993a376e96a49cd838b23b95ec4ca73"},"ARM":{"descriptorSha256":"1c850ac83bb5428b6ac5173da9cd46e72f354d9ff01f8f5bbd73ef3ec5ea146b","geometrySha256":"e0c4fe766a3542cd2878198f056d555f579adc442e57008e50127e867bc3b351","resourceSha256":"d3e611715b20b3a586eb1116048e3e5c8084ab7696a6624046861e404dd66265"},"IRN":{"descriptorSha256":"1cf95e5a92264454d0099281a6bfa3987255c0ed69c0535b2c4b280547889988","geometrySha256":"a1be70195870510b9c5260dfb1b914bfcf7663ad99bc6ab2439b05203c43f996","resourceSha256":"edd9edf37a0e5d1237626c624ea4f15bc02ecba90f2066ff9a90cd7913763cde"},"TUR":{"descriptorSha256":"2f93315eca2fa88a2f81ea95a30c66170e170ab46757966076746af09214da0a","geometrySha256":"42c841e80c88f0af39eade07f739e4d27996a49d85dcc6f79ffca9e11ec54894","resourceSha256":"92b804ee918e3cddceab797d885d25884a41928a44839056e2ba4bfbe7ecb024"},"TKM":{"descriptorSha256":"d6be951141490940e8fde234647b042b5b2e3d1824fa8881aa0822dfb1dc9b88","geometrySha256":"2dcca791a29e7d5dc54e8884408ea80eb1ae27c6bfab68f0d00252714d3bb225","resourceSha256":"4f405de0fbcb03d1a79c6e8c6814f28572c6368afae51d204a22d070efc1a086"},"KAZ":{"descriptorSha256":"466f8a4aedc6271c0a9db3c2fa1ee4244aeda1bad30101149ededce0faf21962","geometrySha256":"0d4cdc27fcd2a78145ec4aff1c35bc1b999b04000d2c61864a0b26c8f3aeed70","resourceSha256":"47de235c3a3e07fa5fa40d7ba0805a5ddbe757d5857534439c37903aa0db46ae"},"UKR":{"descriptorSha256":"ad1d4076b911f4bb8648c4d63013f9024fb2f6d36e2c0fac51b6db92d72a2b93","geometrySha256":"7e3dc7ad1496eda7dcad294946df1e2853ad04d243e2cc3f7dfacb743440e002","resourceSha256":"d2cd0b5bff81ee65c860956a5a8a075502dd80425de40f7dc51ba6881b21e0e1"},"BLR":{"descriptorSha256":"b428bfd7d801ec5d142d70ce8ae390c615cb48199f97eb95b15c60fa3bed12ab","geometrySha256":"b62c1f32988ed51f2768d617b361d3a8f010a2b6fff8c58d1a1a3ba422d0c7cf","resourceSha256":"e1bcd7c8c1ee79363d33698197984484e4e3a05372ae784f642ce7c01549cfbb"},"MNG":{"descriptorSha256":"d7e67adde7c998fe4886811b432aabc08063dbfdef353bb29b94330dfdf71cc8","geometrySha256":"f77ec0aa475978894d8995da93c429579add7bb470cb8813af46ad3b8f698440","resourceSha256":"476459922561c7f96ae33b864421f506436d6eba925ef423b29a052ca27c806a"},"CHN":{"descriptorSha256":"e73ae8acd1df89fd5a6e0cc2948d5218783751f4dfe11c8500378dfd0d31e357","geometrySha256":"cb57c1a9655fc843c7749585400c039a6710a2f654d0f04ac155fc9810a0471e","resourceSha256":"db80e8ef3c0d3bf2e37ad528a5fd9b3d791cb125a83435deeec9a9e113f2f5ac"},"EST":{"descriptorSha256":"4af605358c4edcc2474e010bc7328a859b96b30626d47830a9e021ef052eb4ae","geometrySha256":"79eec602da2604460a2c5b21d2f9bda2a7d5a1ec92cfb1096ffb04143591baaf","resourceSha256":"be7b295f2b35ee0372fb17b77320103d25b9178a52ed221168af4306558ab5b9"},"LVA":{"descriptorSha256":"9ef8a6dba3a4c963f797b4b1bebc8262f68fe7c8c63e279147296a56761de45b","geometrySha256":"d331d69ce2bf3992146f50be6482d1688466c270f468d293c86b0c4442958a3b","resourceSha256":"20cf314ae2721811e5ea99fb3f3322da0118af60de6b60ecf3865b0e1e621b33"},"LTU":{"descriptorSha256":"57bc42f8824495a654e8f0fbf1b70c1c9c640256eac58a579973a47415d183e8","geometrySha256":"0104c51a2a483cd10b00fc324e0f8f73d23fb9dc36422b41a791f11f20c18fb8","resourceSha256":"8ae8b03af3ce3dac3567a273c88073b8eff5199cb4247ead3052da1bde8434a7"},"POL":{"descriptorSha256":"be1b06ae66b5463a123a2455fc17bdef6e863b80b3131196acf77f0439b4ff49","geometrySha256":"454329d6c9a654c4cc4bee1692bd19787ea27779608d9c3c79e00782065b45f0","resourceSha256":"ccdfef130607c3c858b4f3458a0775ca9b7f87b34cfa312f5f9b15e0897c271e"}},"raw":{"AZE":{"path":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-further-six-20261113/originals/AZE-original.json","sha256":"19c29e6ebe3dfbab621dccea9c1fdbdfa9a3c96f2100f043414267176a6e07e7","feature":"4aeb6821-a913-436a-a695-35686ac02655","wkb":"6b00e5f948c6716ed1b314233659bc05139052824219140f6b02de635a907060"}},"resourcePath":"assets/data/territorial-entities/source/geometries/sha256-1666af4d0dfcca1d6a0f93b901a439c68c8ff0dacd9914ae0c6c26e38b37cd56.json","descriptorPath":"assets/data/territorial-entities/source/countries/state-RUS.json"});
