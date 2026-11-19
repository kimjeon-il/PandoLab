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
  const initial=await page.evaluate(()=>({presentedAtMs:window.__PANDO_PERF_INITIAL_MS__,stats:window.__PANDOLAB_VIEWER__.rendererStats(),diagnostics:window.__PANDO_PERF_DIAGNOSTICS__()}));
  const dateTransitions=[];
  for(const month of ['2025-12','2024-12','2025-12']){
   await page.locator('#timelineDateButton').click();await page.locator('#timelineViewUnit').selectOption('month');await page.locator('#timelineYearInput').fill(month.slice(0,4));await page.locator('#timelineMonthInput').selectOption('12');
   await page.evaluate(month=>{window.__PANDO_PERF_DATE_MS__=null;document.querySelector('#timelineGoBtn').addEventListener('click',()=>{const started=performance.now();const probe=()=>{const v=window.__PANDOLAB_VIEWER__,s=v.rendererStats();if(v.documentState().timelineCursor===month&&s.mapReadiness.mapReady&&s.certifiedRevision===s.sourceRevision&&document.querySelector('#viewerStatus').dataset.ready==='true'){window.__PANDO_PERF_DATE_MS__=performance.now()-started;return;}requestAnimationFrame(probe);};requestAnimationFrame(probe);},{once:true,capture:true});},month);
   await page.locator('#timelineGoBtn').click();await page.waitForFunction(()=>Number.isFinite(window.__PANDO_PERF_DATE_MS__),null,{timeout:90000});
   dateTransitions.push(await page.evaluate(month=>({month,elapsedMs:window.__PANDO_PERF_DATE_MS__,stats:window.__PANDOLAB_VIEWER__.rendererStats(),diagnostics:window.__PANDO_PERF_DIAGNOSTICS__()}),month));
  }
  const output={metricVersion:5,scenario:'startup-date',profile,iteration,label:process.env.PANDO_PERF_LABEL,identity:await performanceIdentity(page,navigation),initial,dateTransitions,measured:{stats:await page.evaluate(()=>window.__PANDOLAB_VIEWER__.rendererStats())}};
  await writeFile(testInfo.outputPath('globe-performance.json'),JSON.stringify(output,null,2));
  expect(dateTransitions.every(row=>row.elapsedMs>0)).toBe(true);
 });
});
for(const zoom of [1,3,5])for(const iteration of [1,2,3])test(`globe performance zoom ${zoom} repeat ${iteration}`, async ({ page }, testInfo) => {
  test.skip(process.env.PANDO_PERF_CAPTURE !== '1',
    'Run explicitly with PANDO_PERF_CAPTURE=1 on both baseline and candidate.');
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(captureInitialPresentation);
  const navigation=await page.goto('./?debug=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const viewer = window.__PANDOLAB_VIEWER__;
    const stats = viewer?.rendererStats?.();
    return Boolean(viewer?.initialMapPresented?.()
      && stats?.mapReadiness?.mapReady && !stats?.projectRenderBlocked);
  },null,{timeout:90_000});
  await page.waitForFunction(()=>Number.isFinite(window.__PANDO_PERF_INITIAL_MS__));
  const initialMapPresentedMs=await page.evaluate(()=>window.__PANDO_PERF_INITIAL_MS__);

  await page.evaluate(zoom => {
    const host = window.__PANDOLAB_MAP_HOST__;
    host.setViewState({ projection: 'globe', view: {
      zoom: zoom, globeRotation: [-90, -25, 0],
    } });
  },zoom);
  const admitted = await page.waitForFunction(() => {
    const map = window.__PANDOLAB_MAPLIBRE__;
    const stats = window.__PANDOLAB_VIEWER__?.rendererStats();
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
  await page.evaluate(() => {
    const gaps = [];
    let last = 0;
    const state = { gaps, active: true };
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
    const sorted = state.gaps.filter(Number.isFinite).sort((a, b) => a - b);
    const percentile = p => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
    const stats = window.__PANDOLAB_VIEWER__.rendererStats();
    const map = window.__PANDOLAB_MAPLIBRE__;
    const visual = {canvasConnected:Boolean(map?.getCanvas()?.isConnected),
      displayedRevision:stats.displayedRevision,sourceRevision:stats.sourceRevision,
      certifiedRevision:stats.certifiedRevision,mapReady:stats.mapReadiness?.mapReady,
      camera:map?{center:map.getCenter().toArray(),zoom:map.getZoom(),bearing:map.getBearing(),pitch:map.getPitch()}:null};
    return {
      sampleCount: sorted.length,
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
  const dateTransitions=[];
  for(const value of ['2025-12','2024-12','2025-12']){
    await page.locator('#timelineDateButton').click();await page.locator('#timelineViewUnit').selectOption('month');
    await page.locator('#timelineYearInput').fill(value.slice(0,4));await page.locator('#timelineMonthInput').selectOption('12');
    await page.evaluate(value=>{
      window.__PANDO_PERF_DATE_MS__=null;
      document.querySelector('#timelineGoBtn').addEventListener('click',()=>{
        const started=performance.now();
        const probe=()=>{const v=window.__PANDOLAB_VIEWER__,s=v.rendererStats();
          if(v.documentState().timelineCursor===value&&s.mapReadiness.mapReady&&s.certifiedRevision===s.sourceRevision&&document.querySelector('#timelineDateButtonText')?.textContent.includes(value.slice(0,4))){window.__PANDO_PERF_DATE_MS__=performance.now()-started;return;}
          requestAnimationFrame(probe);
        };requestAnimationFrame(probe);
      },{once:true,capture:true});
    },value);
    await page.locator('#timelineGoBtn').click();
    await page.waitForFunction(()=>Number.isFinite(window.__PANDO_PERF_DATE_MS__),null,{timeout:90000});
    dateTransitions.push({month:value,elapsedMs:await page.evaluate(()=>window.__PANDO_PERF_DATE_MS__)});
  }
  const output = {
    metricVersion:5,scenario:'interaction',profile:'desktop',label: process.env.PANDO_PERF_LABEL || 'candidate',zoom,iteration,
    identity:await performanceIdentity(page,navigation),
    url: page.url(), viewport: { width: 1280, height: 800 },
    initial: {presentedAtMs:initialMapPresentedMs,revision: initial.revision, camera: initial.camera,
      heapBytes: initial.heapBytes },
    measured,dateTransitions,
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
