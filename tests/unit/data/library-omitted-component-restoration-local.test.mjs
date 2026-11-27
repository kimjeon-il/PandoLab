// Isolated actual-store integration. All repositories, writes and commits are test-owned OS temp fixtures.
// No production data checkout, source, pin, reports or common code is modified.
// Shared typed fixture retains the distinct production-store peer metadata.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {encodeTerritorialSource,decodeTerritorialSource} from '../../../tools/data/territorial-source-codec.mjs';
import {assertHistoricalSourceStorageChanges} from '../../../tools/gis/historical-display-review.mjs';
import {prepareLibraryData,withLibraryWrite} from '../../../tools/data/library-runtime.mjs';
import {storeLibraryData} from '../../../tools/data/library-store.mjs';
import {decodeArchiveEntry,libraryCheckout} from '../../../tools/data/library-context.mjs';
import {fixture as createRestorationFixture,hash,json,gh,base,R,marker,wkb,blob,poly,multi,componentHash} from './helpers/restoration-fixture.mjs';
const fixture=revision=>createRestorationFixture(revision,{storageFixture:true});
const GENERATED=base.replace('/source/','/generated/v2/')+'index.json';
const SOURCE=base+'countries/state-AAA.json';
const SENTINEL='assets/data/restoration-local-sentinel.json';
import {put,git} from './helpers/isolated-library-store.mjs';
function isolatedStore(t,{mutateEvidence,mutateHead,mutateSeed,nonSource=false}={}){
 for(const name of ['PANDOLAB_LIBRARY_DATA_ROOT','GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE'])assert(!process.env[name], 'Isolated integration requires unset '+name);
 const parent=fs.mkdtempSync(path.join(tmpdir(),'pando-omitted-store-')),root=path.join(parent,'app'),data=path.join(root,'.library-data/repository');
 t.after(()=>{const actual=path.resolve(parent),allowed=path.resolve(tmpdir())+path.sep;assert(actual.startsWith(allowed));assert(path.basename(actual).startsWith('pando-omitted-store-'));fs.rmSync(actual,{recursive:true,force:true});});
 for(const dir of [root,data]){fs.mkdirSync(dir,{recursive:true});git(dir,'init','-q');git(dir,'config','core.longpaths','true');git(dir,'config','user.name','Fixture');git(dir,'config','user.email','fixture@example.invalid');}
 assert.equal(path.resolve(libraryCheckout(root)),path.resolve(data),'fixture must never resolve to production data');
 let files={};const add=(p,b)=>{put(data,p,b);files[p]={stored:p,encoding:'identity',sha256:hash(b),bytes:b.length};};
 const seed=fixture();for(const[p,b]of seed.sourceMap)add(p,b);add(GENERATED,json({entities:[]}));add(SENTINEL,json({value:0}));mutateSeed?.({add});
 const commit=label=>{put(data,'archive/index.json',json({schema:'pando-library-archive-v1',files}));git(data,'add','.');git(data,'commit','-qm',label);return git(data,'rev-parse','HEAD');};
 const pin=commit('isolated source seed'),f=fixture(pin);
 for(const[p,b]of f.sourceMap)assert.deepEqual(b,seed.sourceMap.get(p),'revision must not change source seed bytes');
 mutateEvidence?.(f);f.refresh();for(const[p,b]of f.evidence)add(p,b);
 const reportHead=commit('isolated fixed evidence report-only descendant');assert.notEqual(reportHead,pin);
 put(root,'config/library-data.json',json({repository:'fixture/data',revision:pin,mounts:['assets/data','reports']}));put(root,'.gitignore','.library-data/\nassets/data/\nreports/\n');git(root,'add','.');git(root,'commit','-qm','isolated app configuration');
 const env={parent,root,data,pin,f,add,commit,get files(){return files;},reportHead};
 // Advance the isolated archive before preparation makes its checkout sparse.
 // This gives the store a clean real descendant, not an uncommitted-file rejection.
 mutateHead?.(env);
 const beforeHead=git(data,'rev-parse','HEAD');
 prepareLibraryData({root,fetch:false,purpose:'gis',prefixes:nonSource?[SENTINEL]:[base+'countries',base+'geometries',GENERATED,SENTINEL]});
 assert.equal(git(data,'rev-parse','HEAD'),beforeHead,'preparation must retain the isolated archive descendant');
 assert.equal(git(data,'status','--porcelain'),'','fixture archive must be clean before testing admission');
 const candidate=encodeTerritorialSource(f.next);
 const writeCandidate=()=>withLibraryWrite({root,prefixes:f.prefixes},()=>{put(root,SOURCE,json(candidate.descriptor));for(const[p,b]of candidate.geometries)put(root,base+p,b);});
 const sourceBefore=JSON.parse(git(data,'show',beforeHead+':archive/index.json'));
 return {...env,candidate,beforeHead,sourceBefore,writeCandidate,store:()=>storeLibraryData({root,prefixes:f.prefixes,push:false}),read:(p,revision)=>{const index=JSON.parse(git(data,'show',revision+':archive/index.json'));return decodeArchiveEntry(data,index.files[p],revision,{fetch:false});}};
}
function rejectsWithoutArchiveMutation(s,pattern){
 s.writeCandidate();assert.throws(s.store,pattern);assert.equal(git(s.data,'rev-parse','HEAD'),s.beforeHead);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.data,'archive/index.json'))),s.sourceBefore);
}

test('isolated restoration actual store accepts report-only HEAD beyond source pin and preserves generated/evidence inputs',t=>{
 const s=isolatedStore(t);s.writeCandidate();const revision=s.store();assert.notEqual(revision,s.beforeHead);
 const index=JSON.parse(fs.readFileSync(path.join(s.data,'archive/index.json')));
 assert.deepEqual(index.files[GENERATED],s.sourceBefore.files[GENERATED]);assert.deepEqual(index.files[SENTINEL],s.sourceBefore.files[SENTINEL]);
 for(const[p]of s.f.evidence)assert.deepEqual(index.files[p],s.sourceBefore.files[p]);
 const stored=decodeTerritorialSource(JSON.parse(s.read(SOURCE,revision)),p=>s.read(base+p,revision));assert.deepEqual(stored,s.f.next);
 assert.deepEqual(JSON.parse(s.read(R+'review.json',revision)),s.f.review);
 for(const[p,b]of s.f.sourceMap)assert.deepEqual(s.read(p,s.pin),b,'original pinned fixture preimage remains byte-identical');
 assert.equal(assertHistoricalSourceStorageChanges(stored,s.f.before,{prefixes:s.f.prefixes,readEvidence:p=>s.read(p,s.beforeHead),getSourceSnapshot:()=>({archiveRevision:s.beforeHead,sourcePin:s.pin,countryDescriptorPaths:s.f.universe.countries.map(c=>c.path)})}),1);
 assert.deepEqual(stored.geometryVersions[0].geometry.coordinates[2],s.f.before.geometryVersions[0].geometry.coordinates[0]);
 assert.equal(stored.geometryVersions[0].geometry.coordinates.length,3);
 assert.equal(JSON.parse(fs.readFileSync(path.join(s.root,'config/library-data.json'))).revision,revision);
});

test('isolated restoration actual store refuses authoritative source descriptor drift after the reviewed source pin',t=>{
 const s=isolatedStore(t,{mutateHead:e=>{const p=base+'countries/state-BBB.json',d=JSON.parse(e.f.sourceMap.get(p));d.names.en='Unreviewed peer descriptor';e.add(p,json(d));e.commit('isolated source descriptor drift');}});
 rejectsWithoutArchiveMutation(s,/source|snapshot|pin|review|restor|changed/i);
});

test('isolated restoration actual store refuses a new country hidden from the reviewed census',t=>{
 const s=isolatedStore(t,{mutateHead:e=>{const d=JSON.parse(e.f.sourceMap.get(base+'countries/state-BBB.json'));d.entityId='state:CCC';d.geometryVersions[0].versionId='new-current';d.metadata.representativeGeometryVersionId='new-current';d.sourceInfo.geometryVersionId='new-current';e.add(base+'countries/state-CCC.json',json(d));e.commit('isolated hidden country');}});
 rejectsWithoutArchiveMutation(s,/source|snapshot|pin|census|country|restor|changed/i);
});

test('isolated restoration actual store refuses false census bounds even when booleans and evidence hashes are refreshed',t=>{
 const s=isolatedStore(t,{mutateEvidence:f=>{f.universe.versions[1].bounds=[200,0,201,1];}});
 rejectsWithoutArchiveMutation(s,/restor|bounds|bbox|census|snapshot/i);
});

test('isolated restoration actual store refuses omission of an authoritative country and its current version',t=>{
 const s=isolatedStore(t,{mutateEvidence:f=>{f.universe.countries.pop();f.universe.versions.pop();f.contacts.countryDescriptorCount=1;f.contacts.currentVersionCount=1;}});
 rejectsWithoutArchiveMutation(s,/restor|country|census|snapshot/i);
});

test('restoration gate cannot be called without authoritative store snapshot context',()=>{
 const f=fixture();assert.throws(()=>assertHistoricalSourceStorageChanges(f.next,f.before,{prefixes:f.prefixes,readEvidence:f.readEvidence}),/snapshot|context|restor/i);
});

test('isolated restoration actual store refuses a valid but non-ancestor source pin',t=>{
 const s=isolatedStore(t),tree=git(s.data,'rev-parse',s.pin+'^{tree}'),unrelated=git(s.data,'commit-tree',tree,'-m','isolated nonancestor source pin');
 const config=JSON.parse(fs.readFileSync(path.join(s.root,'config/library-data.json')));config.revision=unrelated;put(s.root,'config/library-data.json',json(config));
 rejectsWithoutArchiveMutation(s,/ancestor|history|integrate|pin|restor/i);
});

test('non-source actual store stays lazy and does not parse unrelated malformed source descriptors',t=>{
 const s=isolatedStore(t,{nonSource:true,mutateSeed:e=>{e.add(base+'countries/state-UNREAD.json',Buffer.from('not JSON; non-source store must not inspect this'));}});
 withLibraryWrite({root:s.root,prefixes:[SENTINEL]},()=>put(s.root,SENTINEL,json({value:1})));
 const revision=storeLibraryData({root:s.root,prefixes:[SENTINEL],push:false});assert.notEqual(revision,s.beforeHead);
 assert.deepEqual(JSON.parse(s.read(SENTINEL,revision)),{value:1});
 const index=JSON.parse(fs.readFileSync(path.join(s.data,'archive/index.json')));assert.deepEqual(index.files[base+'countries/state-UNREAD.json'],s.sourceBefore.files[base+'countries/state-UNREAD.json']);assert.deepEqual(index.files[SOURCE],s.sourceBefore.files[SOURCE]);
});




test('isolated restoration cannot replace the added raw component by rehashing every new proof past the immutable old full-blob anchor',t=>{
 let anchored;
 const s=isolatedStore(t,{mutateEvidence:f=>{
  anchored=f.before.geometryVersions[0].modernBoundarySupplement.existingComponentSourceReview.rawBlobSha256[0];
  f.next.geometryVersions[0].geometry.coordinates[1]=poly(11);
  const geometry=f.next.geometryVersions[0].geometry,bytes=blob(geometry),rawHash=hash(bytes),rawWkbHash=hash(wkb(geometry));
  f.original.geometry=structuredClone(geometry);f.original.rawBlobBase64=bytes.toString('base64');f.original.rawBlobSha256=rawHash;f.original.rawWkbSha256=rawWkbHash;
  Object.assign(f.map,{candidateSha256:hash(json(geometry)),rawBlobSha256:rawHash,rawWkbSha256:rawWkbHash});
  Object.assign(f.map.addedComplement[0],{componentWkbSha256:componentHash(geometry.coordinates[1]),bounds:[11,0,12,1]});
  Object.assign(f.bridge.original,{blobSha256:rawHash,wkbSha256:rawWkbHash});
  assert.notEqual(rawHash,anchored);
  assert.equal(f.before.geometryVersions[0].modernBoundarySupplement.existingComponentSourceReview.rawBlobSha256[0],anchored);
  // refresh() in isolatedStore rebuilds every new evidence reference/hash, never the old source preimage.
 }});
 assert.equal(s.f.before.geometryVersions[0].modernBoundarySupplement.existingComponentSourceReview.rawBlobSha256[0],anchored);
 rejectsWithoutArchiveMutation(s,/raw|original|identity|anchor|restor/i);
});



test('isolated restoration actual store refuses referenced peer resource drift with unchanged descriptor entries',t=>{
 const s=isolatedStore(t,{mutateHead:e=>{
  const resource=e.f.universe.versions.find(v=>v.entityId==='state:BBB').resourcePath;
  e.add(resource,json(multi([poly(101)])));e.commit('isolated referenced source resource drift');
 }});
 rejectsWithoutArchiveMutation(s,/source|snapshot|pin|resource|hash|changed|restor/i);
});


function rejectCompletedVersionChange(t, change, expected){
 const s=isolatedStore(t);s.writeCandidate();const completedRevision=s.store();
 assert.notEqual(completedRevision,s.beforeHead);
 const completed=decodeTerritorialSource(JSON.parse(s.read(SOURCE,completedRevision)),p=>s.read(base+p,completedRevision));
 assert.deepEqual(completed,s.f.next,'first actual store must archive the successful completion');
 const indexBefore=fs.readFileSync(path.join(s.data,'archive/index.json'));
 const pinBefore=fs.readFileSync(path.join(s.root,'config/library-data.json'));
 assert.equal(JSON.parse(pinBefore).revision,completedRevision);
 const next=structuredClone(completed);change(next);
 const encoded=encodeTerritorialSource(next),prefixes=[SOURCE];
 // Geometry payload stays identical and archived. Descriptor-only second store must
 // obtain the completed preimage from the archive, not the old fixture source.
 withLibraryWrite({root:s.root,prefixes},()=>put(s.root,SOURCE,json(encoded.descriptor)));
 assert.throws(()=>storeLibraryData({root:s.root,prefixes,push:false}),expected);
 assert.equal(git(s.data,'rev-parse','HEAD'),completedRevision);
 assert.deepEqual(fs.readFileSync(path.join(s.data,'archive/index.json')),indexBefore);
 assert.deepEqual(fs.readFileSync(path.join(s.root,'config/library-data.json')),pinBefore);
 assert.deepEqual(decodeTerritorialSource(JSON.parse(s.read(SOURCE,completedRevision)),p=>s.read(base+p,completedRevision)),completed);
 for(const[p,b]of s.f.sourceMap)assert.deepEqual(s.read(p,s.pin),b,'initial pinned source preimage remains unchanged');
 for(const[p]of s.f.evidence)assert.deepEqual(s.read(p,completedRevision),s.read(p,s.beforeHead),'completion evidence remains unchanged');
}

test('isolated second actual store rejects deleting the already completed version',t=>{
 rejectCompletedVersionChange(t,next=>{next.geometryVersions=[];},/version|geometry|completion|representative/i);
});

test('isolated second actual store rejects a schema-consistent unmarked replacement for the completed version',t=>{
 rejectCompletedVersionChange(t,next=>{
  const version=next.geometryVersions[0];version.versionId='replacement-current';
  delete version.modernBoundarySupplement;
  next.metadata.representativeGeometryVersionId=version.versionId;
  next.sourceInfo.geometryVersionId=version.versionId;
  assert.equal(next.sourceInfo.geometrySha256,gh(version.geometry));
 },/whole-feature completion: completed version inventory cannot change/);
});
