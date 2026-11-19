import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';
import {protectedOriginalArcMethod} from './protected-deu-ita-source-review.mjs';
const root='reports/borders/validation/modern-raw-source-20261110/', base='assets/data/territorial-entities/source/', id='state:ITA', pin='c04c6de44a0cf0732c87d709f4da07e7d10350a1',app='4624e155328c914acbb8cf7f4512443b2b55fe31';
const fixed=root+'protected-deu-ita-contract-20261113/';
const status='raw-source-only-not-display-approved', relation='partial-original-with-readonly-austrian-seam';
export const itaAutSeamMethod='exact-original-ita-aut-readonly-counterpart-seam';
export const hasItaAutSeam=e=>e?.entityId===id&&e.geometryVersions?.some(x=>x.validTo===null&&x.modernBoundarySupplement?.adoptionMode===itaAutSeamMethod)===true;
const H=b=>createHash('sha256').update(b).digest('hex'),dom=g=>H(JSON.stringify([g.type,g.coordinates])),cas=g=>H(JSON.stringify({coordinates:g.coordinates,type:g.type})+'\n');
const ref=(reference,sha256)=>({reference,sha256}),fail=m=>{throw Error('ITA/AUT exact archived native seam: '+m);};
const mask=ref(fixed+'ITA-protected-zone.json','4ebef7b8cd00dd1d12b7578017ef33ba2995fb494859075cd7fe428e7f4f2aa8');
const policy=ref(fixed+'protected-arc-fixed-bindings.json','562bbf523f34dd716219279d59d83e37895c2be3ed5612ea327364134372539f');
const priorReview=ref(fixed+'ITA-review.json','7b484d8196b1fa11a82d048411b82d0e42a6da785cfe1031969236632cdd2fdb');
const priorOps=ref(fixed+'ITA-arc-proof.json','1ccefaf3058666995bd22a1cb49bd497973f5aef2abf82ffa7702a264e82cde1');
const oldOriginal=ref(fixed+'ITA-original.json','e19af659908e1341a985723f6ae4a797749e9dd29cf30616b01d7aa250a1543f');
const nativeITA=ref(root+'whole-original-region-historical-metadata-europe-20261113/originals/ITA-original.json','ea7d092d4d353bcc107a57ab446290adeba730d984aee909976d8a268d93a8d7');
const nativeSVN=ref(root+'whole-original-region-mediterranean-africa-20261113/originals/SVN-original.json','06a16ad756732180bc3a2491c90c7ce00ff3b0e29466ed9a902c9443b6a1a4b2');
const oldCas='da5c696a79f0fabd6e0a5e50542c4f58d4e741667213c6896f17ce4bf81b4f6e';
const lastSvnCas='07f80e7f1fe41f9a9be45a82f01e1e1e8274ae0cb5d308cb33300ebbf1594b97';
const lastSvnReview=ref(root+'ita-svn-original-frontier-20261116/review.json','4d9e24c84c39bc8afb2e096695e584a80a837a279826062dc458ff696bc416ae');
const lastSvnTopo=ref(root+'ita-svn-original-frontier-20261116/topology-proof.json','40f0133c76e896b0c29bdb04bbaf1e0d34d4c68d76b545a79afe039f16b95c13');
const deuAutTopo=ref(root+'deu-aut-original-frontier-20261116/topology-proof.json','e2f5ca1c0ed85bb80df5ccf1aeea065f3c0818f667a64496d0b1e7f59aa2088c');
const nativeAUT=ref(root+'whole-original-region-nordic-central-20261113/originals/AUT-original.json','ed0f0879266042a2367a5490b03c3c482ac25a02c5a6df3dfd3f95a55938bf1f');
const asPath=({reference,sha256})=>({path:reference,sha256});
function checkExistingSeams(old,next,ita,svn,aut,curr,p,readEvidence){
 const sr=read(readEvidence,lastSvnReview),st=read(readEvidence,lastSvnTopo),dt=read(readEvidence,deuAutTopo);
 const sx=p.previousSavedFrontiers?.['ITA-SVN'],dg=p.previousSavedFrontiers?.['DEU-AUT'];
 if(sr.method!=='exact-original-ita-svn-readonly-counterpart-seam'||sr.sourcePin!=='5b090caae2e03405adafa34f5b142dc6b6d4148d'||
    sr.geometryResourceSha256!==lastSvnCas||!eq(sr.topologyProof,lastSvnTopo)||sr.geometrySha256!==dom(old)||
    st.wholeNewOverlapKm2!==0||st.coverageLossEmpty!==true||dt.newOverlapKm2!==0||dt.coverageLossKm2!==0||
    !eq(sx?.receipt,asPath(lastSvnTopo))||!eq(dg?.receipt,asPath(deuAutTopo))||dg.deltaDisjointFromDEU!==true)
   fail('accepted Italy–Slovenia and Germany–Austria archive evidence required');
 const seg=arc(ita,[634,0,241668,250561,1]),recip=arc(svn,[1,0,10411,1518,-1]);
 if(seg.length!==8894||sx.points!==8894||!eq(seg,recip)||!eq(sx.existingITARing,[41,0,752,9645])||
   !eq(sx.candidateITARing,[41,0,37454,46347])||!eq(open(old,41,0).slice(752,9646),seg)||!eq(open(next,41,0).slice(37454,46348),seg))
    fail('all 8894 previously accepted reciprocal Italy–Slovenia points must remain contiguous');
 for(const [code,record] of [['AUT',dg.fixedAUT],['DEU',dg.fixedDEU]]){
  const f=registration.frozen[code];
  if(!f||!eq([f.descriptorSha256,f.cas,f.version,f.from,f.to],[record.descriptorHash,record.rawGeometryHash,record.version,record.from,record.to]))fail('prior exact donor preimage changed: '+code);
 }
 const native=arc(aut,[1,0,461927,129346,-1]),dr=open(curr.DEU.v.geometry,0,0);
 const start=dr.findIndex(p=>eq(p,native[0]));
 if(native.length!==332582||start<0||!eq(dr.slice(start,start+native.length),native))fail('latest Germany keeps the entire accepted fixed Austria seam');
}

const rawArc=[634,0,204713,241668,1],donorArc=[1,0,120062,83107,-1],oldArc=[41,0,499,752];
const pe=['ALB','BIH','CHE','DEU','DZA','FRA','GRC','HRV','LIE','MLT','MNE','SMR','SVN','TUN','VAT'];
const tp={CHE:[10.469652800000063,46.85490760000005],SVN:[13.714085700000055,46.52299510000006]};
const read=(f,r)=>{const b=f(r.reference);if(!Buffer.isBuffer(b)||H(b)!==r.sha256)fail('not exact archived bytes: '+r.reference);return JSON.parse(b);};
const open=(g,p,r)=>g.coordinates[p][r].slice(0,-1);
const pts=(a,s,n,d=1)=>Array.from({length:n},(_,i)=>a[(s+i*d+a.length)%a.length]);
const arc=(g,[p,r,s,e,d])=>exactCyclicChain(g.coordinates[p][r],s,e,d);
const omit=(o,...xs)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!xs.includes(k)));
const stable=(e,v)=>({...e,sourceInfo:omit(e.sourceInfo,'geometryVersionId','geometrySha256'),geometryVersions:e.geometryVersions.map(x=>x.versionId===v?omit(x,'geometry','modernBoundarySupplement'):x)});
function native(f,rr,code){
 const a=read(f,rr),b=Buffer.from(a.rawBlobBase64,'base64');
 if(a.properties?.GENC_3!==code||a.featureId!==a.properties?.WP_ID||H(b)!==a.rawBlobSha256||
    a.sourceFileReceipt?.gpkgSha256!=='55fab422ef09e35eb48d68141b9ece0ace86d4276dfe332a04dfd401c0bfc80c')
  fail('native source required: '+code);
 return decodeOriginalBlobGeometry(b,{expectedWkbSha256:a.rawWkbSha256});
}
export function assertItaAutTopology(t){
 if(t.baseData!==pin||t.baseApp!==app||t.wholeDE9IM!=='FF2F11212'||t.wholeNewOverlapKm2!==0||t.coverageLossEmpty!==true||
   t.changesOnlyExistingSingleRing!==true||!eq(t.protected,{file:mask.reference,deltaDisjoint:true,sameAllocationExact:true,sameBoundaryExact:true})||
   !eq(Object.keys(t.peers??{}).sort(),pe))fail('exact protected geometry, literal zero and full peers required');
 for(const [c,x] of Object.entries(t.peers)){
  if(!['exact full delta envelope disjoint','full relations exact by all change contained in window and exact local incidences'].includes(x.verification)||
    !eq(x.deltaContact,Object.hasOwn(tp,c)?{type:'Point',coordinates:tp[c]}:null))fail('changed protected contact: '+c);
 }
}
export function bindItaAutArc(old,ita,aut,proof){
 if(!eq(proof?.old,oldArc)||!eq(proof?.raw,rawArc)||!eq(proof?.donor,donorArc)||proof.count!==36956)fail('exact one reviewed Italian and reciprocal Slovenian arc only');
 const p=arc(ita,rawArc), q=arc(aut,donorArc), r=open(old,41,0);
 const unique=x=>r.map((v,i)=>eq(v,x)?i:-1).filter(i=>i>=0);
 if(!eq(p,q)||!eq([p[0],p.at(-1)],proof.anchors)||!eq(unique(p[0]),[499])||!eq(unique(p.at(-1)),[752]))fail('archived native reciprocal coordinates or old anchors differ');
 return {polygonIndex:41,ringIndex:0,startIndex:499,endIndex:752,raw:{polygonIndex:634,ringIndex:0,startIndex:204713,endIndex:241668,direction:1}};
}
function continuity(old,next,native,approved,p){
 if(approved.code!=='ITA'||approved.arcCount!==488||approved.addedOriginalVertices!==6499||p.oldRegisteredArcCount!==488||p.oldRegisteredInsertedCount!==6499||p.priorPointwise?.length!==488)
  fail('exact 488/6499 archived protected operations required');
 const cache=new Map(), get=(k,g,p,r)=>{const id=[k,p,r].join(':');if(!cache.has(id))cache.set(id,open(g,p,r));return cache.get(id);};
 let inserts=0;
 for(const [j,a] of approved.arcs.entries()){
  const [v,r,s,t,n,vr,rr,ss,tt,d]=p.priorPointwise[j];
  if(!eq([v,r,n,vr,rr,ss,tt,d],[a.polygon,a.ring,a.rawVertices,a.rawPolygon,a.rawRing,a.rawStart,a.rawEnd,a.direction]))fail('old protected arc indexes differ');
  const rr0=get('native',native,vr,rr),old0=get('old',old,v,r),next0=get('next',next,v,r);
  if(!Number.isSafeInteger(s)||s<0||s>=old0.length||!Number.isSafeInteger(t)||t<0||t>=next0.length)fail('old protected locations invalid');
  const points=pts(rr0,ss,n,d);
  if(!eq(points.at(-1),rr0[tt])||!eq(pts(old0,s,n),points)||!eq(pts(next0,t,n),points)||H(JSON.stringify(points))!==a.rawCoordinatesSha256)fail('prior protected point sequence changed');
  inserts+=n-2;
 }
 if(inserts!==6499)fail('approved old inserted vertex count differs');
}
export function assertItaAutSeam(next,old,{prefixes,readEvidence}={}){
 const {binding,frozen,descriptorPath,resourcePath}=registration;
 if(!hasItaAutSeam(next)||old?.entityId!==id||typeof readEvidence!=='function'||!Array.isArray(prefixes)||!eq([...prefixes].sort(),[descriptorPath,resourcePath].sort()))fail('approved Italy descriptor and CAS exclusively required');
 const ov=old.geometryVersions.filter(x=>x.validTo===null),nv=next.geometryVersions.filter(x=>x.validTo===null),o=ov[0],v=nv[0],s=v?.modernBoundarySupplement,oldS=o?.modernBoundarySupplement;
 if(ov.length!==1||nv.length!==1||v.versionId!=='state:ITA:natural-earth-5.1.1'||v.validFrom!==null||o.versionId!==v.versionId||o.validFrom!==null||
    o.geometry.type!=='MultiPolygon'||v.geometry.type!==o.geometry.type||oldS?.adoptionMode!=='exact-original-ita-svn-readonly-counterpart-seam'||!eq(oldS.seamReview,lastSvnReview)||oldS.geometrySha256!==dom(o.geometry)||
    oldS.priorPreparedAttribution?.adoptionMode!==protectedOriginalArcMethod||oldS.priorPreparedAttribution?.priorPreparedAttribution?.adoptionMode!=='lossless-original-subgeometry'||!eq(oldS.priorPreparedAttribution.sourceAdoptionReview,priorReview)||cas(o.geometry)!==lastSvnCas||
    !eq(stable(next,v.versionId),stable(old,v.versionId))||!eq(s,{adoptionMode:itaAutSeamMethod,status,resultRelation:relation,wholeCountryRaw:false,priorPreparedAttribution:oldS,geometrySha256:dom(v.geometry),seamReview:binding.review})||
    next.sourceInfo?.geometrySha256!==s.geometrySha256||next.sourceInfo?.geometryVersionId!==v.versionId)
  fail('old protected Italy and earlier enclaves, histories, dates, metadata and attribution must stay exact');
 const r=read(readEvidence,binding.review),p=read(readEvidence,r.topologyProof);
 if(r.method!==itaAutSeamMethod||r.sourcePin!==pin||binding.sourcePin!==pin||r.entityId!==id||r.versionId!==v.versionId||r.validFrom!==null||r.validTo!==null||
    r.geometrySha256!==dom(v.geometry)||r.previousGeometrySha256!==dom(o.geometry)||r.geometryResourceSha256!==cas(v.geometry)||p.candidateJsonSHA256!==cas(v.geometry)||p.candidateGeometryDomainSHA256!==dom(v.geometry))
  fail('exact registered physical CAS and proof required');
 assertItaAutTopology(p);
 const z=read(readEvidence,mask),rel=read(readEvidence,priorReview),contract=read(readEvidence,policy),row=contract.rows.find(q=>q.code==='ITA'),oldArcs=read(readEvidence,priorOps);
 const replay=read(readEvidence,contract.independentReplay).rows.find(q=>q.code==='ITA'),line=read(readEvidence,contract.protectedLineProof).find(q=>q.code==='ITA');
 if(!z||rel.geometrySha256!==oldS.priorPreparedAttribution.geometrySha256||rel.method!==protectedOriginalArcMethod||!eq(row.zone,mask)||!eq(row.arcProof,priorOps)||
    row.candidateResourceSha256!==oldCas||replay.candidateResourceSha256!==oldCas||replay.exactRawArcReplay!==true||replay.unselectedEdgesChanged!==0||
    line.protectedCurrentAreaExactlyEqual!==true||line.additionalProtectedLossEmpty!==true||
    !line.peers?.every(q=>q.lostSetsEqual===true&&q.missingLength===0&&q.baselineMissingLength===0))fail('prior fixed scope and line receipts differ');
 for(const {path,sha256} of Object.values(p.archiveReceipts??{})){
   read(readEvidence,ref(path,sha256));
 }
 const oo=read(readEvidence,oldOriginal),on=read(readEvidence,nativeITA);
 if(!eq([oo.featureId,oo.rawBlobBase64,oo.rawBlobSha256,oo.rawWkbSha256],[on.featureId,on.rawBlobBase64,on.rawBlobSha256,on.rawWkbSha256]))fail('original Italian receipt copies differ');
 const ita=native(readEvidence,nativeITA,'ITA'),svn=native(readEvidence,nativeSVN,'SVN'),aut=native(readEvidence,nativeAUT,'AUT'),curr={};
 for(const [code,x] of Object.entries(frozen)){
  const d=read(readEvidence,ref(base+'countries/state-'+code+'.json',x.descriptorSha256));
  const h=p.histories[code];
  for(const it of d.geometryVersions){
   const g=it.geometryResource,b=g?readEvidence(base+g.file):null;
   if(g&&(!Buffer.isBuffer(b)||H(b)!==g.sha256))fail('missing exact preserved Italy/peer version: '+code);
  }
  if(h&&(!eq(d.geometryVersions,h.versions)||h.descriptorSHA256!==x.descriptorSha256))fail('archived historical version proof differs: '+code);
  const e=decodeTerritorialSource(d,k=>readEvidence(base+k)),vs=e.geometryVersions.filter(q=>q.validTo===null),ds=d.geometryVersions.find(q=>q.versionId===vs[0]?.versionId);
  if(vs.length!==1||e.entityId!=='state:'+code||!eq([ds.geometryResource.sha256,vs[0].versionId,vs[0].validFrom,vs[0].validTo],[x.cas,x.version,x.from,x.to]))fail('frozen peer bytes changed: '+code);
  curr[code]={e,v:vs[0]};
 }
 if(!eq(curr.ITA.e,old)||!eq(curr.SVN.v.geometry,svn)||!eq(curr.AUT.v.geometry,aut))fail('current exact Italy and fixed whole native Slovenian donor required');
 const k=bindItaAutArc(o.geometry,ita,aut,p.operation);
 if(!eq(replayRetainedCoast(o.geometry,ita,[k],[{polygonIndex:41,ringIndex:0,startIndex:0}]),v.geometry))fail('only one approved Italy exterior may change');
 for(const [j,n] of [[1,984],[2,139]]){const a=open(o.geometry,41,j),b=open(v.geometry,41,j),x=open(ita,634,j);if(a.length!==n||!eq(a,b)||!eq(a,x))fail('previously registered Italy enclave holes differ');}
 checkExistingSeams(o.geometry,v.geometry,ita,svn,aut,curr,p,readEvidence);
 continuity(o.geometry,v.geometry,ita,oldArcs,p);
 return 1;
}

const registration={"binding":{"sourcePin":"c04c6de44a0cf0732c87d709f4da07e7d10350a1","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/ita-aut-original-frontier-20261116/review.json","sha256":"57ac9b020fb45898e2d0d8f7025c9f283ffbd8e821759f89a009ea15dd03bc3e"}},"frozen":{"ITA":{"descriptorSha256":"74711a1f1ea570f1803da40633aacfcf56fdc6f42c14d8c68a96aa17d5b6c437","cas":"07f80e7f1fe41f9a9be45a82f01e1e1e8274ae0cb5d308cb33300ebbf1594b97","version":"state:ITA:natural-earth-5.1.1","from":null,"to":null},"AUT":{"descriptorSha256":"e82e7d36d0c4ae7c6df0e600be12c6720687a7c713766afdd9207191c5e4bba7","cas":"194534ed6b3efbb2b22fe21e778d0351495a91eea720219b2dfc9ca17823171a","version":"state:AUT:natural-earth-5.1.1","from":null,"to":null},"SVN":{"descriptorSha256":"23e67f9b56cf9ff30afeead02411e2dcf1abed017d09980a7b08f43f394eafd6","cas":"ba13fac64b49aa7126cadd3a1bd335dad4be69146a5c543b539e7e2610afff7b","version":"state:SVN:natural-earth-5.1.1","from":null,"to":null},"HRV":{"descriptorSha256":"b981d880c1c7e68526a731a9b1a13b7e8a9e176431924db0faa5b998b54ae99f","cas":"9bd17b1ee29434b71b669d5c982d00909ddb8363ea8772bf7e8b4c55560966ad","version":"state:HRV:natural-earth-5.1.1","from":null,"to":null},"FRA":{"descriptorSha256":"1ec0a42edd3be08ccb0f87dec8d9e14270398b83f33c531c99c2c12efddda1cc","cas":"84e6073a7a8957a981bc618be6782cfd83177f0b175c3ffb95edfa3d1535a933","version":"state:FRA:natural-earth-5.1.1","from":null,"to":null},"CHE":{"descriptorSha256":"41473a3f65a666a5d3d1c10a65564c5e0de6d38a598a37aca401ed17b6bca09e","cas":"9ca05cdaf1da84bb49bbb5cdf1101d5bc22b4070c682f44be1166ae697fc84cb","version":"state:CHE:natural-earth-5.1.1","from":null,"to":null},"SMR":{"descriptorSha256":"340c85f9f0568a13e2b9a5d5ae7a5581c8ffbbf0ee83aa05ba536cb273a66075","cas":"451f0ae71e7652777cecaa979a792539614b5a2042f83bc12d45fa6ec2f17dbe","version":"state:SMR:natural-earth-5.1.1","from":null,"to":null},"VAT":{"descriptorSha256":"e3878ab9a13368cc3fc918c20a8bf19cdd7636f7aaffda605084ec8110a386b3","cas":"9b1875199ef050cf004597df1a5bf0ce31b62708e94e08e504ba8ac8206313ea","version":"state:VAT:natural-earth-5.1.1","from":null,"to":null},"BIH":{"descriptorSha256":"7a5ce3bf24053476ae29e9f3f7d8bb2be3cbc4003c7a696cd81edbcf0b414320","cas":"630b3102b25157eac2463d3dc6aefc81e2ecb481a5a0bd183a38149bad19b2db","version":"state:BIH:natural-earth-5.1.1","from":null,"to":null},"MNE":{"descriptorSha256":"afc96801ef69027319f1095aa87c0ac078524160a03445a6477704f1a885ac55","cas":"bb008ae3b39801371d614482a935650f644e09d252a18181d9e767eba4bbd282","version":"state:MNE:natural-earth-5.1.1","from":null,"to":null},"ALB":{"descriptorSha256":"4b03646bc98a90f59f4dc0e82458a965ff9767a3e60447f53923bc91d4ff82b2","cas":"3ee19fcee50d47733609809a7f0630a144a1b4c164de9358435e8df2952c70cd","version":"state:ALB:natural-earth-5.1.1","from":null,"to":null},"GRC":{"descriptorSha256":"7eb6ed6981619e853cde5b254b04f985376160200a7957dc54b6b922e09ac29f","cas":"60548c28ae57a492df83bb845dfbca7b08f376ffddaa9a1338b82a82b9cb920b","version":"state:GRC:natural-earth-5.1.1","from":null,"to":null},"MLT":{"descriptorSha256":"1a50b8776c5df502ee77da24da1f91a566b0bc97136464dd7fdf1c7ebc420560","cas":"ec5fafdc5e360dd3b889ff1ca4279db358215d0c58d6f74ce87ce52e8a1b6b80","version":"state:MLT:natural-earth-5.1.1","from":null,"to":null},"TUN":{"descriptorSha256":"6dcf15b5eda5cf957235f2489381cca691f7bf587d573302aaf77ed748f31e98","cas":"d8192164308ebbec7ce4fb9f78511ed0e09c01855ed3311f9a25bd6fbd9285e6","version":"state:TUN:natural-earth-5.1.1","from":null,"to":null},"DZA":{"descriptorSha256":"5ca130852a4ee52f4a5846959735358c594d033eeadacd0e147fa027a0b6ecd6","cas":"8cb3fa1b39c5cf8d4d62056bb5cfcbc32e478994048e88e1bd18bb0822afadc8","version":"state:DZA:natural-earth-5.1.1","from":null,"to":null},"DEU":{"descriptorSha256":"5dbd59a011dcf7a43bbad4cc32ae4beedcfd25755659d04671fda08b425dee9e","cas":"0f454612139bde97715765f27ae09829502e58fd7383c45e2c2852f289977813","version":"state:DEU:natural-earth-5.1.1","from":"1918-11-09","to":null},"LIE":{"descriptorSha256":"2098349efbb829df09f30893c78a13efeeb62df4176d5fbaf36f56435849bfa6","cas":"62db9df4d40746bf1609a4f8de01c64743268ad6112ff0a5a098fa187e660ec4","version":"state:LIE:natural-earth-5.1.1","from":null,"to":null}},"descriptorPath":"assets/data/territorial-entities/source/countries/state-ITA.json","resourcePath":"assets/data/territorial-entities/source/geometries/sha256-a65e94ab75d939c3a1e8932b84bf11fa2412e2f6c356cd821ab5dfc077f13e61.json"};
