import fs from 'node:fs';
import {assertHistoricalCompiledChanges} from "../gis/historical-display-review.mjs";
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {withLibraryOutputs} from "../data/library-runtime.mjs";
import {libraryConfig,libraryCheckout,libraryReportEditRoot,decodeArchiveEntry,git,readLibraryDataFile} from "../data/library-context.mjs";
import {checkedReportPath} from '../data/library-reports.mjs';
import {readTerritorialSources,readTerritorialSource,entityFileName,territorialSourceRoot,territorialDataRoot} from "../data/territorial-entity-sources.mjs";
import {normalizeTerritorialLibraryEntity} from "../gis/territorial-library.js";
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {buildCurrentWorld} from "../data/territorial-current-world.mjs";
import {addBuiltinWorldFormalName,applyBuiltinAffiliation,compileBuiltinWorldCatalog,readBuiltinWorldFormalNames,replaceBuiltinWorldCountryNames} from "./builtin-world-compiler.mjs";
import {builtinSubunitId} from "../../src/document/territorial-display-identity.js";
import {loadBuiltinDisplayPolicy} from "../gis/builtin-display-policy.mjs";
import {encodeBuiltinCountries,finalizeBuiltinWorldFiles,readBuiltinCountryStoredBytes,readBuiltinCountry} from "../data/builtin-country-bytes.mjs";
import {isDeepStrictEqual} from 'node:util';
import {readProjectGenerationContext} from './project-generation-context.mjs';
import {assertTerritorialRetirement,assertBuiltinRetirement,readRetirementReceipt,planTerritorialRetirement,mixedRetirementPublicationPlan,verifiedMixedCurrentWorld} from '../gis/territorial-retirement.mjs';
import {buildReviewedBorderBatch,buildReviewedBorderEdition} from './reviewed-border-edition.mjs';
import {assertIndexedTerritorialChunk} from '../data/territorial-metadata-projection.mjs';
import {selectTerritorialChunkBytes} from '../data/territorial-chunk-compression.mjs';
import {normalizeTimelineRecords} from '../../src/document/timeline-records.js';
import {parseTemporal,temporalIntervalsOverlap} from '../../src/document/temporal.js';
export {finalizeBuiltinWorldFiles};

const output=fileURLToPath(new URL("../../assets/data/builtin-world/generated/v1/",import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
// A removal can be activated only from this owner's executed producer, not a
// caller-authored file map. The proof binds immutable content, not mutable state.
const retirementPublications=new WeakMap();
const retirementInputDigest=({retirement,sourceIndex,previousSourceIndex,view,policy,displayPolicy})=>sha(JSON.stringify({retirement,sourceIndex,previousSourceIndex,view,policy,displayPolicy}));
function rememberRetirementPublication(files,input){
 retirementPublications.set(files,{input:retirementInputDigest(input),files:new Map([...files].map(([file,bytes])=>[file,sha(bytes)]))});
 return files;
}
export function recordBuiltinWorldInputs(index,sourceRevisions,view,policy){
 const ordered=Object.fromEntries(Object.entries(sourceRevisions).sort(([a],[b])=>a.localeCompare(b,'en')));
 index.inputHashes={entities:sha(JSON.stringify(ordered)),sourceRevisions:ordered,view:sha(JSON.stringify(view)),policy:sha(JSON.stringify(policy))};
 return index;
}
function loadFormalNamesForProject(generation){
 return readBuiltinWorldFormalNames(JSON.parse(readLibraryDataFile(generation.source('formalCountryNames'))));
}
export function buildBuiltinWorldPublication({input=null,previousIndex=null,policyFile=new URL("../../assets/data/historical-world/policy.json",import.meta.url)}={}){
 const policy=input?.policy||JSON.parse(fs.readFileSync(policyFile));
 // Explicit entities/readSource are caller-verified inputs (for example, an
 // already verified scoped authoring batch). Default readers verify stored chunks.
 const entities=input?.entities||readTerritorialSources(territorialSourceRoot,{sourceIndex:input?.sourceIndex});
 const view=input?.view||JSON.parse(fs.readFileSync(path.join(territorialSourceRoot,'views/world.json')));
 const currentWorld=input?.currentWorld;
 const formalNames=input?input.formalNames:loadFormalNamesForProject(readProjectGenerationContext());
 const {index,countries,coverageReport}=compileBuiltinWorldCatalog({entities,view,currentWorld,policy,displayPolicy:input?.displayPolicy||loadBuiltinDisplayPolicy(),formalNames});
 // In the full compiler, previously verified geometry resources are a
 // content-addressed cache. Name/flag/property changes may replace the small
 // country descriptor but cannot re-gzip the unchanged source coordinates.
 if(previousIndex?.geometryAssets?.length){
   const known=new Map(previousIndex.geometryAssets.map(asset=>[JSON.stringify([asset.id,asset.version]),asset]));
   for(const asset of index.geometryAssets||[])known.set(JSON.stringify([asset.id,asset.version]),asset);
   index.geometryAssets=[...known.values()];
 }
 const files=encodeBuiltinCountries(index,countries,new Map());
 recordBuiltinWorldInputs(index,input?.sourceIndex?Object.fromEntries(input.sourceIndex.entities.filter(row=>!['river','lake'].includes(row.entityType)).map(row=>[row.entityId,row.sha256])):
  Object.fromEntries(entities.map(row=>[row.entityId,sha(JSON.stringify(row))])),view,policy);
 finalizeBuiltinWorldFiles(index,files,{previousIndex});
 files.set('coverage-report.json',Buffer.from(JSON.stringify(coverageReport)+'\n'));
 return files;
}
export function buildBuiltinWorldNamePublication({entityIds,sourceIndex,previousIndex,readSource=null,readPreviousSource,readCountry,formalNames=null}) {
 if(!entityIds?.length||new Set(entityIds).size!==entityIds.length)throw Error('Explicit unique name scope required');
 if(!readPreviousSource&&entityIds.some(id=>!formalNames?.has(id)))
  throw Error('Formal names must match the selected source identities');
 readSource??=id=>readTerritorialSource(id,territorialSourceRoot,{sourceIndex});
 const index=structuredClone(previousIndex),files=new Map();
 const revisions={...index.inputHashes.sourceRevisions};
 for(const id of entityIds){
  const mapping=index.sourceIdentities.filter(row=>row.sourceEntityIds.includes(id));
  if(mapping.length!==1)throw Error(`Name-only update requires one Viewer identity: ${id}`);
  const entry=index.entities.find(row=>row.entityId===mapping[0].projectEntityId);
  if(!entry)throw Error(`Missing named country: ${id}`);
  const stored=readBuiltinCountryStoredBytes(entry,readCountry);
  const country=JSON.parse(gunzipSync(stored));
  if(country.entityId!==entry.entityId)throw Error('Name scope identity mismatch');
  if(mapping[0].sourceEntityIds.length>1&&country.identity.properties.metadata.historicalTimeline?.entityId!==id)
   throw Error(`Name-only update requires the recorded composite representative: ${id}`);
  const source=sourceIndex?.entities.find(row=>row.entityId===id),formalName=formalNames?.get(id);
  let next;
  if(formalName&&(!readPreviousSource||source&&source.sha256===revisions[id])){
   next=addBuiltinWorldFormalName(country,formalName);
  }else{
   if(!source)throw Error(`Missing named source: ${id}`);
   const entity=readSource(id),prior=readPreviousSource(id);
   if(entity.entityId!==id||prior.entityId!==id)throw Error('Name scope identity mismatch');
   const unnamed=({names,alternateNames,nameVersions,...rest})=>rest;
   if(JSON.stringify(unnamed(entity))!==JSON.stringify(unnamed(prior)))throw Error(`Name-only scope includes non-name changes: ${id}`);
   next=replaceBuiltinWorldCountryNames(country,entity,formalName);
   revisions[id]=source.sha256;
  }
  for(const [file,bytes] of encodeBuiltinCountries(index,[next],new Map()))files.set(file,bytes);
 }
 const ordered=Object.fromEntries(Object.entries(revisions).sort(([a],[b])=>a.localeCompare(b,'en')));
 index.inputHashes.sourceRevisions=ordered;index.inputHashes.entities=sha(JSON.stringify(ordered));
 return finalizeBuiltinWorldFiles(index,files,{previousIndex});
}

/** Publish source affiliation metadata and both derivative catalogs without touching geometry or parent records. */
export function buildBuiltinWorldAffiliationPublication({generation,read,updates}) {
 return buildBuiltinWorldSourcePublication({generation,read,updates,edit({id,value,raw,chunk,entry,country,isChild}){
  if(!isChild)throw Error('Affiliation requires one known child source: '+id);
  if(Object.keys(value).length!==1||!['affiliationType','affiliationTypeHistory'].some(key=>Object.hasOwn(value,key)))
   throw Error('Expected one affiliation field: '+id);
  const items=[raw,chunk,entry,country.identity.properties];
  const nextMetadata=items.map(item=>{
   const next=structuredClone(item.metadata??{});
   applyBuiltinAffiliation(next,value);
   return next;
  });
  if(items.every((item,i)=>isDeepStrictEqual(item.metadata,nextMetadata[i])))return false;
  items.forEach((item,i)=>{item.metadata=nextMetadata[i];});
  return true;
 }});
}

/** Record a historical lifetime extension while retaining the admitted display records. */
export function buildBuiltinWorldLifetimePublication({generation,read,updates}) {
 return buildBuiltinWorldSourcePublication({generation,read,updates,edit({id,value,raw,chunk,entry,country}){
  const date=parseTemporal(value,{nullable:false});
  const timeline=country.identity.properties.metadata.historicalTimeline;
  const previous=raw.lifetime;
  if(date.precision!=='date'||date.canonical!==value||!/^[0-9]{4}-/.test(value)||
    timeline?.entityId!==id||!previous?.validTo||value<previous.validTo||entry.validTo!==previous.validTo||
    ![chunk,entry,timeline].every(item=>isDeepStrictEqual(item.lifetime,previous))||
    raw.geometryVersions.some(version=>!version.validTo||version.validTo>previous.validTo))
   throw Error('Expected a source lifetime extension beyond fixed historical geometry: '+id);
  if(value===previous.validTo)return false;
  for(const item of [raw,chunk,entry,timeline])item.lifetime={...previous,validTo:value};
  entry.validTo=value;
  return true;
 }});
}

function buildBuiltinWorldSourcePublication({generation,read,updates,edit}) {
 if(!(updates instanceof Map)||!updates.size)throw Error('Explicit territorial source scope required');
 const rawRoot=generation.source('territorialSourceRoot');
 const sourceIndexPath=generation.source('territorialSourceIndex');
 const sourceRoot=path.posix.dirname(sourceIndexPath);
 const builtinIndexPath=generation.catalogs.territorial;
 const builtinRoot=path.posix.dirname(builtinIndexPath);
 const source=JSON.parse(read(sourceIndexPath));
 const before=JSON.parse(read(builtinIndexPath)),index=structuredClone(before);
 const files=new Map(),builtinFiles=new Map(),countries=[];
 const children=new Set(before.readIndex.records.parentRelations.filter(row=>row.parentId).map(row=>row.objectRef.id));
 const revisions=index.inputHashes.sourceRevisions;
 for(const [id,value] of updates){
  const matches=before.sourceIdentities.filter(row=>row.sourceEntityIds.includes(id));
  const match=matches[0],projectId=match?.projectEntityId;
  if(matches.length!==1||match.sourceEntityIds.length!==1)
   throw Error('Expected one known territorial source: '+id);
  const rawPath=rawRoot+'/countries/'+entityFileName(id);
  const entry=source.entities.find(row=>row.entityId===id);
  const builtin=before.entities.find(row=>row.entityId===projectId);
  if(!entry||!builtin||revisions[id]!==entry.sha256)throw Error('Unpaired territorial source: '+id);
  const sourcePath=sourceRoot+'/'+entry.file;
  const sourceBytes=read(sourcePath);
  assertIndexedTerritorialChunk(entry,sourceBytes);
  const raw=JSON.parse(read(rawPath)),chunk=JSON.parse(gunzipSync(sourceBytes));
  const country=JSON.parse(gunzipSync(readBuiltinCountryStoredBytes(builtin,file=>read(builtinRoot+'/'+file))));
  if(raw.entityId!==id||chunk.entityId!==id||country.entityId!==projectId)
   throw Error('Territorial source file identity mismatch: '+id);
  const format=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
  if(!edit({id,value,raw,chunk,entry,country,isChild:children.has(projectId)}))continue;
  const decoded=format(chunk);
  const {stored}=selectTerritorialChunkBytes(decoded,sourceBytes);
  Object.assign(entry,{sha256:sha(stored),compressedBytes:stored.length,decodedBytes:decoded.length});
  revisions[id]=entry.sha256;
  files.set(rawPath,format(raw));
  files.set(sourcePath,stored);
  countries.push(country);
 }
 if(!countries.length)return files;
 index.inputHashes.entities=sha(JSON.stringify(revisions));
 encodeBuiltinCountries(index,countries,builtinFiles);
 finalizeBuiltinWorldFiles(index,builtinFiles,{previousIndex:before});
 if(!isDeepStrictEqual(index.geometryAssets,before.geometryAssets)||
   !isDeepStrictEqual(index.readIndex.records,before.readIndex.records))
   throw Error('Territorial source publication changed geometry or timeline records');
 files.set(sourceIndexPath,Buffer.from(JSON.stringify(source,null,2)+'\n'));
 for(const [path,bytes] of builtinFiles)files.set(builtinRoot+'/'+path,bytes);
 return files;
}

/** Extend an approved historical relationship only within the same admitted child and parent geometries. */
export function extendBuiltinParentWindows({generation,read,windows}) {
 if(!(windows instanceof Map)||!windows.size)throw Error('Explicit parent extension scope required');
 const policyPath=generation.source('historicalPolicy'),indexPath=generation.catalogs.territorial;
 const root=path.posix.dirname(indexPath),policy=JSON.parse(read(policyPath));
 const before=JSON.parse(read(indexPath)),index=structuredClone(before);
 if(sha(JSON.stringify(policy))!==before.inputHashes.policy)throw Error('Unpaired historical parent policy');
 const records=before.readIndex.records,validationIds=new Set(),countries=[];
 const projectId=id=>{
  const matches=before.sourceIdentities.filter(row=>row.sourceEntityIds.includes(id));
  if(matches.length!==1)throw Error('Unpaired historical parent identity: '+id);
  return matches[0].projectEntityId;
 };
 const step=(day,delta)=>new Date(Date.parse(day+'T00:00:00Z')+delta*86_400_000).toISOString().slice(0,10);
 for(const [sourceId,scope] of windows){
  const {validFrom,validTo}=scope;
  const rules=policy.parentRelations.filter(row=>row.entityId===sourceId);
  if(rules.length!==1)throw Error('Expected one approved parent policy: '+sourceId);
  const rule=rules[0],childId=projectId(sourceId),parentId=projectId(rule.parentEntityId);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(validFrom)||!/^\d{4}-\d{2}-\d{2}$/.test(validTo)||
    validFrom>rule.validFrom||validTo<rule.validTo)
   throw Error('Expected a bounded extension of the approved parent interval: '+sourceId);
  for(const id of [childId,parentId]){
   const bindings=records.geometryBindings.filter(row=>row.objectRef.id===id&&temporalIntervalsOverlap(row,scope));
   if(bindings.length!==1||bindings[0].validFrom>validFrom||(bindings[0].validTo&&bindings[0].validTo<validTo))
    throw Error('Parent extension crosses a geometry change: '+id);
   validationIds.add(id);
  }
  const entry=before.entities.find(row=>row.entityId===childId);
  const country=JSON.parse(gunzipSync(readBuiltinCountryStoredBytes(entry,file=>read(root+'/'+file))));
  const rows=country.timelineRecords.parentRelations;
  const anchor=rows.find(row=>row.validFrom===rule.validFrom&&row.validTo===rule.validTo&&row.parentId===parentId);
  if(!anchor||rows.some(row=>row!==anchor&&row.parentId&&temporalIntervalsOverlap(row,scope)))
   throw Error('Parent extension conflicts with existing history: '+childId);
  country.timelineRecords.parentRelations=rows.filter(row=>row!==anchor).flatMap(row=>{
   if(!temporalIntervalsOverlap(row,scope))return [row];
   const retained=[];
   if(!row.validFrom||row.validFrom<validFrom)retained.push({...row,validTo:step(validFrom,-1)});
   if(!row.validTo||row.validTo>validTo)retained.push({...row,validFrom:step(validTo,1)});
   return retained;
  }).concat({...anchor,validFrom,validTo}).sort((a,b)=>(a.validFrom??'').localeCompare(b.validFrom??'','en'));
  Object.assign(rule,{validFrom,validTo});
  rule.basis.scope='Extension within the existing, unchanged Viewer geometry bindings of the child and parent. Geometry and source validity remain unchanged.';
  countries.push(country);
 }
 index.inputHashes.policy=sha(JSON.stringify(policy));
 const files=finalizeBuiltinWorldFiles(index,encodeBuiltinCountries(index,countries,new Map()),{previousIndex:before});
 const next=index.readIndex.records;
 for(const table of ['lifetimes','geometryBindings','propertyBindings'])
  if(!isDeepStrictEqual(next[table],records[table]))throw Error('Parent extension changed an unrelated timeline table: '+table);
 if(!isDeepStrictEqual(index.geometryAssets,before.geometryAssets))throw Error('Parent extension changed geometry assets');
 const scoped=Object.fromEntries(Object.entries(next).map(([name,rows])=>[name,Array.isArray(rows)?
  rows.filter(row=>validationIds.has(row.objectRef.id)):rows]));
 const geometryKeys=new Set(index.geometryAssets.map(({id,version})=>JSON.stringify([id,version])));
 normalizeTimelineRecords(scoped,{
  entities:index.readIndex.identities.filter(row=>validationIds.has(row.id))
   .map(row=>({objectRef:{domain:'territorial',id:row.id},entityKind:row.properties.entityKind})),
  geometryExists:ref=>geometryKeys.has(JSON.stringify([ref.id,ref.version])),
 });
 return new Map([[policyPath,Buffer.from(JSON.stringify(policy,null,2)+'\n')],
  ...[...files].map(([file,bytes])=>[root+'/'+file,bytes])]);
}

/** Remove an explicitly disproven current identity without altering any surviving
 * country. Source updates already staged elsewhere remain uncompiled revisions. */
export function buildBuiltinWorldRetirementPublication({retirement,sourceIndex,previousSourceIndex,view,policy,
 previousIndex,previousCoverage,displayPolicy=loadBuiltinDisplayPolicy(),readRecovery}){
 const plan=assertTerritorialRetirement({manifest:retirement,previousIndex:previousSourceIndex,index:sourceIndex,displayPolicy,readRecovery});
 if(JSON.stringify(view)!==JSON.stringify(plan.index.views[0]))throw Error('Territorial retirement: unpaired world view');
 if(plan.mixed){const built=mixedRetirementPublicationPlan(plan,{readRecovery}),{index,coverage,files}=built,revisions={...previousIndex.inputHashes.sourceRevisions};for(const id of plan.sourceIds)delete revisions[id];for(const [id,row]of plan.metadataUpdates)revisions[id]=row.nextEntry.sha256;recordBuiltinWorldInputs(index,revisions,view,policy);files.set('coverage-report.json',Buffer.from(JSON.stringify(coverage)+'\n'));finalizeBuiltinWorldFiles(index,files,{previousIndex});assertBuiltinRetirement({plan,previousSourceIndex,sourceIndex,previousIndex,index,previousCoverage,coverage,policy,readRecovery,readDescriptor:entry=>JSON.parse(gunzipSync(readBuiltinCountryStoredBytes(entry,file=>files.get(file))))});return rememberRetirementPublication(files,{retirement,sourceIndex,previousSourceIndex,view,policy,displayPolicy});}
 const retired=new Set([...plan.featureIds].map(builtinSubunitId));
 const index=structuredClone(previousIndex),coverage=structuredClone(previousCoverage);
 index.entities=index.entities.filter(row=>!retired.has(row.entityId));
 const retainedGeometry=new Set(index.entities.flatMap(row=>row.geometryRefs.map(ref=>JSON.stringify([ref.id,ref.version]))));
 index.geometryAssets=index.geometryAssets.filter(asset=>retainedGeometry.has(JSON.stringify([asset.id,asset.version])));
 index.sourceIdentities=index.sourceIdentities.filter(row=>!retired.has(row.projectEntityId));
 coverage.entities=coverage.entities.filter(row=>!retired.has(row.entityId));
 const revisions={...previousIndex.inputHashes.sourceRevisions};for(const id of plan.sourceIds)delete revisions[id];
 recordBuiltinWorldInputs(index,revisions,view,policy);
 const files=new Map([['coverage-report.json',Buffer.from(JSON.stringify(coverage)+'\n')]]);
 finalizeBuiltinWorldFiles(index,files,{previousIndex});
 assertBuiltinRetirement({plan,previousSourceIndex,sourceIndex,previousIndex,index,previousCoverage,coverage,policy});
 return rememberRetirementPublication(files,{retirement,sourceIndex,previousSourceIndex,view,policy,displayPolicy});
}

export function writeBuiltinWorldPublication(files,directory=output,{check=false,readPreviousCountry,retirementInputs=null,
 currentWorldTarget=path.join(territorialDataRoot,'generated/current-world.geojson'),
 displayPolicyTarget=fileURLToPath(new URL('../../assets/data/builtin-world/display-policy-v1.json',import.meta.url))}={}){
 // The index becomes visible only after the emitted payloads and diagnostics.
 // Deltas overlay an existing verified publication; old pinned assets are retained.
 const entries=[...files].filter(([file])=>file!=='index.json');
 if(files.has('index.json'))entries.push(['index.json',files.get('index.json')]);
 let verifiedMixedIds=new Set();
 const changed=[];
 for(const [file,bytes] of entries){
  const target=path.join(directory,file);
  if(fs.existsSync(target)&&fs.readFileSync(target).equals(bytes))continue;
  changed.push({target,bytes});
 }
 if(!files.has('index.json')&&[...files.keys()].some(file=>file.startsWith('countries/')||file.startsWith('country-parts/')))throw Error('Historical country publication requires its paired index');
 if(files.has('index.json')){
  const next=JSON.parse(files.get('index.json')),priorPath=path.join(directory,'index.json'),prior=fs.existsSync(priorPath)?JSON.parse(fs.readFileSync(priorPath)):{entities:[]},old=new Map(prior.entities.map(e=>[e.entityId,e]));
  if(prior.entities.some(entry=>!next.entities.some(row=>row.entityId===entry.entityId))&&!retirementInputs)throw Error('Territorial retirement requires an explicit paired publication manifest');
  if(retirementInputs){
   const {retirement,sourceIndex,previousSourceIndex,view,policy,displayPolicy=loadBuiltinDisplayPolicy(),readRecovery}=retirementInputs;
   const proof=retirementPublications.get(files);
   if(!proof||proof.input!==retirementInputDigest({...retirementInputs,displayPolicy})||proof.files.size!==files.size
    ||[...files].some(([file,bytes])=>proof.files.get(file)!==sha(bytes)))throw Error('Territorial retirement requires unchanged canonical producer output');
   const plan=assertTerritorialRetirement({manifest:retirement,previousIndex:previousSourceIndex,index:sourceIndex,displayPolicy,readRecovery});
   if(!isDeepStrictEqual(prior,plan.previousBuiltinIndex)&&!isDeepStrictEqual(prior,next))throw Error('Territorial retirement: active compiled baseline changed');
   const activeCoverage=JSON.parse(fs.readFileSync(path.join(directory,'coverage-report.json')));
   if(!isDeepStrictEqual(activeCoverage,isDeepStrictEqual(prior,plan.previousBuiltinIndex)?plan.previousCoverage:JSON.parse(files.get('coverage-report.json'))))throw Error('Territorial retirement: active coverage baseline changed');
   if(isDeepStrictEqual(prior,plan.previousBuiltinIndex)&&(!fs.existsSync(currentWorldTarget)||!fs.readFileSync(currentWorldTarget).equals(readRetirementReceipt(retirement.previousCurrentWorld,readRecovery))))throw Error('Territorial retirement: active current-world baseline changed');
   const policyBytes=Buffer.from(JSON.stringify(displayPolicy,null,2)+'\n');
   const activePolicy=fs.readFileSync(displayPolicyTarget);
   if(!activePolicy.equals(isDeepStrictEqual(prior,plan.previousBuiltinIndex)?readRetirementReceipt(retirement.displayPolicy,readRecovery):policyBytes))throw Error('Territorial retirement: active display-policy baseline changed');
   assertBuiltinRetirement({plan,previousSourceIndex,sourceIndex,previousIndex:plan.previousBuiltinIndex,index:next,
    previousCoverage:plan.previousCoverage,coverage:JSON.parse(files.get('coverage-report.json')),policy,
    readRecovery,readDescriptor:entry=>JSON.parse(gunzipSync(readBuiltinCountryStoredBytes(entry,file=>files.get(file)||fs.readFileSync(path.join(directory,file)))))});
   if(plan.mixed)verifiedMixedIds=new Set(plan.verifiedRuntimeCountries.keys());
   const sources=new Map(sourceIndex.entities.map(row=>[row.entityId,row]));
   if(!plan.mixed)for(const row of view.selections)if(next.inputHashes.sourceRevisions[row.entityId]!==sources.get(row.entityId)?.sha256)throw Error('Territorial retirement: current-world input remains uncompiled: '+row.entityId);
   const read=retirementInputs.readSource|| (id=>readTerritorialSource(id,territorialSourceRoot,{sourceIndex}));
   const world=plan.mixed?verifiedMixedCurrentWorld(plan,{readRecovery}):buildCurrentWorld({entities:view.selections.map(row=>read(row.entityId)),view});
   const bytes=Buffer.from(JSON.stringify(world)+'\n');
   for(const candidate of [{target:currentWorldTarget,bytes},{target:displayPolicyTarget,bytes:policyBytes}])if(!fs.existsSync(candidate.target)||!fs.readFileSync(candidate.target).equals(candidate.bytes)){
    const at=changed.findIndex(row=>row.target===path.join(directory,'index.json'));
    changed.splice(at<0?changed.length:at,0,candidate);
   }
  }
  for(const entry of next.entities){const before=old.get(entry.entityId);if(before?.sha256===entry.sha256||verifiedMixedIds.has(entry.entityId))continue;const read=entry=>readBuiltinCountry(entry,next,file=>files.get(file)||fs.readFileSync(path.join(directory,file))),readOld=entry=>readPreviousCountry?readPreviousCountry(entry,prior,file=>fs.readFileSync(path.join(directory,file))):readBuiltinCountry(entry,prior,file=>fs.readFileSync(path.join(directory,file)));assertHistoricalCompiledChanges(read(entry),before?readOld(before):null);}
 }
 if(check){if(changed.length)throw new Error(`Stale builtin world data: ${changed[0].target}`);return;}
 if(!changed.length)return;
 return withLibraryOutputs({paths:changed.map(({target})=>target)},()=>{
  // The old index remains the activation marker until the complete candidate is
  // ready. A failed write restores every changed target, including the projection.
  const backups=new Map(changed.map(({target})=>[target,fs.existsSync(target)?fs.readFileSync(target):null])),written=[];
  try{
   for(const {target,bytes} of changed){fs.mkdirSync(path.dirname(target),{recursive:true});written.push(target);fs.writeFileSync(target,bytes);}
  }catch(error){
   const failures=[];
   for(const target of written.reverse())try{const bytes=backups.get(target);if(bytes===null){if(fs.existsSync(target))fs.unlinkSync(target);}else fs.writeFileSync(target,bytes);}catch(cause){failures.push(new Error('Publication recovery failed: '+target,{cause}));}
   if(failures.length)throw new AggregateError([error,...failures],'Builtin publication failed; recovery is incomplete',{cause:error});
   throw error;
  }
 });
}
async function main(){
 const projectId=process.argv.find(arg=>arg.startsWith('--project='))?.slice(10)||'default-world';
 const root=fileURLToPath(new URL('../../',import.meta.url));
 const generation=readProjectGenerationContext({root,projectId});
 const arg=name=>process.argv.find(value=>value.startsWith(name+'='))?.slice(name.length+1);
 const selected=arg('--entities'),retirementFile=arg('--retirement-manifest');
 const namesOnly=process.argv.includes('--names-only'),planOnly=process.argv.includes('--plan'),check=process.argv.includes('--check');
 if(process.argv.includes('--pack-existing'))throw Error('--pack-existing is retired; use reviewed country-scoped generation');
 if(projectId!=='default-world'&&retirementFile)throw Error('Territorial retirement requires a project-paired archive and source retirement manifest');
 if(namesOnly&&!selected)throw Error('--names-only requires --entities');
 if(retirementFile&&(namesOnly||selected||planOnly))throw Error('Use the dedicated retirement manifest without partial geometry or naming options');
 if(planOnly&&(!selected||namesOnly||check))throw Error('--plan requires a reviewed geometry scope');
 if(selected&&!namesOnly){
  const checkout=libraryCheckout(root),sourceRevision=git(root,['rev-parse','HEAD']);
  const pinned=JSON.parse(git(root,['show',sourceRevision+':config/library-data.json'])).revision;
  const baseline=arg('--baseline')||pinned,evidenceRevision=arg('--evidence-revision')||git(checkout,['rev-parse','HEAD']);
  const reviewPaths=process.argv.filter(value=>value.startsWith('--review=')).map(value=>value.slice('--review='.length));
  if(!/^[a-f0-9]{40}$/.test(baseline)||!/^[a-f0-9]{40}$/.test(evidenceRevision)||!reviewPaths.length||reviewPaths.some(p=>!p))
   throw Error('Scoped geometry requires --review=<archived review path> and immutable data revisions');
  if(!planOnly&&!check&&baseline!==pinned)throw Error('Reviewed edition baseline differs from the committed application pin');
  const archive=revision=>JSON.parse(git(checkout,['show',revision+':archive/index.json']));
  const old=archive(baseline),evidence=archive(evidenceRevision);
  const reader=(index,revision)=>p=>{
   const entry=index.files[p];
   if(!entry)throw Error('Missing archived reviewed input: '+p);
   return decodeArchiveEntry(checkout,entry,revision);
  };
  const editRoot=process.argv.includes('--review-working')?libraryReportEditRoot(root):null;
  const reviewFolders=reviewPaths.map(p=>p.slice(0,p.lastIndexOf('/')+1));
  const workingReports=new Map();
  const readEvidence=p=>{
   if(evidence.files[p])return reader(evidence,evidenceRevision)(p);
   if(old.files[p])return reader(old,baseline)(p);
   if(!editRoot||!p.startsWith('reports/borders/validation/')||!reviewFolders.includes(p.slice(0,p.lastIndexOf('/')+1)))
    throw Error('Missing archived reviewed input: '+p);
   if(!workingReports.has(p))workingReports.set(p,fs.readFileSync(checkedReportPath(editRoot,p.slice('reports/'.length))));
   return workingReports.get(p);
  };
  const receipts=reviewPaths.map(reference=>({reference,sha256:sha(readEvidence(reference))}));
  const inputs={baseline,entityIds:selected.split(','),
   readBaseline:reader(old,baseline),readEvidence,
   sourceRoot:generation.source('territorialSourceRoot'),sourceIndexPath:generation.source('territorialSourceIndex'),
   builtinIndexPath:generation.catalogs.territorial,policyPath:generation.source('historicalPolicy')};
  const result=receipts.length===1?buildReviewedBorderEdition({...inputs,receipt:receipts[0]}):buildReviewedBorderBatch({...inputs,receipts});
  if(planOnly){console.log(JSON.stringify(result.plan,null,2));return;}
  if(check){
   const actual=archive(pinned);
   for(const [p,bytes] of result.files)if(actual.files[p]?.sha256!==sha(bytes)||actual.files[p].bytes!==bytes.length)
     throw Error('Stale scoped Viewer asset: '+p);
   for(const [p,hash] of Object.entries(result.reports))if(actual.files[p]?.sha256!==hash)throw Error('Missing paired review: '+p);
   console.log('Verified reviewed Viewer edition '+pinned);return;
  }
  const {storeReviewedBorderEdition}=await import('../data/library-store.mjs');
  console.log(JSON.stringify(await storeReviewedBorderEdition({root,result,evidenceRevision,sourceRevision,workingReports}),null,2));
  return;
 }
 const sourceRoot=path.resolve(root,generation.source('territorialSourceRoot'));
 const sourceIndexPath=generation.source('territorialSourceIndex');
 const sourceIndexAbsolute=path.resolve(root,sourceIndexPath);
 const output=path.dirname(path.resolve(root,generation.catalogs.territorial));
 const readInput=role=>JSON.parse(readLibraryDataFile(generation.source(role),{root}));
 const selectedView=namesOnly?null:readInput('worldView');
 const selectedPolicy=namesOnly?null:readInput('historicalPolicy');
 const selectedDisplayPolicy=namesOnly?null:readInput('displayPolicy');
 const formalNames=loadFormalNamesForProject(generation);
 const selectedRead=id=>readTerritorialSource(id,sourceRoot,{sourceIndex,
  chunkRoot:path.dirname(sourceIndexAbsolute)});
 const sourceIndex=readInput('territorialSourceIndex');
 const priorCatalogPath=path.join(output,'index.json');
 const index=(selected||retirementFile||fs.existsSync(priorCatalogPath))
   ?JSON.parse(fs.readFileSync(priorCatalogPath)):null;
 let files,retirementInputs=null;
 if(retirementFile){
  const retirement=JSON.parse(fs.readFileSync(retirementFile));
  retirementInputs={retirement,sourceIndex,previousSourceIndex:JSON.parse(fs.readFileSync(retirement.previousIndex.path)),
   view:JSON.parse(fs.readFileSync(path.join(territorialSourceRoot,'views/world.json'))),
   policy:JSON.parse(fs.readFileSync(new URL('../../assets/data/historical-world/policy.json',import.meta.url))),displayPolicy:planTerritorialRetirement(retirement,JSON.parse(readRetirementReceipt(retirement.previousIndex))).displayPolicy};
  const input={...retirementInputs,formalNames,previousIndex:JSON.parse(readRetirementReceipt(retirement.previousBuiltinIndex)),previousCoverage:JSON.parse(readRetirementReceipt(retirement.previousCoverage))};
  files=buildBuiltinWorldRetirementPublication(input);
 }else if(namesOnly){
   const ids=selected.split(',').filter(Boolean);
   const root=fileURLToPath(new URL("../../",import.meta.url)),config=libraryConfig(root),checkout=libraryCheckout(root);
   const archive=JSON.parse(execFileSync('git',['-c','maintenance.auto=false','-c','gc.auto=0','show',`${config.revision}:archive/index.json`],{cwd:checkout,maxBuffer:16*1024*1024}));
   files=buildBuiltinWorldNamePublication({entityIds:ids,sourceIndex,previousIndex:index,readSource:selectedRead,formalNames,readCountry:file=>fs.readFileSync(path.join(output,file)),
    readPreviousSource:id=>normalizeTerritorialLibraryEntity(decodeTerritorialSource(JSON.parse(decodeArchiveEntry(checkout,archive.files[`${generation.source('territorialSourceRoot')}/countries/${entityFileName(id)}`],config.revision)),file=>decodeArchiveEntry(checkout,archive.files[generation.source('territorialSourceRoot')+'/'+file],config.revision)))});
   console.log(`Name-only generation: ${ids.length} selected source; geometry and coverage reused without recomputation.`);
 }else files=buildBuiltinWorldPublication({previousIndex:index,input:{sourceIndex,entities:readTerritorialSources(sourceRoot,{sourceIndex,chunkRoot:path.dirname(sourceIndexAbsolute)}),
   view:selectedView,policy:selectedPolicy,displayPolicy:selectedDisplayPolicy,formalNames}});
 writeBuiltinWorldPublication(files,output,{check,retirementInputs});
 console.log(`Builtin world: ${JSON.parse(files.get('index.json')).entities.length} country references; ${[...files.keys()].filter(file=>file.startsWith('countries/')||file.startsWith('country-parts/')).length} bounded files emitted; ${[...files.values()].reduce((n,b)=>n+b.length,0)} output bytes; no aggregate transport`);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
