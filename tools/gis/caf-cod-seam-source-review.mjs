import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {decodeOriginalBlobGeometry} from '../data/chunked-original-source.mjs';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';

export const cafCodSeamMethod='exact-original-caf-cod-readonly-counterpart-seam';
const id='state:COD', version='state:COD:natural-earth-5.1.1';
const status='raw-source-only-not-display-approved';
const base='assets/data/territorial-entities/source/';
const prior='partial-original-TZA-shared-arcs; all outside coordinates and prior original pieces unchanged';
const hash=b=>createHash('sha256').update(b).digest('hex');
const domain=g=>hash(JSON.stringify([g.type,g.coordinates]));
const fail=message=>{throw Error('CAF/COD exact current seam: '+message);};
const keys=(o,names)=>o&&eq(Object.keys(o).sort(),[...names].sort());
const omit=(o,...names)=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!names.includes(k)));
const active=e=>e.geometryVersions.filter(x=>x.validTo===null);
const preserved=e=>({...e,sourceInfo:omit(e.sourceInfo,'geometrySha256','geometryVersionId'),
 geometryVersions:e.geometryVersions.map(x=>x.versionId===version?omit(x,'geometry','modernBoundarySupplement'):x)});
const dig=(a,b,label)=>{if(a!==b)fail(label+' digest mismatch');};
const bytes=(read,p,h)=>{const x=read(p);if(!Buffer.isBuffer(x))fail(p+' exact archived bytes required');dig(hash(x),h,p);return x;};
export const hasCafCodSeam=e=>e?.entityId===id&&e?.geometryVersions?.some(x=>x.validTo===null&&x.modernBoundarySupplement?.adoptionMode===cafCodSeamMethod)===true;

export function assertCafCodTopology(p,b,peers){
 const {openRingVertexCount,...cafArc}=p.CAFDonor??{};
 if(p.pin!==b.sourcePin||p.newPairDE9IM!=='FF2F11212'||p.newOverlapKm2!==0||p.newPositiveOverlapPolygonCount!==0||
  p.oldCoverageLossKm2!==0||p.oldCoverageLossPolygonCount!==0||p.allArcEdgesExactReciprocal!==true||
  !eq(p.operations,[b.operation])||!eq(p.ringStarts,[b.ringStart])||!eq(cafArc,b.cafArc)||
  !keys(p.otherPeers,peers)||peers.some(c=>{const v=p.otherPeers[c];return v?.exactPrePostIntersectionEqual!==true||
   v.exactPrePostBoundaryShareEqual!==true||v.changeAreaKm2!==0;}))fail('reviewed zero-overlap no-loss topology and unchanged peers required');
 return true;
}

export function assertCafCodSeam(next,previous,{prefixes,readEvidence}={}){
 const {binding,frozen,raw,descriptorPath,resourcePath}=registeredCafCod;
 if(typeof readEvidence!=='function'||!hasCafCodSeam(next)||previous?.entityId!==id)fail('pinned COD archive reader and entity required');
 const nv=active(next),pv=active(previous),v=nv[0],old=pv[0],s=v?.modernBoundarySupplement;
 if(nv.length!==1||pv.length!==1||v.versionId!==version||old.versionId!==version||v.validFrom!==null||old.validFrom!==null||
  next.metadata?.representativeGeometryVersionId!==version||!eq(preserved(next),preserved(previous)))
  fail('dates, selected version, attribution, and unselected geometry must remain exact');
 if(!keys(s,['adoptionMode','status','resultRelation','wholeCountryRaw','priorPreparedAttribution','geometrySha256','seamReview'])||
  s.status!==status||s.resultRelation!=='partial-original-with-readonly-central-african-republic-seam'||s.wholeCountryRaw!==false||
  old.modernBoundarySupplement?.adoptionMode!==prior||!eq(s.priorPreparedAttribution,old.modernBoundarySupplement)||
  !eq(s.seamReview,binding.review))fail('only registered partial source and prior attribution required');
 if(!Array.isArray(prefixes)||!eq([...prefixes].sort(),[descriptorPath,resourcePath].sort()))fail('only COD descriptor and exact new geometry may be written');
 const r=JSON.parse(bytes(readEvidence,binding.review.reference,binding.review.sha256));
 if(r.schemaVersion!==1||r.sourcePin!==binding.sourcePin||r.method!==cafCodSeamMethod||r.status!==status||r.entityId!==id||
  r.versionId!==version||r.validFrom!==null||r.validTo!==null||r.vertexCount!==binding.vertexCount||
  !eq(r.operation,binding.operation)||!eq(r.ringStart,binding.ringStart)||!eq(r.cafArc,binding.cafArc))fail('fixed source review fields required');
 dig(domain(old.geometry),r.previousGeometrySha256,'prior COD geometry');
 dig(domain(v.geometry),r.geometrySha256,'new COD geometry');
 dig(hash(JSON.stringify(v.geometry)+'\n'),r.geometryResourceSha256,'new COD CAS');
 if(s.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometrySha256!==r.geometrySha256||next.sourceInfo?.geometryVersionId!==version)
  fail('current source digest attribution must be correct');
 const proof=JSON.parse(bytes(readEvidence,r.topologyProof.reference,r.topologyProof.sha256));
 const peers=Object.keys(frozen).filter(c=>c!=='CAF'&&c!=='COD');
 assertCafCodTopology(proof,binding,peers);
 const originals={},current={};
 for(const c of ['CAF','COD']){
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
 if(!eq(current.COD,previous)||!eq(active(current.CAF)[0].geometry,originals.CAF))fail('pinned COD and exact unchanged CAF required');
 const arc=(g,x)=>exactCyclicChain(g.coordinates[x.polygonIndex][x.ringIndex],x.startIndex,x.endIndex,x.direction);
 const op=binding.operation, points=arc(originals.COD,op.raw);
 if(op.ringIndex!==0||op.raw.ringIndex!==0||binding.cafArc.ringIndex!==0||points.length!==binding.vertexCount||
  !eq(points,arc(originals.CAF,binding.cafArc))||points.slice(1).some((p,i)=>eq(p,points[i])))fail('one exact reciprocal LSIB exterior arc required');
 if(!eq(replayRetainedCoast(old.geometry,originals.COD,[op],[binding.ringStart]),v.geometry))
  fail('candidate must be exact replay with all other rings and polygons preserved');
 return 1;
}

const registeredCafCod=Object.freeze({"binding":{"sourcePin":"745505cd1606028539021e399230d5094599a1d9","review":{"reference":"reports/borders/validation/modern-raw-source-20261110/caf-cod-original-frontier-20261114/review.json","sha256":"386c169f85cc3c63025622849faf07d9f0fbd569abb95de4e787e4181e7aa92f"},"operation":{"polygonIndex":1,"ringIndex":0,"startIndex":3660,"endIndex":4568,"raw":{"polygonIndex":1,"ringIndex":0,"startIndex":27291,"endIndex":39439,"direction":1}},"ringStart":{"polygonIndex":1,"ringIndex":0,"startIndex":0},"cafArc":{"polygonIndex":0,"ringIndex":0,"startIndex":37216,"endIndex":25068,"direction":-1},"vertexCount":12149},"frozen":{"COD":{"descriptorSha256":"02c8400b45dc274f72377ccbecc81f42033cfced4589914ff4bcd6bd42b499d2","geometrySha256":"8b090221be1cd06806c8a6e1ead2470c997461b4f1a6e3f0c909c846f2f08b4b","resourceSha256":"4ac6ae2f09d46ea77d958405cc0c9d10529e3767708409f869be0ae1fcb50a54"},"CAF":{"descriptorSha256":"48c06dee942ec7918ed4cc1196e572236187b67b7ff7a07ecff0a56b427b340f","geometrySha256":"03961da63bed83a8abcfd3a44cf990a6c0167b6fcc0cf427824d67c2373c2294","resourceSha256":"c7e0b97f8a5e22639f1d6d59895e707bb65c84476123f43ecb35950d573cc51b"},"COG":{"descriptorSha256":"1ee63942748f7136e6a0b23f8e7f818cf8df030b90769c70a2a1fb982792fde4","geometrySha256":"44560177c98e2719312c9abe2ca65a2a924f8672cc64390401037935f62ee1ab","resourceSha256":"091e624cd49c0e026f81b06fd6764e9e0f796380f582a4f22bb56ab4dd39b65a"},"SDS":{"descriptorSha256":"53a7af48af8b6c1cba5342778c0e9e0c09bea4c23abe198ab5dee6a3b9440160","geometrySha256":"0cbeeb74a30bed9f81fce1d38abc3813c26ae2999dab0b07e128a781f9c0d000","resourceSha256":"3a513755c58d8e293dd6a7eb1b0852a3826fe896b13833a7af43e7a4ad2f7455"},"UGA":{"descriptorSha256":"29138906fc8319dc0558f2854dc0876f706d049a2abb735039de4a751e419162","geometrySha256":"6455d8e903087c36765c38e45829e763d5abf3994e02704f7c70d8af67332e9c","resourceSha256":"a2f008cb77924cf34c86147be0d5f7b7a235d34a8fb32a040a54f15a34dbf097"},"RWA":{"descriptorSha256":"e4dd0b0bbdab706ee357b6bb2d167ea56c898c69a6aa066fc2981f790d5478b3","geometrySha256":"d33669fc5fa7f26eeaaebd8034cbf951feaa06b108ec70fc2d021c94ff93fdb8","resourceSha256":"ed665fc2d135dd2620a0d707ba4c4782c607336226be9d6a2cb8a323666baef0"},"BDI":{"descriptorSha256":"d6d94f1efb7f4bb5e45937a6e406353873cacf37fa2744902994d7a71f02b313","geometrySha256":"2c416f0b4cd1ae308da874e0c02a29b44d4255d6a21054ba79accd70ba7cba42","resourceSha256":"ea05af199519bbf56716962a2119f0c97af8fd6ff7c8da8bc7032727d9a5efe2"},"TZA":{"descriptorSha256":"d64f40f8ffc2d8ba5f78ccb01243c1ef70b98adda053c7515d17c0534842c11f","geometrySha256":"e539df8ab7b24397c7755c9d41fff2d88dfc6044d11585c8edb5218719909801","resourceSha256":"dd7cdf1d53b19e39eb05531b0e9989116c3d45955ca2a9937c786100185afcb9"},"ZMB":{"descriptorSha256":"3efc862b4ec1ea136c48ef82a23fc711934d154ecf09739e0911bc34fb5fdda0","geometrySha256":"5828262392705ce68e4915df02d3eb405704676e229d3fc29921d5456c0b6e21","resourceSha256":"6e42f04e7f68ed7b638a1ec9dc24341941ba235f71b904bbefdeeebb380e545f"},"AGO":{"descriptorSha256":"4ab3a0bbc6d2d084d88be714f209dc2b11ff074e6c6b3a0535e7a9de5d200799","geometrySha256":"e49b36b10d42593eb7701413e98d00c200fa3d02998599d9da36424cd6953800","resourceSha256":"a134b7ef3483e125940f9aaa715d9b020519e3ee1ca5f13a6ff8b9eb4204b108"},"CMR":{"descriptorSha256":"0aa60815088b5560b738f98df7acc9cf1a7d13e6258cf9cb1031844c3bb28157","geometrySha256":"ffc8b41a93de95c8a881ad65c35afe23385441afe69c4e9d59a73227d60f54b8","resourceSha256":"84031f2263eef642d298cf366fceaffacf3e9eff694a8a9fc2002e84275599f0"},"GAB":{"descriptorSha256":"300d4668330dbb64a881efefb87d9e0e332bbf26f4e128a2ab5878a93fcd5796","geometrySha256":"1a69ac56237f01c70b7feb19b2ff83518f7dfd8df6c4b96ef337e7705805c356","resourceSha256":"03a090ea4eb08c326e58babfefe2bf5c7ad347a956f655a74de6deb0d2b071c1"},"GNQ":{"descriptorSha256":"58a333e46403b54c6839fb54716d81a81b64d901877b7d79b715f29c5d334615","geometrySha256":"4ae9bc917a4be98782c5cabf09b59cb6dad2a53215596ca8d08585f606322d83","resourceSha256":"23a44bd1b86b0cae5fc1d8c93229fcefebb40b318ee8850c3bc97da2faeea238"},"TCD":{"descriptorSha256":"73821f8ef5454ca15fb4b0f3593ae38f8e1623e60703278cc0bcb4f9a2bba536","geometrySha256":"36621e26185aa0874a412cb229bb98c9d5706b281fc07fff22269e496b8308f6","resourceSha256":"6640940231fd1412245cac08996d0561a0521d6794c30f29613e230a30c74537"},"SDN":{"descriptorSha256":"1a203c788267473003b1de1e663d63f98b3afa1080307678f7596d9b8d97d87b","geometrySha256":"f98d340fd003dedd514adf69820f077c8f68877973c4f9073c905cd2000bb540","resourceSha256":"e4626804a638143fe5d3e103d8b5df93770ca90caa8d17d89c2b0dbc460992e3"},"KEN":{"descriptorSha256":"634a1e2e2fd7e7723b8945d3f93d5e61504d73e11a879f077a04df6b9172e7d2","geometrySha256":"1d1022c882a515cf5e37eb0393b15140d72c268544ec1f296b7ea98805780c50","resourceSha256":"b6591eaf9d70a0e7f6f99c2799108d654019774d44102bb04dd8fc81431794c2"}},"raw":{"CAF":{"path":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-mediterranean-africa-20261113/originals/CAF-original.json","sha256":"2e1e20ec5579247dd471828cf545df09243cbb6ef83b121f3e10255b3fa3225a","feature":"21c50dc3-3837-4f45-8ade-141bae12af0e","wkb":"2e16b49b00d53b17fa4ca174ae083941653e0303cda5e321d3d58e05cf1d6310"},"COD":{"path":"reports/borders/validation/modern-raw-source-20261110/whole-original-region-mediterranean-africa-20261113/originals/COD-original.json","sha256":"67607dc8a402930d881626c188864f48b6bd7a47c3a1abcb4f9881a5a2c3f913","feature":"e20469ad-00d6-4bd8-a47f-98d45cc0d0dd","wkb":"44c906c671fdcbfef05ba2db54003d51ea3de3e16717a0282aaf9c8dccd40354"}},"resourcePath":"assets/data/territorial-entities/source/geometries/sha256-9cc9f468a6de45edd285b916e2f1d13ac9e05e4ca9d5e640a74c454796f9c7dd.json","descriptorPath":"assets/data/territorial-entities/source/countries/state-COD.json"});
