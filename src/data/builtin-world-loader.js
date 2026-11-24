import {createStoredAssetLoader} from "./stored-asset-loader.js";
import {parseTemporal,temporalContains,temporalMonthEnd,normalizeTemporalInterval,sharedCalculationCore} from "../document/temporal.js";
 import {createBuiltinProjectSetup} from "../document/project-setup.js";
import {PROJECT_SCHEMA_VERSION} from "../runtime/version-contract.js";
import {resolveBuiltinGeometryPacks} from './builtin-geometry-pack-receipt.js';
import {createBuiltinAssetTasks} from './builtin-asset-tasks.js';

// The verified country catalog provides source coverage. The project retains
// every original temporal interval; C++ owns month-end selection.
const contains=(rows,date)=>rows.some(row=>temporalContains(row,date));
function validateBuiltinCatalog(index){
 if(index?.schema!=='pandolab-builtin-world'||index.schemaVersion!==2||!Array.isArray(index.entities))throw new Error('Invalid builtin country catalog');
}
function queryMonthEnd(month){
 const value=parseTemporal(month,{nullable:false});
 if(value.precision!=='month')throw new Error('A query month is required');
 return temporalMonthEnd(value);
}
const countriesAt=(index,date)=>index.entities.filter(entry=>contains(entry.coverage,date));
export function selectBuiltinCountries(index,month){
 validateBuiltinCatalog(index);
 return countriesAt(index,queryMonthEnd(month));
}
export function assembleBuiltinWorld(index,countries,month){
 validateBuiltinCatalog(index);
 queryMonthEnd(month);
 const expected=index.entities;
 const byId=new Map(countries.map(row=>[row.entityId,row]));
 if(byId.size!==countries.length||expected.length!==countries.length)throw new Error('Incomplete builtin country selection');
 if(index.template?.schemaVersion!==PROJECT_SCHEMA_VERSION
   ||index.template?.format!=='pandolab-project-state'
   ||Object.hasOwn(index.template,'projectSetup'))
   throw new Error('Invalid builtin project template');
 const project=structuredClone(index.template),geometries=new Map();
 project.territorialEntities=[];project.geometries=[];
 project.timelineRecords={schemaVersion:3,lifetimes:[],geometryBindings:[],parentRelations:[],propertyBindings:[]};
 for(const entry of expected){
  const country=byId.get(entry.entityId);
  if(country?.schemaVersion!==2||country.identity?.id!==entry.entityId)throw new Error('Builtin country identity mismatch');
  const identity=structuredClone(country.identity);
  if(identity.properties.metadata?.historicalTimeline)
   identity.properties.metadata.historicalTimeline.geometryBindings=structuredClone(country.sourceBindings);
  project.territorialEntities.push(identity);
  // Historical lifetimes, geometries, parents, names and flags remain dated.
  // Only the canonical C++ cursor selects an effective month.
  for(const name of ['lifetimes','geometryBindings','parentRelations','propertyBindings'])
   project.timelineRecords[name].push(...structuredClone(country.timelineRecords[name]));
  for(const geometry of country.geometries){
   const key=JSON.stringify([geometry.id,geometry.version]),existing=geometries.get(key);
   if(existing&&JSON.stringify(existing)!==JSON.stringify(geometry))throw new Error('Conflicting builtin geometry');
   geometries.set(key,geometry);
  }
 }
 const used=new Set(project.timelineRecords.geometryBindings.map(row=>JSON.stringify([row.geometryRef.id,row.geometryRef.version])));
 project.geometries=[...geometries].filter(([key])=>used.has(key)).map(([,value])=>value);
 project.projectSetup=createBuiltinProjectSetup(month);
 return project;
}
const geometryKey=ref=>JSON.stringify([ref.id,ref.version]);
export function resolveBuiltinWorldGeometry(index,read,month){
 const catalog=new Map(index.geometryAssets.map(asset=>[geometryKey(asset),asset]));
 const world=sharedCalculationCore.timelineResolveWorld(read.records,{
  entities:read.identities.map(row=>({objectRef:{domain:'territorial',id:row.id},entityKind:row.properties.entityKind})),
  geometryExists:ref=>catalog.has(geometryKey(ref)),
 },month);
 return world.entities.map(row=>({owner:row.objectRef.id,asset:catalog.get(geometryKey(row.geometryRef))}));
}

export function createBuiltinWorldLoader({manifestUrl,manifestSpec,dataRevision,startupGeometryPacks=null,assetRoot,fetchFn=globalThis.fetch,cacheStorage=globalThis.caches,geometryCacheBytes=64*1024*1024}){
 if(!manifestUrl||!manifestSpec?.sha256||!dataRevision)throw new Error('Builtin country catalog integrity metadata is required');
 const base=new URL(manifestUrl,globalThis.location?.href),assetTasks=createBuiltinAssetTasks();
 const memory=Number(globalThis.navigator?.deviceMemory),cores=Number(globalThis.navigator?.hardwareConcurrency);
 const readLimit=memory>0&&memory<=2?2:memory>0&&memory<=4||cores>0&&cores<=4?4:6;
 const assetOptions={dataRevision,fetchFn,cacheStorage,resolveUrl:spec=>new URL(spec.url,base).href};
 // The mutable catalog belongs to a revision. Content-hashed countries do not:
 // unchanged files must survive a newer catalog/data revision without refetching.
 const catalogs=createStoredAssetLoader(assetOptions);
 const assets=createStoredAssetLoader({...assetOptions,cachePolicy:'immutable'});
 let indexPromise,readMetadata,geometryAssetsByRef;
 if(!Number.isSafeInteger(geometryCacheBytes)||geometryCacheBytes<0)throw new RangeError('Invalid builtin geometry cache budget');
 const geometries=new Map(),pending=new Map(),geometryStates=new Map();
 let geometryBytes=0,geometryEvictions=0;
 function cachedGeometry(key){
  const entry=geometries.get(key);
  if(!entry)return undefined;
  geometries.delete(key);geometries.set(key,entry);
  return entry.source;
 }
 function rememberGeometry(asset,source){
  const key=asset.file,bytes=Math.max(asset.decodedBytes,source.length*2);
  const previous=geometries.get(key);
  if(previous){geometryBytes-=previous.bytes;geometries.delete(key);}
  if(bytes>geometryCacheBytes){geometryStates.delete(key);return source;}
  while(geometryBytes+bytes>geometryCacheBytes&&geometries.size){
   const oldest=geometries.keys().next().value;
   geometryBytes-=geometries.get(oldest).bytes;geometries.delete(oldest);
   geometryStates.delete(oldest);geometryEvictions++;
  }
  geometries.set(key,{source,bytes});geometryStates.set(key,'ready');geometryBytes+=bytes;
  return source;
 }
 let activeReads=0;
 const readQueue=[];
 async function limitedRead(operation){
  if(activeReads>=readLimit)await new Promise(resolve=>readQueue.push(resolve));else activeReads++;
  try{return await operation();}finally{if(readQueue.length)readQueue.shift()();else activeReads--;}
 }
 async function parseIndex(bytes){
  const value=await assetTasks.parseIndex(bytes);
  if(value.template?.schemaVersion!==PROJECT_SCHEMA_VERSION||value.template?.format!=='pandolab-project-state'
    ||Object.hasOwn(value.template,'projectSetup'))throw new Error('Invalid builtin world index');
  const read=value.readIndex;
  const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
  freeze(read);freeze(value.template);
  readMetadata={...value.template,territorialEntities:read.identities,timelineRecords:read.records,
    geometryResources:freeze(value.geometryAssets.map(({id,version,type,contentSha256,decodedBytes})=>({id,version,type,contentSha256,decodedBytes})))};
  for(const row of value.entities){
   if(!Array.isArray(row.coverage))throw new Error('Invalid builtin country coverage descriptor');
   for(const interval of row.coverage){
    if(!interval||!['validFrom','validTo'].every(key=>interval[key]===null||typeof interval[key]==='string'&&interval[key].trim()))throw new Error('Invalid builtin country coverage descriptor');
    normalizeTemporalInterval(interval.validFrom,interval.validTo);
   }
  }
  geometryAssetsByRef=new Map(value.geometryAssets.map(asset=>[geometryKey(asset),asset]));
  return value;
 }
 async function loadIndex(){
  if(!indexPromise)indexPromise=catalogs.loadAsset({...manifestSpec,url:base.href},'builtin-world','index','국가 자료 목록',parseIndex)
   .then(({value})=>value).catch(error=>{indexPromise=null;throw error;});
  return indexPromise;
 }
 async function loadGeometry(asset){
  const key=asset.file;
  if(geometries.has(key))return cachedGeometry(key);
  const existing=pending.get(key);
  if(existing)return (await existing)??loadGeometry(asset);
  geometryStates.set(key,'loading');
  const reading=limitedRead(()=>assets.loadAsset({...asset,url:asset.file},
   'builtin-world',asset.id,'국가 형상',buffer=>decodeGeometryContent(buffer,asset)))
   .then(({value})=>rememberGeometry(asset,value))
   .catch(error=>{geometryStates.set(key,'error');throw error;}).finally(()=>pending.delete(key));
  pending.set(key,reading);
  return reading;
 }
 async function decodeGeometryContent(buffer,asset){
  const digest=await globalThis.crypto.subtle.digest('SHA-256',buffer);
  const actual=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
  if(actual!==asset.contentSha256)throw Error('Builtin geometry content hash mismatch: '+asset.id);
  return new TextDecoder('utf-8',{fatal:true}).decode(buffer);
 }
 function loadPack({spec,members}){
  const missing=members.filter(({asset})=>!geometries.has(asset.file)&&!pending.has(asset.file));
  if(!missing.length)return;
  const done=limitedRead(()=>assets.loadStoredAsset({...spec,url:new URL(spec.url,assetRoot).href},
   'builtin-world',spec.sha256,'국가 형상 묶음',async buffer=>{
    const rows=new Array(missing.length);
    // Two bounded independent gzip members per pack; never launch all
    // members at once or abandon an in-flight decode on a sibling failure.
    let cursor=0,failed=false;
    const workers=Array.from({length:Math.min(readLimit<=2?1:2,missing.length)},async()=>{
     try{
      while(!failed&&cursor<missing.length){
       const i=cursor++,{asset,start,end}=missing[i];
       const {value}=await assets.decodeStoredAsset(buffer.slice(start,end),{...asset,maxDecodedBytes:asset.decodedBytes},
        'builtin-world',asset.id,'국가 형상',decoded=>decodeGeometryContent(decoded,asset));
       rows[i]={asset,value};
      }
     }catch(error){failed=true;throw error;}
    });
    const settled=await Promise.allSettled(workers);
    const failure=settled.find(row=>row.status==='rejected');
    if(failure)throw failure.reason;
    return rows;
   })).then(({value})=>{
    return new Map(value.map(({asset,value:source})=>[asset.file,rememberGeometry(asset,source)]));
   }).catch(()=>{
    // The individual catalog assets remain the recovery path for this group.
    for(const {asset} of missing)geometryStates.delete(asset.file);
   }).finally(()=>{for(const {asset} of missing)pending.delete(asset.file);});
  for(const {asset} of missing){
   pending.set(asset.file,done.then(values=>values?.get(asset.file)));
   geometryStates.set(asset.file,'loading');
  }
  return done;
 }
 async function loadGeometryResources(requirements,{isCurrent=()=>true}={}){
  await loadIndex();
  const rows=new Array(requirements.length);let cursor=0,failed=false;
  const workers=Array.from({length:Math.min(readLimit,requirements.length)},async()=>{
   try{
    while(!failed&&cursor<requirements.length){
     if(!isCurrent())throw Object.assign(Error('Builtin geometry request superseded'),{name:'AbortError',cancelled:true});
     const i=cursor++,requirement=requirements[i],asset=geometryAssetsByRef.get(geometryKey(requirement));
     if(!asset||['type','contentSha256','decodedBytes'].some(key=>asset[key]!==requirement[key]))throw Error('Builtin geometry requirement does not match pinned catalog');
     rows[i]={id:asset.id,version:asset.version,source:await loadGeometry(asset)};
    }
   }catch(error){failed=true;throw error;}
  });
  const completed=await Promise.allSettled(workers),failure=completed.find(row=>row.status==='rejected');
  if(failure)throw failure.reason;
  if(!isCurrent())throw Object.assign(Error('Builtin geometry request superseded'),{name:'AbortError',cancelled:true});
  return rows;
 }
 async function geometryState(ref){
  await loadIndex();
  const asset=geometryAssetsByRef.get(geometryKey(ref));
  if(!asset)throw Error('Unknown builtin geometry reference');
  return geometryStates.get(asset.file)||'unloaded';
 }
 async function loadProject(month,{isCurrent=()=>true,concurrency=6,waitForIdle=null}={}){
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>6)throw new RangeError('Builtin country read concurrency must be 1-6.');
  const assertCurrent=()=>{if(!isCurrent())throw Object.assign(new Error('Builtin query superseded'),{name:'AbortError',cancelled:true});};
  assertCurrent();
  const index=await loadIndex();assertCurrent();
  async function loadAll(selected,read){
  let next=0,failed=false;
  const workers=Array.from({length:Math.min(concurrency,selected.length)},async()=>{
   try{
    while(!failed&&next<selected.length){
     assertCurrent();
     if(waitForIdle){await waitForIdle();assertCurrent();}
     if(failed||next>=selected.length)break;
     const i=next++;await read(selected[i]);assertCurrent();
    }
   }catch(error){failed=true;throw error;}
  });
  try{await Promise.all(workers);}
  catch(error){
   // An immediate retry must not join another worker's still-pending failure.
   // Superseded queries do not wait: their shared reads may serve the next query.
   if(error?.name!=='AbortError')await Promise.allSettled(workers);
   throw error;
  }
  }
  // Published metadata is immutable. Only active geometry is loaded; no
  // country-document reconstruction or parallel runtime model is retained.
  queryMonthEnd(month);
  const project={...readMetadata,projectSetup:createBuiltinProjectSetup(month),geometries:[]};
  const required=new Map(resolveBuiltinWorldGeometry(index,index.readIndex,month).map(({asset})=>[geometryKey(asset),asset]));
  let packs=[];
  if(startupGeometryPacks&&startupGeometryPacks.catalogSha256===manifestSpec.sha256){
   try{packs=resolveBuiltinGeometryPacks(startupGeometryPacks,manifestSpec.sha256,index.geometryAssets);}
   catch{ /* An invalid acceleration receipt leaves individual assets available. */ }
  }
  const files=new Map([...required.values()].map(asset=>[asset.file,asset]));
  const eligible=packs.filter(pack=>pack.members.every(({asset})=>files.has(asset.file)));
  const packed=new Set(eligible.flatMap(pack=>pack.members.map(({asset})=>asset.file)));
  // The request owns its assembly independently of the bounded reusable
  // cache; a whole active world may itself exceed the cache budget.
  const resolved=new Map();
  for(const asset of files.values())if(geometries.has(asset.file))resolved.set(asset.file,cachedGeometry(asset.file));
  const readGeometry=async asset=>{resolved.set(asset.file,await loadGeometry(asset));};
  const reads=eligible.filter(pack=>pack.members.some(({asset})=>!resolved.has(asset.file))).map(pack=>async()=>{
   const values=await loadPack(pack);
   for(const [file,source] of values||[])resolved.set(file,source);
  });
  for(const asset of files.values())if(!packed.has(asset.file)&&!resolved.has(asset.file))reads.push(()=>readGeometry(asset));
  await loadAll(reads,read=>read());
  // A failed pack or a concurrent pack reader may leave individual members outstanding.
  const outstanding=[...files.values()].filter(asset=>!resolved.has(asset.file));
  await loadAll(outstanding,readGeometry);
  project.geometries=Array.from(required.values(),asset=>({id:asset.id,version:asset.version,source:resolved.get(asset.file)}));
  if(waitForIdle)await waitForIdle();
  assertCurrent();
  return {project,fingerprint:`${manifestSpec.sha256}:complete-timeline`};
 }
 return Object.freeze({loadIndex,loadProject,loadGeometryResources,geometryState,
  geometryCacheStats:()=>({bytes:geometryBytes,budget:geometryCacheBytes,entries:geometries.size,evictions:geometryEvictions})});
}
