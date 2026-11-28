import {validateGlobeSpatialCatalog,collectGlobeSpatialPages} from '../../src/rendering/globe-spatial-catalog.js';
// P2 publication gate. Validate the exact staged Viewer identities before
// uploading a Pages artifact. Deployment only reads the verified receipt.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {lstatSync,readFileSync,writeFileSync} from 'node:fs';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import {gunzipSync} from 'node:zlib';
import {sharedSourceManifest} from '../build/package-shared-core-assets.mjs';
import {MAP_PROJECT_ROLES,mapProjectResourcePath,mapProjectResourcePaths,
  validateMapProjectManifest} from '../../src/data/map-project-manifest.js';
import {validateMapCatalogCoherence} from '../../scripts/lib/map-catalog-coherence.mjs';
import {resolveBuiltinGeometryPacks} from '../../src/data/builtin-geometry-pack-receipt.js';
import {globeLodEnabled,validateGlobeLodChunks} from '../../src/rendering/globe-lod.js';
import {validateGlobeHistoryDirectory,validateGlobeHistoryPage} from '../../src/rendering/globe-history-catalog.js';
import {validateGlobePhysicalCatalog,collectGlobePhysicalPages} from '../../src/rendering/globe-physical-catalog.js';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const HASH=/^[a-f0-9]{64}$/;
const COMMIT=/^[a-f0-9]{40}$/;
const fail=(code,reason)=>{throw Object.assign(new Error(code+': '+reason),{code});};
const load=(root,path)=>JSON.parse(readFileSync(resolve(root,path),'utf8'));
const gitHead=root=>execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();

function checkOwnership({root,evidence,expectedCommit}){
  if(evidence?.schema!=='pando-web-pages-staging'||!COMMIT.test(evidence.sourceCommit||'')
    ||!COMMIT.test(evidence.dataCommit||'')||!Array.isArray(evidence.files))
    fail('ARTIFACT_DEPLOY_RECEIPT','Missing committed Pages evidence');
  const head=gitHead(root);
  if(evidence.sourceCommit!==head||(expectedCommit&&head!==expectedCommit))
    fail('ARTIFACT_DEPLOY_SOURCE','Pages evidence belongs to another source commit');
  const pin=load(root,'config/library-data.json');
  if(evidence.dataCommit!==pin.revision||evidence.dataRepository!==pin.repository)
    fail('ARTIFACT_DEPLOY_DATA_PIN','Pages evidence differs from this commit’s library pin');
  const files=new Map();
  for(const file of evidence.files){
    if(typeof file.path!=='string'||file.path.startsWith('/')||file.path.split('/').some(x=>!x||x==='.'||x==='..')
      ||files.has(file.path)||!HASH.test(file.sha256||'')
      ||!Number.isSafeInteger(file.bytes)||file.bytes<0)
      fail('ARTIFACT_DEPLOY_RECEIPT','Invalid, duplicate or unsafe published file identity');
    files.set(file.path,file);
  }
  const source=sharedSourceManifest(root),toolchain=load(root,'config/toolchain-versions.json');
  return {head,pin,files,source,toolchain};
}

// Verify the published spatial-chunk contract, including the separately
// compressed history catalog. Packet bytes remain bound to staging receipts.
export function verifyGlobePreviewIdentity(globe,files,bytesFor){
  const invalid=reason=>fail('ARTIFACT_DEPLOY_DATA_PIN',reason);
  const seenPackets=new Set();
  const packet=spec=>{
    if(!spec||!HASH.test(spec.sha256||'')||spec.encoding!=='gzip'
      ||typeof spec.url!=='string'||!spec.url.startsWith('assets/data/globe-preview/')
      ||!spec.url.endsWith('/sha256-'+spec.sha256+'.bin.gz')
      ||!Number.isSafeInteger(spec.compressedBytes)||spec.compressedBytes<=0
      ||!Number.isSafeInteger(spec.decodedBytes)||spec.decodedBytes<=0
      ||files.get(spec.url)?.sha256!==spec.sha256||files.get(spec.url)?.bytes!==spec.compressedBytes)
      invalid('Three.js asset differs from its transfer receipt');
    seenPackets.add(spec.url);
  };
  const rows=(value,label)=>{
    if(!Array.isArray(value))invalid('Missing Three.js '+label+' catalog');
    return value;
  };
  const chunks=(value,label)=>{
    const family=rows(value,label);
    try {validateGlobeLodChunks(family,globe.lodVersion);}
    catch(error){invalid('Invalid Three.js '+label+' LOD: '+error.message);}
    for(const row of family){
      if(!Array.isArray(row?.bounds)||row.bounds.length!==6||!row.bounds.every(Number.isFinite)
        ||row.bounds.slice(0,3).some((min,axis)=>min>row.bounds[axis+3]))
        invalid('Invalid Three.js '+label+' spatial bounds');
      packet(row.spec);
    }
  };
  const physical=context=>{
    validateGlobePhysicalCatalog(context,globe.lodVersion);
    const ids=context.catalog.pages.map((_,i)=>i);
    const descriptors=collectGlobePhysicalPages(context,ids,context.catalog.pages.map(page=>catalogJson(page.spec)),{complete:true});
    for(const row of descriptors)packet(row.spec);
  };
  if(!globe||!Array.isArray(globe.countrySlots)||!Number.isSafeInteger(globe.historySlotCount)
    ||globe.historySlotCount<0)invalid('Missing Three.js map asset manifest');
  try {globeLodEnabled(globe.lodVersion);}
  catch(error){invalid(error.message);}
  packet(globe.graticule);
  packet(globe.hydroMetadata);
  function catalogJson(spec) {
    packet(spec);
    const compressed=bytesFor(spec.url);
    if(compressed.length!==spec.compressedBytes||digest(compressed)!==spec.sha256)
      invalid('Three.js history catalog differs from its transfer receipt');
    const decoded=gunzipSync(compressed,{maxOutputLength:spec.decodedBytes});
    if(decoded.length!==spec.decodedBytes)invalid('Three.js history catalog size mismatch');
    return JSON.parse(decoded);
  }
  try {
    const territorial=validateGlobeSpatialCatalog(globe.territorialCatalog,globe.lodVersion,['country','border','outline']);
    const ids=territorial.pages.map((_,i)=>i);
    for(const row of collectGlobeSpatialPages(territorial,ids,territorial.pages.map(page=>catalogJson(page.spec)),{complete:true}))packet(row.spec);
    physical(globe.physical);
    const history=validateGlobeHistoryDirectory(catalogJson(globe.historyCatalog),
      {lodVersion:globe.lodVersion,slotCount:globe.historySlotCount});
    if(history.physicalContexts.some(row=>row.identity===globe.physical.identity))invalid('Duplicate base physical context');
    for(const [page,record] of history.pages.entries()) {
      const value=validateGlobeHistoryPage(history,page,catalogJson(record.spec));
      for(const {value:row} of value.entries) {
        if(record.kind==='historicalCountries') {
          chunks(row.countryChunks,'historical country');
          chunks(row.outlineChunks,'historical outline');
        }else chunks(row.chunks,'historical border');
      }
    }
    for(const context of history.physicalContexts)physical(context);
  }catch(error){
    if(error?.code?.startsWith('ARTIFACT_DEPLOY_'))throw error;
    invalid('Invalid Three.js history catalog: '+error.message);
  }
  return seenPackets.size;
}

export function verifyStagedPagesIdentity({root,stage,evidence,expectedCommit=null}={}){
  root=resolve(root);stage=resolve(stage);
  const {head,pin,files,source,toolchain}=checkOwnership({root,evidence,expectedCommit});
  const seen=new Set();
  const bytesFor=path=>{
    const spec=files.get(path);
    if(!spec)fail('ARTIFACT_DEPLOY_MISSING','Missing staged identity: '+path);
    const location=resolve(stage,path),rel=relative(stage,location);
    if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)
      ||!lstatSync(location).isFile()||lstatSync(location).isSymbolicLink())
      fail('ARTIFACT_DEPLOY_RECEIPT','Invalid staged identity path: '+path);
    const bytes=readFileSync(location);
    if(bytes.length!==spec.bytes||digest(bytes)!==spec.sha256)
      fail('ARTIFACT_DEPLOY_BYTES','Staged identity differs from finalized evidence: '+path);
    seen.add(path);
    return bytes;
  };
  const sandbox=Object.create(null);
  runInNewContext(bytesFor('assets/js/build-meta.js').toString('utf8'),sandbox,
    {filename:'assets/js/build-meta.js',timeout:1000});
  const meta=sandbox.PANDOLAB_BUILD_META;
  const appVersion=String(load(root,'package.json').version||'');
  if(!meta||!Object.isFrozen(meta)||meta.sourceCommit!==head||meta.dataCommit!==pin.revision
    ||meta.appVersion!==appVersion||meta.buildId!==meta.assetRevision
    ||!meta.buildId.startsWith(appVersion+'-build-')||!HASH.test(evidence.frontendInputSha256||''))
    fail('ARTIFACT_DEPLOY_CODE','Generated JS identity differs from the source revision');
  if(meta.externalRuntimeData?.revision!==undefined && meta.externalRuntimeData.revision!==pin.revision)
    fail('ARTIFACT_DEPLOY_DATA_PIN','External runtime archive differs from the project data pin');
  const project=validateMapProjectManifest(meta.mapProject);
  if(project.projectId!==evidence.projectId)fail('ARTIFACT_DEPLOY_PROJECT','Staged project ID differs from Pages evidence');
  const projectFile=meta.mapProjectManifest;
  const projectBytes=bytesFor(projectFile?.url);
  if(projectFile.sha256!==digest(projectBytes)||projectFile.decodedBytes!==projectBytes.length
    ||JSON.stringify(validateMapProjectManifest(JSON.parse(projectBytes)))!==JSON.stringify(project))
    fail('ARTIFACT_DEPLOY_PROJECT','Published project manifest differs from build identity');
  const paths=mapProjectResourcePaths(project),metadata={};
  const catalogIdentities=paths.map(path=>{
    const bytes=bytesFor(path);
    metadata[path]=JSON.parse(bytes.toString('utf8'));
    return [path,digest(bytes)];
  });
  for(const role of MAP_PROJECT_ROLES){
    const path=mapProjectResourcePath(project,role),receipt=meta.projectCatalogs?.[role];
    const declared=files.get(path);
    if(!receipt||receipt.catalog!==path||receipt.sha256!==declared?.sha256
      ||receipt.bytes!==declared.bytes)
      fail('ARTIFACT_DEPLOY_DATA_PIN','Catalog does not match the selected project: '+role);
  }
  const coherence=validateMapCatalogCoherence(project,metadata,path=>files.get(path)?.sha256);
  const territorialPath=mapProjectResourcePath(project,'territorial');
  const packs=resolveBuiltinGeometryPacks(meta.startupGeometryPacks,files.get(territorialPath).sha256,metadata[territorialPath].geometryAssets);
  for(const {spec,members} of packs){
    const bytes=bytesFor(spec.url);
    if(bytes.length!==spec.compressedBytes||digest(bytes)!==spec.sha256
      ||members.some(({asset,start,end})=>digest(bytes.subarray(start,end))!==asset.sha256))
      fail('ARTIFACT_DEPLOY_DATA_PIN','Startup geometry pack differs from its pinned members');
  }
  const boundary=meta.countryBoundarySeed;
  if(boundary&&(!HASH.test(boundary.algorithmSha256||'')||boundary.territorialCatalogSha256!==files.get(territorialPath).sha256
    ||boundary.worldCatalogSha256!==files.get(mapProjectResourcePath(project,'world')).sha256
    ||boundary.url!==`assets/data/display-boundaries/sha256-${boundary.sha256}.json.gz`
    ||files.get(boundary.url)?.sha256!==boundary.sha256||files.get(boundary.url)?.bytes!==boundary.compressedBytes
    ||digest(bytesFor(boundary.url))!==boundary.sha256))
    fail('ARTIFACT_DEPLOY_DATA_PIN','Boundary display derivative differs from its selected source catalogs or byte receipt');
  if(boundary){
    const anchors=JSON.parse(gunzipSync(bytesFor(boundary.url))).labelAnchors;
    if(!anchors||JSON.stringify(anchors)!==JSON.stringify(boundary.labelAnchors)||Object.values(anchors).some(row=>!row||!/^[a-f0-9]+:[a-f0-9]+$/.test(row.signature)||!Array.isArray(row.coordinates)||row.coordinates.length!==2||!row.coordinates.every(Number.isFinite)||Math.abs(row.coordinates[0])>180||Math.abs(row.coordinates[1])>90))
      fail('ARTIFACT_DEPLOY_DATA_PIN','Label anchors differ from the verified geometry derivative');
  }
  verifyGlobePreviewIdentity(meta.globePreview,files,bytesFor);
  if(meta.projectCatalogs.rivers.version!==coherence.hydroVersion
    ||meta.projectCatalogs.lakes.version!==coherence.hydroVersion
    ||meta.projectCatalogs.preparedMeshes.current!==coherence.preparedMeshesCurrent)
    fail('ARTIFACT_DEPLOY_DATA_PIN','Project catalog role versions disagree');
  const dataRevision='data-'+digest(JSON.stringify([project.projectId,project.resources,catalogIdentities])).slice(0,32);
  if(meta.dataRevision!==dataRevision||!/^data-[a-f0-9]{32}$/.test(dataRevision))
    fail('ARTIFACT_DEPLOY_DATA_REVISION','Generated code uses a different project data revision');
  const core=JSON.parse(bytesFor('assets/wasm/pandoeditor-core.manifest.json').toString('utf8'));
  if(core.schema!=='pandoeditor-core-wasm'||core.abiVersion!==1
    ||core.compiler?.name!=='emscripten'||core.compiler.version!==toolchain.emscripten
    ||core.sourceSha256!==source.sourceSha256
    ||JSON.stringify(core.inputs)!==JSON.stringify(source.inputs))
    fail('ARTIFACT_DEPLOY_WASM_SOURCE','Staged WASM ABI, compiler or C++ source is not current');
  for(const type of ['js','wasm']){
    const path='assets/wasm/pandoeditor-core.'+(type==='js'?'js':'wasm');
    const bytes=bytesFor(path);
    if(core.assets?.[type]?.file!==path.split('/').at(-1)||core.assets[type].sha256!==digest(bytes))
      fail('ARTIFACT_DEPLOY_WASM_BYTES','Compiled Core '+type+' is not its manifest-pinned edition');
    if(type==='wasm'&&(bytes.length<8||!bytes.subarray(0,8).equals(Buffer.from([0,97,115,109,1,0,0,0]))))
      fail('ARTIFACT_DEPLOY_WASM_BYTES','Invalid compiled Core WASM header');
  }
  return Object.freeze({schema:'pando-p2-deploy-identity-v1',verified:true,
    sourceCommit:head,dataCommit:pin.revision,projectId:project.projectId,
    frontendInputSha256:evidence.frontendInputSha256,
    dataRevision,coreSourceSha256:source.sourceSha256,coreAbiVersion:core.abiVersion,
    coreCompilerVersion:core.compiler.version,
    verifiedPaths:[...seen].sort()});
}

export function verifyPagesIdentityReceipt({root,evidence,expectedCommit=null}={}){
  root=resolve(root);
  const {head,pin,source,toolchain,files}=checkOwnership({root,evidence,expectedCommit});
  const proof=evidence.deploymentIdentity;
  if(proof?.schema!=='pando-p2-deploy-identity-v1'||proof.verified!==true
    ||proof.sourceCommit!==head||proof.dataCommit!==pin.revision
    ||proof.projectId!==evidence.projectId||proof.frontendInputSha256!==evidence.frontendInputSha256
    ||proof.coreSourceSha256!==source.sourceSha256||proof.coreAbiVersion!==1
    ||proof.coreCompilerVersion!==toolchain.emscripten||!/^data-[a-f0-9]{32}$/.test(proof.dataRevision||'')
    ||!Array.isArray(proof.verifiedPaths)||proof.verifiedPaths.some(path=>!files.has(path)))
    fail('ARTIFACT_DEPLOY_RECEIPT','Missing or stale verified code/WASM/data identity');
  for(const required of ['assets/js/build-meta.js','assets/wasm/pandoeditor-core.js',
    'assets/wasm/pandoeditor-core.wasm','assets/wasm/pandoeditor-core.manifest.json'])
    if(!proof.verifiedPaths.includes(required))
      fail('ARTIFACT_DEPLOY_RECEIPT','Identity verification omitted required member: '+required);
  return proof;
}

function main(args=process.argv.slice(2)){
  const arg=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
  const root=arg('--root')||'.',manifest=arg('--manifest');
  if(!manifest)throw Error('Required --manifest FILE');
  const evidence=JSON.parse(readFileSync(resolve(manifest),'utf8'));
  const options={root,evidence,expectedCommit:arg('--expect-commit')||null};
  let result;
  if(args.includes('--receipt-only'))result=verifyPagesIdentityReceipt(options);
  else{
    const stage=arg('--stage');
    if(!stage)throw Error('Required --stage DIR unless --receipt-only');
    result=verifyStagedPagesIdentity({...options,stage});
    writeFileSync(resolve(manifest),JSON.stringify({...evidence,deploymentIdentity:result},null,2)+'\n');
  }
  console.log('ARTIFACT_DEPLOY_IDENTITY '+JSON.stringify(result));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  try{main();}catch(error){console.error(error.stack);process.exitCode=1;}
