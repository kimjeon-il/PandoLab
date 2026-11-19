import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';
export const rusLtuSeamMethod='exact-original-rus-ltu-readonly-counterpart-seam';
const base='assets/data/territorial-entities/source/',version='state:RUS:natural-earth-5.1.1',status='raw-source-only-not-display-approved';
const sha=b=>createHash('sha256').update(b).digest('hex'),domain=g=>sha(JSON.stringify([g.type,g.coordinates]));
const active=e=>e?.geometryVersions?.filter(v=>v.validTo===null)??[];
const remove=(o,...keys)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!keys.includes(k)));
const retained=e=>({...e,sourceInfo:remove(e.sourceInfo,'geometrySha256','geometryVersionId'), geometryVersions:e.geometryVersions.map(v=>v.versionId===version?remove(v,'geometry','modernBoundarySupplement'):v)});
const ppath=c=>base+'countries/state-'+c+'.json';
const fetch=(read,reference,sha256)=>{const b=read(reference);assert(Buffer.isBuffer(b)&&sha(b)===sha256,'exact archived bytes: '+reference);return b;};
const oldPol={reference:'reports/borders/validation/modern-raw-source-20261110/rus-pol-original-frontier-20261115/review.json',sha256:'a8262c2ca60b7bee508f033e90ebec1b5f8310ae17101d78a1149cde4e88db41'};
const oldPolWhole={reference:'reports/borders/validation/modern-raw-source-20261110/rus-pol-original-frontier-20261115/topology-proof.json',sha256:'44d0576ae0c9de0834fd86ffac4a027d427a4e7367e038ee0e1e274a91618b57'};
export const hasRusLtuSeam=e=>e?.entityId==='state:RUS'&&active(e).some(v=>v.modernBoundarySupplement?.adoptionMode===rusLtuSeamMethod);
export function validateTopology(t,w,pin,peers){
 assert(t.data===pin&&w.data===pin&&t.newOverlapAreaDeg2===0&&t.oldLandLossEmpty&&w.wholeNewOverlapAreaDeg2===0&&w.pairDE9IM==='FF2F11212'&&w.ltuNativeExact===true,'strict overlap/loss proof');
 assert(eq(w.changedComponents,[11,12])&&w.p12OriginalStartPreserved&&w.polOldIntersectionEqualsNew&&w.polExactSharedEdgeCount===645&&w.polExactSharedUniqueVertices===646,'protected old frontier continuity proof');
 assert(eq(Object.keys(t.peers).sort(),[...peers].sort())&&Object.values(t.peers).every(p=>p.shapeIntersectionEqual===true&&p.sharedBoundaryExactlyEqual===true),'all fixed peers');
}
export function assertRusLtuSeam(next,previous,{prefixes,readEvidence}={}){
 const {binding,frozen,descriptorPath,resourcePath,ltu,geometrySha256,geometryResourceSha256}=registered;
 assert(hasRusLtuSeam(next)&&previous?.entityId==='state:RUS'&&typeof readEvidence==='function','registered exact RUS source and archive reader required');
 assert.deepEqual([...prefixes].sort(),[descriptorPath,resourcePath].sort(),'one current RUS descriptor/CAS only');
 const [v]=active(next),[old]=active(previous);
 assert(active(next).length===1&&active(previous).length===1&&v.versionId===version&&old.versionId===version&&old.validFrom==='2014-03-18'&&eq(retained(next),retained(previous)),'unchanged historical metadata/attribution/dates');
 const s={adoptionMode:rusLtuSeamMethod,status,resultRelation:'partial-original-with-readonly-lithuania-seam',wholeCountryRaw:false,priorPreparedAttribution:old.modernBoundarySupplement,geometrySha256,seamReview:binding.review};
 assert.deepEqual(v.modernBoundarySupplement,s,'only exact partial source and prior supplement');
 assert(old.modernBoundarySupplement?.adoptionMode==='exact-original-rus-pol-readonly-counterpart-seam'&&eq(old.modernBoundarySupplement.seamReview,oldPol),'previous Poland supplement required');
 const read=r=>JSON.parse(fetch(readEvidence,r.reference,r.sha256));
 const pol=read(oldPol),polTopo=read(oldPolWhole);
 assert(pol.geometryResourceSha256===frozen.RUS.resourceSha256&&eq(pol.topologyProof,oldPolWhole)&&polTopo.newOverlapKm2===0&&polTopo.oldCoverageLossKm2===0,'exact previous Poland receipts');
 for(const [code,row] of Object.entries(frozen)){
  const j=JSON.parse(fetch(readEvidence,ppath(code),row.descriptorSha256)),sv=j.geometryVersions.find(x=>x.versionId===row.version);
  assert(sv?.validFrom===row.from&&sv.validTo===row.to&&sv.geometryResource?.sha256===row.resourceSha256,'fixed current entity/dates '+code);
  fetch(readEvidence,base+sv.geometryResource.file,row.resourceSha256);
  if(code==='RUS'){
   assert.deepEqual(decodeTerritorialSource(j,p=>readEvidence(base+p)),previous,'exact before entity');
   for(const o of j.geometryVersions.filter(o=>o.versionId!==version&&o.geometryResource))fetch(readEvidence,base+o.geometryResource.file,o.geometryResource.sha256);
  }
 }
 const r=read(binding.review),t=read(binding.topologyProof),w=read(binding.wholePairProof),src=read(binding.originalArcs);
 assert(r.method===rusLtuSeamMethod&&r.sourcePin===binding.sourcePin&&r.geometrySha256===geometrySha256&&r.geometryResourceSha256===geometryResourceSha256,'exact current review');
 validateTopology(t,w,binding.sourcePin,Object.keys(frozen).filter(c=>c!=='RUS'&&c!=='LTU'));
 assert(src.data===binding.sourcePin&&src.RUS.uuid==='47aaa6b3-b456-4723-9317-e661720b4332'&&src.RUS.wkbSha256==='707b022fc4049577b58685185b1c42fe0e27dbabdd50f1e2a64496ac4532004e'&&src.windows.length===3,'original RUS provenance');
 const j=JSON.parse(fetch(readEvidence,ltu.path,ltu.sha256)),buf=Buffer.from(j.rawBlobBase64,'base64');
 assert(j.featureId===ltu.uuid&&j.rawWkbSha256===ltu.wkbSha256&&sha(buf)===j.rawBlobSha256,'official Lithuania bytes');
 const donor=decodeOriginalBlobGeometry(buf,{expectedWkbSha256:ltu.wkbSha256});
 const lj=JSON.parse(fetch(readEvidence,ppath('LTU'),frozen.LTU.descriptorSha256));
 const fixedLTU=active(decodeTerritorialSource(lj,p=>readEvidence(base+p)))[0].geometry;
 assert.deepEqual(fixedLTU,donor,'unchanged Lithuania equals its official source');
 const expected=buildCandidate(old.geometry,src.windows,donor);
 assert.deepEqual(v.geometry,expected,'complete native RUS replay');
 assert(domain(v.geometry)===geometrySha256&&sha(JSON.stringify({coordinates:v.geometry.coordinates,type:v.geometry.type})+'\n')===geometryResourceSha256&&next.sourceInfo.geometryVersionId===version&&next.sourceInfo.geometrySha256===geometrySha256,'exact candidate geometry/digest');
 return 1;
}
export function buildCandidate(old,windows,donor){
 const ops=operations.map((op,i)=>{
  const s=windows[i];assert.deepEqual(s.index,op.raw,'only exact frozen source indices');
  assert(s.points.length===[64,22617,73][i],'exact source counts');
  return {...op,raw:{polygonIndex:i,ringIndex:0,startIndex:0,endIndex:s.points.length-1,direction:1}};
 });
 const p=windows.map(x=>x.points);
 assert.deepEqual(p[0].slice(0,-1),exactCyclicChain(donor.coordinates[2][0],3313,3251,-1),'native Lithuania coast-terminal chain');
 assert.deepEqual(p[1],exactCyclicChain(donor.coordinates[11][0],119328,96712,-1),'native Lithuania mainland chain');
 assert.deepEqual(p[2],exactCyclicChain(donor.coordinates[11][0],69,119329,-1),'native Lithuania wrapped land chain');
 const raw={type:'MultiPolygon',coordinates:p.map(x=>[[...x,x[0]]])};
 const out=replayRetainedCoast(old,raw,ops,ringStarts);
 out.coordinates[12][0]=rotateClosedAt(out.coordinates[12][0],old.coordinates[12][0][0]);
 assert.deepEqual(old.coordinates[1],out.coordinates[1],'prior Poland Vistula part unchanged');
 assertOldChain(old.coordinates[11][0],out.coordinates[11][0],411,22938,646);
 return out;
}


const registered=Object.freeze({"binding":{"sourcePin":"848698dd63e92e382a84bc6ac1a224e59fd99bdc","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/rus-ltu-original-frontier-20261115/review.json","sha256":"b205b2e3a1374d151370c156469f8ba171ee0cb06ffedb704368d63a83d71e3d"},"originalArcs":{"reference":"reports/borders/validation/modern-raw-source-20261110/rus-ltu-original-frontier-20261115/original-arcs.json","sha256":"d625bd45597353f2700424b5910ff794cd0460228065f2209bcc0baa731636c6"},"topologyProof":{"reference":"reports/borders/validation/modern-raw-source-20261110/rus-ltu-original-frontier-20261115/topology-proof.json","sha256":"dc8f962a6400afb4148656348f79c8a069370b7f59e3038863ca5d7a2f63941c"},"wholePairProof":{"reference":"reports/borders/validation/modern-raw-source-20261110/rus-ltu-original-frontier-20261115/whole-pair-proof.json","sha256":"10d499e4f2eb711641652027682ad75fb6c37a38f866cbf2f98c3dbaa6727cdd"}},"frozen":{"RUS":{"descriptorSha256":"5c46aa078bdb782864d0789f4d126bfa148ef1f06478846b67a33c64055fcfa2","resourceSha256":"87b24be2294a611c06f36d0b6d6f500821dffaa2980e5174954ec2caaf3b6838","version":"state:RUS:natural-earth-5.1.1","from":"2014-03-18","to":null},"LTU":{"descriptorSha256":"57bc42f8824495a654e8f0fbf1b70c1c9c640256eac58a579973a47415d183e8","resourceSha256":"8ae8b03af3ce3dac3567a273c88073b8eff5199cb4247ead3052da1bde8434a7","version":"state:LTU:natural-earth-5.1.1","from":"1990-03-11","to":null},"POL":{"descriptorSha256":"be1b06ae66b5463a123a2455fc17bdef6e863b80b3131196acf77f0439b4ff49","resourceSha256":"ccdfef130607c3c858b4f3458a0775ca9b7f87b34cfa312f5f9b15e0897c271e","version":"state:POL:natural-earth-5.1.1","from":null,"to":null},"BLR":{"descriptorSha256":"b428bfd7d801ec5d142d70ce8ae390c615cb48199f97eb95b15c60fa3bed12ab","resourceSha256":"e1bcd7c8c1ee79363d33698197984484e4e3a05372ae784f642ce7c01549cfbb","version":"state:BLR:natural-earth-5.1.1","from":"1991-08-25","to":null},"LVA":{"descriptorSha256":"9ef8a6dba3a4c963f797b4b1bebc8262f68fe7c8c63e279147296a56761de45b","resourceSha256":"20cf314ae2721811e5ea99fb3f3322da0118af60de6b60ecf3865b0e1e621b33","version":"state:LVA:natural-earth-5.1.1","from":"1991-08-21","to":null},"EST":{"descriptorSha256":"4af605358c4edcc2474e010bc7328a859b96b30626d47830a9e021ef052eb4ae","resourceSha256":"be7b295f2b35ee0372fb17b77320103d25b9178a52ed221168af4306558ab5b9","version":"state:EST:natural-earth-5.1.1","from":"1991-08-20","to":null},"FIN":{"descriptorSha256":"1ad3f71a1524bb1ee788f351620b27bc0e0f551c21b80606b63a6997a3eae050","resourceSha256":"05d93c70c2fc34c47388ad8a212eeeb99364b4716d3df600d33e718a99a4200f","version":"state:FIN:natural-earth-5.1.1","from":null,"to":null},"NOR":{"descriptorSha256":"b053388640262bd43fde695b50a1f67948ad2c25707e816b04abb20502ad723f","resourceSha256":"c0dfe4bdfb94e114c54b49ce71a18125301d03768a48635cec13dd5ebbe26355","version":"state:NOR:natural-earth-5.1.1","from":null,"to":null},"UKR":{"descriptorSha256":"87aef9903325cd4fcf6d0b5b3bc7e7132b73df25671df8e8ceb6d87f4d198e2f","resourceSha256":"5efd244500feb48569bb69459529ade56af62329886d3c9fcbba44bec7ca4980","version":"state:UKR:2014-03-18-post-crimea-r1","from":"2014-03-18","to":null},"GEO":{"descriptorSha256":"1ddead98444b04832e68ca09dfd0d7a2c0c422a1112bce3b8e1eef9719f51c20","resourceSha256":"b5d443edaab17852f4dba37f8efcebd45993a376e96a49cd838b23b95ec4ca73","version":"state:GEO:natural-earth-5.1.1","from":"1991-04-09","to":null},"AZE":{"descriptorSha256":"393c6df95285cad48390a11d426bccdc1e78fb503ba2efe7462839fd21dc1c6f","resourceSha256":"54acfc4e0ec3237a581434984e25e8c39d2250630d0dccdd9ad151e47063d71a","version":"state:AZE:natural-earth-5.1.1","from":"1991-10-18","to":null},"KAZ":{"descriptorSha256":"466f8a4aedc6271c0a9db3c2fa1ee4244aeda1bad30101149ededce0faf21962","resourceSha256":"47de235c3a3e07fa5fa40d7ba0805a5ddbe757d5857534439c37903aa0db46ae","version":"state:KAZ:natural-earth-5.1.1","from":"1995-09-25","to":null},"MNG":{"descriptorSha256":"d7e67adde7c998fe4886811b432aabc08063dbfdef353bb29b94330dfdf71cc8","resourceSha256":"476459922561c7f96ae33b864421f506436d6eba925ef423b29a052ca27c806a","version":"state:MNG:natural-earth-5.1.1","from":"1925-05-13","to":null},"CHN":{"descriptorSha256":"733e6324b391c55e918a870823b6acbe5ceb9720d5a87c2a8497fe68954a0900","resourceSha256":"57f5bdcc36f3b7c03f9108c08cb65bb00aad82c47217b3cdb98bafd7aa39ce41","version":"state:CHN:paektu-lsib-11.4","from":null,"to":null},"PRK":{"descriptorSha256":"0f2a33b509862413a607fed53df2bf628272dc302abe0b381b422e2195d7ad29","resourceSha256":"c7c8493d65399361ea6e1092d133ebf212c5a217d27b8c092fee5b6d3879a50c","version":"state:PRK:sino-korean-protocol-1964","from":"1964-03-20","to":null},"SWE":{"descriptorSha256":"2cf4a40ef63c1c54b27609fadda35f5c060d72e1ba9a4fbf7fdb9bf21c189ffc","resourceSha256":"9b857b5ebcf85e38852dfc89c3d79fec2cb4bf8ed2996ed1707055235e62da61","version":"state:SWE:natural-earth-5.1.1","from":null,"to":null},"DNK":{"descriptorSha256":"9b29a2df25a75f7bc0456dbdc316acd1a2e37b216fb4b49a9ee5893a204ceff7","resourceSha256":"e88d07b0266fa0bc197fa599de8cfc1c99e05fa9a80194a1b7ff83501329fa03","version":"state:DNK:natural-earth-5.1.1","from":null,"to":null},"DEU":{"descriptorSha256":"5dbd59a011dcf7a43bbad4cc32ae4beedcfd25755659d04671fda08b425dee9e","resourceSha256":"0f454612139bde97715765f27ae09829502e58fd7383c45e2c2852f289977813","version":"state:DEU:natural-earth-5.1.1","from":"1918-11-09","to":null}},"descriptorPath":"assets/data/territorial-entities/source/countries/state-RUS.json","resourcePath":"assets/data/territorial-entities/source/geometries/sha256-c9033e2f2750ef2458c8b3a768ffb8f7f5b7325f9efd44b56986dd6fc62e5b8a.json","additionalProofs":[{"reference":"reports/borders/validation/modern-raw-source-20261110/rus-ltu-original-frontier-20261115/original-arcs.json","sha256":"d625bd45597353f2700424b5910ff794cd0460228065f2209bcc0baa731636c6","file":"original-arcs.json"},{"reference":"reports/borders/validation/modern-raw-source-20261110/rus-ltu-original-frontier-20261115/whole-pair-proof.json","sha256":"10d499e4f2eb711641652027682ad75fb6c37a38f866cbf2f98c3dbaa6727cdd","file":"whole-pair-proof.json"}],"ltu":{"path":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-post-soviet-current-20261113/originals/LTU-original.json","sha256":"d548f9e6e7753866da3e216cd8e074ef9f51f551d8806a994ee6184f412692e7","uuid":"3b6aea39-594e-4579-af06-d5af962cca8d","name":"Lithuania","GENC3":"LTU","wkbSha256":"faba9607ce4e93f67c6ae47a5c3469a107d9f791d2bd83f762504cd3fa7e74bb"},"geometrySha256":"b3c343108e377996c9f48b0f0aed186439d06bdd072ebbbb32caeb3a4a0c7786","geometryResourceSha256":"c9033e2f2750ef2458c8b3a768ffb8f7f5b7325f9efd44b56986dd6fc62e5b8a"});
export const operations=[[11,156,161,28,9934,9997],[11,264,411,28,16002,38618],[12,9,5,34,28,100]].map(
 ([polygonIndex,startIndex,endIndex,p,rs,re])=>Object.freeze({polygonIndex,ringIndex:0,startIndex,endIndex,raw:Object.freeze({polygonIndex:p,ringIndex:0,startIndex:rs,endIndex:re,direction:1})}));
Object.freeze(operations);
export const ringStarts=Object.freeze([Object.freeze({polygonIndex:11,ringIndex:0,startIndex:0}),Object.freeze({polygonIndex:12,ringIndex:0,startIndex:9})]);
export function rotateClosedAt(closed,origin){
 assert(closed.length>=4&&eq(closed[0],closed.at(-1)),'closed ring origin');
 const v=closed.slice(0,-1),i=v.findIndex(p=>eq(p,origin));
 assert(i>=0&&v.findIndex((p,k)=>k>i&&eq(p,origin))<0,'unique exact retained origin required');
 return [...v.slice(i),...v.slice(0,i),v[i]];
}
export function assertOldChain(old,next,i,j,n){
 assert([i,j,n].every(Number.isSafeInteger)&&i>=0&&j>=0&&n>=2&&old.length>=i+n&&next.length>=j+n&&eq(old.slice(i,i+n),next.slice(j,j+n)),'prior original point chain differs');
 return true;
}
