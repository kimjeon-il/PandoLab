import {test,expect} from '@playwright/test';

import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {decodeGlobeHistoryList,globeHistoryMonthKey} from '../../src/rendering/globe-history-index.js';

import { COUNTRY_DEFAULT_COLORS } from '../../src/ui/country-default-colors.js';

// Only accepted frames can certify a camera jump, timeline change or screen sample.
// The host's current camera may already have changed while the canvas still shows the old frame.
function readPresentedFrame({month=null,camera=null,afterFrame=null,coordinate=null,settled=false,riverDetail=false}={}){
  const viewer=window.__PANDOLAB_VIEWER__,stats=viewer?.rendererStats(),host=window.__PANDOLAB_MAP_HOST__;
  const status=document.querySelector('#viewerStatus'),frame=stats?.presentedFrame;
  const current=host?.getViewState({withGeographicBounds:false}),cursor=viewer?.documentState()?.timelineCursor;
  const sameCamera=(a,b)=>Boolean(a&&b&&['projection','zoom','bearing','pitch','roll'].every(key=>a[key]===b[key])
    &&a.center?.length===2&&b.center?.length===2&&a.center.every((value,index)=>value===b.center[index]));
  const checks={
    initialMapPresented:Boolean(viewer?.initialMapPresented()),
    rendererMapReady:Boolean(stats?.mapReadiness?.mapReady),
    projectNotBlocked:!stats?.projectRenderBlocked&&!stats?.webglContextLost,
    viewerStatusReady:status?.dataset.ready==='true',
    acceptedFrame:Boolean(frame&&frame.frameId>0&&frame.generation===stats.generation&&stats.displayedRevision>0
      &&stats.certifiedRevision===stats.displayedRevision&&!stats.temporalPresentationPending),
    currentMonth:Boolean(frame&&cursor&&frame.month===cursor),
    currentCamera:sameCamera(frame?.camera,current?.camera),
    currentLayout:Boolean(frame&&current&&frame.size.width===current.size.width&&frame.size.height===current.size.height&&frame.dpr===current.dpr),
    requestedMonth:month===null||frame?.month===month,
    requestedCamera:camera===null||sameCamera(frame?.camera,camera),
    newerFrame:afterFrame===null||frame?.frameId>afterFrame,
    movementSettled:!settled||stats?.moving===false,
    riverDetailPresented:!riverDetail||Boolean(frame&&stats?.riverDetail?.requestedChunks>0
      &&frame.riverDetailChunks===stats.riverDetail.requestedChunks&&frame.riverDetailSegments>0),
  };
  let point=null,rect=null;
  if(coordinate!==null){
    const bounds=document.querySelector('#map canvas')?.getBoundingClientRect();
    if(bounds)rect={x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height};
    if(Object.values(checks).every(Boolean))point=host.project(coordinate);
    checks.projectedCoordinate=Boolean(rect&&Array.isArray(point)&&point.length===2&&point.every(Number.isFinite)
      &&point[0]>=0&&point[0]<rect.width&&point[1]>=0&&point[1]<rect.height);
  }
  return {blockers:Object.keys(checks).filter(key=>!checks[key]),frame:frame??null,point,rect,
    rendererStatus:stats?.mapReadiness?.status??null,errorMessage:stats?.errorMessage??null,
    webglContextLost:stats?.webglContextLost??null,sourceRevision:stats?.sourceRevision??null,
    displayedRevision:stats?.displayedRevision??null,viewerStatus:status?.textContent??null,loadingKind:status?.dataset.loadingKind??null};
}

async function ready(page,stage='map presentation',expected={}){
  const started=performance.now();let lastBlockers='',lastLogAt=-Infinity;
  await expect.poll(async()=>{
    const sample=await page.evaluate(readPresentedFrame,expected);
    const now=performance.now(),elapsedMs=Math.round(now-started);
    if(!sample.blockers.length){
      console.log('[viewer-ready]',JSON.stringify({stage,elapsedMs,result:'ready',frameId:sample.frame.frameId}));
      return true;
    }
    const key=JSON.stringify([sample.blockers,sample.rendererStatus,sample.errorMessage]);
    if(key!==lastBlockers||now-lastLogAt>=10_000){
      console.log('[viewer-ready]',JSON.stringify({stage,elapsedMs,...sample}));
      lastBlockers=key;lastLogAt=now;
    }
    return false;
  },{timeout:90_000,message:'Viewer not ready: '+stage}).toBe(true);
}

async function goToCoordinate(page,center,zoom){
  const target=await page.evaluate(({center,zoom})=>{
    const host=window.__PANDOLAB_MAP_HOST__,before=window.__PANDOLAB_VIEWER__.rendererStats().frameId;
    host.setViewState({projection:'globe',view:{center,zoom}});
    return {camera:host.getViewState({withGeographicBounds:false}).camera,afterFrame:before??null};
  },{center,zoom});
  await ready(page,'camera '+center.join(',')+' at zoom '+zoom,target);
}

async function clickGeographicPoint(page,coordinate,expected={}){
  let sample;
  await expect.poll(async()=>{
    sample=await page.evaluate(readPresentedFrame,{...expected,coordinate,settled:true});
    return sample.blockers;
  },{message:'Geographic click target not presented: '+coordinate.join(',')}).toEqual([]);
  await page.mouse.click(sample.rect.x+sample.point[0],sample.rect.y+sample.point[1]);
}

async function readGeographicPixel(page,coordinate){
  const before=await page.evaluate(readPresentedFrame,{coordinate});
  if(before.blockers.length)return null;
  const png=await page.locator('#map canvas').screenshot({scale:'device'});
  const after=await page.evaluate(readPresentedFrame,{coordinate});
  // Retry a sample if the accepted view changed during capture; a later
  // draw of the same view is valid because its geographic projection is identical.
  if(after.blockers.length||before.frame.generation!==after.frame.generation
    ||before.frame.viewRevision!==after.frame.viewRevision||before.frame.month!==after.frame.month
    ||JSON.stringify(before.point)!==JSON.stringify(after.point)
    ||before.rect.width!==after.rect.width||before.rect.height!==after.rect.height)return null;
  return page.evaluate(async({encoded,point,width,height})=>{
    const image=await createImageBitmap(new Blob([Uint8Array.from(atob(encoded),char=>char.charCodeAt(0))]));
    // Use actual screenshot dimensions, not an assumed device-pixel ratio.
    const x=Math.floor(point[0]*image.width/width),y=Math.floor(point[1]*image.height/height);
    if(x<0||y<0||x>=image.width||y>=image.height){image.close();return null;}
    const pixel=new OffscreenCanvas(1,1).getContext('2d');
    pixel.drawImage(image,x,y,1,1,0,0,1,1);image.close();
    return [...pixel.getImageData(0,0,1,1).data].slice(0,3);
  },{encoded:png.toString('base64'),point:before.point,width:before.rect.width,height:before.rect.height});
}

async function open(page,query=''){
  const health=await page.request.get('./__shell/health');
  if(health.ok()&&health.headers()['content-type']?.includes('application/json')){
    const status=await health.json();
    if(status.executionMode==='development')expect(status.error,'development source must build before workflow verification').toBeNull();
  }
  page.on('pageerror',error=>console.error('Viewer page error:',error));
  page.on('console',message=>{if(message.type()==='error')console.error('Viewer error:',message.text());});
  await page.goto('./?debug=1'+query,{waitUntil:'domcontentloaded'});
  await ready(page,'initial map');
  await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_VIEWER__.visibleTerritorialCount())).toBeGreaterThan(0);
}

const camera=page=>page.evaluate(()=>window.__PANDOLAB_MAP_HOST__.getViewState());

test('Viewer shows the land skeleton while the first globe frame is loading', async ({page})=>{
 let release;
 const pending=new Promise(resolve=>{release=resolve;});
 await page.route('**/assets/data/globe-preview/**',async route=>{
  await pending;
  await route.continue();
 });
 const canvas=page.locator('#map canvas'),skeleton=page.locator('#mapSkeleton');
 try{
  await page.goto('./?debug=1',{waitUntil:'domcontentloaded'});
  await canvas.waitFor({state:'attached'});
  await expect(canvas).toBeHidden({timeout:3000});
  await expect(skeleton).toBeVisible();
  await expect(skeleton.locator('path')).toHaveAttribute('d',/^M.+Z$/);
  // This inland sample used to fall through a crack between simplified rings.
  const landAlpha=await skeleton.evaluate(async element=>{
   const svg=element.cloneNode(true);
   svg.setAttribute('xmlns','http://www.w3.org/2000/svg');
   svg.setAttribute('width','768');svg.setAttribute('height','768');
   const url=URL.createObjectURL(new Blob([svg.outerHTML],{type:'image/svg+xml'}));
   try{
    const image=new Image();image.src=url;await image.decode();
    const context=new OffscreenCanvas(768,768).getContext('2d');
    context.drawImage(image,0,0);
    return context.getImageData(356,453,1,1).data[3];
   }finally{URL.revokeObjectURL(url);}
  });
  expect(landAlpha).toBe(255);
  await expect(skeleton).toHaveCSS('fill','rgb(241, 241, 241)');
 }finally{release();}
 await ready(page,'globe reveal');
 await expect(canvas).toBeVisible();
 await expect(skeleton).toBeHidden();
});

test('Three globe keeps its map ready and reuses loaded spatial chunks while navigating', async ({ browser, baseURL }) => {
 const context = await browser.newContext({ baseURL, viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1.5 });
 let allowOutlines;
 const outlineGate=new Promise(resolve=>{allowOutlines=resolve;});
 try {
  const page = await context.newPage();
  await page.route('**/outlines/**',async route=>{await outlineGate;await route.continue();});
  page.on('pageerror', error => console.error('Three globe page error:', error));
  page.on('console', message => { if (message.type() === 'error') console.error('Three globe error:', message.text()); });
  await page.addInitScript(() => {
   localStorage.setItem('pandolab-user-preferences',JSON.stringify({version:2,selection:{color:'#ff00fd',fillStrength:0}}));
   const prototype = window.WebGL2RenderingContext.prototype;
   window.globeBufferWrites = 0;
   for (const method of ['bufferData', 'bufferSubData']) {
    const original = prototype[method];
    prototype[method] = function (...args) {
     window.globeBufferWrites++;
     return original.apply(this, args);
    };
   }
  });
  await page.route('**/three-camera-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  await page.goto('./three-camera-fixture');
  const saved = { projection: 'globe', center: [3.12, 45.78], zoom: 2.75, bearing: 18, pitch: 0, roll: 0 };
  await page.evaluate(async view => {
   const { createBrowserProjectStorage } = await import(new URL('./assets/js/modules/browser-project-storage.js', location.href).href);
   const storage = createBrowserProjectStorage({ productMode: 'viewer', indexedDB,
    databaseName: 'pandolab-viewer', storeName: 'views', viewKey: 'active-view' });
   await storage.writeCamera('default-world', view);
  }, saved);
  const assetRequests = [];
  page.on('request', request => assetRequests.push(new URL(request.url()).pathname));
  const outlineRequests=()=>assetRequests.filter(path=>path.includes('/outlines/'));
  const isBase = path => /\/globe-preview\/(countries|borders)\//.test(path);
  const baseRequests = () => assetRequests.filter(isBase);
  const completedBaseRequests = [];
  page.on('requestfinished', request => {
   const path = new URL(request.url()).pathname;
   if (isBase(path)) completedBaseRequests.push(path);
  });
  const expectNoDuplicateBaseRequests = () => expect(completedBaseRequests).toHaveLength(new Set(completedBaseRequests).size);
  await page.goto('./?debug=1');
  await expect(page.locator('#viewerStatus')).toHaveAttribute('data-ready', 'true', { timeout: 90_000 });
  await expect(page.locator('#map canvas')).toHaveCount(1);
  const canvas = page.locator('#map canvas');
  const box = await canvas.boundingBox();
  expect(await canvas.evaluate(element => element.width)).toBe(Math.floor(box.width * 1.5));
  expect((await camera(page)).camera).toEqual(saved);
  const scene = await page.evaluate(() => ({
   prepared: window.__PANDOLAB_VIEWER__.rendererStats().countrySlotCount,
   month: window.__PANDOLAB_VIEWER__.builtinMonth().month,
   expectedMonth: window.PANDOLAB_BUILD_META.globePreview.physicalMonth,
   owner: window.__PANDOLAB_VIEWER__.visibleTerritorialCount(),
   drawCalls: window.__PANDOLAB_VIEWER__.rendererStats().drawCalls,
   firstPublishedAt: window.__PANDOLAB_VIEWER__.rendererStats().performance.firstPublishedAt,
   labels: window.__PANDOLAB_VIEWER__.rendererStats().countryLabelCount,
   atlasEntries: window.__PANDOLAB_VIEWER__.rendererStats().labelAtlasEntries,
  }));
  expect(scene.prepared).toBeGreaterThan(0);
  expect(scene.month).toBe(scene.expectedMonth);
  expect(scene.owner).toBeGreaterThan(0);
  expect(scene.drawCalls).toBeGreaterThan(0);
  expect(scene.firstPublishedAt).toBeGreaterThan(0);
  expect(scene.labels).toBe(0);
  expect(scene.atlasEntries).toBe(0);
  const before = await canvas.screenshot();
  const middlePixel = await page.evaluate(async encoded => {
   const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(encoded), char => char.charCodeAt(0))]));
   const pixel = new OffscreenCanvas(1, 1).getContext('2d');
   pixel.drawImage(bitmap, Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1, 0, 0, 1, 1);
   bitmap.close();
   return Array.from(pixel.getImageData(0, 0, 1, 1).data).slice(0, 3);
  }, before.toString('base64'));
  const expected = COUNTRY_DEFAULT_COLORS.FRA.slice(1).match(/../g).map(value => parseInt(value, 16));
  expect(Math.max(...middlePixel.map((value, i) => Math.abs(value - expected[i])))).toBeLessThanOrEqual(1);
  const samplePerformance = async(stage) => {
   const metrics = await page.evaluate(() => {
    const stats = window.__PANDOLAB_VIEWER__.rendererStats(), canvas = document.querySelector('#map canvas');
    const gl = canvas.getContext('webgl2'), debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {source:window.PANDOLAB_BUILD_META.sourceCommit??null, data:window.PANDOLAB_BUILD_META.dataRevision,
     dpr:window.devicePixelRatio, width:canvas.width,height:canvas.height,renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
     drawCount:stats.drawCount,drawCalls:stats.drawCalls,firstPublishedAt:stats.performance.firstPublishedAt,
     phases:stats.performance.phases,spatial:stats.spatialRendering,residency:stats.residency,
     loadPipeline:stats.loadGate?{networkActive:stats.loadGate.active,networkQueued:stats.loadGate.queued,
      networkPeakActive:stats.loadGate.peakActive,networkHandoffs:stats.loadGate.handoffs,
      reservedBytes:stats.loadGate.reservedBytes,peakReservedBytes:stats.loadGate.peakBytes}:null,
     packetWorker:stats.packetWorker?{decodeBatches:stats.packetWorker.decodeBatches,decodeBatchPackets:stats.packetWorker.decodeBatchPackets,
      spatialIndexedPackets:stats.packetWorker.spatialIndexedPackets,decodeBatcher:stats.packetWorker.decodeBatcher}:null,
     meshLedger:stats.residentCache?.meshLedger??null,labelLedger:stats.labelAtlas?.pageLedger??null,
     bufferWrites:window.globeBufferWrites};
   });
   console.log('[viewer-performance]',JSON.stringify({stage,...metrics}));
   return metrics;
  };
  await samplePerformance('startup');
  const writes = await page.evaluate(() => window.globeBufferWrites);
  const startupRequests = baseRequests();
  expect(assetRequests.filter(path=>path.includes('/pick/'))).toEqual([]);
  expect(outlineRequests()).toEqual([]);
  const landSources = await page.evaluate(async () => {
   const meta = window.PANDOLAB_BUILD_META;
   const catalog = await fetch(meta.projectCatalogs.physicalLand.catalog).then(response => response.json());
   return [catalog.asset, catalog.modernCoast?.asset]
    .filter(Boolean).map(asset => new URL(asset.url, location.href).pathname);
  });
  expect(assetRequests.filter(path => landSources.includes(path))).toEqual([]);
  expect(startupRequests.some(path=>path.includes('/countries/'))).toBe(true);
  expect(startupRequests.length).toBeLessThan(await page.evaluate(()=>{
   const spec = window.PANDOLAB_BUILD_META.globePreview;
   return spec.countryChunks.length + spec.borderChunks.length;
  }));
  expectNoDuplicateBaseRequests();
  expect(writes).toBeGreaterThan(0);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => page.evaluate(() => window.__PANDOLAB_VIEWER__.selectionSnapshot().items.map(ref => ref.id))).toEqual(['FRA']);
  expect(assetRequests.some(path=>path.includes('/pick/'))).toBe(false);
  await expect.poll(()=>outlineRequests().length).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.globeBufferWrites)).toBe(writes);
  allowOutlines();
  const outlinePixels = async screenshot => page.evaluate(async encoded => {
   const image = await createImageBitmap(new Blob([Uint8Array.from(atob(encoded), char=>char.charCodeAt(0))]));
   const context = new OffscreenCanvas(image.width,image.height).getContext('2d');
   context.drawImage(image,0,0);
   const rgba = context.getImageData(0,0,image.width,image.height).data;
   image.close();
   let count=0;
   for(let pixel=0;pixel<rgba.length;pixel+=4)if(rgba[pixel]>250&&rgba[pixel+1]<5&&rgba[pixel+2]>247)count++;
   return count;
  },screenshot.toString('base64'));
  expect(await outlinePixels(before)).toBe(0);
  await expect.poll(async()=>outlinePixels(await canvas.screenshot())).toBeGreaterThan(20);
  const selectionWrites=await page.evaluate(() => window.globeBufferWrites);
  expect(selectionWrites).toBeGreaterThan(writes);
  // Record actual animation callback spacing during the same drag/zoom path.
  await page.evaluate(() => {
   const rows = []; let last = null;
   window.globeFrameProbe = {rows,active:true};
   const tick = time => {if (!window.globeFrameProbe.active)return;if(last!==null)rows.push(time-last);last=time;requestAnimationFrame(tick);};
   requestAnimationFrame(tick);
  });
  const movementStarted=performance.now();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 110, box.y + box.height / 2 + 30, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await camera(page)).camera.center).not.toEqual(saved.center);
  const zoomBeforeWheel = (await camera(page)).zoom;
  await page.mouse.wheel(0, -80);
  await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(zoomBeforeWheel);
  await ready(page, 'map after drag and zoom');
  const movementMs=performance.now()-movementStarted;
  const intervals=await page.evaluate(()=>{window.globeFrameProbe.active=false;return window.globeFrameProbe.rows;});
  const ordered=intervals.slice().sort((a,b)=>a-b);
  const quantile=q=>ordered.length?ordered[Math.min(ordered.length-1,Math.floor((ordered.length-1)*q))]:null;
  console.log('[viewer-performance-movement]',JSON.stringify({movementMs,frames:intervals.length,p50Ms:quantile(.5),p95Ms:quantile(.95),maxMs:ordered.at(-1)??null}));
  await samplePerformance('after drag and zoom');
  expectNoDuplicateBaseRequests();
  expect(await page.evaluate(() => window.__PANDOLAB_VIEWER__.rendererStats().renderer)).toBe('three');
  await expect.poll(() => page.evaluate(async () => {
   const count = window.__PANDOLAB_VIEWER__.rendererStats().drawCount;
   await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
   return window.__PANDOLAB_VIEWER__.rendererStats().drawCount - count;
  })).toBe(0);
  const dateCamera = (await camera(page)).camera;
  // This month shares the startup edition's territorial packets.
  const dateStarted=performance.now();
  await month(page, '2026-12');
  console.log('[viewer-performance-date]',JSON.stringify({elapsedMs:performance.now()-dateStarted,month:'2026-12'}));
  await samplePerformance('after month transition');
  expect((await camera(page)).camera).toEqual(dateCamera);
  expectNoDuplicateBaseRequests();
  const viewBeforeContextLoss = (await camera(page)).camera;
  await canvas.evaluate(element => {
   window.threeContextControl = element.getContext('webgl2').getExtension('WEBGL_lose_context');
   window.threeContextControl.loseContext();
  });
  await expect.poll(() => page.evaluate(() => window.__PANDOLAB_VIEWER__.rendererStats().webglContextLost)).toBe(true);
  await page.evaluate(() => window.threeContextControl.restoreContext());
  await expect.poll(() => page.evaluate(() => window.__PANDOLAB_VIEWER__.rendererStats().mapReadiness.mapReady)).toBe(true);
  expect((await camera(page)).camera).toEqual(viewBeforeContextLoss);
  expectNoDuplicateBaseRequests();
 } finally {
  allowOutlines();
  await context.close();
 }
});

test('Three globe preserves mobile DPR during pinch, drag and resize', async ({ browser, baseURL }) => {
 const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2.625,
  hasTouch: true, isMobile: true });
 try {
  const page = await context.newPage();
  await page.goto('./?debug=1');
  await expect(page.locator('#viewerStatus')).toHaveAttribute('data-ready', 'true', { timeout: 90_000 });
  const canvas = page.locator('#map canvas'), box = await canvas.boundingBox();
  expect(await canvas.evaluate(element => element.width)).toBe(Math.floor(box.width * 2.625));
  const points = span => [
   { id: 0, x: box.x + box.width / 2 - span, y: box.y + box.height / 2 },
   { id: 1, x: box.x + box.width / 2 + span, y: box.y + box.height / 2 },
  ];
  const zoom = async () => (await camera(page)).zoom;
  const before = await zoom(), cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(30) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(68) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(zoom).toBeGreaterThan(before);
  const centerBefore=(await camera(page)).camera.center;
  const finger=(dx,dy)=>[{id:0,x:box.x+box.width/2+dx,y:box.y+box.height/2+dy}];
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:finger(0,0)});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:finger(45,16)});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await expect.poll(async()=>(await camera(page)).camera.center).not.toEqual(centerBefore);
  await page.setViewportSize({width:844,height:390});
  await expect.poll(()=>canvas.evaluate(element=>element.width===Math.floor(element.clientWidth*window.devicePixelRatio)&&
   element.height===Math.floor(element.clientHeight*window.devicePixelRatio))).toBe(true);
 } finally {
  await context.close();
 }
});

test('Viewer graticule can be hidden and restored on the globe',async({page})=>{
 await open(page);
 const canvas=page.locator('#map canvas');
 const toggle=async visible=>{
  await page.locator('#preferencesBtn').click();
  await page.locator('#preferencesGraticuleInput').setChecked(visible);
  await page.locator('#preferencesCloseBtn').click();
 };
 const initial=await canvas.screenshot();
 await toggle(false);
 await expect.poll(async()=>(await canvas.screenshot()).equals(initial)).toBe(false);
 await toggle(true);
 await expect.poll(async()=>(await canvas.screenshot()).equals(initial)).toBe(true);
});

test('Three globe places and selects a built-in city at its geographic position', async ({page})=>{
 await page.goto('./?debug=1');
 await ready(page,'Three globe city startup');
 const paris=[2.3488,48.8534];
 await goToCoordinate(page,paris,8);
 await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_VIEWER__.rendererStats().placeLabelCount),{timeout:60_000}).toBeGreaterThan(0);
 await clickGeographicPoint(page,paris);
 await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_VIEWER__.selectionSnapshot().items.map(ref=>ref.domain))).toEqual(['label']);
});

test('Three globe draws local detailed rivers and reuses them after hiding the layer', async ({page})=>{
 const detailRequests=[];
 page.on('request',request=>{if(request.url().includes('/globe-preview/river-detail/'))detailRequests.push(request.url());});
 await page.goto('./?debug=1');
 await ready(page,'Three globe rivers startup');
 expect(detailRequests).toEqual([]);
 const go=zoom=>goToCoordinate(page,[2.3488,48.8534],zoom);
 const detail=()=>page.evaluate(()=>window.__PANDOLAB_VIEWER__.rendererStats().riverDetail);
 await go(8);
 await expect.poll(async()=>{const state=await detail();return state.visibleChunks>0&&state.visibleChunks===state.requestedChunks;}).toBe(true);
 const first=await detail(),network=detailRequests.length;
 expect(first.activeSegments).toBeGreaterThan(0);
 expect(network).toBeGreaterThan(0);
 expect(network).toBeLessThan(await page.evaluate(()=>window.PANDOLAB_BUILD_META.globePreview.physical.riverDetail.length));
 const canvas=page.locator('#map canvas'),before=await canvas.screenshot();
 await page.locator('#preferencesBtn').click();
 await page.locator('#preferencesRiversInput').uncheck();
 await page.locator('#preferencesCloseBtn').click();
 await expect.poll(async()=>(await detail()).visibleChunks).toBe(0);
 await expect.poll(async()=>(await canvas.screenshot()).equals(before)).toBe(false);
 await page.locator('#preferencesBtn').click();
 await page.locator('#preferencesRiversInput').check();
 await page.locator('#preferencesCloseBtn').click();
 await expect.poll(detail).toEqual(first);
 expect(detailRequests).toHaveLength(network);
});

// Read the immutable published catalog independently of the running renderer.
// A changed source pin may legitimately add/remove objects or geometry versions.
async function readPinnedGlobeHistory(page){
  const spec=await page.evaluate(()=>window.PANDOLAB_BUILD_META.globePreview);
  const response=await page.request.get(new URL(spec.historyCatalog.url,page.url()).href);
  expect(response.ok()).toBe(true);
  const bytes=await response.body(),asset=spec.historyCatalog;
  expect(bytes.length).toBe(asset.compressedBytes);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
  const decoded=gunzipSync(bytes,{maxOutputLength:asset.decodedBytes});
  expect(decoded.length).toBe(asset.decodedBytes);
  const catalog=JSON.parse(decoded.toString('utf8')),base=spec.countrySlots.map((_,index)=>index);
  const moments=catalog.historyTimeline,history=catalog.history;
  return month=>{
    const key=globeHistoryMonthKey(month);
    const moment=moments.findLast(([date])=>globeHistoryMonthKey(date)<=key);
    expect(moment,'pinned history contains '+month).toBeDefined();
    const index=moment[1];
    if(index===-1)return base;
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(history.rows.length);
    let slots=[];
    for(let i=index-index%history.stride;i<=index;i++)slots=decodeGlobeHistoryList(slots,history.rows[i][1]);
    expect(new Set(slots).size).toBe(slots.length);
    return slots;
  };
}

test('Three globe switches to changed historical meshes and reuses them on return', async ({page})=>{
 const historyRequests=[];
 page.on('requestfinished',request=>{
  const path=new URL(request.url()).pathname;
  if(/\/globe-preview\/historical\/(?:countries|borders)\//.test(path))historyRequests.push(path);
 });
 await page.goto('./?debug=1');
 await ready(page,'Three globe historical startup');
 await goToCoordinate(page,[46.7,39.8],2.75);
 const expectedSlots=await readPinnedGlobeHistory(page);
 const canvas=page.locator('#map canvas'),modernMap=await canvas.screenshot();
 const active=()=>page.evaluate(()=>{
  const viewer=window.__PANDOLAB_VIEWER__,stats=viewer.rendererStats();
  return {month:stats.presentedFrame.month,slots:stats.presentedFrame.territorialSlots,
   count:stats.countrySlotCount,changed:stats.activeHistoricalTerritories};
 });
 const base=await active(),initialCamera=(await camera(page)).camera;
 const assertMonth=async(value)=>{
  const expected=expectedSlots(value);
  const baseCount=await page.evaluate(()=>window.PANDOLAB_BUILD_META.globePreview.countrySlots.length);
  await expect.poll(active).toEqual({month:value,slots:expected,count:expected.length,
   changed:expected.filter(slot=>slot>=baseCount).length});
  expect((await camera(page)).camera).toEqual(initialCamera);
 };
 await assertMonth(base.month);
 await month(page,'2020-12');
 await assertMonth('2020-12');
 const first=await active();
 expect(first.slots).not.toEqual(base.slots);
 expect(first.changed).toBeGreaterThan(0);
 await expect.poll(()=>historyRequests.length).toBeGreaterThan(0);
 await expect.poll(async()=>(await canvas.screenshot()).equals(modernMap)).toBe(false);
 const visited=new Set(historyRequests);
 const downloads=()=>historyRequests.filter(path=>visited.has(path)).length;
 const initialDownloads=downloads();
 await month(page,base.month);
 await assertMonth(base.month);
 await expect.poll(async()=>(await canvas.screenshot()).equals(modernMap)).toBe(true);
 await month(page,'2020-12');
 await assertMonth('2020-12');
 expect(await active()).toEqual(first);
 // Adjacent-date prefetch may download different packets; a revisit must
 // reuse the successfully downloaded historical packets already visited.
 expect(downloads()).toBe(initialDownloads);
 for(const value of ['1991-12','1910-07','-0001-12','0001-01']){
  await month(page,value);
  await assertMonth(value);
 }
});

async function openGeographicSampleMap(page){
 await page.addInitScript(()=>localStorage.setItem('pandolab-user-preferences',JSON.stringify({version:2,backgrounds:{viewer:{graticule:false}}})));
 await page.goto('./?debug=1');
 await ready(page,'geographic samples startup');
 const go=(center,zoom)=>goToCoordinate(page,center,zoom);
 const rgb=hex=>hex.slice(1).match(/../g).map(value=>parseInt(value,16));
 const paint=async(coordinate,hex)=>expect.poll(async()=>{
  const actual=await readGeographicPixel(page,coordinate);
  return actual?Math.max(...rgb(hex).map((value,index)=>Math.abs(actual[index]-value))):Infinity;
 },{message:'Geographic pixel: '+coordinate.join(',')+' expected '+hex}).toBeLessThanOrEqual(1);
 return {go,paint};
}

// Source coordinates, not a previously rendered image, define the coast.
// Choose points clear of the stroke and antialiasing on opposite sides of
// the current pinned boundary in the original test region.
function coastSamples(geometry,near){
 const polygons=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;
 const segments=polygons.flatMap(p=>p.flatMap(r=>r.slice(1).map((b,i)=>[r[i],b])));
 const containsRing=([x,y],ring)=>{
  let inside=false;
  for(let i=1;i<ring.length;i++){
   const [ax,ay]=ring[i-1],[bx,by]=ring[i];
   if((ay>y)!==(by>y)&&x<ax+(bx-ax)*(y-ay)/(by-ay))inside=!inside;
  }
  return inside;
 };
 const inside=point=>polygons.some(p=>containsRing(point,p[0])&&!p.slice(1).some(r=>containsRing(point,r)));
 const closest=([x,y],[[ax,ay],[bx,by]])=>{
  const dx=bx-ax,dy=by-ay,t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy||1)));
  return [ax+t*dx,ay+t*dy];
 };
 const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
 const nearby=segments.map(segment=>({segment,center:closest(near,segment)}))
  .map(row=>({...row,distance:distance(row.center,near)}))
  .filter(row=>row.distance<0.25).sort((a,b)=>a.distance-b.distance);
 for(const {segment:[a,b],center} of nearby.slice(0,64)){
  const dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);
  if(!length)continue;
  for(const offset of [0.008,0.015]){
   const pair=[1,-1].map(sign=>[center[0]-sign*dy*offset/length,center[1]+sign*dx*offset/length]);
   if(inside(pair[0])===inside(pair[1]))continue;
   if(pair.some(point=>segments.some(segment=>distance(point,closest(point,segment))<0.003)))continue;
   return {center,land:inside(pair[0])?pair[0]:pair[1],ocean:inside(pair[0])?pair[1]:pair[0]};
  }
 }
 throw Error('No clear source coastline samples near '+near.join(','));
}

test('Three globe uses territorial coastlines for coastal fill',async({page})=>{
 const {go,paint}=await openGeographicSampleMap(page);
 const meta=await page.evaluate(()=>window.PANDOLAB_BUILD_META);
 const url=new URL(meta.projectCatalogs.territorial.catalog,page.url());
 const response=await page.request.get(url.href);
 expect(response.ok()).toBe(true);
 const index=await response.json();
 for(const [code,near,color] of [
  ['NCL',[166.216213,-22.126016],COUNTRY_DEFAULT_COLORS.FRA],
  ['CHL',[-74.209291,-42.942997],COUNTRY_DEFAULT_COLORS.CHL],
 ]){
  const identity=index.sourceIdentities.find(row=>row.sourceEntityIds.includes('state:'+code));
  expect(identity,'source identity '+code).toBeDefined();
  const slot=meta.globePreview.countrySlots.find(row=>row.id===identity.projectEntityId);
  expect(slot,'current territory '+code).toBeDefined();
  const asset=index.geometryAssets.find(row=>row.id===slot.geometry.id&&row.version===slot.geometry.version);
  expect(asset.contentSha256).toBe(slot.geometry.contentSha256);
  const source=await page.request.get(new URL(asset.file,url).href);
  expect(source.ok()).toBe(true);
  const bytes=await source.body();
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
  const geometry=JSON.parse(gunzipSync(bytes,{maxOutputLength:asset.decodedBytes}).toString('utf8'));
  const {center,land,ocean}=coastSamples(geometry,near);
  await go(center,10);
  await paint(land,color);await paint(ocean,'#ffffff');
 }
});

test('Three globe preserves polar, date-line and microstate surfaces',async({page})=>{
 const {go,paint}=await openGeographicSampleMap(page);
 const ant=[20,-85],north=[0,89.9];
 await go(ant,5);await paint(ant,'#f1f1f1');
 await go(north,5);await paint(north,'#ffffff');
 await go([180,-16.86],12);
 await paint([179.99,-16.86],COUNTRY_DEFAULT_COLORS.FJI);
 await paint([-179.99,-16.86],COUNTRY_DEFAULT_COLORS.FJI);
 await paint([180,-16.86],COUNTRY_DEFAULT_COLORS.FJI);
 await go([126.5,33.54],10);
 await paint([126.47,33.42],COUNTRY_DEFAULT_COLORS.KOR);
 await paint([126.47,33.66],'#ffffff');
 // Sample inside the polygon beside the country label at this zoom.
 const vatican=[12.45375,41.90308];
 await go([12.4534,41.9033],17);
 await paint(vatican,COUNTRY_DEFAULT_COLORS.VAT);
 await clickGeographicPoint(page,vatican);
 await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_VIEWER__.selectionSnapshot().items.map(row=>row.id))).toContain('VAT');
});

test('Three globe switches historical territories and water in the same dated frame',async({page})=>{
 await page.goto('./?debug=1');
 await ready(page,'dated physical startup');
 const state=()=>page.evaluate(()=>{
  const viewer=window.__PANDOLAB_VIEWER__,stats=viewer.rendererStats();
  return {month:viewer.builtinMonth().month,water:stats.physicalWaterIds,territories:stats.countrySlotCount};
 });
 await goToCoordinate(page,[58,43],2.75);
 const initialCamera=(await camera(page)).camera,before=await state();
 // The same point in the eastern Aral basin is dry today and submerged in 1923.
 const aralPoint=[60.6,45.4];
 const colorAtAral=()=>readGeographicPixel(page,aralPoint);
 const land=COUNTRY_DEFAULT_COLORS.KAZ.slice(1).match(/../g).map(value=>parseInt(value,16));
 await expect.poll(colorAtAral,{timeout:15000}).toEqual(land);
 await month(page,'1923-11');
 const dated=await state();
 expect(dated).toMatchObject({month:'1923-11',water:expect.arrayContaining(['waterbody:aral','waterbody:caspian'])});
 expect(dated.territories).toBeLessThan(before.territories);
 expect((await camera(page)).camera).toEqual(initialCamera);
 await expect.poll(colorAtAral,{timeout:15000}).toEqual([255,255,255]);
 await month(page,before.month);
 expect(await state()).toEqual(before);
 await expect.poll(colorAtAral,{timeout:15000}).toEqual(land);
});

test('Three globe selects rendered rivers and dated water with Core identities',async({page})=>{
 await page.setViewportSize({width:1280,height:800});
 await page.addInitScript(()=>localStorage.setItem('pandolab-user-preferences',JSON.stringify({version:2,selection:{color:'#ff00fd',fillStrength:1}})));
 await page.goto('./?debug=1');
 await ready(page,'Three globe hydro selection startup');
 const go=(center,zoom)=>goToCoordinate(page,center,zoom);
 const click=(coordinate,expected)=>clickGeographicPoint(page,coordinate,expected);
 const selection=()=>page.evaluate(()=>window.__PANDOLAB_VIEWER__.selectionSnapshot().items.map(ref=>ref.id));
 const selectRiver=async(coordinate,id,name)=>{
  await go(coordinate,12);
  await ready(page,'presented river '+name,{riverDetail:true,settled:true});
  await click(coordinate,{riverDetail:true});
  const option=page.locator('#objectChooserList [role="option"]').filter({hasText:name});
  await expect.poll(async()=>await option.isVisible()||(await selection()).includes(id),
   {message:'Rendered river selection: '+name+' ('+id+')'}).toBe(true);
  if(await option.isVisible())await option.click();
  await expect.poll(selection).toContain(id);
 };
 // A vertex from the reviewed GRWL eastern mouth, with the retained river ID.
 const nakdong=[128.96075,35.1557],nakdongId='hydro-system:40505530';
 expect(await page.evaluate(()=>window.PANDOLAB_BUILD_META.projectCatalogs.rivers.version)).toBe('0.14.2');
 // Keep the Busan place label clear of the river hit target.
 await selectRiver(nakdong,nakdongId,'낙동강');
 const canvas=page.locator('#map canvas');
 await expect.poll(async()=>page.evaluate(async encoded=>{
  const image=await createImageBitmap(new Blob([Uint8Array.from(atob(encoded),char=>char.charCodeAt(0))]));
  const ctx=new OffscreenCanvas(image.width,image.height).getContext('2d');ctx.drawImage(image,0,0);image.close();
  const rgba=ctx.getImageData(0,0,ctx.canvas.width,ctx.canvas.height).data;
  for(let i=0;i<rgba.length;i+=4)if(rgba[i]>250&&rgba[i+1]<5&&rgba[i+2]>247)return true;
  return false;
 },(await canvas.screenshot()).toString('base64'))).toBe(true);
 const thames=[-0.84703,51.54459],thamesId='hydro-grwl:V01.02:17337';
 await selectRiver(thames,thamesId,'템스강');
 await expect(page.locator('#viewerSelectionStatus')).toHaveText('템스강');
 const chao=[100.55509,14.04603],chaoId='hydro-system:41339527';
 await selectRiver(chao,chaoId,'짜오프라야강');
 await expect(page.locator('#viewerSelectionStatus')).toHaveText('짜오프라야강');
 const caspian=[51,42];
 await go(caspian,2.75);
 await month(page,'1923-11');
 const unselectedLake=await canvas.screenshot();
 await click(caspian);
 await expect.poll(selection).toEqual(['waterbody:caspian']);
 await expect.poll(async()=>(await canvas.screenshot()).equals(unselectedLake)).toBe(false);
});

test('Viewer paints the correct search layout before startup completes',async({browser,baseURL})=>{
 for(const [width,height,layout,touch] of [[390,844,'mobile',true],[844,390,'phone-landscape',true],
  [1024,768,'compact',true],[1440,900,'wide',false]]){
  const context=await browser.newContext({baseURL,viewport:{width,height},isMobile:touch,hasTouch:touch});
  let release;
  try{
   const page=await context.newPage();
   const pending=new Promise(resolve=>{release=resolve;});
   await page.route(/\/assets\/js\/viewer\.js(?:\?|$)/,async route=>{await pending;await route.abort();});
   await page.goto('./',{waitUntil:'commit'});
   await page.waitForFunction(()=>performance.getEntriesByName('first-contentful-paint').length>0);
   await expect(page.locator('#viewer')).toHaveAttribute('data-layout',layout);
   await expect(page.locator('body')).toHaveAttribute('data-layout',layout);
   const docked=layout==='mobile'||layout==='phone-landscape';
   await expect(page.locator(docked?'#objectSearchInput':'#objectSearchBtn')).toBeVisible();
   await expect(page.locator(docked?'#objectSearchBtn':'#objectSearchInput')).toBeHidden();
  }finally{release?.();await context.close();}
 }
});

test('Viewer dialogs share readable action colors across layouts and themes',async({browser,baseURL,page})=>{
 const install=async target=>{
  await target.addInitScript(()=>{
   const get=window.getComputedStyle.bind(window);
   window.getComputedStyle=(element,...args)=>element.style?.color.toLowerCase()==='accentcolor'
    ?{color:'rgb(0, 117, 255)'}:get(element,...args);
  });
  await open(target);
  await target.addStyleTag({content:'.ui-button { transition: none !important; }'});
 };
 const palette=async(target,{theme,layout,mobile=false})=>{
  await target.emulateMedia({colorScheme:theme});
  await expect(target.locator('html')).toHaveAttribute('data-theme',theme);
  await expect(target.locator('#viewer')).toHaveAttribute('data-layout',layout);
  const read=selector=>target.locator(selector).evaluate(button=>{
   const style=getComputedStyle(button),tokens=getComputedStyle(button.closest('.ui-dialog-card'));
   return {ink:style.color,fill:style.backgroundColor,edge:style.borderTopColor,paper:tokens.backgroundColor,
    states:['--accent','--ui-button-selected','--ui-control-bg-pressed','--text','--focus-ring'].map(key=>style.getPropertyValue(key))};
  });
  const clickMenu=async id=>{
   if(mobile)await target.locator('#mobileMenuBtn').click();
   await target.locator(id).click();
  };
  await clickMenu(mobile?'#mobilePreferencesBtn':'#preferencesBtn');
  await expect(target.locator('#preferencesCloseBtn')).toBeVisible();
  await target.mouse.move(0,0);
  const settings=await read('#preferencesCloseBtn');
  expect(settings.ink).toBe('rgb(255, 255, 255)');
  if(!mobile){
   const button=target.locator('#preferencesCloseBtn');await button.hover();
   expect((await read('#preferencesCloseBtn')).ink).toBe(settings.ink);
   await target.mouse.down();expect((await read('#preferencesCloseBtn')).ink).toBe(settings.ink);
   await target.mouse.up();
  }else await target.locator('#preferencesCloseBtn').click();
  await clickMenu(mobile?'#mobileMenuFileBtn':'#fileBtn');
  await expect(target.locator('#projectPickerCloseBtn')).toBeVisible();
  await target.mouse.move(0,0);
  expect(await read('#projectPickerCloseBtn')).toEqual(settings);
  await target.locator('#projectPickerCloseBtn').click();
  return settings;
 };
 await page.setViewportSize({width:1440,height:900});
 await install(page);
 const wide={light:await palette(page,{theme:'light',layout:'wide'}),dark:await palette(page,{theme:'dark',layout:'wide'})};
 expect(wide.light.fill).not.toBe(wide.dark.fill);
 const context=await browser.newContext({baseURL,viewport:{width:1024,height:768},hasTouch:true,isMobile:true});
 try{
  const touch=await context.newPage();await install(touch);
  for(const [width,height,layout] of [[1024,768,'compact'],[390,844,'mobile'],[844,390,'phone-landscape']]){
   await touch.setViewportSize({width,height});
   for(const theme of ['light','dark'])
    expect(await palette(touch,{theme,layout,mobile:layout!=='compact'})).toEqual(wide[theme]);
  }
 }finally{await context.close();}
});

async function month(page,value){
  const separator=value.lastIndexOf('-'),year=value.slice(0,separator),month=value.slice(separator+1);
  await page.locator('#timelineDateButton').click();
  await page.locator('#timelineViewUnit').selectOption('month');
  await page.locator('#timelineYearInput').fill(year);
  await page.locator('#timelineMonthInput').selectOption(String(Number(month)));
  const before=await page.evaluate(()=>window.__PANDOLAB_VIEWER__.rendererStats().presentedFrame);
  const started=performance.now();
  await page.locator('#timelineGoBtn').click();
  await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_VIEWER__.documentState().timelineCursor),{timeout:60_000}).toBe(value);
  console.log('[viewer-ready]',JSON.stringify({stage:`month ${value}`,milestone:'cursor accepted',elapsedMs:Math.round(performance.now()-started)}));
  await ready(page,`month ${value}`,{month:value,afterFrame:before&&before.month!==value?before.frameId:null});
}

test('timeline displays one line and changes month through the dropdown', async ({page}) => {
  await open(page);
  const current = await page.evaluate(() => window.__PANDOLAB_VIEWER__.builtinMonth().month);
  const [year, currentMonth] = current.split('-').map(Number);
  const button = page.locator('#timelineDateButton'), label = page.locator('#timelineDateButtonText');
  await expect(label).toHaveText(`${year}년 ${currentMonth}월`);
  await expect(button).toHaveAccessibleName(`${year}년 ${currentMonth}월, 현재 월 기준, 시점 직접 입력`);
  await page.locator('#timelinePreviousYear').click();
  await expect(label).toHaveText(`${year - 1}년 말`);
  await expect(button).toHaveAccessibleName(`${year - 1}년 말, 연말 기준, 시점 직접 입력`);
  await page.locator('#timelineDateButton').click();
  await page.locator('#timelineViewUnit').selectOption('month');
  await expect(page.locator('#timelineMonthFields button')).toHaveCount(0);
  await page.getByRole('combobox', {name: '월', exact: true}).selectOption('7');
  await expect(label).toHaveText(`${year - 1}년 말`);
  await page.locator('#timelineGoBtn').click();
  await expect(label).toHaveText(`${year - 1}년 7월`);
  await expect(button).toHaveAccessibleName(`${year - 1}년 7월, 월말 기준, 시점 직접 입력`);
  await page.setViewportSize({width: 320, height: 690});
  await expect(page.locator('#viewer')).toHaveAttribute('data-layout', 'mobile');
  await expect(label).toHaveCSS('white-space', 'nowrap');
  expect(await label.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});

for (const touch of [false, true]) {
  test(`파일에서 프로젝트 선택창을 바로 연다 (${touch ? '모바일' : '데스크톱'})`, async ({browser, baseURL}) => {
    const context = await browser.newContext({baseURL, hasTouch: touch, isMobile: touch,
      viewport: touch ? {width: 390, height: 844} : {width: 1280, height: 800}});
    try {
      const page = await context.newPage();
      await open(page);
      const currentMonth = await page.evaluate(() => window.__PANDOLAB_VIEWER__.builtinMonth().month);
      const previousYearEnd = String(Number(currentMonth.slice(0, 4)) - 1) + '-12';
      await month(page, previousYearEnd);
      const menu = page.locator('#mobileMenuBtn');
      const file = touch ? page.getByRole('menuitem', {name: '파일'}) : page.getByRole('button', {name: '파일', exact: true});
      const picker = page.getByRole('dialog', {name: '프로젝트 선택'});
      const response = await page.request.get('./assets/data/projects/default-world/manifest.json');
      expect(response.ok()).toBe(true);
      const published = await response.json();
      expect(published.name).toBe('세계지도');
      const project = picker.getByRole('button', {name: published.name, exact: true});
      const activate = control => touch ? control.tap({timeout: 5000}) : control.click({timeout: 5000});
      const showPicker = async () => {
        if (touch) await activate(menu);
        await activate(file);
        await expect(picker).toBeVisible();
        await expect(project).toBeFocused();
      };
      const returnFocus = touch ? menu : file;
      await showPicker();
      await activate(picker.getByRole('button', {name: '닫기'}));
      await expect(picker).toBeHidden();
      await expect(returnFocus).toBeFocused();
      await showPicker();
      await page.keyboard.press('Escape');
      await expect(picker).toBeHidden();
      await expect(returnFocus).toBeFocused();
      await showPicker();
      await page.mouse.click(5, 5);
      await expect(picker).toBeHidden();
      await expect(returnFocus).toBeFocused();
      expect(await page.evaluate(() => window.__PANDOLAB_VIEWER__.builtinMonth())).toEqual({
        month: previousYearEnd, automatic: false,
      });
      await showPicker();
      await activate(project);
      await expect(picker).toBeHidden();
      await expect.poll(() => page.evaluate(() => window.__PANDOLAB_VIEWER__.builtinMonth()), {timeout: 60_000})
        .toEqual({month: currentMonth, automatic: true});
    } finally {
      await context.close();
    }
  });
}

async function search(page,touch=false){
  if(touch)await page.locator('#objectSearchInput').tap();
  else await page.locator('#objectSearchBtn').click();
  await page.getByRole('searchbox',{name:'객체 검색'}).fill('대한민국');
  await page.locator('#objectSearchResults button').filter({hasText:'대한민국'}).first()[touch?'tap':'click']();
  await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_VIEWER__.selectionSnapshot().items.map(x=>x.id))).toContain('KOR');
  await ready(page);
}

test('France details flag grid previews and navigates to its child territories',async({browser,baseURL})=>{
  test.setTimeout(180_000);
  for(const mobile of [false,true]){
    const context=await browser.newContext({baseURL,viewport:mobile?{width:320,height:800}:{width:1200,height:900},
      isMobile:mobile,hasTouch:mobile});
    try{
      const page=await context.newPage();
      await open(page);
      if(mobile)await page.locator('#objectSearchInput').tap();
      else await page.locator('#objectSearchBtn').click();
      await page.getByRole('searchbox',{name:'객체 검색'}).fill('프랑스');
      await page.locator('#objectSearchResults button').filter({hasText:/^프랑스(?:\s|$)/}).first()[mobile?'tap':'click']();
      const details=page.locator('#objectDetailSurface');
      await expect(details.locator('#objectDetailObjectName')).toHaveText('프랑스');
      if(mobile)await page.getByRole('slider',{name:'정보창 높이 조절'}).tap();
      await expect(details.getByRole('button',{name:'객체 정보 닫기'})).toHaveCount(0);
      await expect(details.getByText(/^\d+개$/)).toHaveCount(0);
      const heading=page.getByRole('heading',{name:'해외집합체',exact:true});
      const group=details.locator('section.object-details-group').filter({has:heading});
      const tiles=group.locator('.object-details-child');
      await expect(tiles).toHaveCount(5);
      const boxes=await tiles.evaluateAll(nodes=>nodes.map(node=>{
        const {x,y,width,height}=node.getBoundingClientRect();
        return {x,y,width,height};
      }));
      expect(new Set(boxes.slice(0,4).map(box=>box.y)).size).toBe(1);
      expect(boxes[4].y).toBeGreaterThan(boxes[0].y);
      expect(boxes[4].x).toBe(boxes[0].x);
      for(const box of boxes){
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBe(boxes[0].height);
        expect(box.x+box.width).toBeLessThanOrEqual(mobile?320:1200);
      }
      const tile=tiles.first(),name=await tile.getAttribute('aria-label');
      expect(name).toBe('생마르탱');
      if(mobile)await tile.tap();
      else {
        await tile.hover();
        await expect(page.locator('#uiTooltip')).toHaveText(name);
        const name2=await tiles.nth(1).getAttribute('aria-label');
        await tiles.nth(1).hover();
        await expect(page.locator('#uiTooltip')).toHaveText(name2);
        await heading.hover();
        await expect(page.locator('#uiTooltip')).toBeHidden();
        await tiles.nth(1).focus();
        await page.keyboard.press('Shift+Tab');
        await expect(tile).toBeFocused();
        await expect(tile).toHaveCSS('outline-style','solid');
        await expect(page.locator('#uiTooltip')).toHaveText(name);
        await page.keyboard.press('Enter');
      }
      await expect(details.locator('#objectDetailObjectName')).toHaveText(name);
      await expect.poll(()=>page.evaluate(()=>{
        const {center:[lng,lat],zoom}=window.__PANDOLAB_MAP_HOST__.getViewState().camera;
        return Math.abs(lng+63.06)<3&&Math.abs(lat-18.08)<3&&zoom>5;
      })).toBe(true);
      if(mobile){
        await page.evaluate(()=>window.history.back());
        await expect(page.locator('#objectSearchInput')).toBeVisible();
      }else{
        await page.keyboard.press('Escape');
        await expect(details).not.toHaveClass(/surface-open/);
        await expect(page.locator('#map')).toBeFocused();
      }
    }finally{await context.close();}
  }
});

test('desktop Viewer presents the real map, changes year, searches and moves the camera',async({page})=>{
  await page.setViewportSize({width:1280,height:800});
  await open(page);
  await month(page,'2024-12');
  await search(page);
  await ready(page,'before camera drag',{settled:true});
  const before=await camera(page);
  const beforeFrame=await page.evaluate(()=>window.__PANDOLAB_VIEWER__.rendererStats().presentedFrame.frameId);
  await page.mouse.move(600,420);await page.mouse.down();
  await page.mouse.move(740,450,{steps:8});await page.mouse.up();
  await expect.poll(async()=>(await camera(page)).camera.center).not.toEqual(before.camera.center);
  await ready(page,'settled drag frame',{settled:true,afterFrame:beforeFrame});
  const moved=await camera(page);
  await expect.poll(()=>page.evaluate(view=>new Promise((resolve,reject)=>{const request=indexedDB.open('pandolab-viewer');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,transaction=db.transaction('views','readonly');transaction.oncomplete=()=>db.close();const records=transaction.objectStore('views').getAll();records.onsuccess=()=>resolve(records.result.some(record=>Math.abs((record.center?.[0]??1000)+view.globeRotation[0])<0.001&&record.zoom===view.zoom));records.onerror=()=>reject(records.error);};}),moved)).toBe(true);
  await page.reload({waitUntil:'domcontentloaded'});await ready(page,'camera restore');
  const restored=await camera(page);
  expect(restored.globeRotation[0]).toBeCloseTo(moved.globeRotation[0],3);
  expect(restored.globeRotation[1]).toBeCloseTo(moved.globeRotation[1],3);
  expect(restored.zoom).toBeCloseTo(moved.zoom,3);
});

const viewerChrome=element=>element.evaluate(node=>{
  const style=getComputedStyle(node);
  return {face:style.backgroundColor,edge:style.borderTopColor,shadow:style.boxShadow};
});
const viewerFaceRgba=element=>element.evaluate(node=>{
  const canvas=document.createElement('canvas').getContext('2d');
  canvas.fillStyle=getComputedStyle(node).backgroundColor;
  canvas.fillRect(0,0,1,1);
  return [...canvas.getImageData(0,0,1,1).data];
});

test('built-in map opens in the read-only inspector and exports diagnostics without changing its project',async({page})=>{
  await page.setViewportSize({width:1280,height:800});
  await page.emulateMedia({colorScheme:'light'});
  await open(page,'&inspect=1');
  await expect(page.locator('#openProjectBtn, #projectFileInput')).toHaveCount(0);
  const before=await page.evaluate(()=>({project:window.__PANDOLAB_VIEWER__.documentSnapshot(),state:window.__PANDOLAB_VIEWER__.documentState()}));
  expect(await page.evaluate(()=>window.__PANDOLAB_VIEWER__.readOnly)).toBe(true);
  const inspector=page.locator('#reviewPanel'),dateBar=page.locator('.timeline-controls');
  await expect(inspector).toBeVisible();
  for (const [layout, width, height] of [['wide', 1440, 800], ['compact', 834, 620]]) {
    await page.setViewportSize({width, height});
    await expect(page.locator('#viewer')).toHaveAttribute('data-layout', layout);
    const panelRect = await inspector.boundingBox(), barRect = await dateBar.boundingBox();
    expect(panelRect.y + panelRect.height, `${layout} inspector must leave room for the timeline`)
      .toBeLessThan(barRect.y);
    await page.locator('#timelineDateButton').click({timeout: 3000});
    await page.locator('#timelineYearInput').click({timeout: 3000});
    await page.locator('#timelineDateButton').click({timeout: 3000});
    await expect(inspector).toBeVisible();
  }
  await page.setViewportSize({width: 1280, height: 800});
  expect(await viewerChrome(inspector)).toEqual(await viewerChrome(dateBar));
  expect(await viewerFaceRgba(inspector)).toEqual([255,255,255,255]);
  await expect(dateBar).toHaveCSS('backdrop-filter','none');
  await expect(page.locator('#reviewTabPerformance')).toHaveCSS('min-height','40px');
  await expect(page.locator('#objectSearchBtn')).toHaveCSS('width','36px');
  await page.locator('#reviewTabPerformance').click();
  await page.locator('#reviewTabErrors').click();
  await ready(page);
  const pending=page.waitForEvent('download');
  await page.locator('#reviewExportDiagnostics').click();
  const download=await pending;
  expect(download.suggestedFilename()).toMatch(/^pando-viewer-inspection-.*\.json$/);
  const diagnostics=JSON.parse(await readFile(await download.path(),'utf8'));
  expect(diagnostics.schema).toBe('pando-viewer-inspection-v2');
  expect(diagnostics.map.renderer).toBe('three');expect(diagnostics.map.frameAcknowledged).toBe(true);
  expect(diagnostics.data.projectId).toBe(before.project.documentId);
  expect(diagnostics.data.readOnly).toBe(true);
  await page.keyboard.press('Escape');
  const searchButton=page.locator('#objectSearchBtn');
  const normalFace=(await viewerChrome(searchButton)).face;
  await searchButton.hover();
  await expect.poll(async()=>(await viewerChrome(searchButton)).face).not.toBe(normalFace);
  await page.keyboard.press('Tab');
  await searchButton.focus();
  await expect(searchButton).toHaveCSS('outline-style','solid');
  await searchButton.click();
  await expect(page.getByRole('searchbox',{name:'객체 검색'})).toBeFocused();
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:1440,height:900});
  await expect(page.locator('#viewer')).toHaveAttribute('data-layout','wide');
  await page.locator('#preferencesBtn').click();
  await expect(page.locator('#preferencesObjectColorsInput')).toBeChecked();
  await page.locator('[data-preference-theme="dark"]').click();
  expect(await viewerFaceRgba(page.locator('.preferences-card'))).toEqual([23,27,32,255]);
  await page.locator('#preferencesCloseBtn').click();await ready(page);
  expect(await viewerFaceRgba(dateBar)).toEqual([23,27,32,255]);
  await expect(page.locator('#map canvas')).toHaveCount(1);
  await page.keyboard.press('Delete');await page.keyboard.press('Control+z');
  expect(await page.evaluate(()=>window.__PANDOLAB_VIEWER__.documentSnapshot())).toEqual(before.project);
  const after=await page.evaluate(()=>window.__PANDOLAB_VIEWER__.documentState());
  expect(after.revision).toEqual(before.state.revision);
});

test('unsupported WebGL ends initial loading with a visible map error',async({page})=>{
 await page.addInitScript(()=>{const getContext=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(kind,...args){return /webgl/.test(kind)?null:getContext.call(this,kind,...args);};});
 await page.goto('./?debug=1',{waitUntil:'domcontentloaded'});
 await expect(page.locator('#viewerStatus')).toHaveAttribute('role','alert',{timeout:60000});
 await expect(page.locator('#viewerStatus')).toHaveAttribute('data-ready','false');
 await expect(page.locator('#viewer')).toHaveAttribute('data-initial-loading','false');
});
