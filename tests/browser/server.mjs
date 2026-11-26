import {mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {buildFrontendSnapshot} from '../../scripts/lib/frontend-build.mjs';
import {createBranchPreviewServer} from '../../scripts/branch-preview-server.mjs';
import {libraryConfig,libraryCheckout,git,decodeArchiveEntries,decodeArchiveEntry,libraryRuntimeLeasePath} from '../../tools/data/library-context.mjs';

const root=resolve(process.cwd()),port=Number(process.env.PANDOLAB_TEST_PORT||4187);
const config=libraryConfig(root),checkout=libraryCheckout(root);
const index=JSON.parse(git(checkout,['show',config.revision+':archive/index.json']));
const readPinnedData=path=>{
  const entry=index.files[path];
  if(!entry)throw Error('Missing pinned Viewer asset: '+path);
  return decodeArchiveEntry(checkout,entry,config.revision,{fetch:process.env.CI==='true'});
};
const readPinnedDataBatch=paths=>decodeArchiveEntries(checkout,new Map(paths.map(path=>[path,index.files[path]])),config.revision,{fetch:process.env.CI==='true'});
const snapshot=await buildFrontendSnapshot({root,readPinnedData,readPinnedDataBatch,
  dataPaths:Object.keys(index.files).filter(path=>path.startsWith('assets/data/'))});
// Decode requested immutable assets only. Never materialize a library checkout.
const assets=new Map([...snapshot.assets].filter(([path])=>snapshot.viewerPaths.has(path)));
const server=createBranchPreviewServer(root,{reports:false,pinnedAssetsOnly:true,assets:()=>assets,
  handleRequest(_request,response,pathname){
    response.setHeader('X-Pando-Test-Source-SHA256',snapshot.sourceSha256);
    response.setHeader('X-Pando-Test-Source-Commit',snapshot.sourceCommit);
    response.setHeader('X-Pando-Test-Data-Pin',config.revision);
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
