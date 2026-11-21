import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {gzipSync,gunzipSync} from 'node:zlib';
import {buildCountryBoundarySeed,createCountryLabelAnchorComputer} from '../../scripts/lib/country-boundary-seed.mjs';
import {readFileSync} from 'node:fs';
import {createBuiltinWorldLoader} from '../../src/data/builtin-world-loader.js';
import {PROJECT_SCHEMA_VERSION} from '../../src/runtime/version-contract.js';
import {buildBuiltinGeometryPacks} from '../../scripts/lib/builtin-geometry-packs.mjs';
import {historicalWorldCases} from '../fixtures/historical-world-cases.mjs';
import {compileBuiltinWorldCatalog,readBuiltinWorldFormalNames} from '../../tools/build/builtin-world-compiler.mjs';
import {buildBuiltinWorldNamePublication} from '../../tools/build/build-builtin-world.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const base='https://example.test/Pando/';
const indexPath='assets/data/builtin-world/index.json';
function fixture(changed=false){
  const identities=[],entities=[],geometryAssets=[],files=new Map();
  const records={schemaVersion:3,lifetimes:[],geometryBindings:[],parentRelations:[],propertyBindings:[]};
  for(const [i,id] of ['CAN','FRA','DEU','ITA','ESP','GBR','NOR','SWE'].entries()){
    const objectRef={domain:'territorial',id};
    const source=Buffer.from(JSON.stringify({type:'Polygon',coordinates:[[[i,0],[i+1,0],[i,changed&&i===0?2:1],[i,0]]]}));
    const stored=gzipSync(source),sha256=hash(stored),file=`geometries/sha256-${sha256}.json.gz`;
    const geometryRef={id:`geometry:${id}`,version:1};
    geometryAssets.push({...geometryRef,file,sha256,contentSha256:hash(source),type:'Polygon',encoding:'gzip',compressedBytes:stored.length,decodedBytes:source.length});
    files.set(file,stored);
    identities.push({id,properties:{entityKind:'general'}});
    entities.push({entityId:id,sha256,file:`countries/${id}-sha256-${sha256}.json.gz`,encoding:'gzip',compressedBytes:stored.length,decodedBytes:source.length,
      coverage:[{validFrom:i===0?'2026-01':null,validTo:null}],geometryRefs:[geometryRef]});
    records.lifetimes.push({id:`life:${id}`,objectRef,validFrom:i===0?'2026-01':null,validTo:null});
    records.geometryBindings.push({id:`shape:${id}`,objectRef,validFrom:i===0?'2026-01':null,validTo:null,geometryRef});
    records.parentRelations.push({id:`parent:${id}`,objectRef,validFrom:i===0?'2026-01':null,validTo:null,parentId:'',coverageMode:'explicit'});
  }
  const index={schema:'pandolab-builtin-world',schemaVersion:2,storageLayout:'descriptor-geometries-v1',
    template:{schemaVersion:PROJECT_SCHEMA_VERSION,format:'pandolab-project-state'},entities,geometryAssets,
    readIndex:{schemaVersion:1,identities,sourceHashes:entities.map(row=>row.sha256),records}};
  const bytes=Buffer.from(JSON.stringify(index));
  const manifestSpec={url:indexPath,sha256:hash(bytes),encoding:'identity',compressedBytes:bytes.length,decodedBytes:bytes.length};
  const output=()=>buildBuiltinGeometryPacks({index,month:'2026-11',catalogSha256:manifestSpec.sha256,
    readGeometryAssets:paths=>new Map(paths.map(path=>[path,files.get(path)]))});
  return {index,bytes,manifestSpec,files,output};
}

test('builtin startup geometry packs are deterministic and isolate a single change',()=>{
  const world=fixture(),first=world.output();
  assert.deepEqual(first,world.output());
  const next=fixture(true).output();
  assert.ok(first.receipt.packs.length>1);
  assert.equal(first.receipt.packs.filter(pack=>!next.assets.has(pack.url)).length,1);
  assert.equal(first.receipt.packs.flatMap(pack=>pack.members).length,world.index.geometryAssets.length);
});

test('a composite country accepts names only from its recorded representative',()=>{
 const {index}=fixture();
 const sourceId='state:CAN',minorId='state:minor',entry=index.entities[0],readIndex=index.readIndex;
 const timelineRecords=Object.fromEntries(Object.entries(readIndex.records).map(([key,value])=>
  [key,Array.isArray(value)?value.filter(row=>row.objectRef.id==='CAN'):value]));
 const priorName={id:'historical-world:names:CAN:0',objectRef:{domain:'territorial',id:'CAN'},property:'name',validFrom:'2026-01-01',validTo:null,
  value:{name:'캐나다',nameExplicit:true,names:{ko:{common:'캐나다'},en:{common:'Canada'}}}};
 timelineRecords.propertyBindings.push(priorName);
 const country={schemaVersion:3,entityId:'CAN',identity:{id:'CAN',properties:{name:'캐나다',entityKind:'general',
  metadata:{historicalTimeline:{entityId:sourceId,sourceEntityIds:[sourceId,minorId]}}}},geometryRefs:entry.geometryRefs,sourceBindings:[],timelineRecords};
 const raw=Buffer.from(JSON.stringify(country)),bytes=gzipSync(raw);
 Object.assign(entry,{sha256:hash(bytes),compressedBytes:bytes.length,decodedBytes:raw.length});
 entry.file='countries/CAN-sha256-'+entry.sha256+'.json.gz';
 index.readIndex.sourceHashes[0]=entry.sha256;
 index.inputHashes={sourceRevisions:{[sourceId]:'old',[minorId]:'unchanged'}};
 index.sourceIdentities=[{projectEntityId:'CAN',sourceEntityIds:[sourceId,minorId],sourceFeatureIds:['CAN','minor']}];
 const preferred={entityId:sourceId,names:{ko:'캐나다'},lifetime:{validFrom:'2026-01',validTo:null}};
 const updated={...preferred,nameVersions:[{...preferred.lifetime,names:{ko:{common:'캐나다',formal:'캐나다'}}}]};
 const options={sourceIndex:{entities:[{entityId:sourceId,sha256:'new'},{entityId:minorId,sha256:'irrelevant'}]},
  previousIndex:index,readSource:id=>({...updated,entityId:id}),readPreviousSource:id=>({...preferred,entityId:id}),readCountry:()=>bytes};
 const files=buildBuiltinWorldNamePublication({...options,entityIds:[sourceId]});
 const next=JSON.parse(files.get('index.json'));
 assert.deepEqual(next.geometryAssets,[...index.geometryAssets].sort((a,b)=>a.id.localeCompare(b.id)));
 assert.equal(next.inputHashes.sourceRevisions[minorId],'unchanged');
 assert.equal(next.readIndex.records.propertyBindings.find(row=>row.objectRef.id==='CAN'&&row.property==='name').value.names.ko.formal,'캐나다');
 assert.throws(()=>buildBuiltinWorldNamePublication({...options,entityIds:[minorId]}),/representative/);
 const unchangedSource={entities:[{entityId:sourceId,sha256:'old'}]};
 const shouldNotRead=()=>assert.fail('Name-only rebuild must not read unchanged raw coordinates');
 const formal=buildBuiltinWorldNamePublication({entityIds:[sourceId],previousIndex:index,readCountry:()=>bytes,
  sourceIndex:unchangedSource,readSource:shouldNotRead,readPreviousSource:shouldNotRead,
  formalNames:readBuiltinWorldFormalNames({schema:'pandolab-builtin-formal-names',schemaVersion:1,
   names:[{entityId:sourceId,ko:'캐나다',validFrom:'2026-11-21'}]})});
 const formalIndex=JSON.parse(formal.get('index.json'));
 const names=formalIndex.readIndex.records.propertyBindings.filter(row=>row.objectRef.id==='CAN'&&row.property==='name');
 assert.deepEqual(names.map(row=>[row.validFrom,row.validTo,row.value.names]),[
  ['2026-01-01','2026-11-20',priorName.value.names],
  ['2026-11-21',null,{ko:{common:'캐나다',formal:'캐나다'},en:{common:'Canada'}}],
 ]);
 assert.deepEqual(formalIndex.inputHashes.sourceRevisions,index.inputHashes.sourceRevisions);
 const corrected=buildBuiltinWorldNamePublication({entityIds:[sourceId],previousIndex:formalIndex,
  readCountry:file=>formal.get(file),sourceIndex:unchangedSource,readSource:shouldNotRead,readPreviousSource:shouldNotRead,
  formalNames:readBuiltinWorldFormalNames({schema:'pandolab-builtin-formal-names',schemaVersion:1,
   names:[{entityId:sourceId,ko:'수정된 정식명',validFrom:'2026-12-01',validTo:'2026-12-31'}]})});
 const revised=JSON.parse(corrected.get('index.json')).readIndex.records.propertyBindings
  .filter(row=>row.objectRef.id==='CAN'&&row.property==='name');
 assert.deepEqual(revised.map(row=>[row.validFrom,row.validTo,row.value.names.ko.formal??null]),[
  ['2026-01-01','2026-11-30',null],
  ['2026-12-01','2026-12-31','수정된 정식명'],
  ['2027-01-01',null,null],
 ]);
});

test('current boundary seeds retain the exact selected shapes and reject corrupt inputs',()=>{
 const world=fixture(),computeLabelAnchor=createCountryLabelAnchorComputer({d3Source:readFileSync(new URL('../../assets/js-vendor/d3.min.js',import.meta.url)),workerSource:readFileSync(new URL('../../src/rendering/workers/label-anchor-worker.js',import.meta.url))}),options={index:world.index,month:'2026-11',catalogSha256:world.manifestSpec.sha256,algorithmSha256:'algorithm',computeLabelAnchor,readGeometryAssets:paths=>new Map(paths.map(path=>[path,world.files.get(path)]))};
 const first=buildCountryBoundarySeed(options),decoded=JSON.parse(gunzipSync(first.bytes));
 assert.equal(Object.keys(decoded.signatures).length,8);assert.equal(first.spec.sha256,hash(first.bytes));
 assert.deepEqual(first,buildCountryBoundarySeed(options));
 assert.equal(Object.keys(first.spec.labelAnchors||{}).length,8,'current shapes have precomputed anchors from the maintained label algorithm');
 const point=first.spec.labelAnchors.CAN.coordinates;assert.ok(point.every(value=>value>0)&&point[0]+point[1]<1,'the derived anchor stays within the fixture triangle');
 assert.deepEqual(first.spec.labelAnchors,decoded.labelAnchors);
 const past=buildCountryBoundarySeed({...options,month:'2025-11'});assert.equal(Object.keys(JSON.parse(gunzipSync(past.bytes)).signatures).length,7);
 assert.throws(()=>buildCountryBoundarySeed({...options,algorithmSha256:'changed',readGeometryAssets:paths=>new Map(paths.map(path=>[path,Buffer.from('corrupt')]))}),/bytes differ/);
});

test('builtin startup geometry verifies packs and recovers only unavailable or ineligible members',async()=>{
  const world=fixture(),{receipt,assets}=world.output();
  const last=receipt.packs.at(-1);
  for(const mode of ['cold','missing','corrupt','month']){
    const requests=[];
    const loader=createBuiltinWorldLoader({manifestUrl:base+indexPath,manifestSpec:world.manifestSpec,dataRevision:'test',startupGeometryPacks:receipt,
      assetRoot:base,cacheStorage:null,fetchFn:async url=>{
        const path=new URL(url).pathname.replace('/Pando/','');
        requests.push(path);
        if(path===indexPath)return new Response(world.bytes);
        if(path===last.url&&mode==='missing')return new Response(null,{status:404});
        if(path===last.url&&mode==='corrupt')return new Response(new Uint8Array(last.compressedBytes));
        return new Response(assets.get(path)??world.files.get(path.replace('assets/data/builtin-world/','')));
      }});
    const {project}=await loader.loadProject(mode==='month'?'2025-12':'2026-11');
    const required=world.index.geometryAssets.filter(row=>mode!=='month'||row.id!=='geometry:CAN');
    const eligible=receipt.packs.filter(pack=>pack.members.every(member=>required.some(row=>row.sha256===member)));
    const packed=new Set(eligible.filter(pack=>!(['missing','corrupt'].includes(mode)&&pack===last)).flatMap(pack=>pack.members));
    assert.deepEqual(new Set(requests.slice(1)),new Set([...eligible.map(pack=>pack.url),...required.filter(row=>!packed.has(row.sha256)).map(row=>'assets/data/builtin-world/'+row.file)]));
    assert.equal(project.geometries.length,required.length);
    assert.deepEqual(project.geometries.map(row=>row.id).sort(),required.map(row=>row.id).sort());
    const count=requests.length;
    await loader.loadGeometryResources(required);
    assert.equal(requests.length,count,'the timeline and startup share prepared member bytes');
  }
});

test('a fresh builtin compilation applies the dated formal name source and preserves earlier names and geometry',()=>{
 const fixture=historicalWorldCases();
 const selections=fixture.currentSnapshot.entityRefs.map(entityId=>{
  const entity=fixture.entities.find(row=>row.entityId===entityId);
  return {entityId,geometryVersionId:entity.geometryVersions[0].versionId};
 });
 const input={entities:fixture.entities,view:{schemaVersion:1,id:'world-test',selections,sourceInfo:{collectionMetadata:{}}},
  currentWorld:fixture.currentWorld,policy:fixture.policy,displayPolicy:fixture.displayPolicy};
 const id=selections[0].entityId;
 const baseline=compileBuiltinWorldCatalog(input);
 const nameEntry={entityId:id,ko:'테스트 정식 국명',validFrom:'2026-11-21'};
 const priorEntry={...nameEntry,ko:'테스트 이전 국명',validFrom:'2026-10-15',validTo:'2026-10-30'};
 const source={schema:'pandolab-builtin-formal-names',schemaVersion:1,names:[nameEntry,priorEntry]};
 const rebuilt=compileBuiltinWorldCatalog({...input,formalNames:readBuiltinWorldFormalNames(source)});
 const getCountry=output=>{
  const {projectEntityId}=output.index.sourceIdentities.find(row=>row.sourceEntityIds.includes(id));
  return output.countries.find(country=>country.entityId===projectEntityId);
 };
 const before=getCountry(baseline),after=getCountry(rebuilt);
 const names=country=>country.timelineRecords.propertyBindings.filter(row=>row.property==='name');
 const earlier=names(before).at(-1),updated=names(after).at(-1);
 assert.equal(updated.validFrom,'2026-11-21');
 assert.deepEqual(updated.value.names.ko,{...earlier.value.names.ko,formal:'테스트 정식 국명'});
 assert.deepEqual(names(after).slice(-4).map(row=>[row.validFrom,row.validTo,row.value.names.ko.formal??null]),[
  [earlier.validFrom,'2026-10-14',earlier.value.names.ko.formal??null],
  ['2026-10-15','2026-10-30','테스트 이전 국명'],
  ['2026-10-31','2026-11-20',earlier.value.names.ko.formal??null],
  ['2026-11-21',earlier.validTo,'테스트 정식 국명'],
 ]);
 const omitNames=country=>({...country,timelineRecords:{...country.timelineRecords,
  propertyBindings:country.timelineRecords.propertyBindings.filter(row=>row.property!=='name')}});
 assert.deepEqual(omitNames(after),omitNames(before));
 assert.deepEqual(rebuilt.coverageReport,baseline.coverageReport);
 assert.throws(()=>readBuiltinWorldFormalNames({...source,names:[nameEntry,nameEntry]}),/duplicate/i);
 assert.throws(()=>readBuiltinWorldFormalNames({...source,names:[nameEntry,{...priorEntry,validTo:'2026-11-21'}]}),/overlap/i);
});
