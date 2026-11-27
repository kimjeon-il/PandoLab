// Separate strict-subset/complement restoration contract regressions.
// sourceSnapshot provider is proposed authoritative store context, not report-supplied authority.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {encodeTerritorialSource,decodeTerritorialSource} from '../../../tools/data/territorial-source-codec.mjs';import {assertHistoricalSourceStorageChanges} from '../../../tools/gis/historical-display-review.mjs';
import {fixture,hash,json,gh,base,R,marker,wkb,blob,poly,multi,componentHash} from './helpers/restoration-fixture.mjs';
const run=f=>assertHistoricalSourceStorageChanges(f.next,f.before,{prefixes:f.prefixes,readEvidence:f.readEvidence,getSourceSnapshot:f.getSourceSnapshot});
test('restoration accepts exact subset plus complete original complement and reindexes without moving old vertices',()=>{const f=fixture();assert.equal(run(f),1);assert.deepEqual(f.next.geometryVersions[0].geometry.coordinates[2],f.before.geometryVersions[0].geometry.coordinates[0]);assert.deepEqual(f.next.geometryVersions[0].modernBoundarySupplement.existingComponentSourceReview,f.before.geometryVersions[0].modernBoundarySupplement.existingComponentSourceReview);});
const changes={
 'missing marker':f=>{delete f.next.geometryVersions[0].modernBoundarySupplement.wholeFeatureCompletion;},
 'singleton marker cannot restore components':f=>{f.next.geometryVersions[0].modernBoundarySupplement.wholeFeatureCompletion.method=f.review.wholeFeatureCompletion.method='partial-to-whole-original-single-component';},
 'missing scope evidence':f=>{delete f.review.restorationScope;},
 'partial complement':f=>{f.map.addedComplement=[];},
 'wrong complement index':f=>{f.map.addedComplement[0].originalIndex=2;},
 'duplicate retained target':f=>{f.map.pairs[1].newOriginalIndex=2;},
 'missing retained source':f=>{f.map.pairs.pop();},
 'wrong old index':f=>{f.map.pairs[0].oldIndex=8;},
 'reindexed old review':f=>{f.next.geometryVersions[0].modernBoundarySupplement.existingComponentSourceReview.components[0].oldIndex=2;},
 'old preimage digest wrong':f=>{f.scope.target.previousGeometrySha256=hash('wrong');},
 'old supplement digest wrong':f=>{f.scope.target.previousSupplementSha256=hash('wrong');},
 'old source resource wrong':f=>{f.map.previousResourceSha256=hash('wrong');},
 'moved old vertex':f=>{f.next.geometryVersions[0].geometry.coordinates[2][0][1][0]+=.1;},
 'missing original component':f=>{f.next.geometryVersions[0].geometry.coordinates.pop();},
 'foreign added component':f=>{f.next.geometryVersions[0].geometry.coordinates[1]=poly(50);},
 'unexpected hole':f=>{f.next.geometryVersions[0].geometry.coordinates[0].push(poly(.2)[0]);},
 'wrong original properties':f=>{f.original.properties.GENC_3='BBB';},
 'raw parent changed':f=>{f.original.properties.WP_PAR_ID='foreign';},
 'raw dispute':f=>{f.original.properties.Map_Disp='AAA,BBB';},
 'raw blob changed':f=>{f.original.rawBlobBase64=Buffer.from('not GPKG').toString('base64');f.original.rawBlobSha256=hash(Buffer.from('not GPKG'));},
 'wrong actual WKB hash':f=>{f.original.rawWkbSha256=hash('wrong');},
 'changed prepared identity':f=>{f.prepared.properties.WP_ID='foreign';},
 'prepared file mismatch':f=>{f.prepared.fileSha256=hash('wrong');},
 'prepared blob mismatch':f=>{f.prepared.blobSha256=hash('wrong');},
 'prepared-donor equivalence absent':f=>{f.bridge.approvedDonor.equalsPrepared=false;},
 'prepared-minus-donor nonempty':f=>{f.bridge.approvedDonor.preparedMinusDonorEmpty=false;},
 'wrong approved donor file':f=>{f.bridge.approvedDonor.fileSha256=hash('wrong');},
 'wrong approved donor shape':f=>{f.donor.geometry.coordinates[0][0][0][0]+=.1;},
 'invented historical root':f=>{f.lineage.synthesizedHistoricalRoot=true;},
 'wrong ordinary root':f=>{f.lineage.preparedSourceRoot.actualReviewSha256=hash('wrong');},
 'wrong lineage root geometry':f=>{f.lineage.preparedSourceRoot.approvedDonorGeometrySha256=hash('wrong');},
 'wrong reviewed source pin':f=>{f.authority.sourcePin='b'.repeat(40);},
 'new authoritative country':f=>{f.authority.countryDescriptorPaths.push(base+'countries/state-CCC.json');},
 'missing authoritative country':f=>{f.authority.countryDescriptorPaths.pop();},
 'duplicate authoritative country':f=>{f.authority.countryDescriptorPaths.push(f.authority.countryDescriptorPaths[0]);},
 'missing census country':f=>{f.universe.countries.pop();},
 'duplicate current version':f=>{f.universe.versions.push(structuredClone(f.universe.versions[0]));},
 'new authoritative current version':f=>{const p=base+'countries/state-BBB.json',d=JSON.parse(f.sourceMap.get(p));d.geometryVersions.push({...d.geometryVersions[0],versionId:'new-current'});f.sourceMap.set(p,json(d));},
 'actual peer resource bytes changed':f=>{f.sourceMap.set(f.universe.versions[1].resourcePath,json(multi([poly(10)])));},
 'peer contact detected':f=>{f.contacts.nonemptyContacts.push({entityId:'state:BBB',originalComponent:1});},
 'bbox candidate skipped':f=>{f.contacts.checks=[];},
 'scope uncertainty silently erased':f=>{f.scope.uncertainty='';},
 'old raw attribution changed':f=>{f.next.geometryVersions[0].modernBoundarySupplement.sourceFile='new';},
 'dated restoration':f=>{f.before.geometryVersions[0].validFrom=f.next.geometryVersions[0].validFrom='2000';f.review.validFrom='2000';},
};
const expectedErrors={
 "missing marker": "Raw source adoption: whole-feature completion: explicit completion receipt required",
 "singleton marker cannot restore components": "Raw source adoption: whole-feature completion: one component with zero holes required",
 "missing scope evidence": "Raw source adoption: archived adoption evidence required",
 "partial complement": "Raw source adoption: omitted-component restoration: full exact original complement and preimage index meaning required",
 "wrong complement index": "Raw source adoption: omitted-component restoration: full exact original complement and preimage index meaning required",
 "duplicate retained target": "Raw source adoption: omitted-component restoration: old-index mapping mismatch",
 "missing retained source": "Raw source adoption: omitted-component restoration: exact preimage component map required",
 "wrong old index": "Raw source adoption: omitted-component restoration: old-index mapping mismatch",
 "reindexed old review": "Raw source adoption: prior source attribution must be preserved",
 "old preimage digest wrong": "Raw source adoption: omitted-component restoration: actual source preimage or old review binding mismatch",
 "old supplement digest wrong": "Raw source adoption: omitted-component restoration: actual source preimage or old review binding mismatch",
 "old source resource wrong": "Raw source adoption: omitted-component restoration: exact preimage component map required",
 "moved old vertex": "Raw source adoption: omitted-component restoration: typed original restoration scope required",
 "missing original component": "Raw source adoption: omitted-component restoration: typed original restoration scope required",
 "foreign added component": "Raw source adoption: omitted-component restoration: typed original restoration scope required",
 "unexpected hole": "Raw source adoption: omitted-component restoration: typed original restoration scope required",
 "wrong original properties": "Raw source adoption: omitted-component restoration: original ownership/identity mismatch",
 "raw parent changed": "Raw source adoption: omitted-component restoration: original ownership/identity mismatch",
 "raw dispute": "Raw source adoption: omitted-component restoration: original ownership/identity mismatch",
 "raw blob changed": "Raw source adoption: omitted-component restoration: actual GeoPackage header/SRID/hash mismatch",
 "wrong actual WKB hash": "Raw source adoption: omitted-component restoration: actual original WKB differs",
 "changed prepared identity": "Raw source adoption: omitted-component restoration: actual prepared/donor binary64 cyclic equivalence or identity mismatch",
 "prepared file mismatch": "Raw source adoption: omitted-component restoration: actual ordinary prepared attribution root required",
 "prepared blob mismatch": "Raw source adoption: omitted-component restoration: actual GeoPackage header/SRID/hash mismatch",
 "prepared-donor equivalence absent": "Raw source adoption: omitted-component restoration: typed prepared/original/current scope bridge mismatch",
 "prepared-minus-donor nonempty": "Raw source adoption: omitted-component restoration: typed prepared/original/current scope bridge mismatch",
 "wrong approved donor file": "Raw source adoption: omitted-component restoration: actual ordinary prepared attribution root required",
 "wrong approved donor shape": "Raw source adoption: omitted-component restoration: closed finite original rings required",
 "invented historical root": "Raw source adoption: omitted-component restoration: actual ordinary prepared attribution root required",
 "wrong ordinary root": "Raw source adoption: omitted-component restoration: actual ordinary prepared attribution root required",
 "wrong lineage root geometry": "Raw source adoption: omitted-component restoration: actual ordinary prepared attribution root required",
 "wrong reviewed source pin": "Raw source adoption: omitted-component restoration: authoritative current revision/census/contact evidence required",
 "new authoritative country": "Raw source adoption: omitted-component restoration: authoritative country set differs from reviewed census",
 "missing authoritative country": "Raw source adoption: omitted-component restoration: authoritative country set differs from reviewed census",
 "duplicate authoritative country": "Raw source adoption: omitted-component restoration: authoritative current revision/census/contact evidence required",
 "missing census country": "Raw source adoption: omitted-component restoration: authoritative country set differs from reviewed census",
 "duplicate current version": "Raw source adoption: omitted-component restoration: duplicate reviewed current version",
 "new authoritative current version": "Raw source adoption: omitted-component restoration: actual country descriptor/census mismatch",
 "actual peer resource bytes changed": "Raw source adoption: omitted-component restoration: actual current resource bytes/hash mismatch",
 "peer contact detected": "Raw source adoption: omitted-component restoration: authoritative current revision/census/contact evidence required",
 "bbox candidate skipped": "Raw source adoption: omitted-component restoration: complete actual bbox contact coverage required",
 "scope uncertainty silently erased": "Raw source adoption: omitted-component restoration: typed original restoration scope required",
 "old raw attribution changed": "Raw source adoption: omitted-component restoration: old attribution and preimage-index review must remain exact: sourceFile",
 "dated restoration": "Raw source adoption: omitted-component restoration: one ordinary undated source and exact two paths required"
};
for(const [name,mutate]of Object.entries(changes))test('restoration rejects '+name,()=>{const f=fixture();mutate(f);f.refresh();if(name==='missing scope evidence')delete f.review.restorationScope,f.evidence.set(R+'review.json',json(f.review)),f.next.geometryVersions[0].modernBoundarySupplement.sourceAdoptionReview.sha256=hash(json(f.review));assert.throws(()=>run(f),{message:expectedErrors[name]});});
test('restoration requires authoritative store snapshot context',()=>{const f=fixture();f.getSourceSnapshot=undefined;assert.throws(()=>run(f));});
for(const [name,mutate]of Object.entries({sourceHash:e=>{e.sourceInfo.geometrySha256=hash('wrong');},indexEvidence:e=>{e.geometryVersions[0].modernBoundarySupplement.existingComponentSourceReview.components=[];},marker:e=>{delete e.geometryVersions[0].modernBoundarySupplement.wholeFeatureCompletion;}}))test('completed restoration blocks unchanged-geometry metadata bypass '+name,()=>{const f=fixture(),changed=structuredClone(f.next);mutate(changed);assert.throws(()=>assertHistoricalSourceStorageChanges(changed,f.next,{prefixes:[f.prefixes[0]]}));});
test('completed restoration permits ordinary name, period and parent edits with unchanged source proof',()=>{
 const f=fixture();assert.equal(run(f),1);
 const changed=structuredClone(f.next);
 changed.names.en='New display name';changed.parentEntityId='state:BBB';changed.geometryVersions[0].validFrom='1900';
 assert.equal(assertHistoricalSourceStorageChanges(changed,f.next,{prefixes:[f.prefixes[0]],readEvidence:()=>assert.fail('metadata edit replayed source evidence')}),0);
 assert.deepEqual(changed.geometryVersions[0].geometry,f.next.geometryVersions[0].geometry);
 assert.deepEqual(changed.geometryVersions[0].modernBoundarySupplement,f.next.geometryVersions[0].modernBoundarySupplement);
});
test('actual BRN 14-to-24 evidence has exact current arrays, WKB and full complement',{skip:!process.env.PANDO_BRN_RESTORATION_DIR},()=>{const d=process.env.PANDO_BRN_RESTORATION_DIR,load=n=>JSON.parse(fs.readFileSync(path.join(d,n))),raw=load('original-source.json'),map=load('component-index-map.json'),meta=load('source-metadata.json'),row=meta.rows.find(r=>r.code==='BRN'),before=decodeTerritorialSource(row.descriptor,()=>fs.readFileSync(path.join(d,'BRN.geojson'))),g=load('BRN-full-original24-candidate.geojson');assert.equal(before.geometryVersions[0].geometry.coordinates.length,14);assert.equal(g.coordinates.length,24);assert.deepEqual(wkb(g),Buffer.from(raw.rawBlobBase64,'base64').subarray(40));assert.deepEqual(map.addedComplement.map(x=>x.originalIndex),[1,4,6,7,10,11,14,15,20,21]);for(const pair of map.pairs)assert.deepEqual(before.geometryVersions[0].geometry.coordinates[pair.oldIndex],g.coordinates[pair.newOriginalIndex]);});

test('restoration accepts report-only archive HEAD advancement with unchanged reviewed source pin and exact source universe',()=>{const f=fixture();f.authority.archiveRevision='b'.repeat(40);assert.equal(run(f),1);});

test('actual BRN restoration admission uses full typed source and authoritative fixed archive',{skip:!process.env.PANDO_BRN_RESTORATION_DIR||!process.env.PANDO_BRN_REBIND_DIR},async()=>{
 const {execFileSync}=await import('node:child_process'),{decodeArchiveEntry}=await import('../../../tools/data/library-context.mjs');
 const dir=process.env.PANDO_BRN_RESTORATION_DIR,rebind=process.env.PANDO_BRN_REBIND_DIR,load=n=>JSON.parse(fs.readFileSync(path.join(dir,n))),certificateBytes=fs.readFileSync(path.join(rebind,'restoration-scope-certificate.json')),certificate=JSON.parse(certificateBytes),revision=certificate.revision,repo='D:/dev/PandoLab-library-data/.pando-worktrees/gis-raw-modern',index=JSON.parse(execFileSync('C:/Program Files/Git/cmd/git.exe',['-C',repo,'show',revision+':archive/index.json'],{encoding:'utf8',maxBuffer:60000000})),row=load('source-metadata.json').rows.find(r=>r.code==='BRN'),before=decodeTerritorialSource(row.descriptor,p=>decodeArchiveEntry(repo,index.files[base+p],revision,{fetch:false})),next=structuredClone(before),v=next.geometryVersions[0],old=before.geometryVersions[0],source=load('original-source.json');
 v.geometry=source.geometry;v.sourceId='dos-world-polygons-11.4-beta-raw';v.modernBoundarySupplement={...old.modernBoundarySupplement,sourceId:v.sourceId,status:'raw-source-only-not-display-approved',wholeCountryRaw:true,wholeFeatureCompletion:marker(),adoptionMode:'lossless-original-feature',geometrySha256:gh(v.geometry),priorPreparedAttribution:structuredClone(old.modernBoundarySupplement),rawOriginalSource:certificate.originalSource,rawSourceFile:source.sourcePath,rawSourceFileSha256:source.sourceFileReceipt.gpkgSha256,rawFeatureId:source.featureId,sourceFileRole:'Preserved prepared attribution; new original identified separately.'};next.sourceInfo={...before.sourceInfo,sourceId:v.sourceId,title:'Complete BRN original fixture',geometrySha256:gh(v.geometry),geometryVersionId:v.versionId};
 const scopeRef={reference:'reports/borders/validation/modern-raw-source-20261110/'+path.basename(rebind)+'/restoration-scope-certificate.json',sha256:hash(certificateBytes)},proof={schemaVersion:1,status:'raw-source-only-not-display-approved',entityId:next.entityId,versionId:v.versionId,validFrom:null,validTo:null,method:'lossless-original-feature',wholeFeatureCompletion:marker(),wholeCountryRaw:true,rawCoordinateRoundtrip:true,previousGeometrySha256:gh(old.geometry),geometrySha256:gh(v.geometry),sourceInfoGeometryDigestFormat:'sha256(JSON.stringify([geometry.type, geometry.coordinates]))',source:certificate.originalSource,restorationScope:scopeRef,topology:{status:'passed',checks:['validity','shared-boundary','gaps-overlaps','holes-islands','ownership'],counterpartVersions:load('source-metadata.json').rows.filter(r=>r.code!=='BRN').flatMap(r=>r.versionResources.map(v=>({entityId:r.descriptor.entityId,versionId:v.versionId,geometrySha256:gh(JSON.parse(fs.readFileSync(path.join(dir,v.file))))})))}};
 const proofBytes=json(proof),proofRef='reports/restoration-test/actual-brn-source-review.json';v.modernBoundarySupplement.sourceAdoptionReview={reference:proofRef,sha256:hash(proofBytes)};
 const readEvidence=p=>p===proofRef?proofBytes:p.startsWith('reports/')?fs.readFileSync(path.join('D:/dev/PandoLab-library-data/reports/.edits/gis-raw-modern',p.slice(8))):decodeArchiveEntry(repo,index.files[p],revision,{fetch:false});
 assert.equal(assertHistoricalSourceStorageChanges(next,before,{prefixes:[base+'countries/state-BRN.json',base+'geometries/sha256-'+hash(json(v.geometry))+'.json'],readEvidence,getSourceSnapshot:()=>({archiveRevision:revision,sourcePin:revision,countryDescriptorPaths:Object.keys(index.files).filter(p=>p.startsWith(base+'countries/')).sort()})}),1);
});

test('restoration consults authoritative source snapshot rather than trusting census booleans',()=>{const f=fixture();let calls=0;f.getSourceSnapshot=()=>{calls++;return f.authority;};assert.equal(run(f),1);assert.equal(calls,1);});
test('restoration propagates authoritative source-pin ancestry rejection',()=>{const f=fixture();f.getSourceSnapshot=()=>{throw Error('Source pin is not an ancestor of fixed archive HEAD');};assert.throws(()=>run(f),/Source pin is not an ancestor/);});

// Rebind all donor/ordinary-root hashes, so these tests exercise actual cyclic
// coordinate equivalence rather than merely stale receipt detection.
function rebindDonorFixture(f,geometry){
 f.donor.geometry=geometry;const old=f.before.geometryVersions[0],s=old.modernBoundarySupplement,root=s.priorPreparedAttribution,donorHash=hash(json({type:'FeatureCollection',features:[f.donor]}));root.geometrySha256=gh(geometry);root.sourceFileSha256=s.sourceFileSha256=donorHash;f.rootReport.rows[0].candidateGeometrySha256=f.rootReport.rows[0].donorGeometrySha256=gh(geometry);root.sourceReview={reference:R+'root.json',sha256:hash(json(f.rootReport))};s.sourceReview=structuredClone(root.sourceReview);f.bridge.approvedDonor.fileSha256=donorHash;f.lineage.preparedSourceRoot={attributionDepth:1,attribution:structuredClone(root),actualReviewSha256:root.sourceReview.sha256,candidateGeometrySha256:gh(geometry),approvedDonorGeometrySha256:gh(geometry)};
 const ns=f.next.geometryVersions[0].modernBoundarySupplement;ns.sourceFileSha256=donorHash;ns.sourceReview=structuredClone(s.sourceReview);ns.priorPreparedAttribution=structuredClone(s);const descriptor=json(encodeTerritorialSource(f.before).descriptor),descriptorHash=hash(descriptor);f.sourceMap.set(base+'countries/state-AAA.json',descriptor);f.scope.target.previousDescriptorSha256=f.lineage.previousDescriptorSha256=f.bridge.descriptorSha256=descriptorHash;f.scope.target.previousSupplementSha256=f.lineage.previousSupplementSha256=hash(JSON.stringify(s));f.universe.countries[0].descriptorSha256=f.universe.versions[0].descriptorSha256=f.contacts.checks[0].descriptorSha256=descriptorHash;f.refresh();
}
test('restoration accepts prepared-donor exact binary64 ring rotation reversal and component permutation',()=>{const f=fixture(),g=structuredClone(f.donor.geometry);for(const p of g.coordinates){let r=p[0].slice(0,-1);r=r.slice(2).concat(r.slice(0,2)).reverse();r.push(structuredClone(r[0]));p[0]=r;}g.coordinates.reverse();rebindDonorFixture(f,g);assert.equal(run(f),1);});
test('restoration rejects rehashed donor coordinate movement despite true bridge assertions',()=>{const f=fixture(),g=structuredClone(f.donor.geometry);g.coordinates[0][0][1][0]+=.01;rebindDonorFixture(f,g);assert.equal(f.bridge.approvedDonor.equalsPrepared,true);assert.throws(()=>run(f),/actual prepared\/donor binary64 cyclic equivalence/);});
test('restoration rejects rehashed donor redundant collinear point even if geometrically equivalent',()=>{const f=fixture(),g=structuredClone(f.donor.geometry);const r=g.coordinates[0][0];r.splice(1,0,[(r[0][0]+r[1][0])/2,(r[0][1]+r[1][1])/2]);rebindDonorFixture(f,g);assert.throws(()=>run(f),/actual prepared\/donor binary64 cyclic equivalence/);});
function rebindPeerDescriptor(f,d){const bytes=json(d),hashValue=hash(bytes),p=base+'countries/state-BBB.json';f.sourceMap.set(p,bytes);f.universe.countries[1].descriptorSha256=f.universe.versions[1].descriptorSha256=hashValue;return hashValue;}
test('restoration rejects fully rehashed false bbox and hidden added-component contact',()=>{const f=fixture(),d=JSON.parse(f.sourceMap.get(base+'countries/state-BBB.json')),g=multi([poly(10)]),bytes=json(g),sha=hash(bytes),resource=base+'geometries/sha256-'+sha+'.json';d.geometryVersions[0].geometryResource={...d.geometryVersions[0].geometryResource,file:'geometries/sha256-'+sha+'.json',sha256:sha,bytes:bytes.length};f.sourceMap.set(resource,bytes);rebindPeerDescriptor(f,d);Object.assign(f.universe.versions[1],{resourcePath:resource,resourceSha256:sha,bounds:[100,0,101,1],addedEnvelopeHits:[]});f.refresh();assert.equal(f.contacts.nonemptyContacts.length,0);assert.throws(()=>run(f),/actual current country contacts restored original component/);});
test('restoration rejects rehashed omitted current version even with correct descriptor hash',()=>{const f=fixture(),d=JSON.parse(f.sourceMap.get(base+'countries/state-BBB.json'));d.geometryVersions.push({...structuredClone(d.geometryVersions[0]),versionId:'hidden-open-ended'});rebindPeerDescriptor(f,d);f.refresh();assert.throws(()=>run(f));});
test('restoration rejects fully rebound invented census country absent from authoritative set',()=>{const f=fixture(),d=JSON.parse(f.sourceMap.get(base+'countries/state-BBB.json'));d.entityId='state:CCC';d.geometryVersions[0].versionId='invented-current';const bytes=json(d),p=base+'countries/state-CCC.json';f.sourceMap.set(p,bytes);f.universe.countries.push({path:p,entityId:d.entityId,descriptorSha256:hash(bytes),openEndedCount:1,allVersions:[{versionId:'invented-current',validFrom:null,validTo:null}]});f.universe.versions.push({...f.universe.versions[1],entityId:d.entityId,versionId:'invented-current',descriptorPath:p,descriptorSha256:hash(bytes)});f.contacts.countryDescriptorCount=f.contacts.currentVersionCount=3;f.refresh();assert.throws(()=>run(f));});

test('restoration rejects altered added original with all new evidence rehashed against immutable prior full blob',()=>{const f=fixture(),g=multi([poly(0),poly(11),poly(20)]);f.next.geometryVersions[0].geometry=g;Object.assign(f.original,{geometry:structuredClone(g),rawBlobBase64:blob(g).toString('base64'),rawBlobSha256:hash(blob(g)),rawWkbSha256:hash(wkb(g))});Object.assign(f.map,{candidateSha256:hash(json(g)),rawBlobSha256:f.original.rawBlobSha256,rawWkbSha256:f.original.rawWkbSha256});Object.assign(f.map.addedComplement[0],{componentWkbSha256:componentHash(g.coordinates[1]),bounds:[11,0,12,1]});Object.assign(f.bridge.original,{blobSha256:f.original.rawBlobSha256,wkbSha256:f.original.rawWkbSha256});f.refresh();assert.throws(()=>run(f),/immutable prior whole-original blob\/feature anchor mismatch/);});

for(const [name,mutate]of Object.entries({empty:e=>{e.geometryVersions=[];},missing:e=>{delete e.geometryVersions;},renamed:e=>{e.geometryVersions[0].versionId='renamed';},markerRemoved:e=>{delete e.geometryVersions[0].modernBoundarySupplement.wholeFeatureCompletion;}}))test('completed version inventory rejects '+name,()=>{const f=fixture();assert.equal(run(f),1);const changed=structuredClone(f.next);mutate(changed);assert.throws(()=>assertHistoricalSourceStorageChanges(changed,f.next,{prefixes:[f.prefixes[0]]}),/whole-feature completion: (completed version inventory cannot change|unchanged geometry cannot alter completion attribution)/);});
