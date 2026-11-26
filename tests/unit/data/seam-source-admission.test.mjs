import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {assertCommonSeamSourceChanges,sourceGeometryChanges,geometryDigest} from '../../../tools/gis/seam-source-admission.mjs';

const geometry=x=>({type:'Polygon',coordinates:[[[0,0],[x,0],[x,1],[0,0]]]});
const mode='exact-original-aaa-bbb-readonly-counterpart-seam';
const status='raw-source-only-not-display-approved';
const entity=(id,g)=>({entityId:'state:'+id,geometryVersions:[{versionId:'v1',validFrom:null,validTo:null,geometry:g}]});
const receipt=review=>{
 const bytes=Buffer.from(JSON.stringify(review));
 return {bytes,ref:{reference:'reports/borders/source-review.json',sha256:createHash('sha256').update(bytes).digest('hex')}};
};
function single(){
 const before=entity('AAA',geometry(1)),next=entity('AAA',geometry(2));
 const v=next.geometryVersions[0],digest=geometryDigest(v.geometry);
 const r=receipt({method:mode,status,entityId:next.entityId,versionId:v.versionId,previousGeometrySha256:geometryDigest(before.geometryVersions[0].geometry),geometrySha256:digest});
 v.modernBoundarySupplement={adoptionMode:mode,status,wholeCountryRaw:false,geometrySha256:digest,seamReview:r.ref};
 return {before,next,v,r};
}

test('changed border source checks one archived receipt, no peer census or exact path count',()=>{
 const f=single(),reads=[];
 const handled=assertCommonSeamSourceChanges(f.next,f.before,{prefixes:['assets/data','reports'],readEvidence:path=>{reads.push(path);return f.r.bytes;}});
 assert.deepEqual([...handled],['v1']);assert.deepEqual(reads,[f.r.ref.reference]);
});

test('existing seam does not freeze ordinary metadata or date changes',()=>{
 const f=single(),after=structuredClone(f.next);
 after.names={ko:'changed'};after.geometryVersions[0].validTo='2025-01-01';
 assert.deepEqual(sourceGeometryChanges(after,f.next),[]);
 after.geometryVersions[0].historicalSourceReuse={reference:'new-source'};
 assert.equal(sourceGeometryChanges(after,f.next).length,1);
 delete after.geometryVersions[0].historicalSourceReuse;
 assert.equal(assertCommonSeamSourceChanges(after,f.next,{readEvidence:()=>assert.fail('unnecessary evidence replay')}).size,0);
});

test('changed coordinates with a stale claim and corrupt evidence are rejected',()=>{
 const f=single();f.v.geometry=geometry(3);
 assert.throws(()=>assertCommonSeamSourceChanges(f.next,f.before),/stale source geometry digest/);
 f.v.geometry=geometry(2);
 assert.throws(()=>assertCommonSeamSourceChanges(f.next,f.before,{readEvidence:()=>Buffer.from('wrong')}),/bytes differ/);
 assert.throws(()=>{f.v.modernBoundarySupplement.wholeCountryRaw=true;assertCommonSeamSourceChanges(f.next,f.before);},/partial raw source/);
});

test('bilateral adoption checks only the two actual candidate descriptors',()=>{
 const before=entity('AAA',geometry(1)),next=entity('AAA',geometry(2)),other=entity('BBB',geometry(3));
 const bilateral='exact-original-aaa-bbb-bilateral-counterpart-seam';
 const row=(e,sha)=>({descriptor:'assets/data/territorial-entities/source/countries/'+e.entityId.replace(':','-')+'.json',versionId:'v1',domain:geometryDigest(e.geometryVersions[0].geometry),cas:sha.repeat(64)});
 const a=row(next,'a'),b=row(other,'b'),r=receipt({method:bilateral,status,countries:{AAA:a,BBB:b}});
 const descriptors=new Map();
 for(const [e,m] of [[next,a],[other,b]]){
  const s={adoptionMode:bilateral,status,wholeCountryRaw:false,geometrySha256:m.domain,seamReview:r.ref};
  e.geometryVersions[0].modernBoundarySupplement=s;
  descriptors.set(m.descriptor,{entityId:e.entityId,geometryVersions:[{versionId:'v1',geometryResource:{sha256:m.cas},modernBoundarySupplement:s}]});
 }
 const reads=[],options={readEvidence:()=>r.bytes,readCandidateDescriptor:p=>{reads.push(p);return descriptors.get(p);}};
 assert.equal(assertCommonSeamSourceChanges(next,before,options).size,1);
 assert.deepEqual(reads,[a.descriptor,b.descriptor]);
 descriptors.delete(b.descriptor);
 assert.throws(()=>assertCommonSeamSourceChanges(next,before,options),/bilateral candidate is missing/);
});

test('an existing source claim cannot be silently removed from unchanged geometry',()=>{
 const f=single(),after=structuredClone(f.next);
 delete after.geometryVersions[0].modernBoundarySupplement;
 assert.throws(()=>assertCommonSeamSourceChanges(after,f.next),/lose its source evidence/);
});
