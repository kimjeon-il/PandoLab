import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';
import {protectedOriginalArcMethod} from './protected-deu-ita-source-review.mjs';
const base='assets/data/territorial-entities/source/',id='state:DEU',root='reports/borders/validation/modern-raw-source-20261110/';
const domain=g=>hash(JSON.stringify([g.type,g.coordinates])),hash=b=>createHash('sha256').update(b).digest('hex'),cas=g=>hash(JSON.stringify(g)+'\n');
const fail=m=>{throw Error('DEU/CZE exact archived native seam: '+m)};
export const deuCzeSeamMethod='exact-original-deu-cze-readonly-counterpart-seam';
const status='raw-source-only-not-display-approved',relation='partial-original-with-readonly-czech-seam';
export const hasDeuCzeSeam=e=>e?.entityId===id&&e.geometryVersions?.some(x=>x.validTo===null&&x.modernBoundarySupplement?.adoptionMode===deuCzeSeamMethod)===true;
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


/* Insert by template into the existing reviewed DEU/CHE stage, without altering its on-disk code. */
const cheDir=root+'deu-che-original-frontier-20261116/';
const cheReview={reference:cheDir+'review.json',sha256:'cf5eed11d8731ddbdc89a0344c79466690cfe6d7a026ec432c7d6c08a4835e12'};
const cheTopology={reference:cheDir+'topology-proof.json',sha256:'dfcee3980317a571a0fd00d1d53a72ce34c9a990046a66edbf8b0f445cabcb3f'};
const cheCas='b8c8960be9e6d2cfdef534a3a78eac75f8f63b4e2b5c7935fe60651942406bb0';
const cheMethod='exact-original-deu-che-readonly-counterpart-seam';
const swPin='3ef9e58bf20d9e55642241e89ea9eede3868d73d';
const approvalMaskSHA='24aea3f7acf71fbdef719e5de76e0a21888ebbe12fa5bbe9436054f755e3595d';
const rawAutMain={polygonIndex:300,ringIndex:0,startIndex:163811,endIndex:496392,direction:1};
const autMainDonor={polygonIndex:1,ringIndex:0,startIndex:461927,endIndex:129346,direction:-1};
const expectedSwissAnchor=[9.561825500000054,47.50455850000003];
const arc0=(g,a)=>exactCyclicChain(g.coordinates[a.polygonIndex][a.ringIndex],a.startIndex,a.endIndex,a.direction);
const key=p=>JSON.stringify(p);
function pointIndex(ring,point){
 const k=key(point),hits=[];
 ring.slice(0,-1).forEach((x,i)=>{if(key(x)===k)hits.push(i);});
 if(hits.length!==1)fail('one exact pinned original exterior anchor required');
 return hits[0];
}
export function bindAutExistingHole(old,native,donor,proof){
 const op=old.coordinates[0],nr=open(native,300,1),dr=open(donor,0,0);
 if(!op?.[1]||nr.length!==2007||dr.length!==2007||!eq(nr,points(dr,2005,2007,-1))||
 !eq(proof.oldPolygonRing,[0,1])||!eq(proof.rawPolygonRing,[300,1])||!eq(proof.donorPolygonRing,[0,0])||proof.donorStart!==2005||
 proof.countClosed!==2008||proof.oldOriginIndex!==0||proof.rawRotation!==371||proof.existingOutsideEnclaveUnchanged!==true||
 !eq(op[1][0],nr[371]))fail('only existing Jungholz ring, native donor and existing origin permitted');
 const h=points(nr,371,2007);return [...h,h[0]];
}
export function assertAutPriorDeuPoints(old,next,native,approved,proof){
 if(approved.arcCount!==1055||approved.addedOriginalVertices!==66342||proof.approvedArcs!==1055||proof.approvedInsertedVertices!==66342||proof.exactBeforeAfter?.length!==1055)fail('all original 1055 prior German arc receipts required');
 const cache=new Map();const rq=(key,g,p,r)=>{let k=[key,p,r].join(':');if(!cache.has(k))cache.set(k,open(g,p,r));return cache.get(k);};let inserted=0;
 for(const [j,arc] of approved.arcs.entries()){
  const [p,r,i,k,n,p0,r0,s,t,dr]=proof.exactBeforeAfter[j];
  if(!eq([p,r,n,p0,r0,s,t,dr],[arc.polygon,arc.ring,arc.rawVertices,arc.rawPolygon,arc.rawRing,arc.rawStart,arc.rawEnd,arc.direction]))fail('approved prior operation indices changed');
  const x=rq('native',native,p0,r0),a=rq('old',old,p,r),b=rq('new',next,p,r);
  if(!Number.isSafeInteger(i)||i<0||i>=a.length||!Number.isSafeInteger(k)||k<0||k>=b.length)fail('prior indexed locations invalid');
  const ar=points(x,s,n,dr);
  if(!eq(ar,points(a,i,n))||!eq(ar,points(b,k,n))||hash(JSON.stringify(ar))!==arc.rawCoordinatesSha256)fail('a prior protected approved native point stream differs');
  inserted+=n-2;
 }
 if(inserted!==66342)fail('earlier German vertex count changed');
}
const originalA={reference:root+'whole-original-region-nordic-central-20261113/originals/AUT-original.json',sha256:'ed0f0879266042a2367a5490b03c3c482ac25a02c5a6df3dfd3f95a55938bf1f'};

/* TEMP template. Actual app/data pin, registration, dispatcher and test files must be emitted only after complete AUT archive readback and renewed CZE proof. */
const czeOriginal={reference:root+'whole-original-region-nordic-central-20261113/originals/CZE-original.json',sha256:'106b65f01686994c08d3ecf783c2a357810d0abb99bc385943af2713dbb7603d'};
const czeNative={polygonIndex:300,ringIndex:0,startIndex:95103,endIndex:163811,direction:1};
const lastAUTReview={reference:root+'deu-aut-original-frontier-20261116/review.json',sha256:'c30903590959a2110f9bfdc44d2b0aefab02fa60e7f2beb6f926f6d6c140ce00'};
const lastAUTTopo={reference:root+'deu-aut-original-frontier-20261116/topology-proof.json',sha256:'e2f5ca1c0ed85bb80df5ccf1aeea065f3c0818f667a64496d0b1e7f59aa2088c'};
const lastAUTCas='3993b6b635511ab9596160d3c2264ffa6ea3bde88c4d4bf2c93acc01ac6a9636';
const lastAUTMethod='exact-original-deu-aut-readonly-counterpart-seam';
const lastAUTPin='8c1c12cf87dedb9438782d8ed08c3dfed3353b02';
const czeAutAnchors=(g)=>[g.coordinates[300][0][95103],g.coordinates[300][0][163811]];
export function bindCzeCurrentMain(old,native,fixedCze,p){
 const a=arc0(native,czeNative), [lo,hi]=czeAutAnchors(native).map(x=>pointIndex(old.coordinates[0][0],x));
 if(lo>=hi||a.length!==68709||!eq(p.old,[0,0,lo,hi])||!eq(p.raw,[300,0,95103,163811,1])||p.points!==a.length)
   fail('actual uniquely anchored Czech German native interval required');
 const [poly,ring,start,end,direction]=p.donor??[];
 if(!eq([poly,ring,start,end,direction],[0,0,91791,23083,-1]))fail('exact bounded Czech donor metadata required');
 const recip=arc0(fixedCze,{polygonIndex:poly,ringIndex:ring,startIndex:start,endIndex:end,direction});
 if(!eq(a,recip))fail('native German and fixed whole Czech donor coordinates differ');
 return {polygonIndex:0,ringIndex:0,startIndex:lo,endIndex:hi,raw:czeNative};
}
export function assertSavedCheAutPointwise(old,next,deu,che,aut,pair,readEvidence){
 const sr=read(readEvidence,cheReview),st=read(readEvidence,cheTopology),ar=read(readEvidence,lastAUTReview),at=read(readEvidence,lastAUTTopo);
 if(sr.method!==cheMethod||sr.sourcePin!==swPin||sr.geometryResourceSha256!==cheCas||!eq(sr.topologyProof,cheTopology)||st.newOverlap!==0||st.loss!==0||
  ar.method!==lastAUTMethod||ar.sourcePin!==lastAUTPin||ar.geometryResourceSha256!==lastAUTCas||ar.geometrySha256!==domain(old)||!eq(ar.topologyProof,lastAUTTopo)||
  at.newOverlapKm2!==0||at.coverageLossKm2!==0||at.alreadySavedCHEExact.receiptSHA256!==cheTopology.sha256||
  !eq(pair.CHE?.acceptedArchiveProof,{path:cheTopology.reference,sha256:cheTopology.sha256})||!eq(pair.AUT?.acceptedArchiveProof,{path:lastAUTTopo.reference,sha256:lastAUTTopo.sha256}))fail('both actual previously saved archive receipts required');
 const main=(a,b,counts,positions)=>{
   if(a.length!==counts||!eq(a,b)||!Array.isArray(positions)||positions.length!==2)fail('earlier full exact native frontier required');
   const rs=[old.coordinates[0][0],next.coordinates[0][0]];
   for(const [i,r] of rs.entries())if(positions[i]!==pointIndex(r,a[0])||!eq(r.slice(positions[i],positions[i]+counts),a))fail('one earlier full previously saved point stream would move or change');
 };
 main(arc0(deu,{polygonIndex:300,ringIndex:0,startIndex:496392,endIndex:501342,direction:1}),arc0(che,{polygonIndex:0,ringIndex:0,startIndex:0,endIndex:57327,direction:-1}),4951,[pair.CHE.beforeStart,pair.CHE.afterStart]);
 main(arc0(deu,rawAutMain),arc0(aut,autMainDonor),332582,[pair.AUT.beforeStart,pair.AUT.afterStart]);
 const ringOld=open(old,105,0),ringNew=open(next,105,0),e=points(open(deu,240,0),153,305),d=points(open(che,0,1),138,305,-1);
 if(ringOld.length!==305||!eq(ringOld,ringNew)||!eq(ringOld,e)||!eq(e,d))fail('exact previously applied Busingen ring and origin required');
 const jun=bindAutExistingHole(old,deu,aut,at.operations[1]);
 if(!eq(old.coordinates[0][1],jun)||!eq(next.coordinates[0][1],jun))fail('exact existing previously applied Jungholz hole and origin required');
 return true;
}
export function assertCzeProtectedTopology(t,pin,raw){
 if(t.baseData!==pin||t.wholeDE9IM!=='FF2F11212'||t.newOverlapKm2!==0||t.coverageLossKm2!==0||t.coverageDifferenceEmpty!==true||t.protectedZoneDisjoint!==true||t.protectedZoneAllocationExact!==true||t.protectedZoneBoundaryExact!==true||
 !eq(Object.keys(t.peerChecks??{}).sort(),['AUT','BEL','CHE','DNK','FRA','ITA','LIE','LUX','NLD','POL']))fail('strict exact local coverage plus historic DEU policy mask required');
 const [a,b]=czeAutAnchors(raw);
 for(const [c,x] of Object.entries(t.peerChecks)){
  const name=c==='POL'?a:c==='AUT'?b:null;
  if(x.completeIntersectionAndBoundaryExact!==true||(x.deltaContact!==null&&(!name||!eq(x.deltaContact,{type:'Point',coordinates:name}))))
   fail('another current regional boundary or contact changed: '+c);
 }
}

export function assertDeuCzeSeam(next,previous,{prefixes,readEvidence}={}){
 const {binding,frozen,descriptorPath,resourcePath}=registration;
 if(!hasDeuCzeSeam(next)||previous?.entityId!==id||typeof readEvidence!=='function')fail('only registered current Germany supported');
 const ov=previous.geometryVersions.filter(x=>x.validTo===null),nv=next.geometryVersions.filter(x=>x.validTo===null),o=ov[0],v=nv[0],s=v?.modernBoundarySupplement;
 if(ov.length!==1||nv.length!==1||v.versionId!=='state:DEU:natural-earth-5.1.1'||o.validFrom!=='1918-11-09'||o.geometry.type!=='MultiPolygon'||v.geometry.type!==o.geometry.type||v.versionId!==o.versionId||v.validFrom!==o.validFrom||!eq(stable(next,v.versionId),stable(previous,v.versionId))||next.metadata?.representativeGeometryVersionId!==v.versionId)fail('previous German historical versions/metadata must remain exact');
 if(o.modernBoundarySupplement?.adoptionMode!==lastAUTMethod||o.modernBoundarySupplement.geometrySha256!==domain(o.geometry)||cas(o.geometry)!==lastAUTCas||!eq(o.modernBoundarySupplement.seamReview,lastAUTReview)||
  o.modernBoundarySupplement.priorPreparedAttribution?.adoptionMode!==cheMethod||!eq(o.modernBoundarySupplement.priorPreparedAttribution.seamReview,cheReview)||o.modernBoundarySupplement.priorPreparedAttribution.priorPreparedAttribution?.adoptionMode!==protectedOriginalArcMethod||!eq(o.modernBoundarySupplement.priorPreparedAttribution.priorPreparedAttribution.sourceAdoptionReview,priorReview)||
  !eq(s,{adoptionMode:deuCzeSeamMethod,status,resultRelation:relation,wholeCountryRaw:false,geometrySha256:domain(v.geometry),priorPreparedAttribution:o.modernBoundarySupplement,seamReview:binding.review})||
  next.sourceInfo?.geometrySha256!==s.geometrySha256||next.sourceInfo?.geometryVersionId!==v.versionId)fail('exact Swiss and earlier protected German review chain required');
 if(!Array.isArray(prefixes)||!eq([...prefixes].sort(),[descriptorPath,resourcePath].sort()))fail('only reviewed Germany descriptor and coordinate paths');
 const r=read(readEvidence,binding.review),p=read(readEvidence,r.topologyProof);
 if(r.sourcePin!==binding.sourcePin||r.method!==deuCzeSeamMethod||r.entityId!==id||r.versionId!==v.versionId||r.validFrom!==v.validFrom||r.validTo!==null||r.previousGeometrySha256!==domain(o.geometry)||r.geometrySha256!==domain(v.geometry)||r.geometryResourceSha256!==cas(v.geometry))fail('registered physical feature and exact new coordinate CAS required');

 const release=read(readEvidence,priorReview),contract=read(readEvidence,priorContract);read(readEvidence,priorMask);const oldOps=read(readEvidence,priorOps);
 const row=contract.rows.find(x=>x.code==='DEU'), replay=read(readEvidence,contract.independentReplay).rows.find(x=>x.code==='DEU'),line=read(readEvidence,contract.protectedLineProof).find(x=>x.code==='DEU');
 if(release.method!==protectedOriginalArcMethod||release.geometrySha256!==o.modernBoundarySupplement.priorPreparedAttribution.priorPreparedAttribution.geometrySha256||
  !row||row.candidateResourceSha256!=='503f41377852b9783c2be99dd30b00555858c225f99ab3190214030e73b73de1'||!eq(row.zone,priorMask)||!eq(row.arcProof,priorOps)||
  replay?.exactRawArcReplay!==true||replay.unselectedEdgesChanged!==0||replay.candidateResourceSha256!==row.candidateResourceSha256||line?.protectedCurrentAreaExactlyEqual!==true||line.additionalProtectedLossEmpty!==true||!line.peers?.every(x=>x.lostSetsEqual===true&&x.missingLength===0&&x.baselineMissingLength===0))fail('earlier exact protected mask allocation and native receipt must remain');
 assertArchivedHistoricalContext(next,previous,readEvidence,frozen);
 const oldNative=read(readEvidence,earlierOriginalE),boundNative=read(readEvidence,originalE);
 if(!eq([oldNative.featureId,oldNative.rawBlobSha256,oldNative.rawWkbSha256,oldNative.rawBlobBase64],[boundNative.featureId,boundNative.rawBlobSha256,boundNative.rawWkbSha256,boundNative.rawBlobBase64]))fail('same exact historical local native source required');
 const DEU=original(readEvidence,originalE,'DEU'),CHE=original(readEvidence,originalC,'CHE'),AUT=original(readEvidence,originalA,'AUT'),CZE=original(readEvidence,czeOriginal,'CZE'),curr={};
 for(const [c,x] of Object.entries(frozen)){
  const d=read(readEvidence,{reference:base+'countries/state-'+c+'.json',sha256:x.descriptorSha256}),e=decodeTerritorialSource(d,a=>readEvidence(base+a));
  const v=e.geometryVersions.filter(q=>q.validTo===null),d0=d.geometryVersions.find(q=>q.versionId===v[0]?.versionId);
  if(v.length!==1||e.entityId!=='state:'+c||!eq([d0.geometryResource.sha256,v[0].versionId,v[0].validFrom,v[0].validTo],[x.cas,x.version,x.from,x.to]))fail('frozen regional metadata changed: '+c);
  curr[c]={e,v:v[0]};
 }
 if(!eq(curr.DEU.e,previous)||!eq(curr.CHE.v.geometry,CHE)||!eq(curr.AUT.v.geometry,AUT)||!eq(curr.CZE.v.geometry,CZE))fail('exact post-Swiss Germany preimage and unchanged Austrian/Swiss full native peers required');
 assertCzeProtectedTopology(p,r.sourcePin,DEU);
 if(p.operations?.length!==1)fail('one existing Czech frontier only');
 const k=bindCzeCurrentMain(o.geometry,DEU,CZE,p.operations[0]);
 const expected=replayRetainedCoast(o.geometry,DEU,[k],[{polygonIndex:0,ringIndex:0,startIndex:0}]);
 if(!eq(expected,v.geometry))fail('only the exact reviewed native Czech exterior arc is allowed');
 assertSavedCheAutPointwise(o.geometry,v.geometry,DEU,CHE,AUT,p.frozenPreviouslySavedFrontiers,readEvidence);
 assertAutPriorDeuPoints(o.geometry,v.geometry,DEU,oldOps,{approvedArcs:p.old1055Pointwise.rowsByPin.length,approvedInsertedVertices:p.old1055Pointwise.inserted,exactBeforeAfter:p.old1055Pointwise.rowsByPin});
 return 1;
}

const registration={"binding":{"sourcePin":"27cb04059cd031cda81d83b1ad7eeb2cd82c56de","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/deu-cze-original-frontier-20261116/review.json","sha256":"be3a86a9b32978649a240525dd537982faee5c6b259047e1e8735834a5ac8bae"}},"frozen":{"DEU":{"descriptorSha256":"bf6bb849dc5777884f762290fc2236dbfb39ee2eb9b5d9c0db3e9c555e536e86","cas":"3993b6b635511ab9596160d3c2264ffa6ea3bde88c4d4bf2c93acc01ac6a9636","version":"state:DEU:natural-earth-5.1.1","from":"1918-11-09","to":null},"CZE":{"descriptorSha256":"6ee4fcb7896b1c108a8345aefa53c894601efdbf11cec5242e8818bbddcbf1ad","cas":"8b9bd00631f326b2682e54e09051d8af94696116cea2794e15d1029952feec65","version":"state:CZE:natural-earth-5.1.1","from":null,"to":null},"AUT":{"descriptorSha256":"e82e7d36d0c4ae7c6df0e600be12c6720687a7c713766afdd9207191c5e4bba7","cas":"194534ed6b3efbb2b22fe21e778d0351495a91eea720219b2dfc9ca17823171a","version":"state:AUT:natural-earth-5.1.1","from":null,"to":null},"POL":{"descriptorSha256":"be1b06ae66b5463a123a2455fc17bdef6e863b80b3131196acf77f0439b4ff49","cas":"ccdfef130607c3c858b4f3458a0775ca9b7f87b34cfa312f5f9b15e0897c271e","version":"state:POL:natural-earth-5.1.1","from":null,"to":null},"CHE":{"descriptorSha256":"41473a3f65a666a5d3d1c10a65564c5e0de6d38a598a37aca401ed17b6bca09e","cas":"9ca05cdaf1da84bb49bbb5cdf1101d5bc22b4070c682f44be1166ae697fc84cb","version":"state:CHE:natural-earth-5.1.1","from":null,"to":null},"LIE":{"descriptorSha256":"2098349efbb829df09f30893c78a13efeeb62df4176d5fbaf36f56435849bfa6","cas":"62db9df4d40746bf1609a4f8de01c64743268ad6112ff0a5a098fa187e660ec4","version":"state:LIE:natural-earth-5.1.1","from":null,"to":null},"FRA":{"descriptorSha256":"1ec0a42edd3be08ccb0f87dec8d9e14270398b83f33c531c99c2c12efddda1cc","cas":"84e6073a7a8957a981bc618be6782cfd83177f0b175c3ffb95edfa3d1535a933","version":"state:FRA:natural-earth-5.1.1","from":null,"to":null},"LUX":{"descriptorSha256":"38e9e17a48b0da437d31c02282c61938861866e0be39b6caa19d81edf6856dde","cas":"0b183c1ae5705f278e02431c4477dcac749454ef640c6bcc450b7b4332124868","version":"state:LUX:natural-earth-5.1.1","from":null,"to":null},"BEL":{"descriptorSha256":"9e0eeab74a7a44d095cfce5b2c6f89ace0929ae0533fd9e4f8b18c8c0cb5459d","cas":"f342ba69ffe00e500915eb5a9e036213303f9886d1d44bf488292aa02ceb9a21","version":"state:BEL:natural-earth-5.1.1","from":null,"to":null},"NLD":{"descriptorSha256":"0fb113354e5ece7c86392cb173b1a5efaa9c1b3d368a8adaa377dce6e26be8bb","cas":"cf5939ff2ebe09aeb408e0b6a7a7a61120e00b77e002bc1c56a0e3d09bab38ab","version":"state:NLD:natural-earth-5.1.1","from":null,"to":null},"DNK":{"descriptorSha256":"9b29a2df25a75f7bc0456dbdc316acd1a2e37b216fb4b49a9ee5893a204ceff7","cas":"e88d07b0266fa0bc197fa599de8cfc1c99e05fa9a80194a1b7ff83501329fa03","version":"state:DNK:natural-earth-5.1.1","from":null,"to":null},"ITA":{"descriptorSha256":"6fd9228acf51549949a785dbb3800f5445e562f4dd3274bfb839b8ec56d8bdfe","cas":"da5c696a79f0fabd6e0a5e50542c4f58d4e741667213c6896f17ce4bf81b4f6e","version":"state:ITA:natural-earth-5.1.1","from":null,"to":null}},"descriptorPath":"assets/data/territorial-entities/source/countries/state-DEU.json","resourcePath":"assets/data/territorial-entities/source/geometries/sha256-950a7a0037977cb388e37ee684dc3aeb3285532001e5b3e48017f013b385fd61.json"};
