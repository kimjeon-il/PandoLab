import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';
const registration={"app":"2fbbd0e5a676a6c1974b1052da671ce29acf5f75","topologyBase":{"app":"2fbbd0e5a676a6c1974b1052da671ce29acf5f75","data":"26a8bc563184649aee91af27e22f1ac2e26cf0e9"},"binding":{"sourcePin":"26a8bc563184649aee91af27e22f1ac2e26cf0e9","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/kgz-uzb-original-frontier-20261116/review.json","sha256":"037180426c256ec2f4b2709093c46efd181f82b4f6131ebe538ab201783ba305"}},"frozen":{"KGZ":{"descriptorSha256":"9a5a85b58f16a0ab0c407e508a7ea4a976bd5e7ab52bd6748028fe42eea8c6b6","cas":"d21cfdc74aeae9fd5c4ce44fd3d987137ca30302b9f67e676bdd964cdd7863be","version":"state:KGZ:natural-earth-5.1.1","from":"1991-08-31","to":null},"UZB":{"descriptorSha256":"78ce65f012c1f11cd0e34e7537bc72a56e25a8d1f0360e25b27c2c23f9c9bceb","cas":"8fe960fc8149a9624c360f98b01de1590dbe4b3e2c8c128b48a451e4e134c2c5","version":"state:UZB:natural-earth-5.1.1","from":"1991-08-31","to":null},"KAZ":{"descriptorSha256":"466f8a4aedc6271c0a9db3c2fa1ee4244aeda1bad30101149ededce0faf21962","cas":"47de235c3a3e07fa5fa40d7ba0805a5ddbe757d5857534439c37903aa0db46ae","version":"state:KAZ:natural-earth-5.1.1","from":"1995-09-25","to":null},"TJK":{"descriptorSha256":"6607e1d06fc9856250852de1f4091fb9387820bad01ff19c5d467b754cd827ab","cas":"8f7833da8fcd3f33f60e3b423596573625b283e33348b1845783788e411e2d56","version":"state:TJK:natural-earth-5.1.1","from":"1991-09-09","to":null},"CHN":{"descriptorSha256":"8e23485a41ac63223d98dcdf731ec6a9d1687bb6c321e9fd4e6aa357031c3bd9","cas":"92300542e4e0e72f34b1fbbda49594c77d610baa13f67804680a9520e20b2fa8","version":"state:CHN:paektu-lsib-11.4","from":null,"to":null},"RUS":{"descriptorSha256":"915c2ab9018569299bb9c1ce31b2b800f1826c8e6f2801a60f46e20032f0c418","cas":"c9033e2f2750ef2458c8b3a768ffb8f7f5b7325f9efd44b56986dd6fc62e5b8a","version":"state:RUS:natural-earth-5.1.1","from":"2014-03-18","to":null},"AFG":{"descriptorSha256":"92aa6ff9d72fab84205d41794645c385025574e2938fe79165e70dad56612673","cas":"9e8169d42915b2a2a756e6372b7e066f52b66b46c535378457eca5890f2a70ec","version":"state:AFG:natural-earth-5.1.1","from":null,"to":null}},"paths":{"descriptor":"assets/data/territorial-entities/source/countries/state-KGZ.json","resource":"assets/data/territorial-entities/source/geometries/sha256-802dc8de1d2a7052cddd3dc316ac99e66f6424354df073fc4bf844a41ce0d6a5.json"},"receipts":{"policy":{"reference":"reports/borders/validation/modern-raw-source-20261110/protected-final-five-contract-20261113/protected-arc-fixed-bindings.json","sha256":"c555318e66e7f3770e05975f7acd67f716b07bcb2895c6872997f2007894c4c8"},"zone":{"reference":"reports/borders/validation/modern-raw-source-20261110/protected-final-five-contract-20261113/KGZ-protected-zone.json","sha256":"3a3412584d9ce764d3334e668090038a1f0d595410b7a983bd392e5cc3aa8f1b"},"priorArc":{"reference":"reports/borders/validation/modern-raw-source-20261110/protected-final-five-contract-20261113/KGZ-arc-proof.json","sha256":"79f0672f0297ba5e8c474bb3a48b4a00f1fea3266a04c299d94da48dab4fa4fd"},"priorReview":{"reference":"reports/borders/validation/modern-raw-source-20261110/protected-final-five-contract-20261113/KGZ-review.json","sha256":"612a6f33e0b57fa2a4f07935d5576872787957e23f5ddc03e602924730e17e2a"},"nativeKGZ":{"reference":"reports/borders/validation/modern-raw-source-20261110/protected-final-five-contract-20261113/KGZ-original.json","sha256":"113a6fc3c45ce6cdd39c1e14396bab78daf25cf76052d9d7a141f9b65597b2d5"},"nativeKAZ":{"reference":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-current-four-20261113/originals/KAZ-original.json","sha256":"6614379d2869ddfb259f556432c31d72058784927427a2ea7ea4e4ec2461fd8c"},"nativeUZB":{"reference":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-post-soviet-current-20261113/originals/UZB-original.json","sha256":"6fc836bde49519401b5b6176ddab14eb4993c14eb2c8f1d6d0f3da828fa5996b"},"priorSeam":{"reference":"reports/borders/validation/modern-raw-source-20261110/chn-kgz-original-frontier-20261116/review.json","sha256":"64574074961fde339b92a1ed29cd096c5cfd9c3a0c7239bbbea0bd9b55123d45"},"priorSeamTopology":{"reference":"reports/borders/validation/modern-raw-source-20261110/chn-kgz-original-frontier-20261116/topology-proof.json","sha256":"0e5e19a30dde4525c896a67a5206005d2bacd892099bd057359063c49b6a34f4"}},"originals":{"KGZ":{"uuid":"63b5f131-e580-4c10-9e24-78d4c8e5d821","name":"Kyrgyzstan","GENC3":"KGZ","wkbSha256":"37d9b976273488782c22ab6823821910c2927d00f786d388b2ac5907a2618e84"},"UZB":{"uuid":"1acee1ce-f991-445b-a1a2-1a62afc4ca9a","name":"Uzbekistan","GENC3":"UZB","wkbSha256":"b9787b4826f2216ac4f57cff5e54e1db9390534d94e2f2af4ed4846878b15f4e"},"KAZ":{"uuid":"7f1674ad-e097-48c8-829b-a60281d4230f","name":"Kazakhstan","GENC3":"KAZ","wkbSha256":"5870d328e9e29e6647cfb3b4dd8651d117041011a04b3003740860f321b60652"}}};
const BASE='assets/data/territorial-entities/source/',ID='state:KGZ',VERSION='state:KGZ:natural-earth-5.1.1',DATE='1991-08-31';
const status='raw-source-only-not-display-approved',relation='partial-original-with-readonly-uzbek-seam';
export const kgzUzbSeamMethod='exact-original-kgz-uzb-readonly-counterpart-seam';
export const hasKgzUzbSeam=e=>e?.entityId===ID&&e.geometryVersions?.some(v=>v.validTo===null&&v.modernBoundarySupplement?.adoptionMode===kgzUzbSeamMethod)===true;
const H=b=>createHash('sha256').update(b).digest('hex'),dom=g=>H(JSON.stringify([g.type,g.coordinates])),cas=g=>H(JSON.stringify({coordinates:g.coordinates,type:g.type})+'\n');
const err=m=>{throw Error('KGZ/UZB exact archived native seam: '+m);};
const read=(f,{reference,sha256})=>{const b=f(reference);if(!Buffer.isBuffer(b)||H(b)!==sha256)err('not exact archived bytes: '+reference);return JSON.parse(b);};
const poly=g=>g.type==='Polygon'?[g.coordinates]:g.coordinates,ring=(g,p,r)=>poly(g)[p][r],open=(g,p,r)=>ring(g,p,r).slice(0,-1);
const arc=(g,[p,r,s,e,d])=>exactCyclicChain(ring(g,p,r),s,e,d);
const pts=(a,s,n,d=1)=>Array.from({length:n},(_,i)=>a[(s+i*d+a.length)%a.length]);
const omit=(o,...ks)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!ks.includes(k)));
const stable=e=>({...e,sourceInfo:omit(e.sourceInfo,'geometryVersionId','geometrySha256'),geometryVersions:e.geometryVersions.map(v=>v.versionId===VERSION?omit(v,'geometry','modernBoundarySupplement'):v)});
export function assertKgzUzbTopology(p){
 const corners={KAZ:{type:'Point',coordinates:[70.94353410000008,42.263666200000046]},TJK:{type:'Point',coordinates:[70.98361250000005,40.225789500000076]}};
 if(p.baseApp!==registration.topologyBase.app||p.baseData!==registration.topologyBase.data||p.candidateValid!==true||p.afterDE9IM!=='FF2F11212'||p.afterOverlapKm2!==0||p.overlapPositivePolygons!==0||p.oldLandLossIsEmpty!==true||p.oldLandLossKm2!==0||p.oldLandLossPositivePolygons!==0||
  !eq(p.old,oldOp)||!eq(p.raw,nativeOp)||!eq(p.fixedUZB,donorOp)||p.mainPoints!==21488||!eq(p.enclaves,closedOps)||
  !eq(p.mask,{sha256:registration.receipts.zone.sha256,deltaDisjoint:true,allocationExact:true,boundaryExact:true})||
  !eq(p.KAZsaved,{oldStart:2788,candidateStart:21713,points:14690,exact:true})||
  !eq(Object.keys(p.peers).sort(),['AFG','CHN','KAZ','RUS','TJK']))err('exact protected no-loss topology required');
 for(const [k,v] of Object.entries(p.peers))if(v.intersectionExact!==true||v.boundaryExact!==true||!eq(v.deltaContact,corners[k]??null)||v.deltaDisjoint!==!corners[k])err('unchanged peer topology required '+k);
 return true;
}
export function replayClosedKgzUzbRing(old,src,donor,s,t,n){
 if(![old,src,donor].every(r=>Array.isArray(r)&&r.length>=4&&eq(r[0],r.at(-1)))||src.length!==n+1||donor.length!==n+1)err('existing same-count closed geographic identity required');
 const a=old.slice(0,-1),b=src.slice(0,-1),c=donor.slice(0,-1);
 if(!Number.isInteger(s)||!Number.isInteger(t)||s<0||t<0||s>=n||t>=n||b.filter(p=>eq(p,a[0])).length!==1||c.filter(p=>eq(p,a[0])).length!==1||!eq(b[s],a[0])||!eq(c[t],a[0]))err('existing exact ring origin required');
 const out=pts(b,s,n);
 if(!eq(out,pts(c,t,n,-1))||out.some((p,i)=>eq(p,out[(i+1)%n])))err('complete native reciprocal ring required');
 let j=0;for(const p of out)if(j<a.length&&eq(p,a[j]))j++;
 if(j!==a.length)err('every previous ring vertex must stay in exact relative order');
 return [...out,out[0]];
}
const oldOp=[0,0,226,2788],nativeOp=[1,0,34631,56118,1],donorOp=[4,0,49611,28124,-1];
const closedOps=[
 [[0,3],7,[1,3,198,1],[3,0,11,-1],213],
 [[0,4],86,[1,4,272,1],[1,0,1945,-1],2220],
 [[0,5],5,[1,5,42,1],[2,0,41,-1],86],
 [[0,6],25,[1,6,162,1],[0,0,433,-1],598],
 [[1,0],17,[0,0,33,1],[4,1,31,-1],34]
].map(([old,currentOpen,original,fixedUZB,newOpen])=>({old,currentOpen,original,fixedUZB,newOpen,retainedOldOrdered:currentOpen}));


function native(f,r,record,code){
 const x=read(f,r),b=Buffer.from(x.rawBlobBase64,'base64');
 if(x.featureId!==record.uuid||x.properties?.WP_ID!==record.uuid||x.properties?.GENC_3!==code||x.rawWkbSha256!==record.wkbSha256||H(b)!==x.rawBlobSha256)err('official original identity changed: '+code);
 const g=decodeOriginalBlobGeometry(b,{expectedWkbSha256:record.wkbSha256});
 if(!eq(g,x.geometry))err('archived geometry and original WKB differ: '+code);
 return g;
}
function continuity(old,next,g,p,a){
 const witness=p.priorArcProof?.pointwise;
 if(!Array.isArray(witness)||witness.length!==559||p.priorArcProof.inserts!==6204||a.arcCount!==559||a.addedOriginalVertices!==6204||a.arcs.length!==559)err('fixed prior arc count changed');
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
export function assertKgzUzbSeam(next,old,{prefixes,readEvidence,sourceDataRevision}={}){
 const {binding,frozen,receipts,paths,originals}=registration;
 const a=old?.geometryVersions?.filter(v=>v.validTo===null), b=next?.geometryVersions?.filter(v=>v.validTo===null);
 if(!hasKgzUzbSeam(next)||old?.entityId!==ID||a?.length!==1||b?.length!==1||
    sourceDataRevision!==binding.sourcePin||!Array.isArray(prefixes)||!eq([...prefixes].sort(),Object.values(paths).sort()))err('exact scope and pin required');
 const [o]=a,[v]=b;
 const review=read(readEvidence,binding.review), p=read(readEvidence,review.topologyProof);
 assertKgzUzbTopology(p);
 if(!eq(stable(old),stable(next))||o.versionId!==VERSION||v.versionId!==VERSION||o.validFrom!==DATE||
    cas(o.geometry)!==frozen.KGZ.cas||review.sourcePin!==sourceDataRevision||review.previousGeometrySha256!==dom(o.geometry)||
    review.method!==kgzUzbSeamMethod||review.entityId!==ID||review.versionId!==VERSION||review.validFrom!==DATE||review.validTo!==null||
    review.status!==status||review.geometrySha256!==dom(v.geometry)||review.geometryResourceSha256!==cas(v.geometry)||
    paths.resource!==BASE+'geometries/sha256-'+cas(v.geometry)+'.json'||
    !eq(v.modernBoundarySupplement,{adoptionMode:kgzUzbSeamMethod,status,resultRelation:relation,wholeCountryRaw:false,priorPreparedAttribution:o.modernBoundarySupplement,geometrySha256:dom(v.geometry),seamReview:binding.review})||
    next.sourceInfo.geometrySha256!==dom(v.geometry)||next.sourceInfo.geometryVersionId!==VERSION)err('changed identity, topology or historical metadata');
 for(const r of Object.values(receipts))read(readEvidence,r);
 const fixed={};
 for(const [code,f] of Object.entries(frozen)){
   const d=read(readEvidence,{reference:BASE+'countries/state-'+code+'.json',sha256:f.descriptorSha256});
   for(const z of d.geometryVersions)if(z.geometryResource){const g=z.geometryResource; const bytes=readEvidence(BASE+g.file);if(!Buffer.isBuffer(bytes)||H(bytes)!==g.sha256)err('retained CAS differs '+code);}
   const e=decodeTerritorialSource(d,k=>readEvidence(BASE+k));
   const versions=e.geometryVersions.filter(z=>z.validTo===null),q=versions[0];
   if(e.entityId!=='state:'+code||versions.length!==1||!eq([q.versionId,q.validFrom,q.validTo,d.geometryVersions.find(z=>z.versionId===q.versionId).geometryResource.sha256],[f.version,f.from,f.to,f.cas]))err('pinned source differs '+code);
   fixed[code]=e;
 }
 if(!eq(fixed.KGZ,old)||!eq(o.modernBoundarySupplement.seamReview,receipts.priorSeam)||p.priorArcProof.sha256!==receipts.priorArc.sha256)err('previous accepted supplement differs');
 const g=native(readEvidence,receipts.nativeKGZ,originals.KGZ,'KGZ'), u=native(readEvidence,receipts.nativeUZB,originals.UZB,'UZB');
 const donor=fixed.UZB.geometryVersions.find(z=>z.validTo===null).geometry;
 if(!eq(u,donor)||!eq(arc(g,nativeOp),arc(u,donorOp)))err('original reciprocal border required');
 const [i,j,s,e]=oldOp;
 const [ki,kr,ks,ke,kd]=nativeOp;
 const expected=replayRetainedCoast(o.geometry,g,[{polygonIndex:i,ringIndex:j,startIndex:s,endIndex:e,raw:{polygonIndex:ki,ringIndex:kr,startIndex:ks,endIndex:ke,direction:kd}}],[{polygonIndex:0,ringIndex:0,startIndex:0}]);
 for(const c of closedOps){
   const [op,or]=c.old,[np,nr,ns]=c.original,[up,ur,us]=c.fixedUZB;
   poly(expected)[op][or]=replayClosedKgzUzbRing(ring(o.geometry,op,or),ring(g,np,nr),ring(u,up,ur),ns,us,c.newOpen);
 }
 if(!eq(expected,v.geometry)||!eq(pts(open(o.geometry,0,0),2788,14690),pts(open(v.geometry,0,0),21713,14690)))err('out of scope coordinates or unchanged Kazakhstan arc differ');
 continuity(o.geometry,v.geometry,g,p,read(readEvidence,receipts.priorArc));
 return 1;
}
