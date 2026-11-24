import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {isAbsolute,posix,relative,resolve} from 'node:path';
import {parse} from 'yaml';
import {frontendModuleReferences} from './frontend-layout.mjs';

const vendorPath='assets/vendor/maplibre-gl/';
const vendorFiles=['maplibre-gl.mjs','maplibre-gl-worker.mjs','maplibre-gl-shared.mjs','maplibre-gl.css','LICENSE.txt'];
const dependencyPath='node_modules/maplibre-gl/';
const generator='scripts/lib/maplibre-vendor.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const moduleUrl=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');

export function performanceMapLibreIdentity(assets,read=(entry)=>entry){
 const result={};
 for(const [name,file] of [['module','maplibre-gl.mjs'],['worker','maplibre-gl-worker.mjs']]){
  const entry=assets.get(vendorPath+file);
  if(!entry)throw Error('Missing performance MapLibre asset: '+file);
  result[name]=digest(read(entry));
 }
 return result;
}

function lockedPackage(read){
 const version=JSON.parse(read('package.json')).dependencies?.['maplibre-gl'];
 const lock=parse(read('pnpm-lock.yaml').toString());
 const entry=lock.importers?.['.']?.dependencies?.['maplibre-gl'];
 const resolution=lock.packages?.['maplibre-gl@'+entry?.version]?.resolution;
 if(typeof version!=='string'||entry?.version!==version||entry?.specifier!==version||!resolution?.integrity)
  throw Error('Performance snapshots require a pinned MapLibre package integrity');
 return {version,integrity:resolution.integrity};
}

async function runHistoricalGenerator(root,read){
 const key='pando-performance-maplibre-'+randomUUID(),scope=Symbol.for(key);
 globalThis[scope]={readFileSync(filename,encoding){
  const path=relative(root,resolve(filename)).replaceAll('\\','/');
  if(!path||isAbsolute(path)||path.startsWith('../'))throw Error('Historical MapLibre generator read outside its source root');
  const bytes=path.startsWith(dependencyPath)?readFileSync(resolve(root,path)):read(path);
  return encoding?bytes.toString(encoding):bytes;
 }};
 const filesystem=moduleUrl(`export const {readFileSync}=globalThis[Symbol.for(${JSON.stringify(key)})];`);
 const urls=new Map(),active=new Set();
 function sourceUrl(path){
  if(urls.has(path))return urls.get(path);
  if(active.has(path))throw Error('Cyclic historical MapLibre generator dependency: '+path);
  active.add(path);
  let source=read(path).toString('utf8');
  // Rebind imports only. Bundling the module would rewrite functions whose
  // literal toString() output is embedded in the generated vendor distribution.
  for(const ref of frontendModuleReferences(source).sort((a,b)=>b.start-a.start)){
   let url;
   if(ref.kind!=='import'||ref.template)throw Error('Unsupported historical MapLibre generator reference in '+path);
   if(ref.specifier==='node:fs')url=filesystem;
   else if(ref.specifier.startsWith('node:'))continue;
   else if(ref.specifier.startsWith('.')){
    const next=posix.normalize(posix.join(posix.dirname(path),ref.specifier));
    if(next.startsWith('../')||!next.endsWith('.mjs'))throw Error('Invalid historical MapLibre generator import: '+ref.specifier);
    url=sourceUrl(next);
   }else throw Error('Non-pinned historical MapLibre generator import: '+ref.specifier);
   source=source.slice(0,ref.start)+JSON.stringify(url)+source.slice(ref.end);
  }
  const url=moduleUrl(source);
  active.delete(path);urls.set(path,url);return url;
 }
 try{
  const {mapLibreVendorAssets}=await import(sourceUrl(generator));
  return mapLibreVendorAssets(root);
 }finally{delete globalThis[scope];}
}

function verifiedVendorArtifact({commit,pin,readArtifact,readReceipt}){
 const evidence=JSON.parse(readReceipt()),proof=evidence.deploymentIdentity;
 if(evidence.schema!=='pando-web-pages-staging'||evidence.productMode!=='viewer'||evidence.sourceCommit!==commit||
    evidence.dataCommit!==pin.revision||evidence.dataRepository!==pin.repository||!Array.isArray(evidence.files)||
    proof?.schema!=='pando-p2-deploy-identity-v1'||proof.verified!==true||proof.sourceCommit!==commit||
    proof.dataCommit!==pin.revision||!/^[a-f0-9]{64}$/.test(evidence.frontendInputSha256||'')||
    proof.frontendInputSha256!==evidence.frontendInputSha256)
  throw Error('MapLibre artifact evidence does not match the baseline source and data');
 return new Map(vendorFiles.map(file=>{
  const path=vendorPath+file,files=evidence.files.filter(entry=>entry.path===path),bytes=readArtifact(path);
  if(files.length!==1||files[0].bytes!==bytes.length||files[0].sha256!==digest(bytes))
   throw Error('MapLibre baseline artifact hash mismatch: '+path);
  return [path,bytes];
 }));
}

export async function historicalPerformanceMapLibreAssets({root,commit,readBaseline,artifactRoot,receiptPath}){
 const readCurrent=path=>readFileSync(resolve(root,path));
 const baseline=lockedPackage(readBaseline),current=lockedPackage(readCurrent);
 const installed=JSON.parse(readCurrent(dependencyPath+'package.json')).version;
 if(baseline.version===current.version&&baseline.integrity===current.integrity&&installed===baseline.version)
  return runHistoricalGenerator(root,readBaseline);
 if(!artifactRoot||!receiptPath)
  throw Error('MapLibre baseline distribution differs. Supply the verified Pages artifact with PANDO_PERF_MAPLIBRE_ARTIFACT and PANDO_PERF_MAPLIBRE_RECEIPT.');
 return verifiedVendorArtifact({commit,pin:JSON.parse(readBaseline('config/library-data.json')),
  readArtifact:path=>readFileSync(resolve(artifactRoot,path)),readReceipt:()=>readFileSync(receiptPath)});
}
