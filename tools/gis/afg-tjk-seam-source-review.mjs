import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';
const registration={"app":"c65e53c35ef3d5c304ba3c98c84fdac695c2b54b","topologyBase":{"app":"c65e53c35ef3d5c304ba3c98c84fdac695c2b54b","data":"3a5d505ff9e33de9c74dccfc0b0cb143c6c2f9aa"},"binding":{"sourcePin":"3a5d505ff9e33de9c74dccfc0b0cb143c6c2f9aa","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/afg-tjk-original-frontier-20261116/review.json","sha256":"14aa4140ae236666ea37531c58eebd005027f6eaae52af19ceaa2c20d9976909"}},"frozen":{"TJK":{"descriptorSha256":"1859a5e32592afa3119e250025935859ed7ec88e4309e0040ed61cda94bc318b","cas":"3c9120bdb628c8a7d7f311523d5fd905b63d58661895ec36a625c417dd8729eb","version":"state:TJK:natural-earth-5.1.1","from":"1991-09-09","to":null},"AFG":{"descriptorSha256":"92aa6ff9d72fab84205d41794645c385025574e2938fe79165e70dad56612673","cas":"9e8169d42915b2a2a756e6372b7e066f52b66b46c535378457eca5890f2a70ec","version":"state:AFG:natural-earth-5.1.1","from":null,"to":null},"UZB":{"descriptorSha256":"78ce65f012c1f11cd0e34e7537bc72a56e25a8d1f0360e25b27c2c23f9c9bceb","cas":"8fe960fc8149a9624c360f98b01de1590dbe4b3e2c8c128b48a451e4e134c2c5","version":"state:UZB:natural-earth-5.1.1","from":"1991-08-31","to":null},"CHN":{"descriptorSha256":"733e6324b391c55e918a870823b6acbe5ceb9720d5a87c2a8497fe68954a0900","cas":"57f5bdcc36f3b7c03f9108c08cb65bb00aad82c47217b3cdb98bafd7aa39ce41","version":"state:CHN:paektu-lsib-11.4","from":null,"to":null},"KGZ":{"descriptorSha256":"b76ed1ab2d104446485094a76aa9825f59c5e5628af49c7afd59a7db1d0ee72a","cas":"5f3e38cc2c5674529dc7898670ae7023a64a6f571eae0983351ff065698ff2bf","version":"state:KGZ:natural-earth-5.1.1","from":"1991-08-31","to":null},"PAK":{"descriptorSha256":"83e86188a88579f6a7a40ec1004a139686f5794597aea8294847a08692a5e925","cas":"a47942dd6800bcc4babd62b04ccdd90f8f8d49d93de5c3bf2e7d3347813157fd","version":"state:PAK:natural-earth-5.1.1","from":null,"to":null},"IND":{"descriptorSha256":"739b6986129533dc1c92b69d72c713287105c87582fec5a7ab257535faffa03a","cas":"fd27183b80c6a113026db208fed364590d8916322cbc87c39aba37fd3391ee4a","version":"state:IND:natural-earth-5.1.1","from":null,"to":null},"KAS":{"descriptorSha256":"cc54544e2cc74babe45b43dda8acea7ddbde4dfeba5412d5aa67e16cfacf1cb8","cas":"0e7cf134851fec4bbdbc91763e16840e88f7bd958580bff68b52a52b7a15027a","version":"state:KAS:natural-earth-5.1.1","from":null,"to":null}},"paths":{"descriptor":"assets/data/territorial-entities/source/countries/state-TJK.json","resource":"assets/data/territorial-entities/source/geometries/sha256-5a10179f2a61430ca473f71ea4dc41bab4ce2b4a4455a8b52ef04014b2d82666.json"},"receipts":{"policy":{"reference":"reports/borders/validation/modern-raw-source-20261110/protected-final-five-contract-20261113/protected-arc-fixed-bindings.json","sha256":"c555318e66e7f3770e05975f7acd67f716b07bcb2895c6872997f2007894c4c8"},"zone":{"reference":"reports/borders/validation/modern-raw-source-20261110/protected-final-five-contract-20261113/TJK-protected-zone.json","sha256":"3a3412584d9ce764d3334e668090038a1f0d595410b7a983bd392e5cc3aa8f1b"},"priorArc":{"reference":"reports/borders/validation/modern-raw-source-20261110/protected-final-five-contract-20261113/TJK-arc-proof.json","sha256":"1db284284a2344ee81d52f0208fb941dfbd1f33143b53286106de3c2935ed7f3"},"priorReview":{"reference":"reports/borders/validation/modern-raw-source-20261110/protected-final-five-contract-20261113/TJK-review.json","sha256":"7d52b92e4307cde72c8c80cfaffaf24af7278591f99ccd80402b13fa4cd2bc3a"},"nativeTJK":{"reference":"reports/borders/validation/modern-raw-source-20261110/protected-final-five-contract-20261113/TJK-original.json","sha256":"e98c493a5fb181c6583c4f06e112bace12ed896ea493655e8d516bd31aad0d99"},"nativeAFG":{"reference":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-south-asia-20261113/originals/AFG-original.json","sha256":"afb4cb230c706872ccd11147bcc82031e1d638ea56bdde0befe865911f5f6948"}},"originals":{"TJK":{"archivePath":"reports/borders/validation/modern-raw-source-20261110/protected-final-five-contract-20261113/TJK-original.json","archiveSHA256":"e98c493a5fb181c6583c4f06e112bace12ed896ea493655e8d516bd31aad0d99","uuid":"aab14af8-1a9c-4323-97dd-d766b63c4512","wkbSha256":"2fe9229eb0822fca38de1212f7c889bdb3454c77bfa892b10285b57feb3149f4"},"AFG":{"archivePath":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-south-asia-20261113/originals/AFG-original.json","archiveSHA256":"afb4cb230c706872ccd11147bcc82031e1d638ea56bdde0befe865911f5f6948","uuid":"5c56cf7d-c485-4659-9399-5c17e9003112","wkbSha256":"83fa3ab3dd4f7c6ea2871aa7c004fc0413e47c234360bb8cbe0fed66cadb73fd"}}};
const BASE='assets/data/territorial-entities/source/',ID='state:TJK',VERSION='state:TJK:natural-earth-5.1.1',DATE='1991-09-09';
const status='raw-source-only-not-display-approved',relation='partial-original-with-readonly-afghan-seam';
export const afgTjkSeamMethod='exact-original-afg-tjk-readonly-counterpart-seam';
export const hasAfgTjkSeam=e=>e?.entityId===ID&&e.geometryVersions?.some(v=>v.validTo===null&&v.modernBoundarySupplement?.adoptionMode===afgTjkSeamMethod)===true;
const H=b=>createHash('sha256').update(b).digest('hex'),dom=g=>H(JSON.stringify([g.type,g.coordinates])),cas=g=>H(JSON.stringify({coordinates:g.coordinates,type:g.type})+'\n');
const err=m=>{throw Error('TJK/AFG exact archived native seam: '+m);};
const read=(f,{reference,sha256})=>{const b=f(reference);if(!Buffer.isBuffer(b)||H(b)!==sha256)err('not exact archived bytes: '+reference);return JSON.parse(b);};
const poly=g=>g.type==='Polygon'?[g.coordinates]:g.coordinates,ring=(g,p,r)=>poly(g)[p][r],open=(g,p,r)=>ring(g,p,r).slice(0,-1);
const arc=(g,[p,r,s,e,d])=>exactCyclicChain(ring(g,p,r),s,e,d);
const pts=(a,s,n,d=1)=>Array.from({length:n},(_,i)=>a[(s+i*d+a.length)%a.length]);
const omit=(o,...ks)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!ks.includes(k)));
const stable=e=>({...e,sourceInfo:omit(e.sourceInfo,'geometryVersionId','geometrySha256'),geometryVersions:e.geometryVersions.map(v=>v.versionId===VERSION?omit(v,'geometry','modernBoundarySupplement'):v)});
const oldOp=[0,0,7093,2181],nativeOp=[0,0,40245,9504,1],donorOp=[0,0,0,72624,-1];
const peers=['CHN','IND','KAS','KGZ','PAK','UZB'];
export function assertAfgTjkTopology(p){
 const {topologyBase,receipts}=registration;
 if(p.baseApp!==topologyBase.app||p.baseData!==topologyBase.data||p.valid!==true||p.DE9IM!=='FF2F11212'||p.newOverlapKm2!==0||p.lossIsEmpty!==true||p.newGapLossKm2!==0||
    !eq(p.old,oldOp)||!eq(p.raw,nativeOp)||!eq(p.fixedAFG,donorOp)||p.count!==9507||p.wrapRotationToExistingOrigin!==79||p.eastAndWestOldTripointsExact!==true||
    !eq(p.protected,{archive:receipts.zone.reference,sha256:receipts.zone.sha256,deltaEmpty:true,allocationExact:true,boundaryExact:true})||
    !eq(Object.keys(p.peers??{}).sort(),peers))err('exact protected geometry, literal zero and fixed scope required');
 for(const [c,x] of Object.entries(p.peers)){
  if(x.intersectionExact!==true||x.boundaryExact!==true||!eq(x.deltaContact,c==='CHN'?{type:'Point',coordinates:[74.88986200000005,37.23408990000007]}:null)||
  (c==='CHN'&&x.retainedCommonAnchor!==true))err('peer topology changed: '+c);
 }
 return true;
}
function native(f,r,record,code){
 const x=read(f,r),b=Buffer.from(x.rawBlobBase64,'base64');
 if(x.featureId!==record.uuid||x.properties?.WP_ID!==record.uuid||x.properties?.GENC_3!==code||x.rawWkbSha256!==record.wkbSha256||H(b)!==x.rawBlobSha256)err('official original identity changed: '+code);
 const g=decodeOriginalBlobGeometry(b,{expectedWkbSha256:record.wkbSha256});
 if(!eq(g,x.geometry))err('archived geometry and original WKB differ: '+code);
 return g;
}
function continuity(old,next,g,p,a){
 const witness=p.priorArcReceipt?.pointwise;
 if(!Array.isArray(witness)||witness.length!==601||p.priorArcReceipt.priorInserted!==5118||a.arcCount!==601||a.addedOriginalVertices!==5118||a.arcs.length!==601)err('fixed prior arc count changed');
 const cache=new Map(),get=(k,geom,b,c)=>{const key=[k,b,c].join(':');if(!cache.has(key))cache.set(key,open(geom,b,c));return cache.get(key);};
 let additions=0;
 for(const [j,x] of a.arcs.entries()){
  const [po,r,s,t,n,pr,rr,rs,re,d]=witness[j];
  if(!eq([po,r,n,pr,rr,rs,re,d],[x.polygon,x.ring,x.rawVertices,x.rawPolygon,x.rawRing,x.rawStart,x.rawEnd,x.direction]))err('prior protected raw indices differ');
  const oldV=get('old',old,po,r),newV=get('next',next,po,r),raw=get('original',g,pr,rr);
  if(!Number.isSafeInteger(s)||!Number.isSafeInteger(t)||s<0||t<0||s>=oldV.length||t>=newV.length)err('prior invalid ring index');
  const ref=pts(raw,rs,n,d);
  if(!eq(ref.at(-1),raw[re])||!eq(ref,pts(oldV,s,n))||!eq(ref,pts(newV,t,n))||H(JSON.stringify(ref))!==x.rawCoordinatesSha256)err('prior protected point sequence changed');
  additions+=n-2;
 }
 if(additions!==5118)err('fixed old inserted vertex count changed');
}
export function assertAfgTjkSeam(next,old,{prefixes,readEvidence,sourceDataRevision}={}){
 const {binding,frozen,receipts,paths,originals}=registration;
 if(sourceDataRevision!==binding.sourcePin||!hasAfgTjkSeam(next)||old?.entityId!==ID||typeof readEvidence!=='function'||!Array.isArray(prefixes)||!eq([...prefixes].sort(),Object.values(paths).sort()))err('only exact TJK descriptor and resource may change');
 const ov=old.geometryVersions.filter(x=>x.validTo===null),nv=next.geometryVersions.filter(x=>x.validTo===null),o=ov[0],v=nv[0],oldS=o?.modernBoundarySupplement,s=v?.modernBoundarySupplement;
 if(ov.length!==1||nv.length!==1||o.versionId!==VERSION||v.versionId!==VERSION||o.validFrom!==DATE||v.validFrom!==DATE||
    v.geometry.type!==o.geometry.type||oldS?.adoptionMode!=='exact-original-arcs-outside-fixed-policy-zone'||!eq(oldS.sourceAdoptionReview,receipts.priorReview)||
    oldS.geometrySha256!==dom(o.geometry)||cas(o.geometry)!==frozen.TJK.cas||!eq(stable(next),stable(old))||
    !eq(s,{adoptionMode:afgTjkSeamMethod,status,resultRelation:relation,wholeCountryRaw:false,priorPreparedAttribution:oldS,geometrySha256:dom(v.geometry),seamReview:binding.review})||
    next.sourceInfo?.geometrySha256!==s.geometrySha256||next.sourceInfo?.geometryVersionId!==VERSION)err('dates, previous review and all stable metadata unchanged');
 const review=read(readEvidence,binding.review);
 const p=read(readEvidence,review.topologyProof);assertAfgTjkTopology(p);
 if(review.sourcePin!==binding.sourcePin||review.method!==afgTjkSeamMethod||review.status!==status||review.entityId!==ID||review.versionId!==VERSION||review.validFrom!==DATE||review.validTo!==null||
    review.geometrySha256!==dom(v.geometry)||review.previousGeometrySha256!==dom(o.geometry)||review.geometryResourceSha256!==cas(v.geometry)||!paths.resource.endsWith('sha256-'+cas(v.geometry)+'.json'))err('new resource or pinned review mismatch');
 const contract=read(readEvidence,receipts.policy),row=contract.rows.find(x=>x.code==='TJK'),proof=read(readEvidence,receipts.priorArc),oldReview=read(readEvidence,receipts.priorReview);
 read(readEvidence,receipts.zone);
 if(!eq(row.arcProof,receipts.priorArc)||!eq(row.zone,receipts.zone)||!eq(row.source.reference,receipts.nativeTJK.reference)||row.source.sha256!==receipts.nativeTJK.sha256||
    row.candidateResourceSha256!==frozen.TJK.cas||oldReview.geometrySha256!==oldS.geometrySha256||
    !eq(p.priorArcReceipt.path,receipts.priorArc.reference)||p.priorArcReceipt.sha256!==receipts.priorArc.sha256)err('prior fixed approval mismatch');
 const replay=read(readEvidence,contract.independentReplay).rows.find(x=>x.code==='TJK'),line=read(readEvidence,contract.protectedLineProof).find(x=>x.code==='TJK');
 if(replay.candidateResourceSha256!==frozen.TJK.cas||replay.exactRawArcReplay!==true||replay.unselectedEdgesChanged!==0||line.protectedCoordinateEdgeSetsExactlyEqual!==true||line.everyOldEdgeTouchingZoneRetainedExactly!==true||line.noNewEdgeTouchingZone!==true||line.epsilonUsed!==false)err('prior seam or protected coordinate set changed');
 const fixed={};
 for(const [code,x] of Object.entries(frozen)){
  const d=read(readEvidence,{reference:BASE+'countries/state-'+code+'.json',sha256:x.descriptorSha256});
  for(const v0 of d.geometryVersions){const g=v0.geometryResource;if(g){const b=readEvidence(BASE+g.file);if(!Buffer.isBuffer(b)||H(b)!==g.sha256)err('history CAS changed: '+code);}}
  const e=decodeTerritorialSource(d,f=>readEvidence(BASE+f)),vv=e.geometryVersions.filter(y=>y.validTo===null);
  if(e.entityId!=='state:'+code||vv.length!==1||!eq([vv[0].versionId,vv[0].validFrom,vv[0].validTo,d.geometryVersions.find(v=>v.versionId===vv[0].versionId)?.geometryResource?.sha256],[x.version,x.from,x.to,x.cas]))err('frozen descriptor mismatch: '+code);
  fixed[code]={e,v:vv[0]};
 }
 const nativeG=native(readEvidence,receipts.nativeTJK,originals.TJK,'TJK'),nativeK=native(readEvidence,receipts.nativeAFG,originals.AFG,'AFG');
 if(!eq(fixed.TJK.e,old)||!eq(fixed.AFG.v.geometry,nativeK))err('current exact TJK/AFG preimages required');
 const src=arc(nativeG,nativeOp),donor=arc(nativeK,donorOp),oldR=open(o.geometry,0,0);
 if(src.length!==9507||!eq(src,donor)||!eq([src[0],src.at(-1)],[oldR[7093],oldR[2181]])||[src[0],src.at(-1)].some(q=>oldR.filter(x=>eq(x,q)).length!==1))err('exact native counterpart arc and existing endpoint identity required');
 const operation={polygonIndex:0,ringIndex:0,startIndex:7093,endIndex:2181,raw:{polygonIndex:0,ringIndex:0,startIndex:40245,endIndex:9504,direction:1}};
 const replayed=replayRetainedCoast(o.geometry,nativeG,[operation],[{polygonIndex:0,ringIndex:0,startIndex:7093}]);
 const ru=open(replayed,0,0),r0=oldR[0];
 if(ru.filter(x=>eq(x,r0)).length!==1||!eq(ru[79],r0))err('exact existing ring origin must remain unchanged');
 const ordered=[...ru.slice(79),...ru.slice(0,79),r0];
 poly(replayed)[0][0]=ordered;
 if(!eq(replayed,v.geometry))err('only approved cyclic existing ring interval may differ');
 continuity(o.geometry,v.geometry,nativeG,p,proof);
 return 1;
}