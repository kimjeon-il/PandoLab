import {mkdirSync,writeFileSync,unlinkSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {buildFrontendIndex} from '../../scripts/lib/frontend-layout.mjs';
import {resolve,dirname} from 'node:path';
import {buildFrontendSnapshot} from '../../scripts/lib/frontend-build.mjs';
import {createBranchPreviewServer} from '../../scripts/branch-preview-server.mjs';
import {historicalPerformanceMapLibreAssets,performanceMapLibreIdentity} from '../../scripts/lib/performance-maplibre-assets.mjs';
import {libraryConfig,libraryCheckout,git,decodeArchiveEntries,decodeArchiveEntry,libraryRuntimeLeasePath} from '../../tools/data/library-context.mjs';

const root=resolve(process.cwd()),port=Number(process.env.PANDOLAB_TEST_PORT||4187);
const baseline=process.env.PANDO_PERF_SOURCE_COMMIT,measurementPin=process.env.PANDO_PERF_DATA_COMMIT;
if(measurementPin&&(process.env.PANDO_PERF_CAPTURE!=='1'||!/^([a-f0-9]{40})$/.test(measurementPin)))
 throw Error('A full data commit SHA and explicit performance capture are required');
const config={...libraryConfig(root),...(measurementPin?{revision:measurementPin}:{})},checkout=libraryCheckout(root);
const index=JSON.parse(git(checkout,['show',config.revision+':archive/index.json']));
const readPinnedData=path=>{
  const entry=index.files[path];
  if(!entry)throw Error('Missing pinned Viewer asset: '+path);
  return decodeArchiveEntry(checkout,entry,config.revision,{fetch:process.env.CI==='true'});
};
let readSourceBytes,sourcePaths,runtimeDependencyMap,mapLibreAssets;
if(baseline){
 if(process.env.PANDO_PERF_CAPTURE!=='1'||!/^([a-f0-9]{40})$/.test(baseline))throw Error('A full commit SHA and explicit performance capture are required');
 const paths=new Set(execFileSync('git',['ls-tree','-r','--name-only',baseline],{cwd:root,encoding:'utf8'}).trim().split('\n'));
 const read=path=>execFileSync('git',['show',baseline+':'+path],{cwd:root,maxBuffer:32*1024*1024});
 if(JSON.parse(read('config/library-data.json')).revision!==config.revision)throw Error('Performance baseline and candidate must share their data pin');
 mapLibreAssets=await historicalPerformanceMapLibreAssets({root,commit:baseline,readBaseline:read,
  artifactRoot:process.env.PANDO_PERF_MAPLIBRE_ARTIFACT,receiptPath:process.env.PANDO_PERF_MAPLIBRE_RECEIPT});
 sourcePaths=[...new Set([...paths,...[...buildFrontendIndex(root).values()].map(entry=>entry.sourcePath)])];
 const declaration=read('scripts/lib/product-assets.mjs').toString().match(/export const runtimeDependencies = Object\.freeze\((\{[\s\S]*?\})\);/);
 if(!declaration)throw Error('The baseline runtime dependency declaration is not supported');
 runtimeDependencyMap=JSON.parse(declaration[1].replaceAll("'",'"').replace(/,\s*}/g,'}'));
 if(Object.values(runtimeDependencyMap).some(value=>!Array.isArray(value)||value.some(path=>typeof path!=='string'||!path.startsWith('assets/')||path.includes('..'))))throw Error('Invalid baseline runtime dependencies');
 // New, unreferenced files can remain in the index; the baseline import closure never consumes them.
 readSourceBytes=path=>paths.has(path)?read(path):readFileSync(resolve(root,path));
}
const readPinnedDataBatch=paths=>decodeArchiveEntries(checkout,new Map(paths.map(path=>[path,index.files[path]])),config.revision,{fetch:process.env.CI==='true'});
const snapshot=await buildFrontendSnapshot({root,readPinnedData,readPinnedDataBatch,sourceCommit:baseline,readSourceBytes,sourcePaths,runtimeDependencyMap,mapLibreAssets,
  dataPaths:Object.keys(index.files).filter(path=>path.startsWith('assets/data/'))});
// Decode requested immutable assets only. Never materialize a library checkout.
const assets=new Map([...snapshot.assets].filter(([path])=>snapshot.viewerPaths.has(path)));
const vendorIdentity=performanceMapLibreIdentity(assets,entry=>entry.bytes);
const server=createBranchPreviewServer(root,{reports:false,pinnedAssetsOnly:true,assets:()=>assets,
  handleRequest(_request,response,pathname){
    response.setHeader('X-Pando-Test-Source-SHA256',snapshot.sourceSha256);
    response.setHeader('X-Pando-Test-Source-Commit',snapshot.sourceCommit);
    response.setHeader('X-Pando-Test-Data-Pin',config.revision);
    response.setHeader('X-Pando-Test-MapLibre-Module-SHA256',vendorIdentity.module);
    response.setHeader('X-Pando-Test-MapLibre-Worker-SHA256',vendorIdentity.worker);
    const path=pathname.slice(1);
    if(!assets.has(path)&&snapshot.viewerPaths.has(path)&&path.startsWith('assets/data/')){
      try{assets.set(path,{bytes:readPinnedData(path)});}
      catch(error){console.error(error);response.writeHead(503).end('Pinned asset unavailable');return true;}
    }
    return false;
  }});
const lease=libraryRuntimeLeasePath(root,'verification');
mkdirSync(dirname(lease),{recursive:true});
writeFileSync(lease,JSON.stringify({pid:process.pid,root,product:'verification',materialized:[]}));
const release=()=>{try{unlinkSync(lease);}catch(error){if(error.code!=='ENOENT')throw error;}};
process.once('exit',release);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>process.exit(0)));
server.listen(port,'127.0.0.1',()=>console.log(`Viewer tests: http://127.0.0.1:${port}`));
