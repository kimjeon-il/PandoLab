export function installPerformanceProbe(){
 performance.setResourceTimingBufferSize(5000);
 const workers={},longTasks={count:0,totalMs:0,maxMs:0};
 const post=Worker.prototype.postMessage,observed=new WeakSet();
 const geometry={requests:0,packetBytes:0};
 window.__PANDO_PERF_GEOMETRY__=()=>({...geometry});
 Worker.prototype.postMessage=function(message,...rest){
  if(!observed.has(this)){
   observed.add(this);this.__pandoPerfRequests=new Map();
   this.addEventListener('message',event=>{
    const result=event.data,start=this.__pandoPerfRequests.get(result?.requestId);
    if(result?.type!=='result'||!start)return;
    this.__pandoPerfRequests.delete(result.requestId);
    const elapsed=performance.now()-start.at,row=workers[start.operation]||={count:0,totalMs:0,maxMs:0};
    row.count++;row.totalMs+=elapsed;row.maxMs=Math.max(row.maxMs,elapsed);
    if(start.operation==='geometry.prepare'){
     // Both runtime versions transfer these unique packet backing buffers.
     const buffers=new Set();
     for(const {packet} of result.result?.packets||[]){
      for(const value of Object.values(packet||{}))if(ArrayBuffer.isView(value))buffers.add(value.buffer);
     }
     for(const buffer of buffers)geometry.packetBytes+=buffer.byteLength;
    }
   });
  }
  if(message?.type==='request'&&message.operation){
   this.__pandoPerfRequests.set(message.requestId,{at:performance.now(),operation:message.operation});
   if(message.operation.startsWith('geometry.'))geometry.requests++;
  }
  return post.call(this,message,...rest);
 };
 try{new window.PerformanceObserver(list=>{for(const task of list.getEntries()){longTasks.count++;longTasks.totalMs+=task.duration;longTasks.maxMs=Math.max(longTasks.maxMs,task.duration);}}).observe({type:'longtask',buffered:true});}catch{/* Unsupported measurements stay empty. */}
 window.__PANDO_PERF_DIAGNOSTICS__=()=>({workers:structuredClone(workers),longTasks:{...longTasks},resources:performance.getEntriesByType('resource').map(r=>({name:r.name,startTime:r.startTime,duration:r.duration,transferSize:r.transferSize,decodedBodySize:r.decodedBodySize}))});
}

export async function performanceIdentity(page,response){
 const identity=await page.evaluate(async()=>{const meta=window.PANDOLAB_BUILD_META,u=new URL('assets/wasm/pandoeditor-core.manifest.json',document.baseURI);u.searchParams.set('v',meta.assetRevision);const response=await fetch(u);if(!response.ok)throw Error('Missing performance WASM identity');const bytes=await response.arrayBuffer(),digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');return {wasmManifestSha256:digest,viewport:{width:window.innerWidth,height:window.innerHeight,dpr:window.devicePixelRatio},userAgent:navigator.userAgent};});
 return {...identity,browserVersion:page.context().browser().version(),sourceSha256:response.headers()['x-pando-test-source-sha256'],dataPin:response.headers()['x-pando-test-data-pin']};
}
