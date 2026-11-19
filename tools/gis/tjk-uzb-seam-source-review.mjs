import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast} from './retained-coast-source-review.mjs';
const R={"app":"58d8e3492d76b965ce6b35a28f0554597a2f0853","binding":{"sourcePin":"6511d38cf0f5ec523f0d7de55ea035ae5fe5eb08","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/tjk-uzb-original-frontier-20261116/review.json","sha256":"1e2767e4bbe6912bb4295c8d5a8d6a4e164aaf37c887fc46d9939f4a6e197588"}},"frozen":{"TJK":{"descriptorSha256":"6607e1d06fc9856250852de1f4091fb9387820bad01ff19c5d467b754cd827ab","cas":"8f7833da8fcd3f33f60e3b423596573625b283e33348b1845783788e411e2d56","version":"state:TJK:natural-earth-5.1.1","from":"1991-09-09","to":null},"UZB":{"descriptorSha256":"78ce65f012c1f11cd0e34e7537bc72a56e25a8d1f0360e25b27c2c23f9c9bceb","cas":"8fe960fc8149a9624c360f98b01de1590dbe4b3e2c8c128b48a451e4e134c2c5","version":"state:UZB:natural-earth-5.1.1","from":"1991-08-31","to":null},"AFG":{"descriptorSha256":"92aa6ff9d72fab84205d41794645c385025574e2938fe79165e70dad56612673","cas":"9e8169d42915b2a2a756e6372b7e066f52b66b46c535378457eca5890f2a70ec","version":"state:AFG:natural-earth-5.1.1","from":null,"to":null},"KGZ":{"descriptorSha256":"db5aaba37ae815ff9242a8af8aae11737bbe57535470e9df0303aa202121fb5a","cas":"802dc8de1d2a7052cddd3dc316ac99e66f6424354df073fc4bf844a41ce0d6a5","version":"state:KGZ:natural-earth-5.1.1","from":"1991-08-31","to":null},"KAZ":{"descriptorSha256":"466f8a4aedc6271c0a9db3c2fa1ee4244aeda1bad30101149ededce0faf21962","cas":"47de235c3a3e07fa5fa40d7ba0805a5ddbe757d5857534439c37903aa0db46ae","version":"state:KAZ:natural-earth-5.1.1","from":"1995-09-25","to":null},"TKM":{"descriptorSha256":"d6be951141490940e8fde234647b042b5b2e3d1824fa8881aa0822dfb1dc9b88","cas":"4f405de0fbcb03d1a79c6e8c6814f28572c6368afae51d204a22d070efc1a086","version":"state:TKM:natural-earth-5.1.1","from":"1991-10-27","to":null},"CHN":{"descriptorSha256":"8e23485a41ac63223d98dcdf731ec6a9d1687bb6c321e9fd4e6aa357031c3bd9","cas":"92300542e4e0e72f34b1fbbda49594c77d610baa13f67804680a9520e20b2fa8","version":"state:CHN:paektu-lsib-11.4","from":null,"to":null}},"paths":{"descriptor":"assets/data/territorial-entities/source/countries/state-TJK.json","resource":"assets/data/territorial-entities/source/geometries/sha256-e72b68ae4eb7c82dba4274c8ce8d197c623261ec489e395c5d684caeccae7357.json"},"receipts":{"zone":{"reference":"reports/borders/validation/modern-raw-source-20261110/protected-final-five-contract-20261113/TJK-protected-zone.json","sha256":"3a3412584d9ce764d3334e668090038a1f0d595410b7a983bd392e5cc3aa8f1b"},"priorArc":{"reference":"reports/borders/validation/modern-raw-source-20261110/protected-final-five-contract-20261113/TJK-arc-proof.json","sha256":"1db284284a2344ee81d52f0208fb941dfbd1f33143b53286106de3c2935ed7f3"},"nativeTJK":{"reference":"reports/borders/validation/modern-raw-source-20261110/protected-final-five-contract-20261113/TJK-original.json","sha256":"e98c493a5fb181c6583c4f06e112bace12ed896ea493655e8d516bd31aad0d99"},"nativeUZB":{"reference":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-post-soviet-current-20261113/originals/UZB-original.json","sha256":"6fc836bde49519401b5b6176ddab14eb4993c14eb2c8f1d6d0f3da828fa5996b"},"priorSeam":{"reference":"reports/borders/validation/modern-raw-source-20261110/chn-tjk-original-frontier-20261116/review.json","sha256":"1b425ce79d9a711df8b048fee471c8e5ca391a061d987c99734e345f7ce8d14c"}},"oldArc":{"oldPolygon":0,"oldRing":0,"oldStart":9427,"oldEnd":11639,"rawPolygon":0,"rawRing":0,"rawStart":9504,"rawEnd":27704,"rawDirection":1,"count":18201,"donorPolygon":4,"donorRing":0,"donorStart":67811,"donorEnd":49611,"donorDirection":-1},"enclave":{"oldPolygon":3,"oldRing":0,"rawPolygon":3,"rawRing":0,"rawStart":0,"rawDirection":1,"rawOpenLength":77,"donorPolygon":4,"donorRing":2,"donorStart":72,"donorDirection":-1,"donorOpenLength":77,"first":[70.67175720000006,40.915316500000074],"existingEnclave":true},"originals":{"TJK":{"uuid":"aab14af8-1a9c-4323-97dd-d766b63c4512","name":"Tajikistan","GENC3":"TJK","wkbSha256":"2fe9229eb0822fca38de1212f7c889bdb3454c77bfa892b10285b57feb3149f4","gpkgBlobSHA256":"bb6d473b08bdc15ea6ba8a453d8433cd69298298765fe2c3404592c88bb9851e","fid":284},"UZB":{"uuid":"1acee1ce-f991-445b-a1a2-1a62afc4ca9a","name":"Uzbekistan","GENC3":"UZB","wkbSha256":"b9787b4826f2216ac4f57cff5e54e1db9390534d94e2f2af4ed4846878b15f4e","gpkgBlobSHA256":"432e969ac9776e1e7ddce28b5d72b53a36f1befd99864003dd7821bc068d9c3b","fid":309}}};
const base='assets/data/territorial-entities/source/',ID='state:TJK';
export const tjkUzbSeamMethod='exact-original-tjk-uzb-readonly-counterpart-seam';
const status='raw-source-only-not-display-approved', relation='partial-original-with-readonly-uzbek-seam';
const H=b=>createHash('sha256').update(b).digest('hex'), dom=g=>H(JSON.stringify([g.type,g.coordinates])), cas=g=>H(JSON.stringify({coordinates:g.coordinates,type:g.type})+'\n');
const err=m=>{throw Error('TJK/UZB exact archived native seam: '+m);};
const active=e=>e?.geometryVersions?.filter(v=>v.validTo===null)??[];
export const hasTjkUzbSeam=e=>e?.entityId===ID&&active(e).some(v=>v.modernBoundarySupplement?.adoptionMode===tjkUzbSeamMethod);
const omit=(o,...ks)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!ks.includes(k)));
const stable=e=>({...e,sourceInfo:omit(e.sourceInfo,'geometrySha256','geometryVersionId'),geometryVersions:e.geometryVersions.map(v=>v.validTo===null?omit(v,'geometry','modernBoundarySupplement'):v)});
const poly=g=>g.type==='Polygon'?[g.coordinates]:g.coordinates, ring=(g,i,j)=>poly(g)[i][j].slice(0,-1), pts=(v,s,n,d=1)=>Array.from({length:n},(_,i)=>v[((s+d*i)%v.length+v.length)%v.length]);
export function assertTjkUzbTopology(p){
 const z=p.protectedZone, f=p.full;
 if(p.baseApp!==R.app||p.baseData!==R.binding.sourcePin||p.sourceGpkgSHA256!=='55fab422ef09e35eb48d68141b9ece0ace86d4276dfe332a04dfd401c0bfc80c'||
    p.newRelation!=='FF2F11212'||p.valid!==true||p.newIntersectKm2!==0||p.newOverlapPolys!==0||p.coverageLostKm2!==0||p.lostPolys!==0||
    f?.afterKm2!==0||f.lossEmpty!==true||f.peerSetsExact!==true||
    !eq(p.operations,[R.oldArc,R.enclave])||z?.sha256!==R.receipts.zone.sha256||z.deltaIsEmpty!==true||z.coverageEqual!==true||z.boundaryExact!==true||
    !eq(Object.keys(p.peerChecks).sort(),['AFG','CHN','KAZ','KGZ','TKM'])||
    Object.values(p.peerChecks).some(x=>x.intersectionExact!==true||x.boundaryExact!==true||x.deltaIntersects!==false))err('exact protected no-loss topology required');
 return true;
}
export function assertTjkUzbSeam(next,old,{prefixes,readEvidence,sourceDataRevision}={}){
 if(!hasTjkUzbSeam(next)||old?.entityId!==ID||active(old).length!==1||active(next).length!==1||
    sourceDataRevision!==R.binding.sourcePin||!Array.isArray(prefixes)||!eq([...prefixes].sort(),Object.values(R.paths).sort()))err('exact scope and pin required');
 const [o]=active(old),[v]=active(next);
 const bytes=(f,h)=>{const b=readEvidence(f);if(!Buffer.isBuffer(b)||H(b)!==h)err('archive mismatch: '+f);return b;};
 const get=r=>JSON.parse(bytes(r.reference,r.sha256));
 const review=get(R.binding.review), p=get(review.topologyProof); assertTjkUzbTopology(p);
 if(!eq(stable(old),stable(next))||o.versionId!==R.frozen.TJK.version||v.versionId!==o.versionId||o.validFrom!==R.frozen.TJK.from||
    cas(o.geometry)!==R.frozen.TJK.cas||review.sourcePin!==sourceDataRevision||review.previousGeometrySha256!==dom(o.geometry)||
    review.method!==tjkUzbSeamMethod||review.entityId!==ID||review.versionId!==o.versionId||review.validFrom!==o.validFrom||review.validTo!==null||
    review.status!==status||review.geometrySha256!==dom(v.geometry)||review.geometryResourceSha256!==cas(v.geometry)||
    R.paths.resource!==base+'geometries/sha256-'+cas(v.geometry)+'.json'||
    !eq(v.modernBoundarySupplement,{adoptionMode:tjkUzbSeamMethod,status,resultRelation:relation,wholeCountryRaw:false,priorPreparedAttribution:o.modernBoundarySupplement,geometrySha256:dom(v.geometry),seamReview:R.binding.review})||
    !eq(o.modernBoundarySupplement.seamReview,R.receipts.priorSeam)||next.sourceInfo.geometrySha256!==dom(v.geometry)||next.sourceInfo.geometryVersionId!==v.versionId)err('changed identity or historical metadata');
 const fixed={};for(const [c,x] of Object.entries(R.frozen)){
  const d=JSON.parse(bytes(base+'countries/state-'+c+'.json',x.descriptorSha256));
  for(const z of d.geometryVersions)if(z.geometryResource)bytes(base+z.geometryResource.file,z.geometryResource.sha256);
  const e=decodeTerritorialSource(d,k=>readEvidence(base+k)),[q]=active(e),r=d.geometryVersions.find(z=>z.versionId===q.versionId);
  if(e.entityId!=='state:'+c||active(e).length!==1||!eq([q.versionId,q.validFrom,q.validTo,r.geometryResource.sha256],[x.version,x.from,x.to,x.cas]))err('retained descriptor changed '+c);
  fixed[c]=e;
 }
 if(!eq(old,fixed.TJK))err('archived old geometry differs');
 const native=c=>{const s=get(R.receipts['native'+c]),x=R.originals[c],b=Buffer.from(s.rawBlobBase64,'base64');
  if(s.featureId!==x.uuid||s.properties?.WP_ID!==x.uuid||s.properties?.GENC_3!==c||H(b)!==x.gpkgBlobSHA256||s.rawWkbSha256!==x.wkbSha256)err('LSIB identity changed '+c);
  const g=decodeOriginalBlobGeometry(b,{expectedWkbSha256:x.wkbSha256});if(!eq(g,s.geometry))err('LSIB archived coordinates differ '+c);return g;};
 const g=native('TJK'),u=native('UZB'), a=R.oldArc, q=R.enclave;
 if(!eq(u,active(fixed.UZB)[0].geometry)||!eq(pts(ring(g,a.rawPolygon,a.rawRing),a.rawStart,a.count,a.rawDirection),pts(ring(u,a.donorPolygon,a.donorRing),a.donorStart,a.count,a.donorDirection)))err('nonreciprocal LSIB frontier');
 const expected=replayRetainedCoast(o.geometry,g,[{polygonIndex:a.oldPolygon,ringIndex:a.oldRing,startIndex:a.oldStart,endIndex:a.oldEnd,raw:{polygonIndex:a.rawPolygon,ringIndex:a.rawRing,startIndex:a.rawStart,endIndex:a.rawEnd,direction:a.rawDirection}}],[{polygonIndex:0,ringIndex:0,startIndex:0}]);
 const fresh=ring(g,q.rawPolygon,q.rawRing), hole=ring(u,q.donorPolygon,q.donorRing);
 if(fresh.length!==q.rawOpenLength||hole.length!==q.donorOpenLength||poly(o.geometry)[q.oldPolygon].length!==1||!eq(fresh,pts(hole,q.donorStart,hole.length,q.donorDirection)))err('nonreciprocal LSIB enclave');
 poly(expected)[q.oldPolygon]=poly(g)[q.rawPolygon];
 if(!eq(expected,v.geometry))err('unselected coordinates changed');
 for(const k of ['zone','priorSeam'])get(R.receipts[k]);
 const oldProof=get(R.receipts.priorArc), w=p.priorArcs, cache=new Map(), cr=(g,p,r,k)=>{const id=[p,r,k].join(':');if(!cache.has(id))cache.set(id,ring(g,p,r));return cache.get(id);};
 if(w.reference!==R.receipts.priorArc.reference||w.sha256!==R.receipts.priorArc.sha256||w.checks.length!==601||oldProof.arcs.length!==601||oldProof.addedOriginalVertices!==5118)err('protected arc record incomplete');
 for(const [i,z] of oldProof.arcs.entries()){
  const [pp,rr,j,k,n]=w.checks[i], a=cr(o.geometry,pp,rr,'old'), b=cr(v.geometry,pp,rr,'new'), c=cr(g,z.rawPolygon,z.rawRing,'raw'), r=pts(c,z.rawStart,n,z.direction);
  if(!eq([pp,rr,n],[z.polygon,z.ring,z.rawVertices])||!eq(r.at(-1),c[z.rawEnd])||H(JSON.stringify(r))!==z.rawCoordinatesSha256||!eq(r,pts(a,j,n))||!eq(r,pts(b,k,n)))err('older approved exact arc changed');
 }
 return 1;
}
