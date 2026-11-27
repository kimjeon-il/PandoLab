import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,run,hash,json,base,poly,multi,blob,wkb,marker} from './helpers/source-append-fixture.mjs';
import {assertHistoricalSourceStorageChanges} from '../../../tools/gis/historical-display-review.mjs';

test('partial detached append keeps nonraw old prefix and does not claim completion',()=>{const f=fixture();assert.equal(run(f),1);assert.deepEqual(f.next.geometryVersions[0].geometry.coordinates.slice(0,2),f.before.geometryVersions[0].geometry.coordinates);assert.equal(f.next.geometryVersions[0].modernBoundarySupplement.wholeCountryRaw,false);});
function setRaw(f,raw){f.original.geometry=raw;f.original.rawBlobBase64=blob(raw).toString('base64');f.original.rawBlobSha256=hash(blob(raw));f.original.rawWkbSha256=hash(wkb(raw));for(const s of [f.before.geometryVersions[0].modernBoundarySupplement,f.next.geometryVersions[0].modernBoundarySupplement,f.next.geometryVersions[0].modernBoundarySupplement.priorPreparedAttribution])for(const k of ['pairedSourceReview','existingComponentSourceReview'])s[k].rawBlobSha256=f.original.rawBlobSha256;f.next.geometryVersions[0].geometry.coordinates[2]=structuredClone(raw.coordinates[1]);f.rebuildSources();}
const bad={
 'moved old prefix':f=>{f.next.geometryVersions[0].geometry.coordinates[0][0][1][0]+=.1;},
 'old prefix reordered':f=>{f.next.geometryVersions[0].geometry.coordinates.reverse();},
 'wrong raw selected index':f=>{f.scope.selectedRawIndexes=[2];},
 'duplicate raw selected index':f=>{f.scope.selectedRawIndexes=[1,1];},
 'raw index out of range':f=>{f.scope.selectedRawIndexes=[999];},
 'new coordinates forged and all new hashes refreshed':f=>{f.original.geometry.coordinates[1]=poly(30);f.original.rawBlobBase64=blob(f.original.geometry).toString('base64');f.original.rawBlobSha256=hash(blob(f.original.geometry));f.original.rawWkbSha256=hash(wkb(f.original.geometry));f.next.geometryVersions[0].geometry.coordinates[2]=poly(30);},
 'raw wrong ownership':f=>{f.original.properties.GENC_3='BBB';},
 'raw foreign parent':f=>{f.original.properties.WP_PAR_ID='foreign';},
 'raw disputed source':f=>{f.original.properties.Show_Disp='disputed';},
 'actual blob trailing bytes':f=>{f.original.rawBlobBase64=Buffer.concat([blob(f.original.geometry),Buffer.from([0])]).toString('base64');},
 'actual WKB hash wrong':f=>{f.original.rawWkbSha256=hash('bad');},
 'missing authoritative snapshot':f=>{f.getSourceSnapshot=undefined;},
 'stale source revision':f=>{f.authority.sourcePin='b'.repeat(40);},
 'hidden authoritative country':f=>{f.authority.countryDescriptorPaths.push(base+'countries/state-CCC.json');},
 'duplicate authoritative path':f=>{f.authority.countryDescriptorPaths.push(f.authority.countryDescriptorPaths[0]);},
 'missing census country':f=>{f.universe.countries.pop();},
 'rehashed hidden current version':f=>{const p=base+'countries/state-BBB.json',d=JSON.parse(f.sourceMap.get(p));d.geometryVersions.push({...d.geometryVersions[0],versionId:'hidden'});f.sourceMap.set(p,json(d));f.universe.countries[1].sha256=hash(json(d));},
 'peer containment':f=>{f.peer.geometryVersions[0].geometry=multi([[[[9,-1],[12,-1],[12,2],[9,2],[9,-1]]]]);f.rebuildSources();},
 'peer point contact':f=>{f.peer.geometryVersions[0].geometry=multi([[[[11,1],[12,1],[12,2],[11,2],[11,1]]]]);f.rebuildSources();},
 'peer shared edge':f=>{f.peer.geometryVersions[0].geometry=multi([poly(11)]);f.rebuildSources();},
 'old shared edge':f=>{setRaw(f,multi([poly(0),poly(1),poly(20)]));},
 'self intersecting raw ring':f=>{setRaw(f,multi([poly(0),[[[10,0],[11,1],[10,1],[11,0],[10,0]]],poly(20)]));},
 'degenerate raw ring':f=>{setRaw(f,multi([poly(0),[[[10,0],[11,0],[12,0],[10,0]]],poly(20)]));},
 'added has hole':f=>{const raw=multi([poly(0),poly(10),poly(20)]);raw.coordinates[1].push([[10.2,.2],[10.3,.2],[10.3,.3],[10.2,.2]]);setRaw(f,raw);},
 'two appended components touch':f=>{setRaw(f,multi([poly(0),poly(10),poly(11)]));f.scope.selectedRawIndexes=[1,2];f.next.geometryVersions[0].geometry.coordinates.push(poly(11));},
};
for(const [name,change]of Object.entries(bad))test('detached append rejects '+name,()=>{const f=fixture();change(f);f.refresh();assert.throws(()=>run(f),/detached-component append:/);});
for(const [name,change]of Object.entries({
 'whole flag promoted':f=>{f.next.geometryVersions[0].modernBoundarySupplement.wholeCountryRaw=true;},
 'old caveat altered':f=>{f.next.geometryVersions[0].modernBoundarySupplement.limitations='gone';},
 'version date changed':f=>{f.next.geometryVersions[0].validFrom='2000';},
 'ownership changed':f=>{f.next.parentEntityId='state:BBB';},
 'extra source path':f=>{f.prefixes.push(base+'countries/state-BBB.json');},
}))test('detached append preserves '+name,()=>{const f=fixture();f.refresh();change(f);assert.throws(()=>run(f),/Raw source adoption:/);});
for(const [name,mutate]of Object.entries({
 'version array deleted':n=>{delete n.geometryVersions;},
 'version removed':n=>{n.geometryVersions=[];},
 'version renamed':n=>{n.geometryVersions[0].versionId='other';},
 'append marker removed':n=>{delete n.geometryVersions[0].modernBoundarySupplement.detachedComponentAppend;},
 'receipt removed':n=>{delete n.geometryVersions[0].modernBoundarySupplement.sourceAdoptionReview;},
 'source hash changed':n=>{n.sourceInfo.geometrySha256=hash('bad');},
 'crossmethod':n=>{n.geometryVersions[0].modernBoundarySupplement.adoptionMode='lossless-original-feature';},
}))test('admitted append protects unchanged '+name,()=>{const f=fixture();assert.equal(run(f),1);const n=structuredClone(f.next);mutate(n);assert.throws(()=>assertHistoricalSourceStorageChanges(n,f.next,{prefixes:f.prefixes}),/detached-component append:/);});
test('admitted append allows ordinary metadata edits without replaying the source proof',()=>{
 const f=fixture();assert.equal(run(f),1);
 const n=structuredClone(f.next);
 n.names.en='New display name';n.parentEntityId='state:BBB';n.geometryVersions[0].validFrom='1900';
 assert.equal(assertHistoricalSourceStorageChanges(n,f.next,{prefixes:[f.prefixes[0]],readEvidence:()=>assert.fail('metadata edit replayed source evidence')}),0);
 assert.deepEqual(n.geometryVersions[0].geometry,f.next.geometryVersions[0].geometry);
 assert.deepEqual(n.geometryVersions[0].modernBoundarySupplement,f.next.geometryVersions[0].modernBoundarySupplement);
});
test('admitted append unchanged exact descriptor stays readable',()=>{const f=fixture();assert.equal(run(f),1);assert.equal(assertHistoricalSourceStorageChanges(structuredClone(f.next),f.next,{prefixes:f.prefixes}),0);});
test('partial append rejects 200001 selected points before topology',()=>{const f=fixture(),r=poly(10)[0];while(r.length<=200000)r.splice(-1,0,[10.5,.5]);setRaw(f,multi([poly(0),[r],poly(20)]));f.refresh();assert.throws(()=>run(f),/append exceeds 200000 point bound/);});
test('unchanged old geometry cannot acquire an unverified initial append marker',()=>{const f=fixture();f.next.geometryVersions[0].geometry=structuredClone(f.before.geometryVersions[0].geometry);f.refresh();assert.throws(()=>run(f),/detached-component append:.*unchanged/);});

for(const [name,change]of Object.entries({
 'mode only':f=>{delete f.next.geometryVersions[0].modernBoundarySupplement.detachedComponentAppend;},
 'receipt only disguised full method':f=>{delete f.next.geometryVersions[0].modernBoundarySupplement.detachedComponentAppend;f.next.geometryVersions[0].modernBoundarySupplement.adoptionMode='lossless-original-feature';},
 'receipt only without reader':f=>{delete f.next.geometryVersions[0].modernBoundarySupplement.detachedComponentAppend;delete f.next.geometryVersions[0].modernBoundarySupplement.adoptionMode;f.readEvidence=undefined;},
 'receipt only unarchived':f=>{delete f.next.geometryVersions[0].modernBoundarySupplement.detachedComponentAppend;delete f.next.geometryVersions[0].modernBoundarySupplement.adoptionMode;f.readEvidence=()=>undefined;},
}))test('unchanged geometry rejects new append '+name,()=>{const f=fixture();f.next.geometryVersions[0].geometry=structuredClone(f.before.geometryVersions[0].geometry);f.refresh();change(f);assert.throws(()=>run(f),/Raw source adoption:.*(?:unchanged|receipt|archiv)/);});

test('shared peer resource cannot hide inconsistent descriptor byte count through dedupe',()=>{const f=fixture();f.peer.geometryVersions[0].geometry=structuredClone(f.before.geometryVersions[0].geometry);f.rebuildSources();const p=base+'countries/state-BBB.json',d=JSON.parse(f.sourceMap.get(p));d.geometryVersions[0].geometryResource.bytes++;f.sourceMap.set(p,json(d));f.universe.countries[1].sha256=hash(json(d));f.refresh();assert.throws(()=>run(f),/detached-component append:.*resource/);});

test('ordinary unchanged metadata with unchanged receipt stays lazy',()=>{const f=fixture(),before=structuredClone(f.before),next=structuredClone(before);next.names.en='Ordinary rename';assert.equal(assertHistoricalSourceStorageChanges(next,before,{prefixes:[base+'countries/state-AAA.json']}),0);});
test('nonappend archived new receipt keeps its existing unchanged-geometry behavior',()=>{const f=fixture(),n=structuredClone(f.before),bytes=json({schemaVersion:1,method:'ordinary-review'}),r={reference:'reports/detached-test/ordinary.json',sha256:hash(bytes)};n.geometryVersions[0].modernBoundarySupplement.sourceAdoptionReview=r;assert.equal(assertHistoricalSourceStorageChanges(n,f.before,{prefixes:f.prefixes,readEvidence:p=>p===r.reference?bytes:undefined}),0);});
test('strictly separated binary64 near edge is not rounded into contact',()=>{const f=fixture();setRaw(f,multi([poly(0),poly(1+2**-50),poly(20)]));f.refresh();assert.equal(run(f),1);});
test('addition inside an existing polygon hole is genuinely detached',()=>{const f=fixture();f.peer.geometryVersions[0].geometry=multi([[[[5,-5],[15,-5],[15,5],[5,5],[5,-5]],[[9,-1],[12,-1],[12,2],[9,2],[9,-1]]]]);f.rebuildSources();f.refresh();assert.equal(run(f),1);});

function tinyCase(above){const f=fixture(),a=[2.4677579418653533e-178,7.40327382559606e-178],b=[1.111379374742538e-162,3.3341381242276143e-162],c=[2.22275874948508e-162,6.66827624845524e-162];f.before.geometryVersions[0].geometry.coordinates[1]=poly(-5);f.next.geometryVersions[0].geometry.coordinates[1]=poly(-5);const e=above?[a[0],c[1]]:[c[0],a[1]],ring=[a,c,e,a];setRaw(f,multi([poly(20),[ring],poly(30)]));return {f,a,b,c};}
test('underflow exact predicate accepts genuinely separated tiny polygons',()=>{const {f,b}=tinyCase(false),d=[b[0],3.3341381242276147e-162],e=[b[0]-1e-176,b[1]+1e-175];f.peer.geometryVersions[0].geometry=multi([[ [b,d,e,b] ]]);f.rebuildSources();f.refresh();assert.equal(run(f),1);});
test('underflow exact predicate rejects genuine tiny crossing',()=>{const {f,b}=tinyCase(true),d=[b[0],3.334138124227614e-162],e=[b[0]+1e-176,b[1]-1e-175];f.peer.geometryVersions[0].geometry=multi([[ [b,d,e,b] ]]);f.rebuildSources();f.refresh();assert.throws(()=>run(f),/contacts current geometry/);});
test('bounded long simple ring reaches contact work cap and fails closed',()=>{const f=fixture(),r=[];for(let i=0;i<10002;i++){const t=2*Math.PI*i/10002;r.push([10+Math.cos(t),3+Math.sin(t)]);}r.push(r[0]);setRaw(f,multi([poly(0),[r],poly(20)]));f.refresh();assert.throws(()=>run(f),/contact work bound exceeded; smaller batch required/);});

test('initial changed append cannot delete its receipt to escape admission',()=>{const f=fixture();delete f.next.geometryVersions[0].modernBoundarySupplement.sourceAdoptionReview;assert.throws(()=>run(f),/detached-component append:.*receipt/);});
