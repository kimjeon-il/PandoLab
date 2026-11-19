import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';

export const pakIrnSeamMethod='exact-original-pak-irn-readonly-counterpart-seam';
const id='state:PAK', version='state:PAK:natural-earth-5.1.1';
const date=null;
const status='raw-source-only-not-display-approved';
const base='assets/data/territorial-entities/source/';
const prior='exact-original-retained-coast-arcs-current-batch';
const rr='reports/borders/validation/modern-raw-source-20261110/';
const cdir=rr+'south-asia-retained-coast-20261114/PAK/';
const priorReview={reference:cdir+'review.json',sha256:'88f106eb4c610df366e2b2ed5ba4617a6a12b565902981138ef643f9454cefc1'};
const priorPolicy={reference:cdir+'policy.json',sha256:'70f09461941b02947255d2c60f8903be847f3e1a99fc84d6ab9512d7247ea4da'};
const priorOriginal={reference:cdir+'original.json',sha256:'2de5be0b6cc353997a60d892ff89c404c413457a9d6df4076b1f06c02cb58f71'};
const priorPartition={reference:cdir+'partition-proof.json',sha256:'8b90ada23b586d08aafaffe2071f1ce9edab4798f5ecde8c0022882b0a44b87e'};
const priorGeometryCas='99e003b50ec1c6c024e45d5889fab022c51827fb19f2811a9ec2309d8e613086';
const priorGeometryDomain='0cb8f5867a67a63b9789e7451ead75cf22f2acefe831914415f3fa8085f370b6';
const priorHistory=[];
const irnReview={reference:rr+'approved-irn-family-20261113/IRN-review.json',sha256:'98239e7c72500d3d5ee44c429dcb930cc306855cc396bd9543d51afd5eff921d'};
const irnHistory=[
 ['state:IRN:natural-earth-5.1.1:caspian-before',null,'1921-12-31','edd9edf37a0e5d1237626c624ea4f15bc02ecba90f2066ff9a90cd7913763cde'],
 ['state:IRN:natural-earth-5.1.1:caspian-1922-01-01','1922-01-01','1922-12-29','9ff75a4fbe09ee13a5d0fb5a247ddba67d4f9d8767bd4245764cb54e76976435'],
 ['state:IRN:natural-earth-5.1.1:caspian-1922-12-30','1922-12-30','1925-05-12','08ba771b81148e1cb1dccf29fe9bcbb4bc8e04c0bc9769041e346d9894024d02'],
 ['state:IRN:natural-earth-5.1.1:caspian-1925-05-13','1925-05-13','1929-12-31','9ff75a4fbe09ee13a5d0fb5a247ddba67d4f9d8767bd4245764cb54e76976435'],
 ['state:IRN:natural-earth-5.1.1','1930-01-01',null,'edd9edf37a0e5d1237626c624ea4f15bc02ecba90f2066ff9a90cd7913763cde']
];
const irnDomain='a1be70195870510b9c5260dfb1b914bfcf7663ad99bc6ab2439b05203c43f996';
const iranMethod='exact-existing-original-composition-current-batch';
const iranSources=['9c11e0fc-6619-4236-bff0-8c0390b760f4','c2122448-5492-4b6f-b861-0d525e868529'];
function assertIranComposition(e,read,archive){
 const actual=e.geometryVersions.map(v=>[v.versionId,v.validFrom,v.validTo,hash(JSON.stringify(v.geometry)+'\n')]);
 if(!eq(actual,irnHistory))fail('unchanged Iran historical/current dates and entire CAS required');
 const a=active(e)[0],s=a?.modernBoundarySupplement;
 if(a?.validFrom!=='1930-01-01'||domain(a.geometry)!==irnDomain||s?.adoptionMode!==iranMethod||
  !eq(s.compositionReview,irnReview)||s.sourceFeatureCount!==2||s.singleOriginalFeature!==false)fail('exact archived Iran real two-feature composition required');
 const x=JSON.parse(bytes(read,irnReview.reference,irnReview.sha256));
 if(x.method!==iranMethod||x.validFrom!=='1930-01-01'||x.validTo!==null||x.geometrySha256!==irnDomain||!eq(x.orderedFeatureIds,iranSources))fail('Iran original authority chain required');
 const refs=Object.entries(archive??{});if(refs.length!==9)fail('exact independent archive authorities required');
 for(const [ref,sha] of refs)bytes(read,ref,sha);
 bytes(read,x.batch.reference,x.batch.sha256);
}
function chain(g,o){return exactCyclicChain(g.coordinates[o.polygonIndex][o.ringIndex],o.startIndex,o.endIndex,o.direction);}
export function assertPriorPakCoastPoints(old,next,raw,ops,ranges,selected){
 if(ops.length!==ranges.length)fail('previous coast evidence count differs');
 let count=0;
 for(const [i,o] of ops.entries()){
  const w=ranges[i],ps=chain(raw,o.raw),n=ps.length;
  if(w.polygon!==o.polygonIndex||w.ring!==o.ringIndex||!Number.isInteger(w.oldStart)||w.oldStart<0||w.candidateStart!==w.oldStart||n!==w.pointCount||n!==o.points||
   (w.polygon===selected.polygonIndex&&w.ring===selected.ringIndex&&w.oldStart+n-1>=selected.startIndex))fail('prior coast interval crosses registered land frontier or changed');
  if(!eq(old.coordinates[w.polygon][w.ring].slice(w.oldStart,w.oldStart+n),ps)||
   !eq(next.coordinates[w.polygon][w.ring].slice(w.candidateStart,w.candidateStart+n),ps))fail('exact previous Pakistan coastal vertices changed');
  count+=n-2;
 }
 return count;
}
function assertPreviousPakistanCoast(old,next,read,ranges,selected){
 const r=JSON.parse(bytes(read,priorReview.reference,priorReview.sha256));
 const source=JSON.parse(bytes(read,priorOriginal.reference,priorOriginal.sha256));
 if(r.method!==prior||r.geometryResourceSha256!==priorGeometryCas||r.geometrySha256!==priorGeometryDomain||r.operations.length!==36||
  !eq(r.source,priorOriginal)||!eq(r.policy,priorPolicy)||source.featureId!=='199c6c12-b598-4c01-bda7-081a0e3b86fe'||
  source.rawWkbSha256!=='fd9a8f8eacfe279e31475be9b9330f163c52b6a395ac874825324738218a20c9')fail('prior coast-only policy and preimage receipt mismatch');
 bytes(read,priorPolicy.reference,priorPolicy.sha256);bytes(read,priorPartition.reference,priorPartition.sha256);
 const b=Buffer.from(source.rawBlobBase64,'base64');dig(hash(b),source.rawBlobSha256,'old Pakistan GPKG');
 const raw=decodeOriginalBlobGeometry(b,{expectedWkbSha256:source.rawWkbSha256});
 if(assertPriorPakCoastPoints(old,next,raw,r.operations,ranges,selected)!==2226)fail('prior 2,226 inserted coast vertices and all exact anchors must stay exact');
 return raw;
}
export function assertOrderedOriginalCorridor(old,next,pakRaw,irnRaw,frozenIrn,op,rawOp,pointCount){
 const q=chain(pakRaw,rawOp),p=chain(irnRaw,op.raw),f=chain(frozenIrn,op.raw);
 const ring=old.coordinates[op.polygonIndex][op.ringIndex],nextRing=next.coordinates[op.polygonIndex][op.ringIndex];
 const keep=ring.slice(op.startIndex,op.endIndex+1);
 let i=0;for(const x of p)if(i<keep.length&&eq(x,keep[i]))i++;
 if(p.length!==pointCount||i!==keep.length||!eq(q,p)||!eq(f,p)||!eq(nextRing.slice(op.startIndex,op.startIndex+pointCount),p))fail('archived official Pakistan and Iran arcs plus retained old ordered points must match');
 return true;
}

const hash=b=>createHash('sha256').update(b).digest('hex');
const domain=g=>hash(JSON.stringify([g.type,g.coordinates]));
const fail=message=>{throw Error('PAK/IRN exact current seam: '+message);};
const keys=(o,names)=>o&&eq(Object.keys(o).sort(),[...names].sort());
const omit=(o,...names)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!names.includes(k)));
const active=e=>e.geometryVersions.filter(x=>x.validTo===null);
const preserved=e=>({...e,sourceInfo:omit(e.sourceInfo,'geometrySha256','geometryVersionId'),
 geometryVersions:e.geometryVersions.map(x=>x.versionId===version?omit(x,'geometry','modernBoundarySupplement'):x)});
const dig=(a,b,label)=>{if(a!==b)fail(label+' digest mismatch');};
const bytes=(read,p,h)=>{const x=read(p);if(!Buffer.isBuffer(x))fail(p+' exact archived bytes required');dig(hash(x),h,p);return x;};
export const hasPakIrnSeam=e=>e?.entityId===id&&e?.geometryVersions?.some(x=>x.validTo===null&&x.modernBoundarySupplement?.adoptionMode===pakIrnSeamMethod)===true;

export function assertPakIrnTopology(p,b,peers){
 const {openRingVertexCount,...irnArc}=p.IRNDonor??{};
 if(p.pin!==b.sourcePin||p.newPairDE9IM!=='FF2F11212'||p.newOverlapKm2!==0||p.newPositiveOverlapPolygonCount!==0||
  p.oldCoverageLossKm2!==0||p.oldCoverageLossPolygonCount!==0||p.allArcEdgesExactReciprocal!==true||
  !p.sequentialPrior||!eq(p.sequentialPrior.history,priorHistory)||p.sequentialPrior.afgWholeIntersectionExact!==true||p.sequentialPrior.afgFullSharedBoundaryExact!==true||p.sequentialPrior.afgRelation!=='212111212'||p.sequentialPrior.iranCoastAndAuthorityUntouched!==true||p.sequentialPrior.retainedCoastOperationCount!==36||p.sequentialPrior.retainedCoastPoints!==2226||p.PAKOriginal?.wkbSha256!==b.originalPAKWkb||!eq(p.operations,[b.topologyOperation])||!eq(p.ringStarts,[b.ringStart])||!eq(irnArc,b.irnArc)||
  !keys(p.otherPeers,peers)||peers.some(c=>{const v=p.otherPeers[c];return v?.exactPrePostIntersectionEqual!==true||
   v.exactPrePostBoundaryShareEqual!==true||v.changeAreaKm2!==0;}))fail('reviewed zero-overlap no-loss topology and unchanged peers required');
 return true;
}

export function assertPakIrnSeam(next,previous,{prefixes,readEvidence}={}){
 const {binding,frozen,raw,descriptorPath,resourcePath}=registeredPakIrn;
 if(typeof readEvidence!=='function'||!hasPakIrnSeam(next)||previous?.entityId!==id)fail('pinned PAK archive reader and entity required');
 const nv=active(next),pv=active(previous),v=nv[0],old=pv[0],s=v?.modernBoundarySupplement;
 if(nv.length!==1||pv.length!==1||v.versionId!==version||old.versionId!==version||v.validFrom!==date||old.validFrom!==date||
  next.metadata?.representativeGeometryVersionId!==version||!eq(preserved(next),preserved(previous)))
  fail('dates, selected version, attribution, and unselected geometry must remain exact');
 if(!keys(s,['adoptionMode','status','resultRelation','wholeCountryRaw','priorPreparedAttribution','geometrySha256','seamReview'])||
  s.status!==status||s.resultRelation!=='partial-original-with-readonly-iran-seam'||s.wholeCountryRaw!==false||
  old.modernBoundarySupplement?.adoptionMode!==prior||!eq(s.priorPreparedAttribution,old.modernBoundarySupplement)||
  !eq(s.seamReview,binding.review))fail('only registered partial source and prior attribution required');
 if(!Array.isArray(prefixes)||!eq([...prefixes].sort(),[descriptorPath,resourcePath].sort()))fail('only PAK descriptor and exact new geometry may be written');
 if(!eq(old.modernBoundarySupplement?.retainedCoastReview,priorReview)||domain(old.geometry)!==priorGeometryDomain)fail('exact separately approved coast-only Pakistan preimage required');
 const r=JSON.parse(bytes(readEvidence,binding.review.reference,binding.review.sha256));
 if(r.schemaVersion!==1||r.sourcePin!==binding.sourcePin||r.method!==pakIrnSeamMethod||r.status!==status||r.entityId!==id||
  r.versionId!==version||r.validFrom!==date||r.validTo!==null||r.vertexCount!==binding.vertexCount||
  !eq(r.operation,binding.operation)||!eq(r.topologyOperation,binding.topologyOperation)||!eq(r.ringStart,binding.ringStart)||!eq(r.irnArc,binding.irnArc))fail('fixed source review fields required');
 dig(domain(old.geometry),r.previousGeometrySha256,'prior PAK geometry');
 dig(domain(v.geometry),r.geometrySha256,'new PAK geometry');
 dig(hash(JSON.stringify(v.geometry)+'\n'),r.geometryResourceSha256,'new PAK CAS');
 if(s.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometryVersionId!==version)
  fail('current source digest attribution must be correct');
 const proof=JSON.parse(bytes(readEvidence,r.topologyProof.reference,r.topologyProof.sha256));
 const peers=Object.keys(frozen).filter(c=>c!=='IRN'&&c!=='PAK');
 assertPakIrnTopology(proof,binding,peers);
 const originals={},current={};
 for(const c of ['IRN']){
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
 if(!eq(current.PAK,previous)||!current.IRN||!current.AFG||!current.KAS)fail('exact frozen Pakistan/Iran/Afghanistan/Kashmir required');
 const pa=assertPreviousPakistanCoast(old.geometry,v.geometry,readEvidence,proof.sequentialPrior.coastRanges,binding.operation);
 assertIranComposition(current.IRN,readEvidence,proof.archiveReceipts);
 const hist=previous.geometryVersions.filter(w=>w.validTo!==null).map(w=>({versionId:w.versionId,from:w.validFrom,to:w.validTo,resourceSHA:hash(JSON.stringify(w.geometry)+'\n')}));
 if(!eq(hist,priorHistory)||frozen.PAK.resourceSha256!==priorGeometryCas||frozen.PAK.geometrySha256!==priorGeometryDomain)fail('unaltered historic slots and exact prior current CAS required');
 const arc=(g,x)=>exactCyclicChain(g.coordinates[x.polygonIndex][x.ringIndex],x.startIndex,x.endIndex,x.direction);
 const op=binding.operation, points=arc(originals.IRN,op.raw);
 if(!eq(op.raw,binding.irnArc)||op.ringIndex!==0||op.raw.ringIndex!==0||binding.irnArc.ringIndex!==0||points.length!==binding.vertexCount||
  !eq(points,arc(originals.IRN,binding.irnArc))||points.slice(1).some((p,i)=>eq(p,points[i])))fail('one exact reciprocal LSIB exterior arc required');
 assertOrderedOriginalCorridor(old.geometry,v.geometry,pa,originals.IRN,active(current.IRN)[0].geometry,op,binding.topologyOperation.raw,binding.vertexCount);
 if(!eq(replayRetainedCoast(old.geometry,originals.IRN,[op],[binding.ringStart]),v.geometry))
  fail('candidate must be exact replay with all other rings and polygons preserved');
 return 1;
}

const registeredPakIrn=Object.freeze({"binding":{"sourcePin":"476ce3e6a33622e6b3af381ffe5a70a49a101219","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/pak-irn-original-frontier-20261116/review.json","sha256":"7f7e94ea474b5b232e46fdc873ac46abc6b65cf4e7531f90c184f18b72b0f9c3"},"operation":{"polygonIndex":373,"ringIndex":0,"startIndex":4976,"endIndex":5376,"raw":{"polygonIndex":289,"ringIndex":0,"startIndex":264240,"endIndex":213337,"direction":-1}},"topologyOperation":{"polygonIndex":373,"ringIndex":0,"startIndex":4976,"endIndex":5376,"raw":{"polygonIndex":969,"ringIndex":0,"startIndex":111510,"endIndex":162413,"direction":1}},"ringStart":{"polygonIndex":373,"ringIndex":0,"startIndex":0},"irnArc":{"polygonIndex":289,"ringIndex":0,"startIndex":264240,"endIndex":213337,"direction":-1},"vertexCount":50904,"originalPAKWkb":"fd9a8f8eacfe279e31475be9b9330f163c52b6a395ac874825324738218a20c9"},"frozen":{"PAK":{"descriptorSha256":"c607c7c30df1827466fc2a98af90ac2e50a0f3f798e14d679a53b25aa16e64ad","geometrySha256":"0cb8f5867a67a63b9789e7451ead75cf22f2acefe831914415f3fa8085f370b6","resourceSha256":"99e003b50ec1c6c024e45d5889fab022c51827fb19f2811a9ec2309d8e613086"},"IRN":{"descriptorSha256":"1cf95e5a92264454d0099281a6bfa3987255c0ed69c0535b2c4b280547889988","geometrySha256":"a1be70195870510b9c5260dfb1b914bfcf7663ad99bc6ab2439b05203c43f996","resourceSha256":"edd9edf37a0e5d1237626c624ea4f15bc02ecba90f2066ff9a90cd7913763cde"},"AFG":{"descriptorSha256":"92aa6ff9d72fab84205d41794645c385025574e2938fe79165e70dad56612673","geometrySha256":"52095d69a0e57368089d4a916ed94fa67aa72a525bb1079c9bf3e4b0132c9db5","resourceSha256":"9e8169d42915b2a2a756e6372b7e066f52b66b46c535378457eca5890f2a70ec"},"KAS":{"descriptorSha256":"cc54544e2cc74babe45b43dda8acea7ddbde4dfeba5412d5aa67e16cfacf1cb8","geometrySha256":"00238ed92de0e11a41b39f9e0d89e0310a01b9a3ee35bcc29f10667420b4f21d","resourceSha256":"0e7cf134851fec4bbdbc91763e16840e88f7bd958580bff68b52a52b7a15027a"},"IND":{"descriptorSha256":"739b6986129533dc1c92b69d72c713287105c87582fec5a7ab257535faffa03a","geometrySha256":"f4d54214a05887f1aa82f4fef21128a490aea32258d86ea5aad0e90e67754d81","resourceSha256":"fd27183b80c6a113026db208fed364590d8916322cbc87c39aba37fd3391ee4a"},"CHN":{"descriptorSha256":"a81f1eaeae67c32929cdd850172bba1ec2a1ccf676e7b616ab6eb19cba6a6160","geometrySha256":"922e1afb5840630a3f53a2db477c78125b12dbce77af5038c70a4c457a40d12c","resourceSha256":"f1114e1701a764f5ecab977b94deba5df47aa0e77c5e3435d016a5b454adcc03"},"TJK":{"descriptorSha256":"1859a5e32592afa3119e250025935859ed7ec88e4309e0040ed61cda94bc318b","geometrySha256":"6feab00b43ee19bf3a68baa3f2682107d8eec8035362b90847781130e2255b72","resourceSha256":"3c9120bdb628c8a7d7f311523d5fd905b63d58661895ec36a625c417dd8729eb"},"OMN":{"descriptorSha256":"703bb5279aa24b3db694e6905df1402f85e632e5df3e6526c678c14f01d2f5c5","geometrySha256":"7db9aeef5844bc5310cec1ced8f3becb3358d9498b1cbdc0fd5f666e52c252fc","resourceSha256":"acee976e06ea4eeec0c75893245aebf55bf6902ed194b10c056a825415a9c8db"},"ARE":{"descriptorSha256":"0db3ea18892b466399160d2abf37fefa663254652d1b8b6c9e314310285dd0bd","geometrySha256":"fe1f6f51b48f7a7fac7a7b6498b7c095a97156735b4080f70e84d2c862ede463","resourceSha256":"5cb1cb8e741315467b3cbe3212b9097e0cd4df0c214ed8fdc64636135defe22e"},"SAU":{"descriptorSha256":"3aa073707684b718f7014c8907e84b18db07d1b12ed28b0e3ebefb5445d5806c","geometrySha256":"15a9a1df6c6869252a5f508c5e98c4b4c6d3304f894865fefb111bdde8b7d287","resourceSha256":"2ca76e4e36ce4e4e6ed753c54deee727185a05daea64afa91ed9e8eff5ba75cc"},"QAT":{"descriptorSha256":"767a65cdd4a548247d49a45403978d4e607b283fbe36cb9ff663999c9d5e452c","geometrySha256":"c76a19585c2580829873493734952787199c2128516a92411ae0431dd638cdcd","resourceSha256":"7738047bd1d41702673ca0f53a5c268c3c38fbf0e504caff4df02e7c44deb425"}},"raw":{"IRN":{"path":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-current-four-20261113/originals/IRN-original.json","sha256":"c387f1a3b12f01741ba9d7e22192cdb4263a018c1289ed3bf7413ad2cd828f92","feature":"9c11e0fc-6619-4236-bff0-8c0390b760f4","wkb":"29c8c6c1ba3a029e06d2a59456368916e07d2caf90c0c3f8c3f8eabc70a8fbeb"}},"resourcePath":"assets/data/territorial-entities/source/geometries/sha256-a47942dd6800bcc4babd62b04ccdd90f8f8d49d93de5c3bf2e7d3347813157fd.json","descriptorPath":"assets/data/territorial-entities/source/countries/state-PAK.json"});
