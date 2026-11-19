import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';
import {protectedOriginalArcMethod} from './protected-deu-ita-source-review.mjs';
const base='assets/data/territorial-entities/source/',id='state:DEU',root='reports/borders/validation/modern-raw-source-20261110/';
const domain=g=>hash(JSON.stringify([g.type,g.coordinates])),hash=b=>createHash('sha256').update(b).digest('hex'),cas=g=>hash(JSON.stringify(g)+'\n');
const fail=m=>{throw Error('DEU/CHE exact archived native seam: '+m)};
export const deuCheSeamMethod='exact-original-deu-che-readonly-counterpart-seam';
const status='raw-source-only-not-display-approved',relation='partial-original-with-readonly-swiss-seam';
export const hasDeuCheSeam=e=>e?.entityId===id&&e.geometryVersions?.some(x=>x.validTo===null&&x.modernBoundarySupplement?.adoptionMode===deuCheSeamMethod)===true;
const dir=root+'protected-deu-ita-contract-20261113/';
const priorReview={reference:dir+'DEU-review.json',sha256:'2c1e00c68af96f615d08d3b4cde9b0d10a0fd8ad67937df8f9b80a1644241882'};
const priorOps={reference:dir+'DEU-arc-proof.json',sha256:'66b40ee942a8789f6aa33ae7f8b5fdbe09165018d6eb48214ee1598c58877a68'};
const priorMask={reference:dir+'DEU-protected-zone.json',sha256:'24aea3f7acf71fbdef719e5de76e0a21888ebbe12fa5bbe9436054f755e3595d'};
const priorContract={reference:dir+'protected-arc-fixed-bindings.json',sha256:'562bbf523f34dd716219279d59d83e37895c2be3ed5612ea327364134372539f'};
const earlierOriginalE={reference:dir+'DEU-original.json',sha256:'899b2cff28592eac083af1ecc01a557cb8d81c8b0731bf7d577630b269323e7e'};
const originalE={reference:root+'whole-original-region-current-four-20261113/originals/DEU-original.json',sha256:'90feaefbc8f2700ed975cdd54e5423552c7122b8d35c93e13965cdf30698ec86'};
const originalC={reference:root+'whole-original-region-historical-metadata-europe-20261113/originals/CHE-original.json',sha256:'ac6f4375efb7edef13921ce01eadad2c2dd6770c039532add620a280c63df64e'};
const main={polygonIndex:0,ringIndex:0,startIndex:63073,endIndex:64174,raw:{polygonIndex:300,ringIndex:0,startIndex:496392,endIndex:501342,direction:1}};
const read=(f,r)=>{const b=f(r.reference);if(!Buffer.isBuffer(b)||hash(b)!==r.sha256)fail('not exact archived bytes: '+r.reference);return JSON.parse(b)};
const omit=(o,...ks)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!ks.includes(k)));
const stable=(e,v)=>({...e,sourceInfo:omit(e.sourceInfo,'geometryVersionId','geometrySha256'),geometryVersions:e.geometryVersions.map(x=>x.versionId===v?omit(x,'geometry','modernBoundarySupplement'):x)});
const points=(r,start,n,dir=1)=>Array.from({length:n},(_,j)=>r[(start+j*dir+r.length)%r.length]);
const open=(g,p,r)=>g.coordinates[p][r].slice(0,-1);
function original(readEvidence,ref,code){
 const a=read(readEvidence,ref),b=Buffer.from(a.rawBlobBase64,'base64');
 if(a.properties?.GENC_3!==code||a.featureId!==a.properties?.WP_ID||hash(b)!==a.rawBlobSha256||a.sourceFileReceipt?.gpkgSha256!=='55fab422ef09e35eb48d68141b9ece0ace86d4276dfe332a04dfd401c0bfc80c')fail('native archived source required: '+code);
 return decodeOriginalBlobGeometry(b,{expectedWkbSha256:a.rawWkbSha256});
}
export function exactEnclave(old,native,donor){
 const e=open(native,240,0),d=open(donor,0,1),o=open(old,105,0);
 if(e.length!==305||d.length!==305||o.length!==53)fail('existing single enclave ring only');
 const replacement=points(e,153,e.length),dv=points(d,138,d.length,-1);
 if(!eq(replacement,dv)||!eq(replacement[0],o[0]))fail('existing enclave origin or shared native ring changed');
 let last=-1;
 for(const x of o){const i=replacement.findIndex((p,j)=>j>last&&eq(p,x));if(i<0)fail('an existing enclave coordinate/order would be lost');last=i;}
 return [...replacement,replacement[0]];
}
export function assertDeuCheTopology(p,pin){
 const cs=['AUT','BEL','CZE','DNK','FRA','LUX','NLD','POL'];
 if(p.data!==pin||p.pair!=='FF2F11212'||p.newOverlap!==0||p.loss!==0||p.valid!==true||p.maskDeltaEmpty!==true||p.maskInsideEqual!==true||p.priorArcCount!==1055||p.priorInsertedVertices!==66342||
 !eq(Object.keys(p.peers??{}).sort(),cs)||Object.entries(p.peers).some(([c,o])=>o.boundaryEqual!==true||o.intersectionEqual!==true||o.deltaType!==null))fail('pinned native coverage and protected topology required');
}
export function assertPriorDeuPoints(old,next,native,approved,rows){
 if(approved.arcCount!==1055||approved.addedOriginalVertices!==66342||rows?.length!==1055||approved.arcs?.length!==1055)fail('all 1,055 previous operations required');
 const ck=(g,p,r)=>{const k=p+':'+r;return g.cache.get(k)??(g.cache.set(k,open(g.geom,p,r)),g.cache.get(k));};
 const a={geom:old,cache:new Map()},b={geom:next,cache:new Map()},raw={geom:native,cache:new Map()};
 let inserted=0;
 for(const [i,x] of approved.arcs.entries()){
  const [p,r,start,end,np,nr,ns,ne,dr,n]=rows[i];
  if(!eq([p,r,np,nr,ns,ne,dr,n],[x.polygon,x.ring,x.rawPolygon,x.rawRing,x.rawStart,x.rawEnd,x.direction,x.rawVertices])||end!==start+n-1)fail('prior approved arc index mismatch');
  const rr=ck(raw,np,nr),xs=points(rr,ns,n,dr),before=ck(a,p,r),after=ck(b,p,r);
  let j=start;
  if(p===0&&r===0&&start>=64174)j+=3849;
  else if((p===0&&r===0&&end>=63073)||(p===105&&r===0))j=after.findIndex(v=>eq(v,xs[0]));
  if(!Number.isSafeInteger(start)||start<0||start>=before.length||j<0||j>=after.length||!eq(points(before,start,n),xs)||!eq(points(after,j,n),xs)||hash(JSON.stringify(xs))!==x.rawCoordinatesSha256)fail('earlier approved native stream changed');
  inserted+=n-2;
 }
 if(inserted!==66342)fail('all earlier native vertices required');
}
const hbase=root+'historical-europe-partial-20261113/';
const historicalReview={reference:hbase+'paired-fresh-d79f3004/review.json',sha256:'37aaaac1161ccb97c4b7407eec5d03f26057a2d20b678034e516135a6f00236b'};
const operationProof={reference:hbase+'paired-anchor-fresh-86658fc5-1794557709308-1794559025612505000/paired-coast-proofs.json',sha256:'21153bd56099b9f8d3ec88470c8f9452c4764ccf419664d94d6d71c6baba3e5b'};
const combinedHistorical={reference:hbase+'paired-combined-validity.json',sha256:'278e1e7c948a50c20bd79a6f1313a492e457133bda9c3c645af5895b7868c48e'};
const histMethod='fixed-existing-deu-west-prussia-north-schleswig-literal-coast';
const history=[
 {code:'DEU',id:'state:DEU:natural-earth-5.1.1-before-1914-snapshot',from:null,to:'1870-12-31',geo:'503f41377852b9783c2be99dd30b00555858c225f99ab3190214030e73b73de1',paired:false},
 {code:'DEU',id:'state:DEU:1914-07-31-display-r1',from:'1871-01-01',to:'1918-11-08',geo:'bc98c18d4058a78a0bb78a30775567b637e819e7bd42158aacc5a44929e13f35',paired:true},
 {code:'west-prussia',desc:'0f986a45ac642ca0782c94488632de13f7a78203ec8922669cf6d228e1dd67b4',id:'state:west-prussia:1900-01-01-r1',from:'1878-04-01',to:'1919-12-31',geo:'1bae8dcb996126d2eadbeeaa1882f03d54ca0db18008192697ae740ce5eae466',paired:true},
 {code:'north-schleswig',desc:'0a4bdaf6587296c038929e794c627ce4f07df44b3a139aa0534242a29e2a7289',id:'north-schleswig-1900-r3',from:'1900-01-01',to:'1900-01-01',geo:'6ace30bf0d9e1e8be74d06b6c2131da319102178980420b550454144faefb7d7',paired:true}
];
const histMarker={method:histMethod,status:'source-only-not-display-approved',singleOriginalFeature:false,review:historicalReview};
export function assertHistoricalDeuUnchanged(next,previous){
 const nt=next?.geometryVersions?.filter(v=>v.validTo!==null),pt=previous?.geometryVersions?.filter(v=>v.validTo!==null);
 if(!Array.isArray(nt)||!Array.isArray(pt)||pt.length!==2||!eq(nt,pt))fail('all two Germany historical versions must remain exactly unchanged');
}
function assertArchivedHistoricalContext(next,previous,readEvidence,frozen){
 assertHistoricalDeuUnchanged(next,previous);
 const rr=read(readEvidence,historicalReview),op=read(readEvidence,operationProof),co=read(readEvidence,combinedHistorical);
 if(rr.method!==histMethod||!eq(rr.proof,operationProof)||rr.historicalAccuracyVerified!==false||rr.displayApproved!==false||!eq(op.map(x=>x.donor).sort(),['DNK','POL'])||!eq(co.operationProof,operationProof)||co.method!==histMethod||co.sourceWrites!==0||!eq(co.geos.expectedSharedBoundaryExact,[true,true]))fail('the archived paired historical contracts must remain intact');
 for(const x of history){
  const path=base+'countries/state-'+x.code+'.json',d=read(readEvidence,{reference:path,sha256:x.desc??frozen.DEU.descriptorSha256});
  const v=d.geometryVersions.find(y=>y.versionId===x.id),b=readEvidence(base+v?.geometryResource?.file);
  if(!v||v.validFrom!==x.from||v.validTo!==x.to||v.geometryResource.sha256!==x.geo||!Buffer.isBuffer(b)||hash(b)!==x.geo||(!x.paired?v.historicalPairedCoastInsertion!==undefined:!eq(v.historicalPairedCoastInsertion,histMarker)))fail('existing historical target bytes, dates, and source-only markers required');
  if(x.paired&&!rr.targets?.some(y=>y.entityId==='state:'+x.code&&y.versionId===x.id&&y.validFrom===x.from&&y.validTo===x.to&&y.candidateResourceSha256===x.geo))fail('historical paired receipt target differs');
  if(x.code==='DEU'){
   const a=previous.geometryVersions.find(a=>a.versionId===x.id),z=next.geometryVersions.find(a=>a.versionId===x.id),gg=JSON.parse(b);
   if(!eq(a,z)||!eq(a?.geometry,gg))fail('same historical geometry before and after required');
  }
 }
}

export function assertDeuCheSeam(next,previous,{prefixes,readEvidence}={}){
 const {binding,frozen,descriptorPath,resourcePath}=registration;
 if(!hasDeuCheSeam(next)||previous?.entityId!==id||typeof readEvidence!=='function')fail('only registered current Germany supported');
 const ov=previous.geometryVersions.filter(x=>x.validTo===null),nv=next.geometryVersions.filter(x=>x.validTo===null),o=ov[0],v=nv[0],s=v?.modernBoundarySupplement;
 if(ov.length!==1||nv.length!==1||v.versionId!=='state:DEU:natural-earth-5.1.1'||o.validFrom!=='1918-11-09'||o.geometry.type!=='MultiPolygon'||v.geometry.type!==o.geometry.type||v.versionId!==o.versionId||v.validFrom!==o.validFrom||!eq(stable(next,v.versionId),stable(previous,v.versionId))||next.metadata?.representativeGeometryVersionId!==v.versionId)fail('previous German historical versions/metadata must remain exact');
 if(o.modernBoundarySupplement?.adoptionMode!==protectedOriginalArcMethod||!eq(o.modernBoundarySupplement.sourceAdoptionReview,priorReview)||
  !eq(s,{adoptionMode:deuCheSeamMethod,status,resultRelation:relation,wholeCountryRaw:false,geometrySha256:domain(v.geometry),priorPreparedAttribution:o.modernBoundarySupplement,seamReview:binding.review})||
  next.sourceInfo?.geometrySha256!==s.geometrySha256||next.sourceInfo?.geometryVersionId!==v.versionId)fail('exact current protected German review chain required');
 if(!Array.isArray(prefixes)||!eq([...prefixes].sort(),[descriptorPath,resourcePath].sort()))fail('only reviewed Germany descriptor and coordinate paths');
 const r=read(readEvidence,binding.review),p=read(readEvidence,r.topologyProof);
 if(r.sourcePin!==binding.sourcePin||r.method!==deuCheSeamMethod||r.entityId!==id||r.versionId!==v.versionId||r.validFrom!==v.validFrom||r.validTo!==null||r.previousGeometrySha256!==domain(o.geometry)||r.geometrySha256!==domain(v.geometry)||r.geometryResourceSha256!==cas(v.geometry))fail('registered physical feature and exact new coordinate CAS required');
 assertDeuCheTopology(p,r.sourcePin);
 const review=read(readEvidence,priorReview),contract=read(readEvidence,priorContract);
 read(readEvidence,priorMask);const oldOps=read(readEvidence,priorOps); const replay=read(readEvidence,contract.independentReplay).rows.find(x=>x.code==='DEU'); const line=read(readEvidence,contract.protectedLineProof).find(x=>x.code==='DEU'); if(replay?.exactRawArcReplay!==true||replay.unselectedEdgesChanged!==0||replay.candidateResourceSha256!==cas(o.geometry)||line?.protectedCurrentAreaExactlyEqual!==true||line.additionalProtectedLossEmpty!==true||!line.peers?.every(x=>x.lostSetsEqual===true&&x.missingLength===0&&x.baselineMissingLength===0))fail('prior independent masked allocation or exact source evidence missing');
 const row=contract.rows.find(x=>x.code==='DEU');
 if(review.method!==protectedOriginalArcMethod||review.geometrySha256!==domain(o.geometry)||!row||row.candidateResourceSha256!==cas(o.geometry)||!eq(row.zone,priorMask)||!eq(row.arcProof,priorOps))fail('earlier protected contract archive mismatch');
 assertArchivedHistoricalContext(next,previous,readEvidence,frozen);
 const archivedOldOriginal=read(readEvidence,earlierOriginalE), boundOriginal=read(readEvidence,originalE); if(!eq([archivedOldOriginal.featureId,archivedOldOriginal.rawBlobSha256,archivedOldOriginal.rawWkbSha256,archivedOldOriginal.rawBlobBase64],[boundOriginal.featureId,boundOriginal.rawBlobSha256,boundOriginal.rawWkbSha256,boundOriginal.rawBlobBase64]))fail('identical previously accepted official German WKB required');
 const DEU=original(readEvidence,originalE,'DEU'),CHE=original(readEvidence,originalC,'CHE'),curr={};
 for(const [c,x] of Object.entries(frozen)){
  const d=read(readEvidence,{reference:base+'countries/state-'+c+'.json',sha256:x.descriptorSha256}),e=decodeTerritorialSource(d,a=>readEvidence(base+a));
  const v=e.geometryVersions.filter(q=>q.validTo===null),d0=d.geometryVersions.find(q=>q.versionId===v[0]?.versionId);
  if(v.length!==1||e.entityId!=='state:'+c||!eq([d0.geometryResource.sha256,v[0].versionId,v[0].validFrom,v[0].validTo],[x.cas,x.version,x.from,x.to]))fail('frozen regional metadata changed: '+c);
  curr[c]={e,v:v[0]};
 }
 if(!eq(curr.DEU.e,previous)||!eq(curr.CHE.v.geometry,CHE))fail('Germany archive preimage and fixed Switzerland exact');
 const sw=exactCyclicChain(CHE.coordinates[0][0],0,57327,-1),nat=exactCyclicChain(DEU.coordinates[300][0],496392,501342,1);
 if(sw.length!==4951||!eq(sw,nat))fail('reciprocal German/Swiss native main arc differs');
 const expected=replayRetainedCoast(o.geometry,DEU,[main],[{polygonIndex:0,ringIndex:0,startIndex:0}]);
 expected.coordinates[105][0]=exactEnclave(o.geometry,DEU,CHE);
 if(!eq(v.geometry,expected))fail('outside the two exact German rings or splice changed');
 assertPriorDeuPoints(o.geometry,v.geometry,DEU,oldOps,p.priorRows);
 return 1;
}

const registration={"binding":{"sourcePin":"3ef9e58bf20d9e55642241e89ea9eede3868d73d","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/deu-che-original-frontier-20261116/review.json","sha256":"cf5eed11d8731ddbdc89a0344c79466690cfe6d7a026ec432c7d6c08a4835e12"}},"frozen":{"DEU":{"descriptorSha256":"f2bf22fd63dbefbd181eae55a6ab0ad10d736f7c77b5529ffed7915ce307f14e","cas":"503f41377852b9783c2be99dd30b00555858c225f99ab3190214030e73b73de1","version":"state:DEU:natural-earth-5.1.1","from":"1918-11-09","to":null},"CHE":{"descriptorSha256":"41473a3f65a666a5d3d1c10a65564c5e0de6d38a598a37aca401ed17b6bca09e","cas":"9ca05cdaf1da84bb49bbb5cdf1101d5bc22b4070c682f44be1166ae697fc84cb","version":"state:CHE:natural-earth-5.1.1","from":null,"to":null},"AUT":{"descriptorSha256":"e82e7d36d0c4ae7c6df0e600be12c6720687a7c713766afdd9207191c5e4bba7","cas":"194534ed6b3efbb2b22fe21e778d0351495a91eea720219b2dfc9ca17823171a","version":"state:AUT:natural-earth-5.1.1","from":null,"to":null},"BEL":{"descriptorSha256":"9e0eeab74a7a44d095cfce5b2c6f89ace0929ae0533fd9e4f8b18c8c0cb5459d","cas":"f342ba69ffe00e500915eb5a9e036213303f9886d1d44bf488292aa02ceb9a21","version":"state:BEL:natural-earth-5.1.1","from":null,"to":null},"CZE":{"descriptorSha256":"6ee4fcb7896b1c108a8345aefa53c894601efdbf11cec5242e8818bbddcbf1ad","cas":"8b9bd00631f326b2682e54e09051d8af94696116cea2794e15d1029952feec65","version":"state:CZE:natural-earth-5.1.1","from":null,"to":null},"DNK":{"descriptorSha256":"9b29a2df25a75f7bc0456dbdc316acd1a2e37b216fb4b49a9ee5893a204ceff7","cas":"e88d07b0266fa0bc197fa599de8cfc1c99e05fa9a80194a1b7ff83501329fa03","version":"state:DNK:natural-earth-5.1.1","from":null,"to":null},"FRA":{"descriptorSha256":"1ec0a42edd3be08ccb0f87dec8d9e14270398b83f33c531c99c2c12efddda1cc","cas":"84e6073a7a8957a981bc618be6782cfd83177f0b175c3ffb95edfa3d1535a933","version":"state:FRA:natural-earth-5.1.1","from":null,"to":null},"LUX":{"descriptorSha256":"38e9e17a48b0da437d31c02282c61938861866e0be39b6caa19d81edf6856dde","cas":"0b183c1ae5705f278e02431c4477dcac749454ef640c6bcc450b7b4332124868","version":"state:LUX:natural-earth-5.1.1","from":null,"to":null},"NLD":{"descriptorSha256":"0fb113354e5ece7c86392cb173b1a5efaa9c1b3d368a8adaa377dce6e26be8bb","cas":"cf5939ff2ebe09aeb408e0b6a7a7a61120e00b77e002bc1c56a0e3d09bab38ab","version":"state:NLD:natural-earth-5.1.1","from":null,"to":null},"POL":{"descriptorSha256":"be1b06ae66b5463a123a2455fc17bdef6e863b80b3131196acf77f0439b4ff49","cas":"ccdfef130607c3c858b4f3458a0775ca9b7f87b34cfa312f5f9b15e0897c271e","version":"state:POL:natural-earth-5.1.1","from":null,"to":null}},"descriptorPath":"assets/data/territorial-entities/source/countries/state-DEU.json","resourcePath":"assets/data/territorial-entities/source/geometries/sha256-b8c8960be9e6d2cfdef534a3a78eac75f8f63b4e2b5c7935fe60651942406bb0.json"};
