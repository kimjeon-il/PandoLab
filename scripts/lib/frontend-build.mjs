import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {buildCountryBoundarySeed,createCountryLabelAnchorComputer} from './country-boundary-seed.mjs';
import {buildFrontendIndex,emitFrontendModule} from './frontend-layout.mjs';
import {renderProductHtml} from './product-html.mjs';
import {buildUiBundles} from '../build-ui-bundle.mjs';
import {buildWorkerAsset} from './worker-assets.mjs';
import {collectViewerAssets,viewerDataEntryPaths} from './product-assets.mjs';
import {mapLibreVendorAssets} from './maplibre-vendor.mjs';
import {collectRuntimeDataAssets} from '../../src/data/runtime-manifest-assets.js';
import {decodeArchiveEntries,decodeArchiveEntry,libraryCheckout,libraryConfig} from "../../tools/data/library-context.mjs";
import {validateMapCatalogCoherence} from './map-catalog-coherence.mjs';
import {buildPhysicalLandDisplayAssets} from './physical-land-display-assets.mjs';
import {MAP_PROJECT_ROLES,validateMapProjectManifest,mapProjectResourcePath,mapProjectResourcePaths,mapProjectManifestSourcePath}
  from '../../src/data/map-project-manifest.js';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function selectFrontendProduct(snapshot,product,{readRuntimeAsset}={}){
 if(product!=='viewer')throw Error('Unknown distributable frontend product');
 const assets=new Map();
 for(const path of [...snapshot.viewerPaths].sort()){
  const entry=snapshot.assets.get(path);
  if(entry){if(entry.product==='editor')throw Error('Editor source entered the viewer output');assets.set(path,entry);}
  else{if(!path.startsWith('assets/data/'))throw Error('Unowned runtime resource');assets.set(path,{publicPath:path,sourcePath:path,product:'shared',bytes:readRuntimeAsset(path)});}
 }
 const sourceSha256=hash(JSON.stringify({input:snapshot.sourceSha256,product,files:[...assets].map(([path,entry])=>[path,hash(entry.bytes)])}));
 return {...snapshot,product,sourceSha256,assets};
}
export function readFrontendInput(snapshot,path,encoding){
 if(isAbsolute(path))path=relative(snapshot.root,path).replaceAll('\\','/');
 const bytes=snapshot.assets.has(path)?snapshot.assets.get(path).bytes:readFileSync(resolve(snapshot.root,path));
 return encoding?bytes.toString(encoding):bytes;
}
export function hasFrontendInput(snapshot,path){
 if(isAbsolute(path))path=relative(snapshot.root,path).replaceAll('\\','/');
 return snapshot.assets.has(path)||existsSync(resolve(snapshot.root,path));
}
const pinnedContexts=new Map();
function pinnedContext(root){
 const configuration=libraryConfig(root),checkout=libraryCheckout(root),key=checkout+'|'+configuration.revision;
 if(!pinnedContexts.has(key)){
  const index=JSON.parse(execFileSync('git',['-c','maintenance.auto=false','-c','gc.auto=0','show',configuration.revision+':archive/index.json'],{cwd:checkout,maxBuffer:16*1024*1024}));
  const bytes=new Map();
  const entry=path=>{assert.ok(index.files[path],'Missing pinned input: '+path);return index.files[path];};
  pinnedContexts.set(key,{revision:configuration.revision,index,dataPaths:Object.keys(index.files).filter(p=>p.startsWith('assets/data/')),
   read:path=>{if(!bytes.has(path))bytes.set(path,decodeArchiveEntry(checkout,entry(path),configuration.revision));return bytes.get(path);},
   readBatch:paths=>{
    const missing=new Map(paths.filter(path=>!bytes.has(path)).map(path=>[path,entry(path)]));
    for(const [path,buffer] of decodeArchiveEntries(checkout,missing,configuration.revision,{fetch:process.env.CI==='true'}))bytes.set(path,buffer);
    return new Map(paths.map(path=>[path,bytes.get(path)]));
   }});
 }
 return pinnedContexts.get(key);
}
/** Build the one Viewer runtime shared by browser and Windows review, without output mutations. */
export async function buildFrontendSnapshot({root=process.cwd(),sourceCommit,readPinnedData,readPinnedDataBatch,dataPaths,readSourceBytes,sourcePaths,runtimeDependencyMap,resourceProfile,projectId='default-world',externalRuntimeData=false,workerSourceTransform=(_path,source)=>source,mapLibreAssets}={}){
 if(resourceProfile!==undefined&&!['map-data','test-fixture'].includes(resourceProfile))throw Error('Invalid frontend resource profile');
 root=resolve(root);const pinned=readPinnedData?null:pinnedContext(root);
 readPinnedData??=pinned.read;dataPaths??=pinned.dataPaths;
 readPinnedDataBatch??=pinned?.readBatch;
 sourceCommit??=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
 const readBytes=readSourceBytes??(path=>readFileSync(resolve(root,path)));
 readSourceBytes=path=>{
  const bytes=readBytes(path);
  return /\.(?:[cm]?js|json|css|html|svg|txt|md)$|\/(?:LICENSE|NOTICE)$/i.test(path)
   ?Buffer.from(bytes.toString('utf8').replaceAll('\r\n','\n')):bytes;
 };
 const appVersion=String(JSON.parse(readSourceBytes('package.json')).version||'');
 if(!/^\d+\.\d+\.\d+$/.test(appVersion))throw Error('Invalid frontend version');
 const buildId=appVersion+'-build-'+(process.env.PANDOLAB_BUILD_ID||sourceCommit.slice(0,12)).replace(/[^A-Za-z0-9._-]/g,'-'),assetRevision=buildId;
 const index=buildFrontendIndex(root,{sourcePaths}),assets=new Map(),sourceInputs=[];
 const sourceText=path=>{const bytes=readSourceBytes(path);sourceInputs.push({sourcePath:path,sha256:hash(bytes)});return bytes.toString('utf8');};
 for(const entry of index.values()){
  const original=readSourceBytes(entry.sourcePath);sourceInputs.push({sourcePath:entry.sourcePath,sha256:hash(original)});
  let bytes=entry.publicPath.endsWith('.js')&&!/\/vendor\/|\/wasm\//.test(entry.publicPath)?Buffer.from(emitFrontendModule(original.toString('utf8'),entry.sourcePath,index)):original;
  if(entry.publicPath.startsWith('assets/js/workers/')&&entry.publicPath.endsWith('.js'))bytes=Buffer.from(workerSourceTransform(entry.publicPath,bytes.toString('utf8')));
  assets.set(entry.publicPath,{...entry,bytes});
 }
 const generated=(path,bytes,product='shared')=>assets.set(path,{publicPath:path,sourcePath:null,product,bytes:Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes)});
 for(const [path,bytes] of mapLibreAssets??mapLibreVendorAssets(root))generated(path,bytes,'viewer');
 const read=path=>{
  if(assets.has(path))return assets.get(path).bytes.toString('utf8');
  if(path.startsWith('assets/data/'))return readPinnedData(path).toString('utf8');
  throw Error('Missing product input: '+path);
 };
 const bundles=buildUiBundles(root,{readSource:read});
 generated('assets/css/ui-viewer.bundle.css',bundles.viewer,'viewer');
 const workerAssets={};
 for(const entry of [...assets.keys()].filter(p=>/^assets\/js\/workers\/.*-worker\.js$/.test(p)).sort()){
  const built=await buildWorkerAsset({root,entry,readSource:read});
  const files=[...built.files].sort(([a],[b])=>a<b?-1:a>b?1:0);
  workerAssets[entry]={url:built.url,files:files.map(([path])=>path),sha256:Object.fromEntries(files.map(([p,bytes])=>[p,hash(bytes)]))};
  const product=index.get(entry).product;for(const [path,bytes]of files)generated(path,bytes,product);
 }
 // The selected project owns its catalog references. Pinned library assets
 // supply immutable bytes, not another viewer-maintained membership list.
 const projectSource=sourceText(mapProjectManifestSourcePath(projectId));
 const mapProject=validateMapProjectManifest(JSON.parse(projectSource));
 if(mapProject.projectId!==projectId)throw new TypeError('Map project source identity mismatch');
 const resource=role=>mapProjectResourcePath(mapProject,role);
 const metadataPaths=mapProjectResourcePaths(mapProject);
 // Build validates pinned existence, catalog digest and cross-role compatibility.
 // The Viewer chooses and loads catalog contents from its project at runtime.
 const catalogInputs=Object.fromEntries(metadataPaths.map(path=>{
   const bytes=readPinnedData(path),value=JSON.parse(bytes.toString('utf8'));
   if(!value||typeof value!=='object'||Array.isArray(value))
     throw new TypeError('Invalid pinned project catalog: '+path);
   return [path,{value,sha256:hash(bytes),bytes:bytes.length}];
 }));
 const metadata=Object.fromEntries(metadataPaths.map(path=>[path,catalogInputs[path].value]));
 const {hydroVersion,preparedMeshesCurrent}=validateMapCatalogCoherence(
   mapProject,metadata,path=>catalogInputs[path].sha256);
 const territorialPath=resource('territorial'),territorial=catalogInputs[territorialPath];
 let startupGeometryPacks=null,historicalGeometryDeltas=null,historicalDeltaAssets=new Map();
 if(resourceProfile!=='test-fixture'){
   const {buildBuiltinGeometryPacks,readBuiltinGeometryPackInputs}=await import('./builtin-geometry-packs.mjs');
   const timestamp=Number(execFileSync('git',['show','-s','--format=%ct',sourceCommit],{cwd:root,encoding:'utf8'}).trim());
   const month=new Date(timestamp*1000).toISOString().slice(0,7);
   const {receipt,assets:packAssets}=buildBuiltinGeometryPacks({index:territorial.value,month,catalogSha256:territorial.sha256,
     readGeometryAssets:files=>readBuiltinGeometryPackInputs(territorialPath,files,readPinnedData,readPinnedDataBatch)});
   startupGeometryPacks=receipt;
   for(const [path,bytes] of packAssets)generated(path,bytes,'viewer');
   const {buildBuiltinGeometryDeltas}=await import('./builtin-geometry-deltas.mjs');
   const deltas=buildBuiltinGeometryDeltas({index:territorial.value,month,catalogSha256:territorial.sha256,
     readGeometryAssets:files=>readBuiltinGeometryPackInputs(territorialPath,files,readPinnedData,readPinnedDataBatch)});
   historicalGeometryDeltas=deltas.receipt;historicalDeltaAssets=deltas.assets;
   for(const [path,bytes]of historicalDeltaAssets)generated(path,bytes,'viewer');
 }
 const physicalCatalog=metadata[resource('physicalLand')];
 let physicalLandDisplays={},physicalLandDisplayAssets=new Map();
 if(resourceProfile!=='test-fixture'||physicalCatalog.asset){
   // The recipe and verified compiled kernel belong to this build process, even
   // when a performance comparison supplies a historical runtime import closure.
   const recipePaths=['src/rendering/physical-land-display.js','src/data/physical-land-patch.js',
     'scripts/lib/physical-land-display-assets.mjs','assets/wasm/pandoeditor-core.manifest.json'];
   const recipe=recipePaths.map(path=>{
     const bytes=readFileSync(resolve(root,path)),sha256=hash(bytes);
     sourceInputs.push({sourcePath:path,sha256});return [path,sha256];
   });
   const {sharedCalculationCore}=await import('../../src/document/temporal.js');
   const displays=await buildPhysicalLandDisplayAssets({catalog:physicalCatalog,readPinnedData,
     algorithmSha256:hash(JSON.stringify(recipe)),
     union:coordinates=>sharedCalculationCore.polygonOperation('union',[coordinates],false)});
   physicalLandDisplays=displays.specs;physicalLandDisplayAssets=displays.assets;
   for(const [path,bytes]of physicalLandDisplayAssets)generated(path,bytes,'viewer');
 }
 const projectCatalogs=Object.fromEntries(MAP_PROJECT_ROLES.map(role=>{
   const path=resource(role),receipt=catalogInputs[path];
   return [role,{catalog:path,sha256:receipt.sha256,bytes:receipt.bytes,
     ...(role==='rivers'||role==='lakes'?{version:hydroVersion}:{}),
     ...(role==='preparedMeshes'?{current:preparedMeshesCurrent}:{})}];
 }));
 let countryBoundarySeed;
 if(startupGeometryPacks&&resourceProfile!=='test-fixture'){
  const {readBuiltinGeometryPackInputs}=await import('./builtin-geometry-packs.mjs');
  const recipe=['scripts/lib/country-boundary-seed.mjs','src/geometry/boundary-topology.js','src/geometry/country-contact-core.js','src/geometry/country-contact-row-pruning.js','src/geometry/geographic-boundary.js','src/geometry/boundary-spatial-index.js','src/rendering/workers/label-anchor-worker.js','assets/js-vendor/d3.min.js'];
  const {sharedCalculationCore}=await import('../../src/document/temporal.js');
  const algorithmSha256=hash(JSON.stringify([recipe.map(path=>[path,hash(readSourceBytes(path))]),workerAssets['assets/js/workers/map-geometry-worker.js'].url,hash(read('assets/wasm/pandoeditor-core.manifest.json')),sharedCalculationCore.polygonMeshAlgorithmRevision]));
  const prepared=buildCountryBoundarySeed({index:metadata[resource('territorial')],month:startupGeometryPacks.month,catalogSha256:projectCatalogs.territorial.sha256,algorithmSha256,
   computeLabelAnchor:createCountryLabelAnchorComputer({d3Source:readSourceBytes('assets/js-vendor/d3.min.js'),workerSource:readSourceBytes('src/rendering/workers/label-anchor-worker.js')}),
   readGeometryAssets:files=>readBuiltinGeometryPackInputs(resource('territorial'),files,readPinnedData,readPinnedDataBatch)});
  countryBoundarySeed={...prepared.spec,worldCatalogSha256:projectCatalogs.world.sha256};generated(prepared.spec.url,prepared.bytes,'viewer');
 }
 let externalData;
 if(externalRuntimeData){
   if(!pinned)throw Error('External runtime data requires the pinned archive index');
   const selected=collectRuntimeDataAssets({availablePaths:dataPaths,entryPaths:viewerDataEntryPaths,projectManifest:mapProject,
     preparedMeshesCurrent,readManifest:path=>JSON.parse(readPinnedData(path))});
   const files=Object.fromEntries([...selected].sort().map(path=>{
     const entry=pinned.index.files[path];
     if(!entry)throw Error('Missing pinned archive entry: '+path);
     return [path,{stored:entry.stored,encoding:entry.encoding,bytes:entry.bytes,sha256:entry.sha256}];
   }));
   const hydro=metadata[resource('rivers')],hydroBase=resource('rivers').replace(/[^/]+$/,'');
   if(hydro.container){
     const entry=files[hydroBase+hydro.container.url];
     if(!entry||entry.encoding!=='identity')throw Error('External hydro container must have identity storage');
     const segments=[hydro.index,hydro.metadata?.core,hydro.metadata?.detail,...hydro.shards].filter(Boolean);
     entry.segments=segments.map(({offset,bytes,sha256,url})=>{
       if(url!==hydro.container.url||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(bytes)||bytes<1
          ||offset+bytes>entry.bytes||!/^[a-f0-9]{64}$/.test(sha256||''))throw Error('Invalid external hydro segment');
       return {offset,bytes,sha256};
     });
   }
   externalData={revision:pinned.revision,files};
 }
 const dataRevision='data-'+hash(JSON.stringify([mapProject.projectId,mapProject.resources,
   metadataPaths.map(path=>[path,catalogInputs[path].sha256])])).slice(0,32);
 const projectBytes=Buffer.from(projectSource);
 const projectManifestPath='assets/data/projects/'+mapProject.projectId+'/manifest.json';
 generated(projectManifestPath,projectBytes,'viewer');
 const mapProjectManifest={url:projectManifestPath,encoding:'identity',
   compressedBytes:projectBytes.length,decodedBytes:projectBytes.length,sha256:hash(projectBytes)};
 // The generated metadata carries one project manifest and one compact
 // integrity receipt per role. No duplicate world/water catalog is
 // expanded into process-global build metadata.
 const buildMeta={appVersion,buildId,assetRevision,dataRevision,sourceCommit,dataCommit:pinned?.revision||null,...resourceProfile?{resourceProfile}:{},
   ...(externalData?{externalRuntimeData:externalData}:{}),
   mapProject,mapProjectManifest,projectCatalogs,
   workerAssets,physicalLandDisplays,startupGeometryPacks,historicalGeometryDeltas,...countryBoundarySeed?{countryBoundarySeed}:{}};
 generated('assets/js/build-meta.js','// Generated product identity.\nglobalThis.PANDOLAB_BUILD_META = Object.freeze('+JSON.stringify(buildMeta,null,2)+');\n');
 const templates=renderProductHtml(sourceText),moduleImports=Object.fromEntries([...assets.keys()].filter(p=>p.startsWith('assets/js/')&&p.endsWith('.js')).map(p=>['./'+p,'./'+p+'?v='+encodeURIComponent(assetRevision)]));
 const render=(template,imports)=>{
  let html=template.replaceAll('{{assetRevision}}',assetRevision).replace(/(\bdata-app-version=")[^"]+(")/,'$1'+appVersion+'$2');
  html=html.replace(/(\b(?:href|src)="[^"]*assets\/[^"?]+)(?:\?v=[^"]*)?(")/g,(_,start,end)=>/\.woff2$/.test(start)?start+end:start+'?v='+assetRevision+end);
  const importMap='<script id="pandolab-module-import-map" type="importmap">\n'+JSON.stringify({imports},null,2)+'\n</script>';
  return /<script\b[^>]*id="pandolab-module-import-map"[^>]*>[\s\S]*?<\/script>/.test(html)?html.replace(/<script\b[^>]*id="pandolab-module-import-map"[^>]*>[\s\S]*?<\/script>/,()=>importMap):html.replace(/(?=<script\b)/,importMap+'\n');
 };
 generated('index.html',render(templates.web,moduleImports),'viewer');generated('.nojekyll','', 'viewer');
 const viewerPaths=await collectViewerAssets({root,availablePaths:[...assets.keys(),...dataPaths],readSource:read,workerAssets,runtimeDependencyMap});
 for(const path of physicalLandDisplayAssets.keys())viewerPaths.add(path);
 for(const pack of startupGeometryPacks?.packs??[])viewerPaths.add(pack.url);
 for(const path of historicalDeltaAssets.keys())viewerPaths.add(path);
 if(countryBoundarySeed)viewerPaths.add(countryBoundarySeed.url);
 const viewerImports=Object.fromEntries(Object.entries(moduleImports).filter(([path])=>viewerPaths.has(path.slice(2))));
 const html={viewer:render(templates.web,viewerImports)};
 generated('index.html',html.viewer,'viewer');
 const sourceSha256=hash(JSON.stringify({sourceCommit,appVersion,dataRevision,sources:sourceInputs.sort((a,b)=>a.sourcePath.localeCompare(b.sourcePath)),outputs:[...assets].map(([path,entry])=>[path,hash(entry.bytes)])}));
 return{root,sourceCommit,sourceSha256,dataRevision,dataCommit:pinned?.revision||null,assets,index,viewerPaths,html,buildMeta,sourceInputs,readPinnedRuntimeAsset:readPinnedData};
}
