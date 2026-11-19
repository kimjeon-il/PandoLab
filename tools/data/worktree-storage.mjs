// Local application storage owner. Library bytes remain owned by library-data.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync, readdirSync, statfsSync, openSync, closeSync, lstatSync, rmdirSync, statSync, chmodSync, renameSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicStorageJSON, containedPath, contentHash, contentFiles, contentPath, publishContent, linkContentView, removeContentView, recoverContentPermissions } from "./library-content.mjs";
import {libraryStagingContent,librarySharedCheckout,withLibraryLock,discardDeadLibraryLock} from "./library-context.mjs";
import { previewGeneratedCleanup, applyGeneratedCleanup } from "./worktree-generated.mjs";
import { snapshotGitStorage, repackLocalObjects } from "./library-git.mjs";
import {assertRemoteOnlyNativeAllowed,remoteOnlyBranch} from "../../scripts/lib/remote-only-native-policy.mjs";

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const schema='pando-worktree-storage-v1';
export const cacheLimit=2*1024**3;
const nativeWriter=p=>Boolean(p.globalBuild)||/^(cargo|rustc|rust-lld|cmake|ninja|msbuild|gradle|clang(?:\+\+)?|emcc|em\+\+)\.exe$/i.test(p.Name||'')||/stage\.mjs|tools[\\/]build-[\w-]+\.mjs|tauri.*(dev|build)/i.test(p.CommandLine||'');
const usesDirectory=(p,directory)=>{const normalize=value=>String(value||'').replaceAll('\\','/').replace(/\/+/g,'/').toLowerCase(),target=normalize(directory);return [p.ExecutablePath,p.CommandLine].some(value=>{const text=normalize(value);return text.endsWith(target)||['/','"',"'",' '].some(suffix=>text.includes(target+suffix));});};
export function dependencyPreparationArguments({root,store}){
  return ['--dir',root,'install','--frozen-lockfile','--config.enableGlobalVirtualStore=true','--store-dir='+store,'--package-import-method=hardlink','--config.confirmModulesPurge=false'];
}
export function prepareDependencies(root=repository){
  const settings=storageSettings(root);if(!settings)throw Error('Activate application storage before dependency preparation');
  const version=JSON.parse(readFileSync(resolve(root,'package.json'))).packageManager;
  const executable=process.env.npm_execpath||resolve(dirname(execFileSync(process.platform==='win32'?'where.exe':'which',['pnpm'],{encoding:'utf8'}).split(/\r?\n/)[0]),'node_modules/pnpm/bin/pnpm.cjs');
  const pnpm=execFileSync(process.execPath,[executable,'--version'],{encoding:'utf8'}).trim();if(version!=='pnpm@'+pnpm)throw Error('Use the pinned pnpm version: '+version);
  const store=containedPath(settings.cacheRoot,'pnpm/store');
  atomicStorageJSON(resolve(root,'.library-data/dependencies.json'),{schema:'pando-dependency-store-v1',store});
  const args=dependencyPreparationArguments({root,store});
  execFileSync(process.execPath,[executable,...args],{cwd:root,stdio:'inherit',windowsHide:true});
  return {pnpm,store,projects:[root]};
}
export function installFrontendSnapshot({root,snapshot,settings=storageSettings(root)||{cacheRoot:resolve(root,'.library-data/cache')},afterFile=()=>{}}){
  if(!/^[a-f0-9]{64}$/.test(snapshot.sourceSha256))throw Error('Invalid frontend input identity');
  return withStorageLock(root,settings,()=>{
    const install=()=>{
    const store={root:settings.cacheRoot,blobDirectory:'blobs'},directory=containedPath(settings.cacheRoot,'frontend/'+snapshot.sourceSha256),pending=directory+'.pending',marker='frontend-manifest.json';
    const journal=containedPath(settings.cacheRoot,'frontend-install.pending.json');
    const files=[...snapshot.assets].map(([path,entry])=>({path,sourcePath:entry.sourcePath||null,bytes:entry.bytes.length,sha256:contentHash(entry.bytes)}));
    const manifest={schema:'pando-frontend-v1',product:snapshot.product||'common',sourceCommit:snapshot.sourceCommit,sourceSha256:snapshot.sourceSha256,dataCommit:snapshot.dataCommit,files};
    if(existsSync(journal)&&JSON.stringify(JSON.parse(readFileSync(journal)).manifest)!==JSON.stringify(manifest))throw Error('Resume the pending frontend installation first');
    const verify=dir=>{for(const file of files){const target=containedPath(dir,file.path),s=lstatSync(target);if(s.size!==file.bytes||contentHash(readFileSync(target))!==file.sha256||(s.mode&0o200))throw Error('Frontend immutable output differs: '+file.path);}};
    if(!existsSync(directory)){
      const peak=files.reduce((n,f)=>n+f.bytes,0),disk=statfsSync(settings.cacheRoot);
      if(peak>=1024**3&&disk.bavail*disk.bsize<peak+5*1024**3)throw Error('Frontend output requires payload plus 5GiB headroom');
      mkdirSync(pending,{recursive:true});atomicStorageJSON(journal,{root,manifest});atomicStorageJSON(resolve(pending,marker),manifest);
      for(const file of files){
        const shared=libraryStagingContent({root,sha256:file.sha256,bytes:file.bytes}),view={viewRoot:pending,marker};
        if(shared)linkContentView(shared,file.sha256,containedPath(pending,file.path),view);
        else{const blob=publishContent(store,snapshot.assets.get(file.path).bytes);linkContentView(store,blob.sha256,containedPath(pending,file.path),view);}
        afterFile(file);
      }
      verify(pending);renameSync(pending,directory);
    }
    if(JSON.stringify(JSON.parse(readFileSync(resolve(directory,marker))))!==JSON.stringify(manifest))throw Error('Frontend identity collision');
    verify(directory);if(existsSync(journal))unlinkSync(journal);
    const pointer=resolve(root,'.library-data/frontend-artifacts.json'),references=existsSync(pointer)?JSON.parse(readFileSync(pointer)):{};
    references[manifest.product]={directory,sourceSha256:snapshot.sourceSha256};atomicStorageJSON(pointer,references);return directory;
    };
    return existsSync(resolve(root,'config/library-data.json'))?withLibraryLock(root,install):install();
  });
}
export function retireFrontendSnapshots({root=repository,roots=permanentWorktrees(root),settings=storageSettings(root),apply=false,processes=runningStorageConsumers(),refreshProcesses=()=>processes,afterFile=()=>{}}={}){
  const markerName='frontend-manifest.json',retirementSchema='pando-frontend-retirement-v1';
  if(!settings)throw Error('Application storage is not activated');
  const libraryStore=existsSync(resolve(root,'config/library-data.json'))?{root:librarySharedCheckout(root),blobDirectory:'.pando-store/blobs'}:null;
  const operation=()=>{
    if(processes.some(nativeWriter))throw Error('Active consumers block artifact retirement');
    // Frontend views contain thousands of tiny files. References/leases remain
    // checked per unlink under the owner lock; bound expensive Windows process
    // inventory to once per second.
    let processCheckedAt=0,currentProcesses=processes;
    const latestProcesses=()=>{if(Date.now()-processCheckedAt>=1000){currentProcesses=refreshProcesses();processCheckedAt=Date.now();}return currentProcesses;};
    const base=containedPath(settings.cacheRoot,'frontend'),journal=containedPath(settings.cacheRoot,'frontend-retirement.pending.json');
    for(const name of ['frontend-install.pending.json','native-install.pending.json','generated-retirement.pending.json'])if(existsSync(containedPath(settings.cacheRoot,name)))throw Error('Pending installation blocks frontend retirement');
    const referenced=new Set();
    const leaseReferences=()=>{const refs=new Set();for(const lease of contentFiles(containedPath(settings.cacheRoot,'frontend-leases'))){const record=JSON.parse(readFileSync(lease.path));if(!Number.isInteger(record.pid)||record.pid<=0)throw Error('Invalid artifact lease owner');let alive=true;try{process.kill(record.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else if(e.code!=='EPERM')throw e;}if(alive)refs.add(containedPath(base,record.directory));}return refs;};
    for(const ref of leaseReferences())referenced.add(ref);

    for(const app of roots){const pointer=resolve(app,'.library-data/frontend-artifacts.json');if(existsSync(pointer))for(const ref of Object.values(JSON.parse(readFileSync(pointer))))referenced.add(containedPath(base,ref.directory));}
    let state=existsSync(journal)?JSON.parse(readFileSync(journal)):null;
    if(state&&(state.schema!==retirementSchema||containedPath(base,state.directory)!==state.directory||referenced.has(state.directory)||!Number.isInteger(state.completedCount)||state.completedCount<0||state.completedCount>state.manifest.files.length))throw Error('Pending retirement scope changed');
    if(state?.batch){const batch=state.batch,expected=state.manifest.files.slice(state.completedCount,batch.end);if(!Number.isInteger(batch.end)||batch.end<=state.completedCount||batch.end>state.manifest.files.length||!Array.isArray(batch.files)||batch.files.length!==expected.length||batch.files.some((f,i)=>f.path!==expected[i].path||!Number.isSafeInteger(f.physicalBytes)||f.physicalBytes<0||f.physicalBytes>expected[i].bytes))throw Error('Pending artifact retirement batch changed');}
    const entries=[];let deletedBytes=state?.deletedBytes||0,payloadBytesUnlinked=state?.payloadBytesUnlinked||0;
    const directories=existsSync(base)?readdirSync(base).filter(name=>/^[a-f0-9]{64}$/.test(name)).map(name=>containedPath(base,name)):[];
    for(const directory of directories)if(processes.some(p=>usesDirectory(p,directory)))referenced.add(directory);
    if(state&&!directories.includes(state.directory)){
      if(!apply||!state.markerRetirement||state.completedCount!==state.manifest.files.length)throw Error('Pending frontend directory is missing');
      deletedBytes+=state.markerRetirement.bytes;payloadBytesUnlinked+=state.markerRetirement.bytes;unlinkSync(journal);state=null;
    }
    if(state)directories.sort((a,b)=>Number(b===state.directory)-Number(a===state.directory));
    for(const directory of directories){
      if(referenced.has(directory)){entries.push({directory,status:'referenced'});continue;}
      const marker=containedPath(directory,markerName),manifest=existsSync(marker)?JSON.parse(readFileSync(marker)):state?.directory===directory&&state.markerRetirement?state.manifest:null;
      if(!manifest)throw Error('Frontend ownership marker is missing');
      if(manifest.schema!=='pando-frontend-v1'||directory!==containedPath(base,manifest.sourceSha256)||!Array.isArray(manifest.files)||new Set(manifest.files.map(f=>f.path)).size!==manifest.files.length||manifest.files.some(f=>f.path===markerName))throw Error('Unknown frontend ownership');
      const resumed=state?.directory===directory;
      if(resumed&&JSON.stringify(state.manifest)!==JSON.stringify(manifest))throw Error('Pending frontend manifest changed');
      const completed=resumed?state.completedCount:0,expected=new Set([markerName,...manifest.files.slice(completed).map(file=>file.path)]);
      for(const file of contentFiles(directory))if(!expected.has(file.logical))throw Error('Unlisted frontend file must be preserved: '+file.path);
      for(const file of manifest.files.slice(completed)){
        const target=containedPath(directory,file.path);
        if(!existsSync(target)){if(resumed&&(state.pending?.path===file.path||state.batch?.files.some(f=>f.path===file.path)))continue;throw Error('Frontend file is missing');}
        const s=lstatSync(target);if(!/^[a-f0-9]{64}$/.test(file.sha256)||s.size!==file.bytes||contentHash(readFileSync(target))!==file.sha256||(s.mode&0o200))throw Error('Modified artifact output must be preserved');
      }
      const markerBytes=existsSync(marker)?lstatSync(marker).size:state.markerRetirement.bytes;
      const row={directory,status:'eligible',bytes:manifest.files.reduce((n,f)=>n+f.bytes,0)+markerBytes};entries.push(row);
      if(!apply)continue;
      state=resumed?state:{schema:retirementSchema,directory,manifest,completedCount:0,pending:null,deletedBytes,payloadBytesUnlinked};
      atomicStorageJSON(journal,state);
      while(state.completedCount<manifest.files.length){
        if(leaseReferences().has(directory))throw Error('Artifact acquired a live verification lease during retirement');
        const observed=latestProcesses(),busy=observed.filter(p=>nativeWriter(p)||usesDirectory(p,directory));if(busy.length)throw Error('Active consumer appeared during artifact retirement: '+busy.map(p=>p.ProcessId+':'+p.Name+':'+p.CommandLine).join('; '));
        for(const app of roots){const pointer=resolve(app,'.library-data/frontend-artifacts.json');if(existsSync(pointer)&&Object.values(JSON.parse(readFileSync(pointer))).some(ref=>containedPath(base,ref.directory)===directory))throw Error('Artifact acquired a worktree reference during retirement');}
        const file=manifest.files[state.completedCount],target=containedPath(directory,file.path);
        if(!state.batch){
          const end=Math.min(state.completedCount+64,manifest.files.length);
          state.batch={end,files:manifest.files.slice(state.completedCount,end).map(f=>{const p=containedPath(directory,f.path);return{path:f.path,physicalBytes:existsSync(p)?(lstatSync(p).nlink===1?f.bytes:0):state.pending?.path===f.path?state.pending.physicalBytes:0};})};
          atomicStorageJSON(journal,state);
        }
        const planned=state.batch.files.find(f=>f.path===file.path);if(!planned)throw Error('Invalid artifact retirement batch');
        if(existsSync(target)){
          const s=lstatSync(target);if(s.size!==file.bytes||contentHash(readFileSync(target))!==file.sha256)throw Error('Frontend changed before retirement');
          state.pending={path:file.path,physicalBytes:s.nlink===1?file.bytes:0};
          const candidate=libraryStore?contentPath(libraryStore,file.sha256):null;
          const shared=candidate&&existsSync(candidate)&&statSync(candidate,{bigint:true}).ino===statSync(target,{bigint:true}).ino?libraryStore:null;
          removeContentView(shared||{root:settings.cacheRoot,blobDirectory:'blobs'},target,{viewRoot:directory,marker:markerName});
        }
        state.deletedBytes+=file.bytes;state.payloadBytesUnlinked+=state.pending?.physicalBytes??planned.physicalBytes;state.pending=null;state.completedCount++;
        if(state.completedCount===state.batch.end){state.batch=null;atomicStorageJSON(journal,state);}afterFile(file);
      }
      state.markerRetirement={bytes:markerBytes};atomicStorageJSON(journal,state);
      if(existsSync(marker))unlinkSync(marker);state.deletedBytes+=markerBytes;state.payloadBytesUnlinked+=markerBytes;
      const prune=folder=>{for(const child of readdirSync(folder,{withFileTypes:true})){if(!child.isDirectory()||child.isSymbolicLink())throw Error('Unexpected frontend retirement remnant');prune(containedPath(folder,child.name));}rmdirSync(folder);};prune(directory);
      deletedBytes=state.deletedBytes;payloadBytesUnlinked=state.payloadBytesUnlinked;unlinkSync(journal);state=null;row.status='removed';
    }
    return{apply,entries,deletedBytes,payloadBytesUnlinked};
  };
  if(!apply)return operation();
  return withStorageLock(root,settings,()=>existsSync(resolve(root,'config/library-data.json'))?withLibraryLock(root,operation,{compact:false}):operation());
}
export function finishArtifactMaintenance({root=repository,roots=permanentWorktrees(root),settings=storageSettings(root),processes=runningStorageConsumers()}={}){
  const marker=containedPath(settings.cacheRoot,'artifact-maintenance.requested.json');
  atomicStorageJSON(marker,{root,requestedAt:new Date().toISOString()});
  if(processes.some(nativeWriter))return {status:'deferred',reason:'active build or stage writer'};
  const options={root,roots,settings,processes,refreshProcesses:runningStorageConsumers,apply:true};
  try{
    const frontend=retireFrontendSnapshots(options),blobs=pruneApplicationBlobs(options);
    unlinkSync(marker);return {status:'completed',frontend,blobs};
  }catch(error){
    const result={status:'blocked',code:'PL-STORAGE-MAINTENANCE',message:error.message};
    atomicStorageJSON(marker,{...result,root,diagnostic:error.stack});process.stderr.write(result.code+': '+result.message+'\n');return result;
  }
}

function withStorageLock(root,settings,operation){
  mkdirSync(settings.cacheRoot,{recursive:true});
  const path=containedPath(settings.cacheRoot,'storage.lock');
  discardDeadLibraryLock(path);let fd;
  try{fd=openSync(path,'wx');}catch(error){throw Error('Worktree storage is already running; preserve its journal and retry',{cause:error});}
  try{writeFileSync(fd,JSON.stringify({pid:process.pid,root}));recoverContentPermissions({root:settings.cacheRoot,blobDirectory:'blobs'});return operation();}
  finally{closeSync(fd);unlinkSync(path);}
}
const fileIdentity=path=>{const s=lstatSync(path,{bigint:true});return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;};
function isRetiringEmsdkConsumer(p){
  return /^D:\/build\/toolchains\/emsdk-6\.0\.3\//i.test((p.ExecutablePath||'').replaceAll('\\','/'))||
    /D:\/build\/toolchains\/emsdk-6\.0\.3(?=[/\s"']|$)/i.test((p.CommandLine||'').replaceAll('\\','/'));
}
export function isStorageConsumer(p){
  const name=p.Name||'',command=p.CommandLine||'';
  return isRetiringEmsdkConsumer(p)||
    /^(cargo|rustc|rust-lld|cmake|ninja|msbuild|gradle|emulator|qemu-system-[\w-]+|pandolab.*|baseline-ui_tests|candidate-ui_tests)\.exe$/i.test(name)||
    (/^java(w)?\.exe$/i.test(name)&&/gradle/i.test(command))||
    (/^(msedgewebview2|chrome|msedge)\.exe$/i.test(name)&&/PandoLab|worktrees/i.test(command))||
    (/^node\.exe$/i.test(name)&&/stage\.mjs|dev\.mjs|frontend-dev-server\.mjs|tests[\\/]browser[\\/]server\.mjs|tools[\\/]build-[\w-]+\.mjs|tauri.*(dev|build)/i.test(command));
}
export function storageConsumersFromProcesses(processes){
  return processes.filter(isStorageConsumer).map(p=>isRetiringEmsdkConsumer(p)?{...p,globalBuild:true}:p);
}
export function runningStorageConsumers(){
  if(process.platform!=='win32')throw Error('Consumer inventory requires this Windows host');
  const inventory='Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Compress';
  const json=execFileSync('powershell.exe',['-NoProfile','-Command',inventory],{encoding:'utf8',windowsHide:true,maxBuffer:8*1024**2}).trim();
  return json?storageConsumersFromProcesses([JSON.parse(json)].flat()):[];
}
export function parseAvailableWorktrees(listing,exists=existsSync){
 return listing.split(/\r?\n\r?\n/).filter(Boolean).flatMap(block=>{
  const lines=block.split(/\r?\n/),header=lines.find(line=>line.startsWith('worktree '));
  if(!header)throw Error('Malformed worktree inventory');
  const path=resolve(header.slice(9));
  if(exists(path))return [path];
  if(lines.some(line=>line==='prunable'||line.startsWith('prunable ')))return [];
  throw Error(`Registered worktree is missing: ${path}`);
 });
}
export function permanentWorktrees(root=repository){return parseAvailableWorktrees(execFileSync('git',['-C',root,'worktree','list','--porcelain'],{encoding:'utf8',windowsHide:true}));}
export function protectedWorktreeFiles(roots){return roots.flatMap(app=>execFileSync('git',['-C',app,'ls-files','-z','--cached','--others','--exclude-standard'],{encoding:'utf8',windowsHide:true}).split('\0').filter(Boolean).map(path=>resolve(app,path)));}
function storageBusy(root,processes){
 if(existsSync(resolve(root,'.library-data/prepare.lock')))return 'Active library preparation lock';
 if(processes.length)return 'Active storage consumer: '+processes.map(p=>p.ProcessId+':'+p.Name).join(', ');
 return null;
}
export function pruneApplicationBlobs({root=repository,roots=permanentWorktrees(root),settings=storageSettings(root),apply=false,processes=runningStorageConsumers()}={}){
  if(!settings)throw Error('Worktree storage is not activated');
  const operation=()=>{
    for(const name of ['migration.pending.json','runtime-migration.pending.json','generated-retirement.pending.json','app-git-compaction.pending.json','native-install.pending.json','frontend-install.pending.json','frontend-retirement.pending.json','native-retirement.pending.json'])if(existsSync(containedPath(settings.cacheRoot,name)))throw Error(`Pending recovery journal blocks blob pruning: ${name}`);
    const busy=roots.map(app=>storageBusy(app,processes)).find(Boolean);if(busy)throw Error(busy);
    const store={root:settings.cacheRoot,blobDirectory:'blobs'},directory=containedPath(settings.cacheRoot,'blobs'),entries=[];
    const before=statfsSync(settings.cacheRoot);
    for(const file of contentFiles(directory)){
      const s=lstatSync(file.path);if(s.nlink!==1)continue;
      if(processes.some(p=>String(p.ExecutablePath||'').replaceAll('\\','/').toLowerCase()===file.path.replaceAll('\\','/').toLowerCase()))continue;
      const row={path:file.path,bytes:s.size,status:'protected'};entries.push(row);
      if(!/^[a-f0-9]{64}$/.test(file.logical)||contentHash(readFileSync(file.path))!==file.logical){row.reason='Unknown or modified pool object';continue;}
      const identity=fileIdentity(file.path);row.status='unused-blob';
      if(apply){
        if(lstatSync(file.path).nlink!==1||fileIdentity(file.path)!==identity)throw Error('Pool object changed before removal');
        containedPath(settings.cacheRoot,file.path);chmodSync(file.path,0o600);unlinkSync(file.path);row.status='removed';
      }
    }
    recoverContentPermissions(store);
    const after=statfsSync(settings.cacheRoot);
    return {schema,apply,entries,deletedBytes:entries.filter(x=>x.status==='removed').reduce((n,x)=>n+x.bytes,0),freeBytesBefore:before.bavail*before.bsize,freeBytesAfter:after.bavail*after.bsize,freeBytesDelta:(after.bavail-before.bavail)*after.bsize};
  };
  return apply?withStorageLock(root,settings,operation):operation();
}
export function commonGit(root){return resolve(root,execFileSync('git',['-C',root,'rev-parse','--git-common-dir'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim());}
export function storageSettings(root){
  if(!existsSync(join(root,'.git')))return null;
  const path=join(commonGit(root),'pando-storage.json');
  if(!existsSync(path))return null;
  const settings=JSON.parse(readFileSync(path,'utf8'));
  if(settings.schema===schema&&settings.compilerEnabled===false)return settings;
  if(settings.schema!==schema||settings.version!=='0.19.0'||!/^[a-f0-9]{64}$/.test(settings.toolSha256))throw Error('Invalid activated worktree storage configuration');
  return settings;
}
export function assertCompilerCacheServer(settings,server){
  const normalize=value=>value.replace(/\\+/g,'/').replace(/\/$/,'').toLowerCase();
  const location=server.cache_location?.match(/^Local disk: "(.+)"$/)?.[1];
  if(server.version!==settings.version||server.max_cache_size!==cacheLimit||!location||normalize(location)!==normalize(join(settings.cacheRoot,'sccache'))||server.basedirs?.length)throw Error('Activated compiler cache server ownership/configuration mismatch');
}
export function compilerCacheEnvironment({root=repository,env=process.env,settings=storageSettings(root)}={}){
  const result={...env};
  // Detached candidate checkouts and Codespaces never reuse a retired local
  // compiler wrapper, even when a previous worktree left storage activated.
  if(remoteOnlyBranch({root,environment:env})&&env.GITHUB_ACTIONS!=='true'){
    if(settings){
      for(const key of ['RUSTC_WRAPPER','CMAKE_C_COMPILER_LAUNCHER',
        'CMAKE_CXX_COMPILER_LAUNCHER','EM_COMPILER_WRAPPER'])
        if(result[key]===settings.tool)delete result[key];
      if(result.SCCACHE_DIR&&resolve(result.SCCACHE_DIR)===resolve(settings.cacheRoot,'sccache'))
        for(const key of Object.keys(result))if(key.startsWith('SCCACHE_'))delete result[key];
    }
    return result;
  }
  if(!settings)return result;
  if(settings.schema!==schema)throw Error('Invalid compiler cache configuration');
  if(settings.compilerEnabled===false){
    for(const key of ['RUSTC_WRAPPER','CMAKE_C_COMPILER_LAUNCHER','CMAKE_CXX_COMPILER_LAUNCHER','EM_COMPILER_WRAPPER'])if(result[key]===settings.tool)delete result[key];
    if(result.SCCACHE_DIR&&resolve(result.SCCACHE_DIR)===resolve(settings.cacheRoot,'sccache'))for(const key of Object.keys(result))if(key.startsWith('SCCACHE_'))delete result[key];
    return result;
  }
  if(settings.schema!==schema||!Number.isInteger(settings.port)||settings.port<1024||settings.port>65535)throw Error('Invalid compiler cache configuration');
  if(!existsSync(settings.tool)||contentHash(readFileSync(settings.tool))!==settings.toolSha256)throw Error('Activated compiler cache tool integrity failed');
  const values={RUSTC_WRAPPER:settings.tool,CMAKE_C_COMPILER_LAUNCHER:settings.tool,CMAKE_CXX_COMPILER_LAUNCHER:settings.tool,
    EM_COMPILER_WRAPPER:settings.tool,SCCACHE_DIR:join(settings.cacheRoot,'sccache'),SCCACHE_CACHE_SIZE:String(cacheLimit),
    SCCACHE_SERVER_PORT:String(settings.port),SCCACHE_SERVER_UDS:'',SCCACHE_IGNORE_SERVER_IO_ERROR:'0',SCCACHE_BASEDIRS:settings.basedirs?.join(';')||''};
  for(const [key,value]of Object.entries(values)){
    if(result[key]&&result[key]!==value)throw Error(`Compiler cache configuration conflict: ${key}`);
    if(value)result[key]=value;
  }
  if(settings.version){
    const server=JSON.parse(execFileSync(settings.tool,['--show-stats','--stats-format=json'],{env:result,encoding:'utf8',windowsHide:true,timeout:15000}));
    assertCompilerCacheServer(settings,server);
  }
  return result;
}
function stopOwnedCompilerServer(settings){
  const command=`@(Get-NetTCPConnection -LocalPort ${settings.port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {Get-CimInstance Win32_Process -Filter ('ProcessId='+$_)} | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress`;
  const text=execFileSync('powershell.exe',['-NoProfile','-Command',command],{encoding:'utf8',windowsHide:true}).trim(),owners=text?[JSON.parse(text)].flat():[];
  if(!owners.length)return;
  if(owners.length!==1||resolve(owners[0].ExecutablePath||'')!==resolve(settings.tool))throw Error('Compiler port belongs to another process; preserve it');
  if(contentHash(readFileSync(settings.tool))!==settings.toolSha256)throw Error('Compiler server executable changed');
  const env={...process.env,SCCACHE_DIR:join(settings.cacheRoot,'sccache'),SCCACHE_SERVER_PORT:String(settings.port),SCCACHE_CACHE_SIZE:String(cacheLimit)};
  const server=JSON.parse(execFileSync(settings.tool,['--show-stats','--stats-format=json'],{env,encoding:'utf8',windowsHide:true}));assertCompilerCacheServer(settings,server);
  execFileSync(settings.tool,['--stop-server'],{env,stdio:'pipe',windowsHide:true});
}
export function deactivateCompilerCache({root=repository,settings=storageSettings(root),processes=runningStorageConsumers(),stopServer=stopOwnedCompilerServer}={}){
  if(!settings)throw Error('Application storage is not activated');
  if(processes.some(p=>/^(cargo|rustc|rust-lld|cmake|ninja|msbuild|gradle)\.exe$/i.test(p.Name||'')||/^java(w)?\.exe$/i.test(p.Name||'')&&/gradle/i.test(p.CommandLine||'')))throw Error('An active native build blocks compiler deactivation');
  return withStorageLock(root,settings,()=>{if(settings.compilerEnabled!==false)stopServer(settings);const next={...settings,compilerEnabled:false};atomicStorageJSON(join(commonGit(root),'pando-storage.json'),next);return{compilerActive:false,applicationStorageActive:true,cacheRoot:settings.cacheRoot};});
}
export async function activateCompilerCache(root=repository,{environment=process.env,branch}={}){
  assertRemoteOnlyNativeAllowed({root,environment,branch,operation:'compiler-cache SDK activation'});
  const versions=JSON.parse(readFileSync(join(root,'config/toolchain-versions.json'),'utf8')).sccache;
  const toolDirectory=`D:/build/toolchains/sccache/${versions.version}`,tool=join(toolDirectory,'sccache.exe');
  const cacheRoot='D:/build/cache/pandolab';
  const existing=storageSettings(root),receipt=join(toolDirectory,'installation.json');
  mkdirSync(cacheRoot,{recursive:true});containedPath(cacheRoot,'blobs');
  const fs=statfsSync(cacheRoot);if(fs.bavail*fs.bsize<8*1024**3)throw Error('Insufficient headroom for 3GiB peak + 5GiB');
  if(!existsSync(tool)){
    if(existsSync(toolDirectory)&&readdirSync(toolDirectory).length)throw Error('Preserve unexpected existing tool installation');
    mkdirSync(toolDirectory,{recursive:true});
    const archive=join(toolDirectory,'download.zip'),unpacked=join(toolDirectory,'unpacked');
    if(existsSync(archive)||existsSync(unpacked))throw Error('Preserve unfinished sccache download; inspect before resuming installation');
    const response=await fetch(versions.url);if(!response.ok)throw Error(`sccache download failed: ${response.status}`);
    const bytes=Buffer.from(await response.arrayBuffer());
    if(contentHash(bytes)!==versions.sha256)throw Error('Official sccache archive integrity failed');
    writeFileSync(archive,bytes,{flag:'wx'});
    execFileSync('tar.exe',['-xf',archive,'-C',toolDirectory],{windowsHide:true,stdio:'pipe'});
    // Only the fixed official executable is installed. Extraction remnants are task-owned.
    const {copyFileSync,rmSync}=await import('node:fs');
    const extracted=join(toolDirectory,`sccache-v${versions.version}-x86_64-pc-windows-msvc`);
    copyFileSync(join(extracted,'sccache.exe'),tool,1);
    atomicStorageJSON(receipt,{version:versions.version,archiveSha256:versions.sha256,toolSha256:contentHash(readFileSync(tool))});
    rmSync(extracted,{recursive:true});unlinkSync(archive);
  }
  const recorded=existsSync(receipt)?JSON.parse(readFileSync(receipt,'utf8')):null;
  if(recorded ? recorded.version!==versions.version||recorded.archiveSha256!==versions.sha256||recorded.toolSha256!==contentHash(readFileSync(tool)) : !existing||existing.tool!==tool||existing.toolSha256!==contentHash(readFileSync(tool)))throw Error('Unowned or modified compiler cache installation; preserve it for inspection');
  const version=execFileSync(tool,['--version'],{encoding:'utf8',windowsHide:true}).trim();
  if(version!==`sccache ${versions.version}`)throw Error('Unexpected sccache version');
  const settings={schema,cacheRoot,tool,toolSha256:contentHash(readFileSync(tool)),port:42427,version:versions.version};
  if(existing&&JSON.stringify(existing)!==JSON.stringify(settings))throw Error('Preserve existing storage activation; configuration differs');
  compilerCacheEnvironment({root,settings});
  if(!existing){
    const {createServer}=await import('node:net');
    const server=createServer();await new Promise((yes,no)=>{server.once('error',no);server.listen(settings.port,'127.0.0.1',yes);});
    await new Promise(yes=>server.close(yes));
    atomicStorageJSON(join(commonGit(root),'pando-storage.json'),settings);
  }
  console.log(JSON.stringify(settings));return settings;
}

async function main(){
  const args=process.argv.slice(2),root=resolve(args.find(x=>x.startsWith('--root='))?.slice(7)||repository);
  const cacheMode=args.find(x=>x.startsWith('--cleanup-caches='))?.split('=')[1];
  if(cacheMode){const {cleanupCDrive}=await import("../pc-cleanup.mjs");return cleanupCDrive({mode:cacheMode,root,settings:storageSettings(root),library:librarySharedCheckout(root),cacheOnly:true});}
  const pcMode=args.find(x=>x.startsWith('--cleanup-c-drive='))?.split('=')[1];
  if(pcMode){const {cleanupCDrive}=await import("../pc-cleanup.mjs");return cleanupCDrive({mode:pcMode,root,settings:storageSettings(root),library:librarySharedCheckout(root)});}
  if(args.includes('--compact-git')){
    const shared=dirname(commonGit(root)),settings=storageSettings(root),progress=message=>console.error('App Git storage: '+message);
    if(!settings)throw Error('Worktree storage activation required');
    const operation=()=>{
      const journalPath=containedPath(settings.cacheRoot,'app-git-compaction.pending.json');
      const busy=execFileSync('powershell.exe',['-NoProfile','-Command',"@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(git|git-pack-objects|git-index-pack)\\.exe$' }).Count"],{encoding:'utf8',windowsHide:true}).trim();
      if(busy!=='0')throw Error('Another Git operation is active; retry after it finishes');
      const journal=existsSync(journalPath)?JSON.parse(readFileSync(journalPath,'utf8')):snapshotGitStorage(shared,progress);
      const save=()=>atomicStorageJSON(journalPath,journal);
      if(args.includes('--apply')){save();progress('packing and independently verifying all local objects');repackLocalObjects(shared,journal,save);}
      const output=args.find(x=>x.startsWith('--output='))?.slice(9);if(output)atomicStorageJSON(resolve(output),journal);
      if(args.includes('--apply'))unlinkSync(journalPath);
      console.log(JSON.stringify({objects:journal.objects.length,phase:journal.phase,deletedBytes:journal.deleted.reduce((n,x)=>n+x.bytes,0),output}));
    };
    return args.includes('--apply')?withStorageLock(root,settings,operation):operation();
  }
  const retirement=args.find(x=>x.startsWith('--retire-generated='))?.slice('--retire-generated='.length);
  if(retirement){
    const worktrees=permanentWorktrees(root),settings=storageSettings(root),input=JSON.parse(readFileSync(retirement,'utf8'));
    const compilerScopes=args.includes('--retire-compilers')?[...worktrees.map(root=>({root,kind:'worktree'})),{root:'D:/build/toolchains',kind:'toolchains'},{root:'C:/Users/taeeu/AppData/Local/Android/Sdk',kind:'android-sdk'},{root:'D:/Android/Sdk',kind:'retired-android-sdk'},{root:'D:/Android/avd',kind:'avd'},{root:'C:/Users/taeeu/.android/avd',kind:'avd'},{root:'D:/build/cache/pandolab',kind:'compiler-cache'}]:[];
    if(compilerScopes.length&&settings?.compilerEnabled!==false)throw Error('Disable local compilers after actual runtime acceptance before retiring SDKs');
    const roots=[...new Set([...worktrees,...compilerScopes.map(s=>s.root)])];
    if(!settings)throw Error('Worktree storage activation required');
    const protectedPaths=protectedWorktreeFiles(worktrees);
    const relocationRoots=[resolve(librarySharedCheckout(root),'private-evidence/worktree-storage/generated-cleanup-20261025'),resolve(librarySharedCheckout(root),'private-evidence/worktree-storage/workspace-layout-20261025'),resolve('D:/build/toolchains')];
    const proof=args.find(x=>x.startsWith('--verified-compiler-preview='))?.slice('--verified-compiler-preview='.length);
    const options={roots,compilerScopes,consumers:runningStorageConsumers(),refreshConsumers:runningStorageConsumers,protectedPaths,relocationRoots,verifiedPreview:proof?JSON.parse(readFileSync(proof,'utf8')):null,progress:message=>console.error('Generated cleanup: '+message)};
    const operation=()=>input.schema?applyGeneratedCleanup({...options,manifest:input,journal:resolve(settings.cacheRoot,'generated-retirement.pending.json')}):previewGeneratedCleanup({...options,requests:input.requests});
    if(!!input.schema!==args.includes('--apply'))throw Error('Preview requires requests; apply requires the exact preview manifest');
    const result=args.includes('--apply')?withStorageLock(root,settings,operation):operation();
    const output=args.find(x=>x.startsWith('--output='))?.slice(9);if(output)atomicStorageJSON(resolve(output),result);
    console.log(JSON.stringify({entries:result.entries?.length,deletedBytes:result.deletedBytes,relocatedBytes:result.relocatedBytes,payloadBytesUnlinked:result.payloadBytesUnlinked,output}));return;
  }
  if(args.includes('--prepare-dependencies')){console.log(JSON.stringify(prepareDependencies(root)));return;}
  if(args.includes('--retire-frontend')){console.log(JSON.stringify(retireFrontendSnapshots({root,apply:args.includes('--apply')})));return;}
  if(args.includes('--activate-compiler-cache'))return activateCompilerCache(root);
  if(args.includes('--disable-local-compiler')){console.log(JSON.stringify(deactivateCompilerCache({root})));return;}
  const compilerValues=()=>remoteOnlyBranch({root})||storageSettings(root)?.compilerEnabled===false?{}:Object.fromEntries(Object.entries(compilerCacheEnvironment({root})).filter(([key])=>/^(RUSTC_WRAPPER|CMAKE_C_COMPILER_LAUNCHER|CMAKE_CXX_COMPILER_LAUNCHER|EM_COMPILER_WRAPPER|SCCACHE_\w+)$/.test(key)));
  if(args.includes('--compiler-config')){const settings=storageSettings(root);console.log(JSON.stringify({active:!remoteOnlyBranch({root})&&!!settings&&settings.compilerEnabled!==false,env:settings?compilerValues():{}}));return;}
  if(args.includes('--compiler-env')){console.log(JSON.stringify(storageSettings(root)?compilerValues():{}));return;}
  if(args.includes('--with-compiler-cache')){
    assertRemoteOnlyNativeAllowed({root,operation:'local compiler wrapper execution'});
    const index=args.indexOf('--'),command=args.slice(index+1);
    if(index<0||!command.length)throw Error('Expected --with-compiler-cache -- command arguments');
    const result=spawnSync(command[0],command.slice(1),{cwd:process.cwd(),env:compilerCacheEnvironment({root}),stdio:'inherit',windowsHide:true});
    if(result.error)throw result.error;process.exitCode=result.status??1;return;
  }
  if(!args.includes('--prune-blobs'))throw Error('Choose an explicit storage operation: --prune-blobs, --retire-frontend or --retire-generated=<manifest>');
  const result=pruneApplicationBlobs({root,apply:args.includes('--apply')});
  const output=args.find(x=>x.startsWith('--output='))?.slice(9);
  if(output)atomicStorageJSON(resolve(output),result);
  console.log(JSON.stringify({apply:result.apply,entries:result.entries.length,statuses:Object.fromEntries([...new Set(result.entries.map(x=>x.status))].map(status=>[status,result.entries.filter(x=>x.status===status).length])),freeBytesDelta:result.freeBytesDelta,output}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
