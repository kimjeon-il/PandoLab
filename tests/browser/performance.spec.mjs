import { test, expect } from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {installPerformanceProbe,performanceIdentity} from './performance-probe.mjs';

// Timestamp approval inside the browser, rather than the later Playwright poll.
function captureInitialPresentation(){
 const probe=()=>{const viewer=window.__PANDOLAB_VIEWER__;
  if(viewer?.initialMapPresented()&&viewer.rendererStats().mapReadiness.mapReady){window.__PANDO_PERF_INITIAL_MS__=performance.now();return;}
  requestAnimationFrame(probe);
 };requestAnimationFrame(probe);
}

function startInteractionCostProbe(){
 const map=window.__PANDOLAB_MAPLIBRE__,restore=[];
 const beforeGeometry=window.__PANDO_PERF_GEOMETRY__();
 let layerMoves=0,sourceWrites=0;
 function observe(target,key,count){
  const original=target[key];
  if(typeof original!=='function')return;
  const own=Object.getOwnPropertyDescriptor(target,key);
  target[key]=function(...args){count();return original.apply(this,args);};
  restore.push(()=>{if(own)Object.defineProperty(target,key,own);else delete target[key];});
 }
 observe(map,'moveLayer',()=>layerMoves++);
 const sourceOwners=new Set();
 for(const id of Object.keys(map.getStyle().sources)){
  const source=map.getSource(id);
  if(!source||typeof source.setData!=='function')continue;
  sourceOwners.add(Object.getPrototypeOf(source));
 }
 for(const owner of sourceOwners)for(const method of ['setData','updateData'])observe(owner,method,()=>sourceWrites++);
 window.__PANDO_PERF_INTERACTION_COST__=()=>{
  for(const cleanup of restore)cleanup();
  delete window.__PANDO_PERF_INTERACTION_COST__;
  const afterGeometry=window.__PANDO_PERF_GEOMETRY__();
  return {layerMoves,sourceWrites,geometryWorkerRequests:afterGeometry.requests-beforeGeometry.requests,
   geometryWorkerTransferBytes:afterGeometry.packetBytes-beforeGeometry.packetBytes};
 };
}

// Observe the actual painted framebuffer from the same MapLibre render event
// used by the visual regressions, without treating a source write as a frame.
async function armPaintedInteraction({kind,target,samples,edge}){
 const map=window.__PANDOLAB_MAPLIBRE__,viewer=window.__PANDOLAB_VIEWER__;
 const canvas=map.getCanvas(),gl=canvas.getContext('webgl2'),ratio=map.getPixelRatio();
 const projected=coordinate=>{
  const p=map.project(coordinate);
  return [Math.round(p.x*ratio),canvas.height-1-Math.round(p.y*ratio)];
 };
 const points=samples.map(projected),edgePoint=edge&&projected(edge);
 const pixel=new Uint8Array(4),edgePixels=new Uint8Array(7*7*4);
 function readFill(){
  return points.map(([x,y])=>{
   gl.readPixels(x,y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
   return [pixel[0],pixel[1],pixel[2]];
  });
 }
 function readEdge(){
  if(!edgePoint)return true;
  gl.readPixels(edgePoint[0]-3,edgePoint[1]-3,7,7,gl.RGBA,gl.UNSIGNED_BYTE,edgePixels);
  return edgePixels.some((red,index)=>index%4===0&&red<80&&edgePixels[index+1]>70
   &&edgePixels[index+1]<190&&edgePixels[index+2]>200);
 }
 const baseline=await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{
   map.off('render',check);
   reject(new Error('The previous selection outline did not clear before the next measured input.'));
  },8000);
  const check=()=>{
   if(edgePoint&&readEdge())return;
   clearTimeout(timeout);
   map.off('render',check);
   resolve(readFill());
  };
  map.on('render',check);
  map.triggerRepaint();
 });
 const previousPhases=viewer.rendererStats().performance.phases;
 const eventName=kind==='hover'?'pointermove':'click';
 let started=null,firstPick=null,firstSource=null,firstFill=null,firstEdge=null;
 window.__PANDO_PERF_PAINTED_INTERACTION__=null;
 window.__PANDO_PERF_PAINTED_DETAIL__={kind,baseline};
 const begin=event=>{if(event.target===canvas)started=performance.now();};
 canvas.addEventListener(eventName,begin,{capture:true,once:true});
 const source=event=>{
  if(started!==null&&firstSource===null&&['interaction','interaction-standby'].includes(event.sourceId)&&event.isSourceLoaded)
   firstSource=performance.now()-started;
 };
 map.on('sourcedata',source);
 const render=()=>{
  if(started===null)return;
  const elapsedMs=performance.now()-started;
  const tooltip=document.querySelector('#uiTooltip');
  const picked=kind==='hover'?tooltip?.getAttribute('aria-hidden')==='false'&&tooltip.textContent.includes('남극')
   :viewer.selectionSnapshot().primaryKey==='territorial:entity:ATA';
  if(picked&&firstPick===null)firstPick=elapsedMs;
  const colors=readFill();
  const fill=colors.every((rgb,i)=>rgb.some((value,j)=>Math.abs(value-baseline[i][j])>4));
  const edgeDrawn=readEdge();
  window.__PANDO_PERF_PAINTED_DETAIL__={kind,baseline,colors,picked,fill,edgeDrawn};
  if(fill&&firstFill===null)firstFill=elapsedMs;
  if(edgeDrawn&&firstEdge===null)firstEdge=elapsedMs;
  if(picked&&fill&&edgeDrawn){
   map.off('render',render);
   map.off('sourcedata',source);
   const {highlight,performance:timings}=viewer.rendererStats();
   const phases={};
   for(const [phase,timing] of Object.entries(timings.phases)){
    if(!phase.startsWith('highlight.')&&phase!=='source:interaction')continue;
    const previous=previousPhases[phase];
    const count=timing.count-(previous?.count||0);
    if(count>0)phases[phase]={count,totalMs:timing.totalMs-(previous?.totalMs||0)};
   }
   window.__PANDO_PERF_PAINTED_INTERACTION__={elapsedMs,firstPick,firstSource,firstFill,
    firstEdge:edgePoint?firstEdge:null,highlight:highlight||null,phases};
  }
 };
 map.on('render',render);
 const rect=canvas.getBoundingClientRect(),point=map.project(target);
 return {x:rect.x+point.x,y:rect.y+point.y};
}

for(const iteration of [1,2,3])test(`input to painted Antarctic hover and selection repeat ${iteration}`,async({page},testInfo)=>{
 test.skip(process.env.PANDO_PERF_CAPTURE!=='1','Explicit performance capture required');
 test.setTimeout(160000);
 await page.setViewportSize({width:900,height:850});
 await page.addInitScript(installPerformanceProbe);
 await page.addInitScript(captureInitialPresentation);
 const navigation=await page.goto('./?debug=1',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>Number.isFinite(window.__PANDO_PERF_INITIAL_MS__),null,{timeout:90000});
 const camera=async(center,zoom)=>{
  await page.evaluate(({center,zoom})=>{window.__PANDOLAB_MAPLIBRE__.jumpTo({center,zoom});},{center,zoom});
  await page.waitForFunction(()=>{
   const stats=window.__PANDOLAB_VIEWER__.rendererStats();
   return stats.mapReadiness.mapReady&&!stats.mapMoving&&stats.certifiedRevision===stats.sourceRevision;
  },null,{timeout:45000});
 };
 const waitPaint=async()=>{
  const handle=await page.waitForFunction(()=>window.__PANDO_PERF_PAINTED_INTERACTION__,null,{timeout:8000}).catch(async error=>{
   throw new Error(`Painted interaction was not observed: ${JSON.stringify(await page.evaluate(()=>window.__PANDO_PERF_PAINTED_DETAIL__))}`,{cause:error});
  });
  try{return await handle.jsonValue();}finally{await handle.dispose();}
 };
 const polarBefore=await page.evaluate(()=>window.__PANDOLAB_VIEWER__.rendererStats().polar);
 await camera([20,-85],3);
 const polarAfter=await page.evaluate(()=>window.__PANDOLAB_VIEWER__.rendererStats().polar);
 const hover=[];
 for(let sample=0;sample<3;sample++){
  await page.mouse.move(5,5);
  await expect(page.locator('#uiTooltip')).toHaveAttribute('aria-hidden','true');
  await page.evaluate(startInteractionCostProbe);
  const point=await page.evaluate(armPaintedInteraction,{kind:'hover',target:[21,-87],samples:[[21,-84.9],[21,-85.1]]});
  await page.mouse.move(point.x,point.y);
  hover.push({...await waitPaint(),...await page.evaluate(()=>window.__PANDO_PERF_INTERACTION_COST__())});
 }
 await page.mouse.move(5,5);
 await camera([-157.5,-85.051129],5);
 const selection=[];
 let previousPoint=null;
 for(let sample=0;sample<3;sample++){
  if(previousPoint){
   await page.keyboard.down('Control');
   try{await page.mouse.click(previousPoint.x,previousPoint.y);}finally{await page.keyboard.up('Control');}
   await page.waitForFunction(()=>!window.__PANDOLAB_VIEWER__.selectionSnapshot().primaryKey,null,{timeout:5000});
  }
  await page.mouse.move(5,5);
  await expect(page.locator('#uiTooltip')).toHaveAttribute('aria-hidden','true');
  await page.evaluate(startInteractionCostProbe);
  const point=await page.evaluate(armPaintedInteraction,{kind:'selection',target:[-160,-85.3],
   samples:[[-155.6,-85.15],[-160.33,-86.35]],edge:[-158.67317,-85.1325]});
  await page.mouse.click(point.x,point.y);
  const paint=await waitPaint();
  selection.push({...paint,...await page.evaluate(()=>window.__PANDO_PERF_INTERACTION_COST__())});
  previousPoint=point;
 }
 const output={scenario:'painted-interaction',metricVersion:1,iteration,identity:await performanceIdentity(page,navigation),
  hover,selection,polarBefore,polarAfter};
 await writeFile(testInfo.outputPath('painted-interaction.json'),JSON.stringify(output,null,2));
});

test('Viewer asset footprint',async({request},testInfo)=>{
 test.skip(process.env.PANDO_PERF_CAPTURE!=='1','Explicit performance capture required');
 const response=await request.get('./assets/js/build-meta.js');
 expect(response.ok()).toBe(true);
 const match=/Object\.freeze\(([\s\S]*)\);\s*$/.exec(await response.text());
 expect(match).toBeTruthy();
 const meta=JSON.parse(match[1]);
 const workerSpecs=Object.entries(meta.workerAssets).filter(([entry])=>/\/(?:hydro-tile|map-geometry|map-display|core-viewer-session)-worker\.js$/.test(entry));
 const snapshot={sourceSha256:response.headers()['x-pando-test-source-sha256'],dataPin:response.headers()['x-pando-test-data-pin']};
 const measure=async path=>{
  const asset=await request.head('./'+path);
  expect(asset.ok(),path).toBe(true);
  const headers=asset.headers();
  expect(headers['x-pando-test-source-sha256']).toBe(snapshot.sourceSha256);
  expect(headers['x-pando-test-data-pin']).toBe(snapshot.dataPin);
  const bytes=Number(headers['content-length']);
  expect(Number.isSafeInteger(bytes)&&bytes>0,path).toBe(true);
  return {path,bytes};
 };
 const workers={};
 for(const [entry,spec] of workerSpecs){
  const files=await Promise.all(spec.files.map(measure));
  workers[entry]={entryUrl:spec.url,files,totalBytes:files.reduce((sum,file)=>sum+file.bytes,0)};
 }
 const dataPaths=[...new Set([meta.countryBoundarySeed?.url,
  ...Object.values(meta.physicalLandDisplays||{}).map(spec=>spec.url),
  ...['rivers','lakes','physicalLand'].map(role=>meta.projectCatalogs[role]?.catalog)].filter(Boolean))];
 const wasm=await Promise.all(['pandoeditor-core.js','pandoeditor-core.wasm','pandoeditor-core.manifest.json'].map(file=>measure('assets/wasm/'+file)));
 const data=await Promise.all(dataPaths.map(measure));
 await writeFile(testInfo.outputPath('asset-footprint.json'),JSON.stringify({snapshot,workers,wasm,data},null,2));
});

for(const iteration of [1,2,3])test(`rapid zoom and polar admission repeat ${iteration}`,async({page},testInfo)=>{
 test.skip(process.env.PANDO_PERF_CAPTURE!=='1','Explicit performance capture required');
 test.setTimeout(130000);
 await page.setViewportSize({width:1280,height:800});
 await page.addInitScript(installPerformanceProbe);
 await page.addInitScript(captureInitialPresentation);
 const navigation=await page.goto('./?debug=1',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>Number.isFinite(window.__PANDO_PERF_INITIAL_MS__),null,{timeout:90000});
 const camera=async(states,needsPolarPixels)=>page.evaluate(async({states,needsPolarPixels})=>{
  const map=window.__PANDOLAB_MAPLIBRE__,viewer=window.__PANDOLAB_VIEWER__;
  const before=viewer.rendererStats(),canvas=map.getCanvas();
  let firstPolarUploadMs=null;
  const started=performance.now();
  const target=states.at(-1);
  return new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>{map.off('render',render);reject(Error(`Camera frame not published: ${JSON.stringify(viewer.rendererStats())}`));},20000);
   const render=()=>{
    const stats=viewer.rendererStats(),elapsedMs=performance.now()-started;
    if(firstPolarUploadMs===null&&stats.polar?.uploadedBytes>(before.polar?.uploadedBytes||0))firstPolarUploadMs=elapsedMs;
    if(Math.abs(map.getZoom()-target.zoom)>.01||map.isMoving()||stats.mapMoving||!stats.mapReadiness.mapReady
     ||stats.certifiedRevision!==stats.sourceRevision||stats.performance.publications<=before.performance.publications)return;
    if(needsPolarPixels){
     const point=map.project([21,-87]),ratio=map.getPixelRatio(),gl=canvas.getContext('webgl2'),pixel=new Uint8Array(4);
     gl.readPixels(Math.round(point.x*ratio),canvas.height-1-Math.round(point.y*ratio),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
     if(!pixel[3]||pixel.slice(0,3).every(value=>value>245))return;
    }
    clearTimeout(timeout);map.off('render',render);
    const phases={};
    for(const [phase,timing] of Object.entries(stats.performance.phases)){
     if(!phase.startsWith('hydro.')&&!phase.startsWith('polar.')&&phase!=='source:hydro')continue;
     const previous=before.performance.phases[phase];
     const count=timing.count-(previous?.count||0);
     if(count>0)phases[phase]={count,totalMs:timing.totalMs-(previous?.totalMs||0)};
    }
    resolve({elapsedMs,firstPolarUploadMs,polarBefore:before.polar,polarAfter:stats.polar,
     hydroBefore:before.hydro,hydroAfter:stats.hydro,
     sourceWrites:stats.sourceWrites-before.sourceWrites,geometryWorkerRequests:stats.geometryWorkerRequests-before.geometryWorkerRequests,
     phases});
   };
   map.on('render',render);
   const next=index=>{map.jumpTo(states[index]);if(index+1<states.length)requestAnimationFrame(()=>next(index+1));};
   next(0);
  });
 },{states,needsPolarPixels});
 const rapidZoom=await camera([3,5,6].map(zoom=>({center:[90,25],zoom})),false);
 const polarRotation=await camera([{center:[20,-85],zoom:3}],true);
 const output={scenario:'camera-admission',metricVersion:1,iteration,identity:await performanceIdentity(page,navigation),rapidZoom,polarRotation};
 await writeFile(testInfo.outputPath('camera-admission.json'),JSON.stringify(output,null,2));
});

test('camera settle and restore medians',async({page})=>{
 test.skip(process.env.PANDO_PERF_CAPTURE!=='1','Explicit performance capture required');
 test.setTimeout(180_000);
 await page.setViewportSize({width:1280,height:800});
 await page.addInitScript(captureInitialPresentation);
 await page.goto('./?debug=1',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>Number.isFinite(window.__PANDO_PERF_INITIAL_MS__));
 const coldInitialMs=await page.evaluate(()=>window.__PANDO_PERF_INITIAL_MS__);
 const home=await page.evaluate(()=>{
  const map=window.__PANDOLAB_MAPLIBRE__;
  return {center:map.getCenter().toArray(),zoom:map.getZoom(),bearing:map.getBearing(),pitch:map.getPitch()};
 });
 const bounds=await page.locator('.maplibregl-canvas').boundingBox();
 expect(bounds).toBeTruthy();
 const x=bounds.x+bounds.width/2,y=bounds.y+bounds.height/2;
 const measure=async action=>{
  const before=await page.evaluate(()=>({stats:window.__PANDOLAB_VIEWER__.rendererStats(),start:performance.now()}));
  await action();
  return page.evaluate(async({stats:before,start})=>{
   const map=window.__PANDOLAB_MAPLIBRE__,viewer=window.__PANDOLAB_VIEWER__;
   for(;;){
    await new Promise(resolve=>requestAnimationFrame(resolve));
    const stats=viewer.rendererStats();
    if(!map.isMoving()&&stats.mapReadiness.mapReady&&stats.certifiedRevision===stats.sourceRevision&&
       stats.performance.publications>before.performance.publications&&!stats.mapMoving){
     return {ms:performance.now()-start,sourceUpdates:stats.sourceUpdates-before.sourceUpdates,
      landPreparations:stats.physicalLandPreparations-before.physicalLandPreparations,
      borderPreparations:stats.strokePreparedPackets-before.strokePreparedPackets};
    }
    if(performance.now()-start>20000)throw new Error('The target camera frame was not published: '+JSON.stringify({
     center:map.getCenter().toArray(),zoom:map.getZoom(),moving:map.isMoving(),dragging:map.dragPan.isActive(),
     mapMoving:stats.mapMoving,readiness:stats.mapReadiness,certified:stats.certifiedRevision,source:stats.sourceRevision,
     renders:stats.renderedFrames,publications:stats.performance.publications,beforePublications:before.performance.publications,
     polar:stats.polar,unloadedSources:Object.keys(map.getStyle().sources).filter(id=>!map.isSourceLoaded(id)),error:stats.errorMessage,
     labelTiles:map.style.tileManagers['viewer-labels']?._inViewTiles.getAllTiles().map(tile=>[tile.tileID.key,tile.state,tile.aborted]),
     labelDataIdle:map.getSource('viewer-labels')?.loaded(),
    }));
   }
  },before);
 };
 const settle=[],restore=[];
 for(let iteration=0;iteration<5;iteration++){
  await page.mouse.move(x,y);
  settle.push(await measure(async()=>{
   // jumpTo returns the entire Map. Keep it in the browser so the
   // measured interval does not include Playwright serializing it.
   await page.evaluate(zoom=>{window.__PANDOLAB_MAPLIBRE__.jumpTo({zoom});},home.zoom+2);
   await page.mouse.down();
   await page.mouse.move(x+120,y+40,{steps:12});
   await page.mouse.up();
  }));
  expect(await page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.getCenter().toArray())).not.toEqual(home.center);
  restore.push(await measure(()=>page.evaluate(camera=>{window.__PANDOLAB_MAPLIBRE__.jumpTo(camera);},home)));
 }
 await page.reload({waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>Number.isFinite(window.__PANDO_PERF_INITIAL_MS__));
 const warmInitialMs=await page.evaluate(()=>window.__PANDO_PERF_INITIAL_MS__);
 const median=rows=>rows.map(row=>row.ms).sort((a,b)=>a-b)[2];
 const result={coldInitialMs,warmInitialMs,settle,restore,settleMedianMs:median(settle),restoreMedianMs:median(restore)};
 console.log('[viewer-camera-performance]',JSON.stringify(result));
 expect(result.settle.concat(result.restore).every(row=>row.landPreparations===0)).toBe(true);
});

// Opt-in comparison probe. Run unchanged on the previous published build and
// this branch using the same browser, viewport, data pin and device profile.
// This deliberately reports observations rather than claiming an FPS gain.
for(const profile of ['desktop','mobile'])test.describe(profile,()=>{
 test.use(profile==='mobile'?{viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true}:{viewport:{width:1280,height:800},deviceScaleFactor:1});
 for(const iteration of [1,2,3])test(`startup and dates ${profile} repeat ${iteration}`,async({page},testInfo)=>{
  test.skip(process.env.PANDO_PERF_CAPTURE!=='1','Explicit performance capture required');test.setTimeout(240000);
  await page.addInitScript(installPerformanceProbe);await page.addInitScript(captureInitialPresentation);
  const navigation=await page.goto('./?debug=1',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>Number.isFinite(window.__PANDO_PERF_INITIAL_MS__),null,{timeout:90000});
  const initial=await page.evaluate(()=>({presentedAtMs:window.__PANDO_PERF_INITIAL_MS__,
   month:window.__PANDOLAB_VIEWER__.documentState().timelineCursor,
   stats:window.__PANDOLAB_VIEWER__.rendererStats(),diagnostics:window.__PANDO_PERF_DIAGNOSTICS__()}));
  const dateTransitions=[];
  for(const month of ['1922-12','2025-12','1922-12']){
   const [year,monthNumber]=month.split('-');
   const targetLabel=`${year}년 ${Number(monthNumber)}월`;
   await page.locator('#timelineDateButton').click();
   await page.locator('#timelineViewUnit').selectOption('month');
   await page.locator('#timelineYearInput').fill(year);
   await page.locator('#timelineMonthInput').selectOption(String(Number(monthNumber)));
   const before=await page.evaluate(()=>({
    month:window.__PANDOLAB_VIEWER__.documentState().timelineCursor,
    displayedLabel:document.querySelector('#timelineDateButtonText').textContent,
    displayedRevision:window.__PANDOLAB_VIEWER__.rendererStats().displayedRevision,
   }));
   expect(before.month).not.toBe(month);
   expect(before.displayedLabel).not.toBe(targetLabel);
   expect(before.displayedLabel).not.toBe(`${year}년 말`);
   await page.evaluate(({month,targetLabel,previousRevision})=>{
    window.__PANDO_PERF_DATE_MS__=null;
    document.querySelector('#timelineGoBtn').addEventListener('click',()=>{
     const started=performance.now();
     const probe=()=>{
      const viewer=window.__PANDOLAB_VIEWER__,stats=viewer.rendererStats();
      if(viewer.documentState().timelineCursor===month&&stats.mapReadiness.mapReady
       &&stats.displayedRevision>previousRevision&&stats.certifiedRevision===stats.sourceRevision
       &&document.querySelector('#timelineDateButtonText').textContent===targetLabel
       &&document.querySelector('#viewerStatus').dataset.ready==='true'){
       window.__PANDO_PERF_DATE_MS__=performance.now()-started;
       return;
      }
      requestAnimationFrame(probe);
     };
     requestAnimationFrame(probe);
    },{once:true,capture:true});
   },{month,targetLabel,previousRevision:before.displayedRevision});
   await page.locator('#timelineGoBtn').click();await page.waitForFunction(()=>Number.isFinite(window.__PANDO_PERF_DATE_MS__),null,{timeout:90000});
   dateTransitions.push(await page.evaluate(({month,before})=>({
    month,fromMonth:before.month,previousDisplayedRevision:before.displayedRevision,elapsedMs:window.__PANDO_PERF_DATE_MS__,
    stats:window.__PANDOLAB_VIEWER__.rendererStats(),diagnostics:window.__PANDO_PERF_DIAGNOSTICS__(),
   }),{month,before}));
  }
  const identity=await performanceIdentity(page,navigation);
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>Number.isFinite(window.__PANDO_PERF_INITIAL_MS__),null,{timeout:90000});
  const warm=await page.evaluate(()=>({presentedAtMs:window.__PANDO_PERF_INITIAL_MS__,
   month:window.__PANDOLAB_VIEWER__.documentState().timelineCursor,stats:window.__PANDOLAB_VIEWER__.rendererStats()}));
  expect(warm.month).toBe(initial.month);
  const output={metricVersion:7,scenario:'startup-date',profile,iteration,label:process.env.PANDO_PERF_LABEL,identity,
   initial,warmInitialMs:warm.presentedAtMs,dateTransitions,measured:{stats:warm.stats}};
  await writeFile(testInfo.outputPath('globe-performance.json'),JSON.stringify(output,null,2));
  expect(dateTransitions.every(row=>row.elapsedMs>0)).toBe(true);
 });
});
for(const view of [1,3,5,'polar'])for(const iteration of [1,2,3])test(`globe performance zoom ${view} repeat ${iteration}`, async ({ page }, testInfo) => {
  const polar=view==='polar',zoom=polar?3:view;
  test.skip(process.env.PANDO_PERF_CAPTURE !== '1',
    'Run explicitly with PANDO_PERF_CAPTURE=1 on both baseline and candidate.');
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(captureInitialPresentation);
  await page.addInitScript(installPerformanceProbe);
  const navigation=await page.goto('./?debug=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const viewer = window.__PANDOLAB_VIEWER__;
    const stats = viewer?.rendererStats?.();
    return Boolean(viewer?.initialMapPresented?.()
      && stats?.mapReadiness?.mapReady && !stats?.projectRenderBlocked);
  },null,{timeout:90_000});
  await page.waitForFunction(()=>Number.isFinite(window.__PANDO_PERF_INITIAL_MS__));
  const initialMapPresentedMs=await page.evaluate(()=>window.__PANDO_PERF_INITIAL_MS__);

  await page.evaluate(({zoom,polar}) => {
    const host = window.__PANDOLAB_MAP_HOST__;
    host.setViewState({ projection: 'globe', view: {
      zoom, globeRotation: polar?[-20,85,0]:[-90,-25,0],
    } });
  },{zoom,polar});
  const admitted = await page.waitForFunction(() => {
    const map = window.__PANDOLAB_MAPLIBRE__;
    const stats = window.__PANDOLAB_VIEWER__?.rendererStats();
    if(stats?.projectRenderBlocked)throw new Error('MapLibre rejected the zoom frame: '+stats.errorMessage);
    if(!map?.getCanvas()?.isConnected||!stats?.mapReadiness?.mapReady||stats.displayedRevision<=0||stats.certifiedRevision!==stats.sourceRevision)return null;
    return {revision:window.__PANDOLAB_VIEWER__.documentState()?.timelineCursor,
      camera:window.__PANDOLAB_MAP_HOST__.getViewState(),stats,
      heapBytes:performance.memory?.usedJSHeapSize??null};
  },null,{timeout:90_000});
  const initial=await admitted.jsonValue();await admitted.dispose();

  // Include warmup separately. The measured interval excludes loading and
  // idle frames; the RAF gap sample includes browser presentation stalls.
  const bounds = await page.locator('#map').boundingBox();
  expect(bounds).toBeTruthy();
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.evaluate(startInteractionCostProbe);
  await page.evaluate(() => {
    const gaps = [];
    let last = 0;
    const map=window.__PANDOLAB_MAPLIBRE__,viewer=window.__PANDOLAB_VIEWER__;
    const before=viewer.rendererStats(),nativeGaps=[];
    let lastNative=null;
    const native=()=>{
      const now=performance.now();
      if(!map.isMoving()||document.hidden){lastNative=null;return;}
      if(lastNative!==null)nativeGaps.push(now-lastNative);
      lastNative=now;
    };
    map.on('render',native);
    const state = { gaps, nativeGaps, before, active: true, finish(){
      map.off('render',native);
    } };
    window.__PANDO_PERF_CAPTURE__ = state;
    const tick = now => {
      if (!state.active) return;
      if (last) gaps.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.mouse.down();
  await page.mouse.move(centerX + 160, centerY + 70, { steps: 280 });
  await page.mouse.move(centerX - 120, centerY - 40, { steps: 280 });
  await page.mouse.up();
  const measured = await page.evaluate(() => {
    const state = window.__PANDO_PERF_CAPTURE__;
    state.active = false;
    delete window.__PANDO_PERF_CAPTURE__;
    state.finish();
    const costs=window.__PANDO_PERF_INTERACTION_COST__();
    const native=state.nativeGaps.sort((a,b)=>a-b);
    const nativePercentile=p=>native.length?native[Math.ceil(native.length*p)-1]:null;
    const sorted = state.gaps.filter(Number.isFinite).sort((a, b) => a - b);
    const percentile = p => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
    const stats = window.__PANDOLAB_VIEWER__.rendererStats();
    const map = window.__PANDOLAB_MAPLIBRE__;
    const hydroPhases={};
    for(const [phase,timing] of Object.entries(stats.performance.phases)){
      if(!phase.startsWith('hydro.')&&phase!=='source:hydro')continue;
      const previous=state.before.performance.phases[phase];
      const count=timing.count-(previous?.count||0);
      if(count>0)hydroPhases[phase]={count,totalMs:timing.totalMs-(previous?.totalMs||0)};
    }
    const visual = {canvasConnected:Boolean(map?.getCanvas()?.isConnected),
      displayedRevision:stats.displayedRevision,sourceRevision:stats.sourceRevision,
      certifiedRevision:stats.certifiedRevision,mapReady:stats.mapReadiness?.mapReady,
      camera:map?{center:map.getCenter().toArray(),zoom:map.getZoom(),bearing:map.getBearing(),pitch:map.getPitch()}:null};
    return {
      sampleCount: sorted.length,
      nativeSampleCount:native.length,nativeFrameGapP95Ms:nativePercentile(.95),nativeFrameGapP99Ms:nativePercentile(.99),
      ...costs,sourceUpdates:stats.sourceUpdates-state.before.sourceUpdates,
      hydroBefore:state.before.hydro,hydroAfter:stats.hydro,hydroPhases,
      frameGapP50Ms: percentile(0.50),
      frameGapP95Ms: percentile(0.95),
      frameGapP99Ms: percentile(0.99),
      fpsFromMedianGap: percentile(0.50) ? 1000 / percentile(0.50) : null,
      over50msCount: sorted.filter(value => value > 50).length,
      stats,
      visual,
      heapBytes: performance.memory?.usedJSHeapSize ?? null,
    };
  });
  await page.waitForFunction(()=>!window.__PANDOLAB_MAPLIBRE__.isMoving());
  await page.evaluate(startInteractionCostProbe);
  const cameraBeforeHover=await page.evaluate(()=>window.__PANDOLAB_MAP_HOST__.getViewState());
  await page.mouse.move(centerX+96,centerY+24,{steps:32});
  await page.mouse.move(centerX-96,centerY-24,{steps:32});
  await page.evaluate(async()=>{for(let frame=0;frame<12;frame++)await new Promise(requestAnimationFrame);});
  const hover=await page.evaluate(()=>({
    ...window.__PANDO_PERF_INTERACTION_COST__(),camera:window.__PANDOLAB_MAP_HOST__.getViewState(),
  }));
  expect(hover.camera).toEqual(cameraBeforeHover);
  const dateTransitions=[];
  for(const value of ['2025-12','2024-12','2025-12']){
    await page.locator('#timelineDateButton').click();await page.locator('#timelineViewUnit').selectOption('month');
    await page.locator('#timelineYearInput').fill(value.slice(0,4));await page.locator('#timelineMonthInput').selectOption('12');
    await page.evaluate(value=>{
      const viewer=window.__PANDOLAB_VIEWER__;
      const before=viewer.rendererStats();
      const fromMonth=viewer.documentState().timelineCursor;
      window.__PANDO_PERF_DATE_RESULT__=null;
      document.querySelector('#timelineGoBtn').addEventListener('click',()=>{
        const started=performance.now();
        let pendingHighlightFrames=0;
        const probe=()=>{
          const stats=viewer.rendererStats();
          if(stats.highlight?.pending)pendingHighlightFrames++;
          if(viewer.documentState().timelineCursor===value&&stats.mapReadiness.mapReady
            &&stats.certifiedRevision===stats.sourceRevision&&document.querySelector('#timelineDateButtonText')?.textContent.includes(value.slice(0,4))){
            window.__PANDO_PERF_DATE_RESULT__={month:value,fromMonth,elapsedMs:performance.now()-started,
              before,stats,pendingHighlightFrames};
            return;
          }
          requestAnimationFrame(probe);
        };requestAnimationFrame(probe);
      },{once:true,capture:true});
    },value);
    await page.locator('#timelineGoBtn').click();
    await page.waitForFunction(()=>Number.isFinite(window.__PANDO_PERF_DATE_RESULT__?.elapsedMs),null,{timeout:90000});
    dateTransitions.push(await page.evaluate(()=>window.__PANDO_PERF_DATE_RESULT__));
  }
  const output = {
    metricVersion:5,scenario:polar?'polar-interaction':'interaction',profile:'desktop',label: process.env.PANDO_PERF_LABEL || 'candidate',zoom,iteration,
    identity:await performanceIdentity(page,navigation),
    url: page.url(), viewport: { width: 1280, height: 800 },
    initial: {presentedAtMs:initialMapPresentedMs,revision: initial.revision, camera: initial.camera,
      heapBytes: initial.heapBytes },
    measured,hover,dateTransitions,
  };
  const capturePath=testInfo.outputPath('globe-performance.json');
  await writeFile(capturePath,JSON.stringify(output,null,2));
  if(iteration===1)await page.screenshot({path:testInfo.outputPath('viewer.png')});
  await testInfo.attach('globe-performance.json', {
    path:capturePath,
    contentType: 'application/json',
  });
  expect(measured.sampleCount).toBeGreaterThanOrEqual(500);
  expect(measured.visual.canvasConnected).toBe(true);
  expect(initial.stats.displayedRevision).toBeGreaterThan(0);
  // Accuracy is checked separately by the existing projection-parity,
  // temporal country and hydro/terrain Viewer regression scenarios.
});
