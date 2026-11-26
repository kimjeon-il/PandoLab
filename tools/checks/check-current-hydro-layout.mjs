#!/usr/bin/env node
// Read-only validation of the current Web hydro package and shared format.
import {libraryMaterializedRoot} from "../data/library-context.mjs";
import {decodeHydroIndex,decodeHydroMetadata} from '../../src/data/hydro-pack.js';
import {mapProjectManifestSourcePath,mapProjectResourcePath,validateMapProjectManifest} from '../../src/data/map-project-manifest.js';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,lstatSync,realpathSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';

const DATA='assets/data/hydro';
// These releases were explicitly retired from the deployed runtime. This list
// is a retirement policy, not a declaration of the current release or shard count.
const RETIRED=['v0.13.0','v0.13.1'];
const ensure=(ok,message)=>{if(!ok)throw Error(message);};
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
const validHash=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
function inside(root,path) {
  ensure(typeof path==='string'&&path&&!path.includes('\\')&&!isAbsolute(path),'Unsafe hydro path: '+path);
  const full=resolve(root,path),rel=relative(resolve(root),full);
  ensure(rel&&rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel),'Unsafe hydro path: '+path);
  let cursor=full;
  while(cursor!==resolve(root)){
    if(existsSync(cursor)&&lstatSync(cursor).isSymbolicLink()){
      const logical=relative(resolve(root),cursor).replaceAll('\\','/');
      const configPath=resolve(root,'config/library-data.json');
      const pin=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')).revision:null;
      const allowed=pin&&resolve(libraryMaterializedRoot(root),'assets/data');
      ensure(logical==='assets/data'&&allowed&&realpathSync(cursor)===realpathSync(allowed),
        'Hydro symlink: '+path);
    }
    cursor=dirname(cursor);
  }
  return full;
}

export function manifestRoles(manifest) {
  ensure(manifest&&typeof manifest.version==='string'&&typeof manifest.schema==='string','Missing hydro identity');
  ensure(manifest.schema==='pandolab-water-shards-v5','Invalid current hydro schema');
  const container=manifest.container;
  ensure(container&&typeof container.url==='string'&&container.url&&
    Number.isSafeInteger(container.bytes)&&container.bytes>0&&validHash(container.sha256),'Invalid hydro container');
  inside('/hydro-audit-root',container.url);
  ensure(Array.isArray(manifest.shards)&&manifest.metadata?.core&&manifest.metadata?.detail,'Missing hydro subresource declarations');
  const ids=new Set();
  for(const shard of manifest.shards){ensure(Number.isSafeInteger(shard.id)&&shard.id>=0&&!ids.has(shard.id),'Invalid or duplicate hydro shard id');ids.add(shard.id);}
  const source=[['index',manifest.index],['metadata-core',manifest.metadata.core],['metadata-detail',manifest.metadata.detail],
    ...manifest.shards.map(shard=>['shard-'+shard.id,shard])].sort((a,b)=>a[1]?.offset-b[1]?.offset);
  let position=0;
  const segments=source.map(([role,spec])=>{
    ensure(spec&&spec.url===container.url&&spec.offset===position&&
      Number.isSafeInteger(spec.bytes)&&spec.bytes>0&&spec.bytes<=container.bytes-position&&validHash(spec.sha256),
      'Invalid, overlapping or missing hydro subresource: '+role);
    const segment={role,offset:position,bytes:spec.bytes,sha256:spec.sha256};position+=spec.bytes;return segment;
  });
  ensure(position===container.bytes,'Hydro container has uncovered bytes');
  ensure(JSON.stringify(container.roles)===JSON.stringify(segments.map(s=>s.role)),'Declared hydro role order differs from byte ranges');
  return segments;
}
function listFiles(dir,root=dir) {
  if(!existsSync(dir))return [];
  const st=lstatSync(dir);ensure(st.isDirectory()&&!st.isSymbolicLink(),'Hydro directory is not plain');
  const rows=[];
  for(const d of readdirSync(dir,{withFileTypes:true})){
    const full=join(dir,d.name);ensure(d.isDirectory()||d.isFile(),'Hydro symlink or special file: '+full);
    if(d.isDirectory())rows.push(...listFiles(full,root));else rows.push(relative(root,full).replaceAll('\\','/'));
  }
  return rows.sort();
}
export function verifyPackedIndex(manifest,packed){
  const section=spec=>gunzipSync(packed.subarray(spec.offset,spec.offset+spec.bytes));
  const logicalPacks=new Map();
  const {packSpecs}=decodeHydroIndex(section(manifest.index),{logicalPacks});
  const metadata=decodeHydroMetadata(section(manifest.metadata.core));
  const detail=JSON.parse(section(manifest.metadata.detail));
  ensure(detail?.version===5&&Array.isArray(detail.features),'Invalid hydro detail metadata');
  ensure(detail.features.length===metadata.size&&new Set(detail.features.map(row=>row.fid)).size===metadata.size
    &&detail.features.every(row=>metadata.has(row.fid)),'Hydro detail identities differ from core');
  const shards=new Map(manifest.shards.map(spec=>[spec.id,spec]));
  for(const spec of packSpecs.values()){
    const shard=shards.get(spec.shard);
    ensure(shard&&spec.length>0&&spec.offset+spec.length<=shard.bytes,'Hydro pack outside shard');
  }
  for(const ids of logicalPacks.values())ensure(ids.every(id=>packSpecs.has(id)),'Missing logical Hydro pack');
  return {packs:packSpecs.size,features:metadata.size,logicalFeatures:logicalPacks.size};
}

export async function auditLayout(root,{allowRetired=false}={}) {
  root=resolve(root);
  const project=validateMapProjectManifest(JSON.parse(readFileSync(inside(root,mapProjectManifestSourcePath('default-world')),'utf8')));
  const webPath=mapProjectResourcePath(project,'rivers');
  const manifestPath=inside(root,webPath),dir=dirname(manifestPath);
  const manifestBuffer=readFileSync(manifestPath),manifest=JSON.parse(manifestBuffer);
  const roles=manifestRoles(manifest),packed=readFileSync(inside(dir,manifest.container.url));
  const current=listFiles(dir),declared=[relative(dir,manifestPath).replaceAll('\\','/'),manifest.container.url];
  const receiptNames=['independentHydronymReplacements','independentHydronymFollowup',
    'independentHydronymBulk'];
  for(const name of receiptNames){
    const evidence=manifest.sources?.[name];
    if(!evidence)continue;
    ensure(typeof evidence.file==='string'&&/^[\w.-]+\.json$/.test(evidence.file)
      &&validHash(evidence.sha256),'Invalid independent river-name source declaration '+name);
    ensure(!declared.includes(evidence.file),'Repeated independent source receipt '+name);
    const sourceBytes=readFileSync(inside(dir,evidence.file));
    ensure(hash(sourceBytes)===evidence.sha256,'Independent river-name source SHA-256 mismatch '+name);
    declared.push(evidence.file);
  }
  declared.sort();
  ensure(JSON.stringify(current)===JSON.stringify(declared),'Current hydro package contains missing or undeclared files');
  ensure(packed.length===manifest.container.bytes&&hash(packed)===manifest.container.sha256,'Hydro container byte count or SHA-256 differs');
  for(const segment of roles){
    const bytes=packed.subarray(segment.offset,segment.offset+segment.bytes);
    ensure(hash(bytes)===segment.sha256,'Hydro segment SHA-256 differs: '+segment.role);
    if(['index','metadata-core','metadata-detail'].includes(segment.role))ensure(gunzipSync(bytes).length>0,'Empty/invalid gzip: '+segment.role);
  }
  const old=RETIRED.filter(v=>resolve(root,DATA,v)!==dir).flatMap(v=>listFiles(join(root,DATA,v),join(root,DATA)));
  if(!allowRetired)ensure(old.length===0,'Retired production hydro files remain: '+old.slice(0,12).join(', '));
  const before=hash(packed),index=verifyPackedIndex(manifest,packed);
  ensure(hash(readFileSync(inside(dir,manifest.container.url)))===before,'Hydro audit mutated the package');
  return {schema:'pandolab-current-hydro-audit',version:3,passed:true,productionVersion:manifest.version,
    manifestPath:webPath,activeFiles:current.length,activeFilePaths:current,packedContainerBytes:packed.length,
    packedContainerSha256:hash(packed),manifestBytes:manifestBuffer.length,manifestSha256:hash(manifestBuffer),
    roles,previousFiles:old,previousFileCount:old.length,strictRetirement:!allowRetired,
    index,note:'Read-only manifest, exact bytes and shared Hydro format validation; no data generation.'};
}
const invoked=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(invoked)try{
  const argv=process.argv.slice(2),flags=new Map();ensure(argv.length%2===0,'Expected flag/value options');
  for(let i=0;i<argv.length;i+=2){ensure(['--root','--allow-retired','--out'].includes(argv[i])&&!flags.has(argv[i]),'Invalid argument '+argv[i]);flags.set(argv[i],argv[i+1]);}
  if(flags.has('--allow-retired'))ensure(['true','false'].includes(flags.get('--allow-retired')),'Invalid retirement option');
  const result=await auditLayout(flags.get('--root')||'.',{allowRetired:flags.get('--allow-retired')==='true'});
  if(flags.has('--out')){const out=resolve(flags.get('--out'));mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(result,null,2)+'\n');}
  console.log(JSON.stringify({passed:result.passed,productionVersion:result.productionVersion,retiredFiles:result.previousFileCount,
    segmentCount:result.roles.length,runtime:result.runtime},null,2));
}catch(error){console.error('Current hydro gate failed: '+(error.stack||error));process.exitCode=1;}
