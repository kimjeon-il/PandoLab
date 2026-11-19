import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';
const registration={"app":"7f61cd0d4272b783f645721bd556d5abed73e0b1","topologyBase":{"app":"7f61cd0d4272b783f645721bd556d5abed73e0b1","data":"9e5a22831fbb2660c65a2c185486bbd4c610069f"},"binding":{"sourcePin":"9e5a22831fbb2660c65a2c185486bbd4c610069f","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/kgz-kaz-original-frontier-20261116/review.json","sha256":"4b1778442d03aa552548efbfed79a6f5d43f9b7085d79449e7afa8828f121de3"}},"frozen":{"KGZ":{"descriptorSha256":"385e9a3b1811fce7037b8343d919a5c6ca73a973a13346fb1ba0b56022f8800a","cas":"c15a45050b4a3a87acb81d6d2699065c8bc07533958fe561020587b8b0f4c227","version":"state:KGZ:natural-earth-5.1.1","from":"1991-08-31","to":null},"KAZ":{"descriptorSha256":"466f8a4aedc6271c0a9db3c2fa1ee4244aeda1bad30101149ededce0faf21962","cas":"47de235c3a3e07fa5fa40d7ba0805a5ddbe757d5857534439c37903aa0db46ae","version":"state:KAZ:natural-earth-5.1.1","from":"1995-09-25","to":null},"UZB":{"descriptorSha256":"78ce65f012c1f11cd0e34e7537bc72a56e25a8d1f0360e25b27c2c23f9c9bceb","cas":"8fe960fc8149a9624c360f98b01de1590dbe4b3e2c8c128b48a451e4e134c2c5","version":"state:UZB:natural-earth-5.1.1","from":"1991-08-31","to":null},"TJK":{"descriptorSha256":"1859a5e32592afa3119e250025935859ed7ec88e4309e0040ed61cda94bc318b","cas":"3c9120bdb628c8a7d7f311523d5fd905b63d58661895ec36a625c417dd8729eb","version":"state:TJK:natural-earth-5.1.1","from":"1991-09-09","to":null},"CHN":{"descriptorSha256":"733e6324b391c55e918a870823b6acbe5ceb9720d5a87c2a8497fe68954a0900","cas":"57f5bdcc36f3b7c03f9108c08cb65bb00aad82c47217b3cdb98bafd7aa39ce41","version":"state:CHN:paektu-lsib-11.4","from":null,"to":null},"RUS":{"descriptorSha256":"915c2ab9018569299bb9c1ce31b2b800f1826c8e6f2801a60f46e20032f0c418","cas":"c9033e2f2750ef2458c8b3a768ffb8f7f5b7325f9efd44b56986dd6fc62e5b8a","version":"state:RUS:natural-earth-5.1.1","from":"2014-03-18","to":null}},"paths":{"descriptor":"assets/data/territorial-entities/source/countries/state-KGZ.json","resource":"assets/data/territorial-entities/source/geometries/sha256-5f3e38cc2c5674529dc7898670ae7023a64a6f571eae0983351ff065698ff2bf.json"},"receipts":{"policy":{"reference":"reports/borders/validation/modern-raw-source-20261110/protected-final-five-contract-20261113/protected-arc-fixed-bindings.json","sha256":"c555318e66e7f3770e05975f7acd67f716b07bcb2895c6872997f2007894c4c8"},"zone":{"reference":"reports/borders/validation/modern-raw-source-20261110/protected-final-five-contract-20261113/KGZ-protected-zone.json","sha256":"3a3412584d9ce764d3334e668090038a1f0d595410b7a983bd392e5cc3aa8f1b"},"priorArc":{"reference":"reports/borders/validation/modern-raw-source-20261110/protected-final-five-contract-20261113/KGZ-arc-proof.json","sha256":"79f0672f0297ba5e8c474bb3a48b4a00f1fea3266a04c299d94da48dab4fa4fd"},"priorReview":{"reference":"reports/borders/validation/modern-raw-source-20261110/protected-final-five-contract-20261113/KGZ-review.json","sha256":"612a6f33e0b57fa2a4f07935d5576872787957e23f5ddc03e602924730e17e2a"},"nativeKGZ":{"reference":"reports/borders/validation/modern-raw-source-20261110/protected-final-five-contract-20261113/KGZ-original.json","sha256":"113a6fc3c45ce6cdd39c1e14396bab78daf25cf76052d9d7a141f9b65597b2d5"},"nativeKAZ":{"reference":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-current-four-20261113/originals/KAZ-original.json","sha256":"6614379d2869ddfb259f556432c31d72058784927427a2ea7ea4e4ec2461fd8c"}},"originals":{"KGZ":{"uuid":"63b5f131-e580-4c10-9e24-78d4c8e5d821","name":"Kyrgyzstan","GENC3":"KGZ","wkbSha256":"37d9b976273488782c22ab6823821910c2927d00f786d388b2ac5907a2618e84"},"KAZ":{"uuid":"7f1674ad-e097-48c8-829b-a60281d4230f","name":"Kazakhstan","GENC3":"KAZ","wkbSha256":"5870d328e9e29e6647cfb3b4dd8651d117041011a04b3003740860f321b60652"}}};
const BASE='assets/data/territorial-entities/source/',ID='state:KGZ',VERSION='state:KGZ:natural-earth-5.1.1',DATE='1991-08-31';
const status='raw-source-only-not-display-approved',relation='partial-original-with-readonly-kazakh-seam';
export const kgzKazSeamMethod='exact-original-kgz-kaz-readonly-counterpart-seam';
export const hasKgzKazSeam=e=>e?.entityId===ID&&e.geometryVersions?.some(v=>v.validTo===null&&v.modernBoundarySupplement?.adoptionMode===kgzKazSeamMethod)===true;
const H=b=>createHash('sha256').update(b).digest('hex'),dom=g=>H(JSON.stringify([g.type,g.coordinates])),cas=g=>H(JSON.stringify({coordinates:g.coordinates,type:g.type})+'\n');
const err=m=>{throw Error('KGZ/KAZ exact archived native seam: '+m);};
const read=(f,{reference,sha256})=>{const b=f(reference);if(!Buffer.isBuffer(b)||H(b)!==sha256)err('not exact archived bytes: '+reference);return JSON.parse(b);};
const poly=g=>g.type==='Polygon'?[g.coordinates]:g.coordinates,ring=(g,p,r)=>poly(g)[p][r],open=(g,p,r)=>ring(g,p,r).slice(0,-1);
const arc=(g,[p,r,s,e,d])=>exactCyclicChain(ring(g,p,r),s,e,d);
const pts=(a,s,n,d=1)=>Array.from({length:n},(_,i)=>a[(s+i*d+a.length)%a.length]);
const omit=(o,...ks)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!ks.includes(k)));
const stable=e=>({...e,sourceInfo:omit(e.sourceInfo,'geometryVersionId','geometrySha256'),geometryVersions:e.geometryVersions.map(v=>v.versionId===VERSION?omit(v,'geometry','modernBoundarySupplement'):v)});
const oldOp=[0,0,2788,4685],nativeOp=[1,0,56118,70807,1],donorOp=[7,0,58836,44147,-1];
const peers=['CHN','RUS','TJK','UZB'];
export function assertKgzKazTopology(p){
 const {topologyBase,receipts}=registration;
 if(p.baseApp!==topologyBase.app||p.baseData!==topologyBase.data||p.valid!==true||p.DE9IM!=='FF2F11212'||p.newOverlapKm2!==0||p.lossIsEmpty!==true||p.newGapLossKm2!==0||
    !eq(p.old,oldOp)||!eq(p.raw,nativeOp)||!eq(p.fixedKAZ,donorOp)||p.count!==14690||
    !eq(p.protected,{archive:receipts.zone.reference,sha256:receipts.zone.sha256,deltaEmpty:true,allocationExact:true,boundaryExact:true})||
    !eq(Object.keys(p.peers??{}).sort(),peers))err('exact protected geometry, literal zero and fixed scope required');
 for(const [c,x] of Object.entries(p.peers)){
  if(x.intersectionExact!==true||x.boundaryExact!==true||!eq(x.deltaContact,c==='CHN'?{type:'Point',coordinates:[80.17485780000004,42.210843200000056]}:null)||
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
 if(!Array.isArray(witness)||witness.length!==559||p.priorArcReceipt.priorInserted!==6204||a.arcCount!==559||a.addedOriginalVertices!==6204||a.arcs.length!==559)err('fixed prior arc count changed');
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
 if(additions!==6204)err('fixed old inserted vertex count changed');
}
export function assertKgzKazSeam(next,old,{prefixes,readEvidence,sourceDataRevision}={}){
 const {binding,frozen,receipts,paths,originals}=registration;
 if(sourceDataRevision!==binding.sourcePin||!hasKgzKazSeam(next)||old?.entityId!==ID||typeof readEvidence!=='function'||!Array.isArray(prefixes)||!eq([...prefixes].sort(),Object.values(paths).sort()))err('only exact KGZ descriptor and resource may change');
 const ov=old.geometryVersions.filter(x=>x.validTo===null),nv=next.geometryVersions.filter(x=>x.validTo===null),o=ov[0],v=nv[0],oldS=o?.modernBoundarySupplement,s=v?.modernBoundarySupplement;
 if(ov.length!==1||nv.length!==1||o.versionId!==VERSION||v.versionId!==VERSION||o.validFrom!==DATE||v.validFrom!==DATE||
    v.geometry.type!==o.geometry.type||oldS?.adoptionMode!=='exact-original-arcs-outside-fixed-policy-zone'||!eq(oldS.sourceAdoptionReview,receipts.priorReview)||
    oldS.geometrySha256!==dom(o.geometry)||cas(o.geometry)!==frozen.KGZ.cas||!eq(stable(next),stable(old))||
    !eq(s,{adoptionMode:kgzKazSeamMethod,status,resultRelation:relation,wholeCountryRaw:false,priorPreparedAttribution:oldS,geometrySha256:dom(v.geometry),seamReview:binding.review})||
    next.sourceInfo?.geometrySha256!==s.geometrySha256||next.sourceInfo?.geometryVersionId!==VERSION)err('dates, previous review and all stable metadata unchanged');
 const review=read(readEvidence,binding.review);
 const p=read(readEvidence,review.topologyProof);assertKgzKazTopology(p);
 if(review.sourcePin!==binding.sourcePin||review.method!==kgzKazSeamMethod||review.status!==status||review.entityId!==ID||review.versionId!==VERSION||review.validFrom!==DATE||review.validTo!==null||
    review.geometrySha256!==dom(v.geometry)||review.previousGeometrySha256!==dom(o.geometry)||review.geometryResourceSha256!==cas(v.geometry)||!paths.resource.endsWith('sha256-'+cas(v.geometry)+'.json'))err('new resource or pinned review mismatch');
 const contract=read(readEvidence,receipts.policy),row=contract.rows.find(x=>x.code==='KGZ'),proof=read(readEvidence,receipts.priorArc),oldReview=read(readEvidence,receipts.priorReview);
 read(readEvidence,receipts.zone);
 if(!eq(row.arcProof,receipts.priorArc)||!eq(row.zone,receipts.zone)||!eq(row.source.reference,receipts.nativeKGZ.reference)||row.source.sha256!==receipts.nativeKGZ.sha256||
    row.candidateResourceSha256!==frozen.KGZ.cas||oldReview.geometrySha256!==oldS.geometrySha256||
    !eq(p.priorArcReceipt.path,receipts.priorArc.reference)||p.priorArcReceipt.sha256!==receipts.priorArc.sha256)err('prior fixed approval mismatch');
 const replay=read(readEvidence,contract.independentReplay).rows.find(x=>x.code==='KGZ'),line=read(readEvidence,contract.protectedLineProof).find(x=>x.code==='KGZ');
 if(replay.candidateResourceSha256!==frozen.KGZ.cas||replay.exactRawArcReplay!==true||replay.unselectedEdgesChanged!==0||line.protectedCoordinateEdgeSetsExactlyEqual!==true||line.everyOldEdgeTouchingZoneRetainedExactly!==true||line.noNewEdgeTouchingZone!==true||line.epsilonUsed!==false)err('prior seam or protected coordinate set changed');
 const fixed={};
 for(const [code,x] of Object.entries(frozen)){
  const d=read(readEvidence,{reference:BASE+'countries/state-'+code+'.json',sha256:x.descriptorSha256});
  for(const v0 of d.geometryVersions){const g=v0.geometryResource;if(g){const b=readEvidence(BASE+g.file);if(!Buffer.isBuffer(b)||H(b)!==g.sha256)err('history CAS changed: '+code);}}
  const e=decodeTerritorialSource(d,f=>readEvidence(BASE+f)),vv=e.geometryVersions.filter(y=>y.validTo===null);
  if(e.entityId!=='state:'+code||vv.length!==1||!eq([vv[0].versionId,vv[0].validFrom,vv[0].validTo,d.geometryVersions.find(v=>v.versionId===vv[0].versionId)?.geometryResource?.sha256],[x.version,x.from,x.to,x.cas]))err('frozen descriptor mismatch: '+code);
  fixed[code]={e,v:vv[0]};
 }
 const nativeG=native(readEvidence,receipts.nativeKGZ,originals.KGZ,'KGZ'),nativeK=native(readEvidence,receipts.nativeKAZ,originals.KAZ,'KAZ');
 if(!eq(fixed.KGZ.e,old)||!eq(fixed.KAZ.v.geometry,nativeK))err('current exact KGZ/KAZ preimages required');
 const src=arc(nativeG,nativeOp),donor=arc(nativeK,donorOp),oldR=open(o.geometry,0,0);
 if(src.length!==14690||!eq(src,donor)||!eq([src[0],src.at(-1)],[oldR[2788],oldR[4685]])||[src[0],src.at(-1)].some(q=>oldR.filter(x=>eq(x,q)).length!==1))err('exact native counterpart arc and existing endpoint identity required');
 const operation={polygonIndex:0,ringIndex:0,startIndex:2788,endIndex:4685,raw:{polygonIndex:1,ringIndex:0,startIndex:56118,endIndex:70807,direction:1}};
 if(!eq(replayRetainedCoast(o.geometry,nativeG,[operation],[{polygonIndex:0,ringIndex:0,startIndex:0}]),v.geometry))err('only approved existing ring interval may differ');
 continuity(o.geometry,v.geometry,nativeG,p,proof);
 return 1;
}