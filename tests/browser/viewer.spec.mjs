import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';

async function ready(page,stage='map presentation'){
  const started=performance.now();let lastBlockers='',lastLogAt=-Infinity;
  await expect.poll(async()=>{
    const sample=await page.evaluate(()=>{
      const v=window.__PANDOLAB_VIEWER__,s=v?.rendererStats();
      const status=document.querySelector('#viewerStatus');
      const checks={
        initialMapPresented:Boolean(v?.initialMapPresented()),
        rendererMapReady:Boolean(s?.mapReadiness?.mapReady),
        projectNotBlocked:!s?.projectRenderBlocked,
        hasDisplayedRevision:s?.displayedRevision>0,
        viewerStatusReady:status?.dataset.ready==='true',
      };
      const blockers=Object.keys(checks).filter(key=>!checks[key]);
      if(!blockers.length)return {blockers};
      const map=window.__PANDOLAB_MAPLIBRE__;
      const inspect=read=>{try{return read();}catch{return null;}};
      return {blockers,rendererStatus:s?.mapReadiness?.status??null,
        webglContextLost:s?.webglContextLost??null,errorMessage:s?.errorMessage,
        sourceRevision:s?.sourceRevision??null,certifiedRevision:s?.certifiedRevision??null,
        displayedRevision:s?.displayedRevision??null,
        viewerStatus:status?.textContent??null,loadingKind:status?.dataset.loadingKind??null,
        tilesLoaded:inspect(()=>map?.areTilesLoaded()??null),styleLoaded:inspect(()=>map?.isStyleLoaded()??null),
        sources:Object.fromEntries(['territories','physical-land','physical-water','hydro','interaction'].map(id=>[
          id,map?.getSource(id)?map.isSourceLoaded(id)??null:null,
        ])),
      };
    });
    const now=performance.now(),elapsedMs=Math.round(now-started);
    if(!sample.blockers.length){
      console.log('[viewer-ready]',JSON.stringify({stage,elapsedMs,result:'ready'}));
      return true;
    }
    const key=JSON.stringify([sample.blockers,sample.rendererStatus,sample.tilesLoaded,sample.styleLoaded,sample.sources]);
    if(key!==lastBlockers||now-lastLogAt>=10_000){
      console.log('[viewer-ready]',JSON.stringify({stage,elapsedMs,...sample}));
      lastBlockers=key;lastLogAt=now;
    }
    return false;
  },{timeout:90_000,message:`Viewer not ready: ${stage}`}).toBe(true);
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

for(const [profile,viewport,saved] of [
 ['mobile',{width:390,height:844},null],
 ['desktop',{width:1440,height:900},null],
 ['saved desktop',{width:1440,height:900},{projection:'globe',center:[38,42],zoom:3.25,bearing:12,pitch:0,roll:0}],
]){
 test(`first visible globe keeps its camera through data loading (${profile})`,async({browser,baseURL})=>{
  const context=await browser.newContext({baseURL,viewport,hasTouch:profile==='mobile',isMobile:profile==='mobile'});
  const page=await context.newPage();
  if(saved){
   await page.route('**/camera-storage-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
   await page.goto('./camera-storage-fixture');
   await page.evaluate(async value=>{
    const {createBrowserProjectStorage}=await import(new URL('./assets/js/modules/browser-project-storage.js',location.href).href);
    const storage=createBrowserProjectStorage({productMode:'viewer',indexedDB,databaseName:'pandolab-viewer',storeName:'views',viewKey:'active-view'});
    await storage.writeCamera('default-world',value);
   },saved);
  }
  let allowGeometry,geometryRequested=false;
  const geometryBlocked=new Promise(resolve=>{allowGeometry=resolve;});
  try{
   await page.route(/\/world-geometry\/sha256-/,async route=>{
    geometryRequested=true;
    await geometryBlocked;
    await route.continue();
   });
   await page.addInitScript(()=>{
    const capture=()=>{
     const map=window.__PANDOLAB_MAPLIBRE__,canvas=map?.getCanvas();
     if(canvas&&getComputedStyle(canvas).visibility==='visible'){
      const center=map.getCenter();
      (window.__visibleGlobeFrames??=[]).push([center.lng,center.lat,map.getZoom(),map.getBearing()]);
      if(document.querySelector('#viewer')?.dataset.initialLoading==='true'&&
       !map.getLayer('initial-map-land')&&!document.querySelector('[data-map-preserved-frame]'))
       window.__uncoveredInitialFrame=true;
     }
     if(document.querySelector('#viewerStatus')?.dataset.ready!=='true')requestAnimationFrame(capture);
    };
    requestAnimationFrame(capture);
   });
   await page.goto('./?debug=1',{waitUntil:'domcontentloaded'});
   await expect.poll(()=>page.evaluate(()=>window.__visibleGlobeFrames?.length??0)).toBeGreaterThan(0);
   await expect.poll(()=>geometryRequested).toBe(true);
   expect(await page.locator('#viewer').getAttribute('data-initial-loading')).toBe('true');
   allowGeometry();
   await ready(page,'globe camera after loading');
   expect(await page.evaluate(()=>window.__uncoveredInitialFrame??false)).toBe(false);
   const {frames,final}=await page.evaluate(()=>{
    const map=window.__PANDOLAB_MAPLIBRE__,center=map.getCenter();
    return {frames:window.__visibleGlobeFrames,final:[center.lng,center.lat,map.getZoom(),map.getBearing()]};
   });
   for(const frame of frames)frame.forEach((value,index)=>expect(value).toBeCloseTo(final[index],5));
   if(saved)[...saved.center,saved.zoom,saved.bearing].forEach((value,index)=>expect(final[index]).toBeCloseTo(value,5));
  }finally{
   allowGeometry();
   await context.close();
  }
 });
}

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

test('graticule draws above the colored map and below selection and labels',async({page})=>{
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.addInitScript(()=>{
  const capture=()=>{
   const viewer=document.querySelector('#viewer'),map=window.__PANDOLAB_MAPLIBRE__;
   if(viewer?.dataset.initialLoading==='true'&&map?.getLayer('pando-polar-caps')){
    const layers=map.getLayersOrder();
    if(layers.at(-2)==='initial-map-land'&&layers.at(-1)==='pando-polar-caps'&&
       getComputedStyle(map.getCanvas()).animationName==='viewer-map-skeleton-pulse'){
     window.__polarSkeletonAnimated=true;
     return;
    }
   }
   if(!window.__PANDOLAB_VIEWER__?.initialMapPresented())requestAnimationFrame(capture);
  };
  requestAnimationFrame(capture);
 });
 await open(page);
 expect(await page.evaluate(()=>window.__polarSkeletonAnimated)).toBe(true);
 const ordered=()=>page.evaluate(()=>{
  const map=window.__PANDOLAB_MAPLIBRE__,order=map.getLayersOrder();
  const grid=order.indexOf('map-graticule');
  const selection=order.indexOf('interaction-fill'),labels=order.indexOf('viewer-label-text');
  return grid>order.indexOf('physical-land-fill')&&grid>order.indexOf('territories')
   &&grid>order.indexOf('physical-water')&&grid>order.indexOf('borders')&&grid<selection&&grid<labels;
 });
 await expect.poll(ordered).toBe(true);
 const sample=()=>page.evaluate(()=>new Promise(resolve=>{
  const map=window.__PANDOLAB_MAPLIBRE__;
  map.once('render',()=>{
   const source=map.getCanvas(),canvas=document.createElement('canvas');canvas.width=source.width;canvas.height=source.height;
   canvas.getContext('2d').drawImage(source,0,0);
   resolve(canvas.toDataURL());
  });
  map.triggerRepaint();
 }));
 const setGrid=async visible=>{
  await page.locator('#preferencesBtn').click();
  await page.locator('#preferencesGraticuleInput').setChecked(visible);
  await page.locator('#preferencesCloseBtn').click();
  await expect.poll(()=>page.evaluate(()=>Boolean(window.__PANDOLAB_MAPLIBRE__.getLayer('map-graticule')))).toBe(visible);
  await ready(page,'graticule preference');
 };
 await page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.jumpTo({center:[20,-85],zoom:3}));
 await ready(page,'polar graticule camera');
 const visible=await sample();
 await setGrid(false);
 expect(await sample()).not.toBe(visible);
 await setGrid(true);
 await expect.poll(ordered).toBe(true);
});

for(const deviceRatio of [2.625,1.3125])test('physical land stays continuous across inland borders at reference zooms, DPR '+deviceRatio,async({browser,baseURL})=>{
 test.setTimeout(180000);
 const context=await browser.newContext({baseURL,viewport:{width:412,height:780},deviceScaleFactor:deviceRatio});
 const page=await context.newPage();
 try{
 await open(page);
 expect(await page.evaluate(()=>window.__PANDOLAB_VIEWER__.rendererStats().physicalLandAssetHits)).toBeGreaterThan(0);
 const before=await page.evaluate(()=>window.__PANDOLAB_VIEWER__.rendererStats().physicalLandPreparations);
 await page.evaluate(()=>{
  const map=window.__PANDOLAB_MAPLIBRE__;
  map.addLayer({id:'land-proof-background',type:'background',paint:{'background-color':'#ffffff'}});
  map.addLayer({id:'land-proof-fill',type:'fill',source:'physical-land',paint:{'fill-color':'#cccccc','fill-antialias':true}});
 });
  for(const zoom of [1,3,5]){
   await page.evaluate(zoom=>window.__PANDOLAB_MAP_HOST__.setViewState({projection:'globe',view:{zoom:zoom,globeRotation:[-12,-49,0]}}),zoom);await ready(page,'land continuity '+zoom);
    await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.isSourceLoaded('physical-land'))).toBe(true);
    const sample=await page.evaluate(()=>new Promise((resolve,reject)=>{
     const map=window.__PANDOLAB_MAPLIBRE__;let attempts=0;
     // App ordering can place optional hydro above test layers. Isolate the
     // actual land source, so white river lines cannot be counted as land gaps.
     const others=()=>map.getStyle().layers.filter(layer=>!['land-proof-background','land-proof-fill'].includes(layer.id)&&layer.layout?.visibility!=='none');
     const isolate=()=>{for(const layer of others())map.setLayoutProperty(layer.id,'visibility','none');map.once('render',read);map.triggerRepaint();};
     const read=()=>{
      if(others().length){if(++attempts>20){reject(Error('Could not isolate physical land from optional layers'));return;}isolate();return;}
      const canvas=map.getCanvas(),gl=canvas.getContext('webgl2'),pixels=new Uint8Array(canvas.width*canvas.height*4),ratio=canvas.width/canvas.clientWidth;
      gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      // This inland rectangle excludes coasts and the canonical lake holes.
      // It spans several national borders; the count is pixels, not gaps.
      const visited=new Set(),light=[];
      const visit=coordinate=>{const p=map.project(coordinate),x=Math.round(p.x*ratio),y=Math.round(p.y*ratio);
       if(x<4||y<4||x>=canvas.width-4||y>=canvas.height-4)return;
       const key=y*canvas.width+x;if(visited.has(key))return;visited.add(key);
       const offset=((canvas.height-1-y)*canvas.width+x)*4;
       if(pixels[offset]>215&&pixels[offset+1]>215&&pixels[offset+2]>215&&light.length<20)light.push({coordinate,pixel:[x,y],rgb:[...pixels.slice(offset,offset+3)]});
      };
      for(let x=0;x<=320;x++)for(let y=0;y<=100;y++)visit([8+x*.05,47+y*.05]);
      visit([17.3796,48.8466]);
      resolve({sampledPixels:visited.size,light,tolerance:map.getSource('physical-land').serialize().tolerance??.375,
       deviceRatio:window.devicePixelRatio,pixelRatio:map.getPixelRatio()});
     };isolate();
    }));
    expect(sample.sampledPixels).toBeGreaterThan(100);expect(sample.light,JSON.stringify({zoom,deviceRatio,sample})).toEqual([]);
    expect(sample.tolerance).toBeGreaterThan(0);
    expect(sample.deviceRatio).toBe(deviceRatio);
    expect(sample.pixelRatio).toBe(deviceRatio);
  }
  expect(await page.evaluate(()=>window.__PANDOLAB_VIEWER__.rendererStats().physicalLandPreparations)).toBe(before);
 }finally{
  await context.close();
 }
});

test('prepared land and country coverage remain visible while panning',async({page})=>{
 test.setTimeout(180000);await open(page);
 await page.evaluate(()=>window.__PANDOLAB_MAP_HOST__.setViewState({projection:'globe',view:{zoom:4,globeRotation:[-20,-45,0]}}));
 await ready(page,'coverage camera');
 await page.evaluate(()=>{
  const map=window.__PANDOLAB_MAPLIBRE__,ids=['physical-land',map.getLayer('territories').source];
  const sources=ids.map(id=>map.getSource(id)),samples=[];
  const read=()=>{const point=map.project([20,45]),canvas=map.getCanvas();
   if(point.x<0||point.y<0||point.x>=canvas.clientWidth||point.y>=canvas.clientHeight)return;
   const layers=['physical-land-fill','territories'];
   const hits=new Set(map.queryRenderedFeatures(point,{layers}).map(feature=>feature.layer.id));
   samples.push({missing:layers.filter(id=>!hits.has(id)),sameSources:ids.every((id,index)=>map.getSource(id)===sources[index])});
  };
  map.on('render',read);window.__finishCoverage=()=>{map.off('render',read);return samples;};
 });
 const bounds=await page.locator('#map').boundingBox(),x=bounds.x+bounds.width/2,y=bounds.y+bounds.height/2;
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x-120,y+20,{steps:30});await page.mouse.move(x,y,{steps:30});await page.mouse.up();
 await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.isMoving())).toBe(false);
 const samples=await page.evaluate(()=>window.__finishCoverage());
 expect(samples.length).toBeGreaterThan(5);
 expect(samples.filter(row=>!row.sameSources)).toEqual([]);
 expect(samples.filter(row=>row.missing.length)).toEqual([]);
});

test('rapid zoom keeps the previous frame until the shared inland boundary and land tiles draw',async({page,context})=>{
 const devtools=await context.newCDPSession(page);
 await devtools.send('Network.enable');
 await devtools.send('Network.setCacheDisabled',{cacheDisabled:true});
 await page.setViewportSize({width:1280,height:800});
 await open(page);
 const center=await page.evaluate(async()=>{
  const map=window.__PANDOLAB_MAPLIBRE__,source=map.getSource(map.getLayer('territories').source);
  let nearest=null,distance=Infinity;
  for(const feature of (await source.getData()).features){
   if(feature.properties.displayRole!=='country-border')continue;
   for(const line of feature.geometry.coordinates)for(const point of line){
    const d=Math.hypot((point[0]-13.84)*.63,point[1]-50.77);
    if(d<distance){nearest=point;distance=d;}
   }
  }
  if(!nearest||distance>.1)throw Error('German–Czech boundary is missing near the fixture');
  return nearest;
 });
 expect(await page.evaluate(()=>[window.__PANDOLAB_MAPLIBRE__.getMinZoom(),window.__PANDOLAB_MAPLIBRE__.getMaxZoom()])).toEqual([-2,22]);
 const jump=zoom=>page.evaluate(({center,zoom})=>{window.__PANDOLAB_MAPLIBRE__.jumpTo({center,zoom});},{center,zoom});
 await jump(-2);
 await ready(page,'minimum zoom');
 await page.evaluate(center=>{
  const map=window.__PANDOLAB_MAPLIBRE__,canvas=map.getCanvas();
  const source=map.getSource(map.getLayer('territories').source),land=map.getSource('physical-land');
  if(map.getLayer('borders').source!==map.getLayer('territories').source)throw Error('Separate country tiles');
  const pending=[];
  for(const item of [source,land]){
   const load=item.loadTile.bind(item);
   item.loadTile=async tile=>{
    if(tile.tileID.overscaledZ>=18)await new Promise(resolve=>pending.push(resolve));
    return load(tile);
   };
   pending.push(()=>{item.loadTile=load;});
  }
  const sampleCanvas=document.createElement('canvas');sampleCanvas.width=sampleCanvas.height=12;
  const ctx=sampleCanvas.getContext('2d',{willReadFrequently:true});
  const sample=frame=>{ctx.clearRect(0,0,12,12);ctx.drawImage(frame,0,0,12,12);return ctx.getImageData(0,0,12,12).data.join(',');};
  const before=sample(canvas),frames=[];
  let recording=true;
  const capture=()=>{
   if(!recording)return;
   const overlay=document.querySelector('[data-map-preserved-frame] canvas');
   const loaded=map.isSourceLoaded(source.id)&&map.isSourceLoaded(land.id);
   frames.push({retained:!!overlay&&sample(overlay)===before,loaded,ready:window.__PANDOLAB_VIEWER__.rendererStats().mapReadiness.mapReady});
   requestAnimationFrame(capture);
  };
  window.__rapidZoom={
   pending:()=>pending.length-2,
   release:()=>{for(const resolve of pending.splice(0))resolve();},
   finish:()=>{recording=false;return frames;},
  };
  map.jumpTo({center,zoom:map.getMaxZoom()});
  requestAnimationFrame(capture);
 },center);
 await expect.poll(()=>page.evaluate(()=>window.__rapidZoom.pending())).toBeGreaterThan(0);
 await expect(page.locator('[data-map-preserved-frame]')).toBeVisible();
 const bounds=await page.locator('#map').boundingBox();
 const selected=()=>page.evaluate(()=>window.__PANDOLAB_VIEWER__.selectionSnapshot().items);
 const formerSelection=await selected();
 await page.mouse.click(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
 expect(await selected()).toEqual(formerSelection);
 await page.evaluate(()=>window.__rapidZoom.release());
 await ready(page,'maximum zoom with delayed required tiles');
 const frames=await page.evaluate(()=>window.__rapidZoom.finish());
 expect(frames.some(frame=>!frame.loaded)).toBe(true);
 const firstReady=frames.findIndex(frame=>frame.ready);
 const beforeFirstReady=firstReady===-1?frames:frames.slice(0,firstReady);
 expect(beforeFirstReady.filter(frame=>!frame.loaded||!frame.ready).every(frame=>frame.retained)).toBe(true);
 await expect(page.locator('[data-map-preserved-frame]')).toHaveCount(0);
 const visible=await page.evaluate(()=>{
  const map=window.__PANDOLAB_MAPLIBRE__;
  return {countries:[...new Set(map.queryRenderedFeatures({layers:['territories']}).map(row=>row.properties.objectKey))],
   borders:map.queryRenderedFeatures({layers:['borders']}).length};
 });
 expect(visible.countries).toEqual(expect.arrayContaining(['territorial:entity:DEU','territorial:entity:CZE']));
 expect(visible.borders).toBeGreaterThan(0);
 await jump(-2);
 await ready(page,'reverse rapid zoom');
 await page.locator('#resetViewBtn').click();
 await ready(page,'fitted view');
 await jump(22);
 await ready(page,'fitted view to maximum zoom');
 await expect(page.locator('[data-map-preserved-frame]')).toHaveCount(0);
});

for(const mobile of [false,true])test(`ordinary camera gestures never preserve the whole frame (${mobile?'touch':'desktop'})`,async({browser,baseURL})=>{
 const context=await browser.newContext({baseURL,viewport:mobile?{width:390,height:844}:{width:1200,height:800},
  deviceScaleFactor:mobile?2:1,hasTouch:mobile,isMobile:mobile});
 try{
  const page=await context.newPage();await open(page);
  await page.evaluate(()=>window.__PANDOLAB_MAP_HOST__.setViewState({projection:'globe',view:{zoom:3,globeRotation:[-112,-31,0]}}));
  await ready(page,'gesture camera');
  await expect(page.locator('[data-map-preserved-frame]')).toHaveCount(0);
  const before=await page.evaluate(()=>{
   const map=window.__PANDOLAB_MAPLIBRE__,stats=window.__PANDOLAB_VIEWER__.rendererStats;
   const baseline=stats(),gaps=[];let previous,request,overlays=0,longTasks=0;
   const tileRequests=new Map();
   const tileSources=Object.values(baseline.datedSources).map(id=>map.getSource(id)).filter(Boolean);
   const restore=tileSources.map(source=>{
    const load=source.loadTile;
    source.loadTile=function(tile){
     const key=this.id+':'+tile.tileID.key;
     tileRequests.set(key,(tileRequests.get(key)||0)+1);
     return load.call(this,tile);
    };
    return ()=>{source.loadTile=load;};
   });
   const observer=new PerformanceObserver(list=>{longTasks+=list.getEntries().length;});observer.observe({entryTypes:['longtask']});
   const sample=now=>{if(previous!==undefined)gaps.push(now-previous);previous=now;
    overlays+=Number(!!document.querySelector('[data-map-preserved-frame]'));request=requestAnimationFrame(sample);};
   request=requestAnimationFrame(sample);
   window.__finishCameraProbe=()=>{
    cancelAnimationFrame(request);longTasks+=observer.takeRecords().length;observer.disconnect();gaps.sort((a,b)=>a-b);
    restore.forEach(fn=>fn());
    const after=stats(),percentile=p=>gaps[Math.ceil(gaps.length*p)-1];
    return {center:map.getCenter().toArray(),zoom:map.getZoom(),overlays,longTasks,p95:percentile(.95),p99:percentile(.99),
     copies:after.preservedFrameCopies-baseline.preservedFrameCopies,sourceWrites:after.sourceWrites-baseline.sourceWrites,
     repeatedTiles:[...tileRequests.values()].reduce((total,count)=>total+count-1,0),
     approvalAttempts:after.approvalAttempts-baseline.approvalAttempts};
   };
   return {center:map.getCenter().toArray(),zoom:map.getZoom()};
  });
  const bounds=await page.locator('#map').boundingBox(),x=Math.round(bounds.x+bounds.width/2),y=Math.round(bounds.y+bounds.height/2);
  if(mobile){
   const session=await context.newCDPSession(page);
   await session.send('Input.synthesizePinchGesture',{x,y,scaleFactor:1.4,relativeSpeed:280,gestureSourceType:'touch'});
  }else{
   await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+95,y-40,{steps:20});await page.mouse.up();
   await page.mouse.wheel(0,-130);
  }
  await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.getZoom())).toBeGreaterThan(before.zoom);
  await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.isMoving())).toBe(false);
  const result=await page.evaluate(()=>window.__finishCameraProbe());
  console.log('[camera-gesture]',JSON.stringify({mobile,...result}));
  if(!mobile)expect(result.center).not.toEqual(before.center);
  expect(result.copies).toBe(0);expect(result.overlays).toBe(0);
 }finally{await context.close();}
});

for(const trackedKind of ['territorial','label'])test(`native ${trackedKind} names and flags stay attached during globe movement`,async({page})=>{
 await open(page);
 await page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.on('error',event=>{
  console.error('MapLibre tile error',JSON.stringify({source:event.sourceId,stack:event.error?.stack}));
 }));
 if(trackedKind==='territorial'){
  await page.evaluate(()=>{window.__PANDOLAB_MAPLIBRE__.jumpTo({zoom:4});});
  await ready(page,'country tracking camera');
 }
 if(trackedKind==='label'){
  await page.evaluate(()=>window.__PANDOLAB_MAP_HOST__.setViewState({projection:'globe',view:{zoom:4,globeRotation:[-90,-25,0]}}));
  await ready(page,'city tracking camera');
  await expect.poll(()=>page.evaluate(async()=>{const source=window.__PANDOLAB_MAPLIBRE__.getSource('viewer-labels');return (await source.getData()).features.some(feature=>feature.properties.kind==='label');})).toBe(true);
 }
 await page.evaluate(async trackedKind=>{
  const map=window.__PANDOLAB_MAPLIBRE__,rows=(await map.getSource('viewer-labels').getData()).features;
  if(!rows.some(feature=>feature.properties.kind==='territorial'&&feature.geometry.coordinates[0]>-130&&feature.geometry.coordinates[0]<-60&&feature.geometry.coordinates[1]>20&&feature.geometry.coordinates[1]<55))throw Error('The other hemisphere must already have geographic country labels before panning');
  const target=rows.filter(feature=>feature.properties.kind===trackedKind&&feature.properties.primary&&window.__PANDOLAB_MAP_HOST__.project(feature.geometry.coordinates)).sort((a,b)=>{const distance=feature=>{const p=map.project(feature.geometry.coordinates);return Math.hypot(p.x-map.getCanvas().clientWidth/2,p.y-map.getCanvas().clientHeight/2);};return distance(a)-distance(b);})[0];
  if(!target)throw Error('No country label to track');
  const trackedLayer=trackedKind==='territorial'?'viewer-label-country':'viewer-label-text';
  const key=target.properties.objectKey,coordinate=target.geometry.coordinates;
  const layout=map.setLayoutProperty.bind(map),filter=map.setFilter.bind(map);
  const fixed={'text-variable-anchor':null,'text-anchor':'left','text-allow-overlap':true,'icon-allow-overlap':true,'icon-image':'tracking-flag-fixture'};
  map.setLayoutProperty=(id,name,value)=>layout(id,name,id===trackedLayer&&Object.hasOwn(fixed,name)?fixed[name]:value);
  map.setFilter=(id,value)=>filter(id,id===trackedLayer?['==',['get','objectKey'],key]:value);
  map.setFilter(trackedLayer,['==',['get','objectKey'],key]);
  // Isolate attachment from MapLibre's permitted variable-anchor/collision
  // changes; those can move a glyph edge without any geographic lag.
  map.setLayoutProperty(trackedLayer,'text-variable-anchor',null);
  map.setLayoutProperty(trackedLayer,'text-anchor','left');
  map.setLayoutProperty(trackedLayer,'text-allow-overlap',true);
  map.setLayoutProperty(trackedLayer,'icon-allow-overlap',true);
  const paint=map.setPaintProperty.bind(map);
  // Keep country fills out of the pixel classifier for the test symbol.
  const testPaint=(id,name,value)=>id===trackedLayer&&name==='text-color'?'#ff00ff':
   /^territories(?:-fill-\d+)?$/.test(id)&&name==='fill-color'?'#f1f1f1':value;
  map.setPaintProperty=(id,name,value)=>paint(id,name,testPaint(id,name,value));
  for(const layer of map.getStyle().layers)
   if(layer.type==='fill'&&layer.source===map.getLayer('territories').source)paint(layer.id,'fill-color','#f1f1f1');
  map.setPaintProperty(trackedLayer,'text-color','#ff00ff');
  const data=new Uint8Array(12*8*4);for(let i=0;i<data.length;i+=4){data[i+1]=255;data[i+3]=255;}
  map.addImage('tracking-flag-fixture',{width:12,height:8,data});map.setLayoutProperty(trackedLayer,'icon-image','tracking-flag-fixture');
  const canvas=map.getCanvas(),gl=canvas.getContext('webgl2'),pixels=new Uint8Array(canvas.width*canvas.height*4),ratio=canvas.width/canvas.clientWidth;
  // Track the anchored text edge: globe perspective can change a long word's
  // width and SDF pixel centroid even when its anchor follows perfectly.
  // Include antialiased magenta fringes: an opaque-only cutoff can lose an
  // entire thin first glyph as its subpixel coverage changes.
  const locate=()=>{gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity,n=0,ix=0,iy=0,ni=0;for(let i=0;i<pixels.length;i+=4){const px=(i/4)%canvas.width,py=canvas.height-1-Math.floor(i/4/canvas.width);if(pixels[i]-pixels[i+1]>35&&pixels[i+2]-pixels[i+1]>35){left=Math.min(left,px);right=Math.max(right,px);top=Math.min(top,py);bottom=Math.max(bottom,py);n++;}if(pixels[i]<60&&pixels[i+1]>220&&pixels[i+2]<60){ix+=px;iy+=py;ni++;}}const p=map.project(coordinate);return {point:[p.x,p.y],text:n?[Math.max(left/ratio,Math.min(right/ratio,p.x)),Math.max(top/ratio,Math.min(bottom/ratio,p.y))]:null,flag:ni?[ix/ni/ratio,iy/ni/ratio]:null};};
  // The default WebGL drawing buffer is discarded after presentation. Read
  // pixels inside render, including on an otherwise idle city view.
  await new Promise((resolve,reject)=>{let attempts=0;const check=()=>{
   const sample=locate();
   if(sample.text&&sample.flag){map.off('render',check);resolve();return;}
   if(++attempts>=180){map.off('render',check);reject(Error('The native tracking fixture did not draw: '+JSON.stringify({sample,target,sourcePresent:!!map.getSource('viewer-labels')})));return;}
   map.triggerRepaint();
  };map.on('render',check);map.triggerRepaint();});
  const values=[];let last=-Infinity;
  const read=()=>{if(performance.now()-last<60)return;last=performance.now();values.push(locate());};map.on('render',read);
  window.__finishLabelTracking=()=>{map.off('render',read);return values;};
 },trackedKind);
 const bounds=await page.locator('#map').boundingBox(),x=bounds.x+bounds.width/2,y=bounds.y+bounds.height/2;
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x-220,y+90,{steps:90});await page.mouse.up();
 await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.isMoving())).toBe(false);
 const samples=await page.evaluate(()=>window.__finishLabelTracking());
 const visible=samples.filter(row=>row.text&&row.flag);expect(visible.length,JSON.stringify(samples)).toBeGreaterThanOrEqual(8);
 for(const kind of ['text','flag']){const first=visible[0],offset=first[kind].map((value,index)=>value-first.point[index]);const drift=visible.map(row=>Math.hypot(...row[kind].map((value,index)=>value-row.point[index]-offset[index])));expect(Math.max(...drift),JSON.stringify({kind,visible})).toBeLessThan(6);}
});

test('single white base and object-color toggle preserve boundaries, labels and selection',async({page})=>{
 await open(page);
 const initial=await page.evaluate(async()=>{
  const map=window.__PANDOLAB_MAPLIBRE__,source=map.getLayer('territories').source;
  const features=(await map.getSource(source).getData()).features;
  return {features:features.length,hasBorders:!!map.getLayer('borders'),
   hasLabels:!!map.getLayer('viewer-label-text'),
   hasCountryColors:features.some(feature=>feature.properties.color&&feature.properties.color!=='#f1f1f1'),
   hasChild:features.some(feature=>feature.properties.objectKey==='territorial:entity:d34b00a1-9b13-8000-8000-00000047524c'),
   document:JSON.stringify(window.__PANDOLAB_VIEWER__.documentSnapshot())};
 });
 expect(initial.features).toBeGreaterThan(100);
 expect(initial.hasBorders).toBe(true);
 expect(initial.hasLabels).toBe(true);
 expect(initial.hasCountryColors).toBe(true);
 expect(initial.hasChild).toBe(true);
 await page.locator('#preferencesBtn').click();
 const toggle=page.locator('#preferencesObjectColorsInput');
 await expect(toggle).toBeChecked();
 await toggle.uncheck();
 await expect.poll(()=>page.evaluate(async()=>{
  const map=window.__PANDOLAB_MAPLIBRE__,source=map.getLayer('territories').source,data=await map.getSource(source).getData();
  const fills=data.features.filter(feature=>feature.properties.displayRole==='country-fill');
  return fills.length>100&&fills.every(f=>map.getFeatureState({source,id:f.id}).neutral===true);
 }),{timeout:20_000}).toBe(true);
 expect(await page.evaluate(()=>JSON.stringify(window.__PANDOLAB_VIEWER__.documentSnapshot()))).toEqual(initial.document);
 expect(await page.evaluate(()=>{
  const map=window.__PANDOLAB_MAPLIBRE__;
  return {borders:!!map.getLayer('borders'),labels:!!map.getLayer('viewer-label-text')};
 })).toEqual({borders:true,labels:true});
 await page.locator('#preferencesCloseBtn').click();
 await page.evaluate(()=>window.__PANDOLAB_MAP_HOST__.setViewState({projection:'globe',view:{zoom:3,globeRotation:[-23,3,0]}}));
 await ready(page,'neutral map picking');
 const point=await page.evaluate(()=>window.__PANDOLAB_MAP_HOST__.project([23,-3]));
 const bounds=await page.locator('#map').boundingBox();
 await page.mouse.click(bounds.x+point[0],bounds.y+point[1]);
 await expect.poll(()=>page.evaluate(()=>
  window.__PANDOLAB_VIEWER__.selectionSnapshot().items.length>0
  ||document.querySelector('#objectChooser')?.classList.contains('hidden')===false)).toBe(true);
 await page.locator('#preferencesBtn').click();
 await toggle.check();
 await expect.poll(()=>page.evaluate(async()=>{
  const map=window.__PANDOLAB_MAPLIBRE__,source=map.getLayer('territories').source,data=await map.getSource(source).getData();
  return data.features.some(f=>f.properties.color&&f.properties.alpha>0&&map.getFeatureState({source,id:f.id}).neutral===false);
 }),{timeout:20_000}).toBe(true);
 expect(await page.evaluate(()=>JSON.stringify(window.__PANDOLAB_VIEWER__.documentSnapshot()))).toEqual(initial.document);
});

async function month(page,value){
  const [year,month]=value.split('-');
  await page.locator('#timelineDateButton').click();
  await page.locator('#timelineViewUnit').selectOption('month');
  await page.locator('#timelineYearInput').fill(year);
  await page.locator('#timelineMonthInput').selectOption(String(Number(month)));
  const started=performance.now();
  await page.locator('#timelineGoBtn').click();
  await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_VIEWER__.documentState().timelineCursor),{timeout:60_000}).toBe(value);
  console.log('[viewer-ready]',JSON.stringify({stage:`month ${value}`,milestone:'cursor accepted',elapsedMs:Math.round(performance.now()-started)}));
  await ready(page,`month ${value}`);
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

test('external basemap preserves the dated map and restores it after failure',async({page})=>{
 test.setTimeout(180_000);await open(page);await search(page);
 const before=await page.evaluate(()=>({month:window.__PANDOLAB_VIEWER__.documentState().timelineCursor,selection:window.__PANDOLAB_VIEWER__.selectionSnapshot(),camera:window.__PANDOLAB_MAP_HOST__.getViewState()}));
 const style={version:8,sources:{'external-fixture':{type:'geojson',attribution:'Fixture attribution',data:{type:'FeatureCollection',features:[]}}},layers:[{id:'external-fixture',type:'fill',source:'external-fixture'}]};
 await page.evaluate(async style=>{window.__removeBasemap=await window.__PANDOLAB_VIEWER__.previewExternalBasemap(style);},style);await ready(page);
 expect(await page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.getLayer('external-fixture')?.source)).toBe('external-fixture');
 expect(await page.evaluate(()=>({month:window.__PANDOLAB_VIEWER__.documentState().timelineCursor,selection:window.__PANDOLAB_VIEWER__.selectionSnapshot(),camera:window.__PANDOLAB_MAP_HOST__.getViewState()}))).toEqual(before);
 await page.evaluate(()=>window.__removeBasemap());await ready(page);
 await page.route('**/failing-basemap/**',route=>route.fulfill({status:503,body:'fixture failure'}));
 const failing={version:8,sources:{'failing-basemap':{type:'raster',tiles:[new URL('/failing-basemap/{z}/{x}/{y}.png',page.url()).href],tileSize:256,attribution:'Fixture attribution'}},layers:[{id:'failing-basemap',type:'raster',source:'failing-basemap'}]};
 await page.evaluate(async style=>{try{window.__removeBasemap=await window.__PANDOLAB_VIEWER__.previewExternalBasemap(style);}catch(error){window.__basemapError=error.message;}},failing);
 await expect.poll(()=>page.evaluate(()=>!!window.__PANDOLAB_MAPLIBRE__.getLayer('failing-basemap')),{timeout:30000}).toBe(false);await ready(page);
 expect(await page.evaluate(()=>({month:window.__PANDOLAB_VIEWER__.documentState().timelineCursor,selection:window.__PANDOLAB_VIEWER__.selectionSnapshot(),camera:window.__PANDOLAB_MAP_HOST__.getViewState()}))).toEqual(before);
 expect(await page.locator('.maplibregl-ctrl-attrib').count()).toBe(0);
});

test('dated map keeps its complete frame through delayed, superseded and failed requests',async({page})=>{
 test.setTimeout(180_000);
 await page.setViewportSize({width:1280,height:800});await open(page);
 await page.evaluate(()=>{window.__datedTileErrors=[];window.__PANDOLAB_MAPLIBRE__.on('error',event=>{if(String(event.error?.message).includes('queryRadius'))window.__datedTileErrors.push({source:event.sourceId,message:event.error.message,layers:window.__PANDOLAB_MAPLIBRE__.getStyle().layers.map(layer=>({id:layer.id,type:layer.type,source:layer.source}))});});});
 const before=await page.locator('#timelineDateButtonText').innerText();
 let mode='delay',release,seen;
 const requested=new Promise(resolve=>{seen=resolve;});
 const gate=new Promise(resolve=>{release=resolve;});
 await page.route('**/caspian-1922-water.json.gz*',async route=>{
  if(mode==='delay'){seen();await gate;await route.fulfill({status:404,body:'injected stale failure'});return;}
  if(mode==='fail'){await page.evaluate(()=>{window.__holdDatedTiles=false;});await route.fulfill({status:404,body:'injected failure'});return;}
  await route.continue();
 });
 const selectYear=async year=>{
  await page.locator('#timelineDateButton').click();await page.locator('#timelineViewUnit').selectOption('year');
  await page.locator('#timelineYearInput').fill(String(year));await page.locator('#timelineGoBtn').click();
 };
 await selectYear(1922);await requested;
 const beforeMove=await page.evaluate(()=>({center:window.__PANDOLAB_MAPLIBRE__.getCenter().toArray(),
  dragEnabled:window.__PANDOLAB_MAPLIBRE__.dragPan.isEnabled(),date:document.querySelector('#timelineDateButtonText').textContent}));
 expect(beforeMove.date).toBe(before);
 expect(beforeMove.dragEnabled,'the old map remains interactive while the next physical context is loading').toBe(true);
 const bounds=await page.locator('#map').boundingBox(),x=bounds.x+bounds.width/2,y=bounds.y+bounds.height/2;
 await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x-100,y,{steps:12});await page.mouse.up();
 await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.getCenter().lng)).not.toBe(beforeMove.center[0]);
 expect(await page.locator('#timelineDateButtonText').innerText()).toBe(before);
 await page.locator('#timelinePreviousDecade').click();
 await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_VIEWER__.documentState().timelineCursor),{timeout:60000}).toBe('1912-12');
 await ready(page,'latest request');release();await page.waitForTimeout(300);
 expect(await page.locator('#timelineDateButtonText').innerText()).toContain('1912');
 expect(await page.evaluate(()=>window.__PANDOLAB_VIEWER__.documentState().timelineCursor)).toBe('1912-12');
 await page.evaluate(()=>{const map=window.__PANDOLAB_MAPLIBRE__,original=map.isSourceLoaded.bind(map);window.__holdDatedTiles=true;map.isSourceLoaded=id=>!(window.__holdDatedTiles&&id===map.getLayer('territories')?.source)&&original(id);});
 await page.locator('#timelinePreviousYear').click();
 await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_VIEWER__.documentState().timelineCursor),{timeout:60000}).toBe('1911-12');
 await page.evaluate(()=>{
  const map=window.__PANDOLAB_MAPLIBRE__;
  map.jumpTo({center:[13.84,50.77],zoom:12});
  map.jumpTo({center:[13.84,50.77],zoom:9});
 });
 await expect(page.locator('[data-map-preserved-frame]')).toHaveCount(1);
 expect(await page.locator('#timelineDateButtonText').innerText()).toContain('1912');
 mode='fail';await selectYear(1922);
 await expect.poll(()=>page.locator('#timelineDateError').textContent(),{timeout:60000}).not.toBe('');
 expect(await page.evaluate(()=>window.__PANDOLAB_VIEWER__.documentState().timelineCursor)).toBe('1912-12');
 expect(await page.locator('#timelineDateButtonText').innerText()).toContain('1912');
 await expect(page.locator('[data-map-preserved-frame]')).toHaveCount(0);
 expect(await page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.dragPan.isEnabled())).toBe(true);
 mode='pass';await page.locator('#timelineGoBtn').click();
 await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_VIEWER__.documentState().timelineCursor),{timeout:60000}).toBe('1922-12');
 await ready(page,'retry after failure');
 expect(await page.locator('#timelineDateButtonText').innerText()).toContain('1922');
 expect((await camera(page)).zoom).toBeCloseTo(9,6);
 expect(await page.evaluate(()=>window.__datedTileErrors)).toEqual([]);
});


test('optional raster tile delay does not block a 1925 to 2025 transition',async({page})=>{
 test.setTimeout(180_000);await open(page);await month(page,'1925-12');
 let release,mark;const gate=new Promise(resolve=>{release=resolve;}),requested=new Promise(resolve=>{mark=resolve;});
 await page.route('**/optional-dated-test/**',async route=>{mark();await gate;await route.abort();});
 try{
  await page.evaluate(()=>{const map=window.__PANDOLAB_MAPLIBRE__;map.addSource('optional-dated-test',{type:'raster',tiles:[new URL('/optional-dated-test/{z}/{x}/{y}.png',window.location.href).href],tileSize:256});map.addLayer({id:'optional-dated-test',type:'raster',source:'optional-dated-test'});});
  await requested;await month(page,'2025-12');
  expect(await page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.areTilesLoaded())).toBe(false);
  expect(await page.locator('#timelineDateButtonText').innerText()).toContain('2025');
 }finally{await page.evaluate(()=>{const map=window.__PANDOLAB_MAPLIBRE__;map.removeLayer('optional-dated-test');map.removeSource('optional-dated-test');});release();}
});


test('dated physical water is restored across timeline changes',async({page})=>{
 await page.addInitScript(()=>{
  const operations=new Set(['core.document-geometry-requirements','core.document-geometry-admit','place.viewport']);
  const post=Worker.prototype.postMessage;
  window.__datedWorkerProbe={requirements:0,admissions:0,places:0};
  Worker.prototype.postMessage=function(payload,...rest){
   if(payload?.type==='request'&&operations.has(payload.operation)){
    const key=payload.operation==='place.viewport'?'places':payload.operation.endsWith('requirements')?'requirements':'admissions';
    window.__datedWorkerProbe[key]++;
   }
   return post.call(this,payload,...rest);
  };
 });
 await open(page);await month(page,'2026-11');
 const original=await page.evaluate(()=>{
  const map=window.__PANDOLAB_MAPLIBRE__,states=window.__PANDOLAB_VIEWER__.rendererStats().datedSources;
  window.__datedTileProbe=Object.fromEntries(Object.values(states).map(id=>{
   const source=map.getSource(id),probe={source,requests:0};
   const load=source.loadTile.bind(source);
   source.loadTile=(...args)=>{probe.requests++;return load(...args);};
   return [id,probe];
  }));
  return states;
 });
 const unchangedWork=()=>page.evaluate(()=>{
  const s=window.__PANDOLAB_VIEWER__.rendererStats(),phases=s.performance.phases;
  return {tiles:Object.values(window.__datedTileProbe).map(probe=>probe.requests),
   geometryRequests:s.boundaryRequests,physicalLandPreparations:s.physicalLandPreparations,
   territorialPayloads:phases['territorial.payload']?.count??0};
 });
 const unchangedBefore=await unchangedWork();
 const workerBefore=await page.evaluate(()=>window.__datedWorkerProbe);
 const unchangedDownloads=[];
 const recordDownload=request=>{
  if(/\/(?:world-geometry\/sha256-|geometries\/sha256-|display-land\/sha256-)/.test(request.url()))unchangedDownloads.push(request.url());
 };
 page.on('request',recordDownload);
 await month(page,'2026-10');await month(page,'2026-11');
 page.off('request',recordDownload);
 expect(await unchangedWork()).toEqual(unchangedBefore);
 expect(unchangedDownloads).toEqual([]);
 expect(await page.evaluate(()=>window.__datedWorkerProbe)).toEqual({...workerBefore,requirements:workerBefore.requirements+2});
 const physical=()=>page.evaluate(async()=>{
  const map=window.__PANDOLAB_MAPLIBRE__,{water:id}=window.__PANDOLAB_VIEWER__.rendererStats().datedSources;
  const water=await map.getSource(id).getData();
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(water)));
  return {water:[...new Uint8Array(bytes)].join(','),base:map.getLayer('physical-land-fill')?.source};
 });
 const modern=await physical();await month(page,'1922-12');const historical=await physical();
 expect(historical.water).not.toBe(modern.water);
 expect(historical.base).toBe('physical-land');
 const historicalSources=await page.evaluate(()=>window.__PANDOLAB_VIEWER__.rendererStats().datedSources);
 const replaced=Object.keys(original).filter(kind=>historicalSources[kind]!==original[kind]);
 expect(replaced).toContain('territories');
 expect(replaced).toContain('water');
 const hitsBefore=await page.evaluate(()=>window.__PANDOLAB_VIEWER__.rendererStats().retainedSourceHits);
 const tilesBefore=await page.evaluate(()=>Object.values(window.__datedTileProbe).map(probe=>probe.requests));
 await month(page,'2026-11');expect((await physical()).water).toBe(modern.water);
 const returned=await page.evaluate(()=>{
  const map=window.__PANDOLAB_MAPLIBRE__,stats=window.__PANDOLAB_VIEWER__.rendererStats();
  return {ids:stats.datedSources,hits:stats.retainedSourceHits,
   same:Object.entries(window.__datedTileProbe).every(([id,probe])=>map.getSource(id)===probe.source),
   requests:Object.values(window.__datedTileProbe).map(probe=>probe.requests)};
 });
 expect(returned.ids).toEqual(original);
 expect(returned.same).toBe(true);
 expect(returned.hits-hitsBefore).toBe(replaced.length);
 expect(returned.requests).toEqual(tilesBefore);
 await page.evaluate(()=>{window.__PANDOLAB_MAPLIBRE__.jumpTo({center:[124,35],zoom:4});});
 await ready(page,'uncached viewport after returning to a retained date');
 expect(await page.evaluate(before=>Object.values(window.__datedTileProbe)
  .some((probe,index)=>probe.requests>before[index]),tilesBefore)).toBe(true);
});

test('desktop Viewer presents the real map, changes year, searches and moves the camera',async({page})=>{
  await page.setViewportSize({width:1280,height:800});
  await open(page);
  await month(page,'2024-12');
  await search(page);
  await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.isMoving())).toBe(false);
  const before=await camera(page);
  await page.mouse.move(600,420);await page.mouse.down();
  await page.mouse.move(740,450,{steps:8});await page.mouse.up();
  await expect.poll(()=>camera(page)).not.toEqual(before);
  await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.isMoving())).toBe(false);
  await ready(page);
  await page.evaluate(()=>{window.__PANDOLAB_MAPLIBRE__.jumpTo({zoom:15});});
  await ready(page,'save native zoom beyond former limit');
  const moved=await camera(page);
  await expect.poll(()=>page.evaluate(view=>new Promise((resolve,reject)=>{const request=indexedDB.open('pandolab-viewer');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,transaction=db.transaction('views','readonly');transaction.oncomplete=()=>db.close();const records=transaction.objectStore('views').getAll();records.onsuccess=()=>resolve(records.result.some(record=>Math.abs((record.center?.[0]??1000)+view.globeRotation[0])<0.001&&record.zoom===view.zoom));records.onerror=()=>reject(records.error);};}),moved)).toBe(true);
  await page.reload({waitUntil:'domcontentloaded'});await ready(page,'camera restore');
  const restored=await camera(page);
  expect(restored.globeRotation[0]).toBeCloseTo(moved.globeRotation[0],3);
  expect(restored.globeRotation[1]).toBeCloseTo(moved.globeRotation[1],3);
  expect(restored.zoom).toBeCloseTo(moved.zoom,3);
});


test('dated Viewer renders names while flag downloads are pending',async({page})=>{
 const warnings=[];let germanFlagRequested=false,release;
 const gate=new Promise(resolve=>{release=resolve;});
 page.on('console',message=>{
  if(/Image "pando-flag-.*could not be loaded|feature index out of bounds/.test(message.text()))warnings.push(message.text());
 });
 await page.route(/\/assets\/vendor\/(?:country-flags|flag-icons|political-flags)\/.*\/de\.svg(?:\?|$)/,async route=>{
  germanFlagRequested=true;
  await gate;
  await route.continue();
 });
 const labels=()=>page.evaluate(async()=>{
  const map=window.__PANDOLAB_MAPLIBRE__;
  const data=await map.getSource('viewer-labels').getData();
  const rows=data.features.filter(feature=>feature.properties.kind==='territorial').map(feature=>feature.properties);
  const germany=rows.find(row=>row.objectKey==='territorial:entity:DEU');
  return {name:germany?.primary,icon:germany?.icon,unregistered:rows.filter(row=>row.icon&&!map.hasImage(row.icon)).length};
 });
 try{
  await open(page);
  await page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.jumpTo({center:[15,48],zoom:4}));
  await expect.poll(()=>germanFlagRequested).toBe(true);
  await month(page,'2024-12');
  await expect.poll(async()=>(await labels()).name).toBeTruthy();
  expect((await labels()).icon).toBe('');
 }finally{release();}
 await expect.poll(async()=>(await labels()).icon,{timeout:30_000}).toMatch(/^pando-flag-/);
 expect((await labels()).unregistered).toBe(0);
 expect(warnings).toEqual([]);
});

test('MapLibre camera projection and map selection remain aligned after date changes',async({page})=>{
 await page.setViewportSize({width:1280,height:800});await open(page);await month(page,'2024-12');
 await page.locator('#objectSearchBtn').click();await page.getByRole('searchbox',{name:'객체 검색'}).fill('대한민국');
 await page.getByRole('button',{name:'대한민국 선택 객체로 이동',exact:true}).click();await ready(page);
 await expect.poll(()=>page.evaluate(()=>{const point=window.__PANDOLAB_MAP_HOST__.project([127.8,36.6]),map=window.__PANDOLAB_MAPLIBRE__;return !!point&&point[0]>0&&point[0]<map.getCanvas().clientWidth&&point[1]>0&&point[1]<map.getCanvas().clientHeight;})).toBe(true);
 await ready(page);
 await page.keyboard.press('Escape');
 await ready(page);
 expect(await page.evaluate(()=>window.__PANDOLAB_VIEWER__.rendererStats().renderer)).toBe('maplibre');
 const point=await page.evaluate(()=>window.__PANDOLAB_MAP_HOST__.project([127.8,36.6]));
 const bounds=await page.locator('#map').boundingBox();
 await page.mouse.move(bounds.x+point[0],bounds.y+point[1]);
 await page.keyboard.down('Control');await page.mouse.click(bounds.x+point[0],bounds.y+point[1]);await page.keyboard.up('Control');
 await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_VIEWER__.selectionSnapshot().items.map(item=>item.id))).not.toContain('KOR');
 await page.mouse.click(bounds.x+point[0],bounds.y+point[1]);
 await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_VIEWER__.selectionSnapshot().items.map(item=>item.id))).toContain('KOR');
 await month(page,'2025-12');
 await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.queryRenderedFeatures({layers:['viewer-label-country']}).length)).toBeGreaterThan(0);
 expect(await page.evaluate(()=>document.querySelectorAll('.maplibregl-canvas').length)).toBe(1);
});

test('MapLibre projection follows focused camera, horizon and high zoom after resize',async({page})=>{
 await page.setViewportSize({width:1280,height:800});await open(page);
 const fittedGlobe=async()=>{
  const ratio=await page.evaluate(()=>{
   const map=window.__PANDOLAB_MAPLIBRE__,width=map.getCanvas().clientWidth,height=map.getCanvas().clientHeight;
   let low=0,high=Math.min(width,height)/2;
   for(let i=0;i<20;i++){const radius=(low+high)/2,point={x:width/2+radius,y:height/2},actual=map.project(map.unproject(point));if(Math.hypot(actual.x-point.x,actual.y-point.y)<.01)low=radius;else high=radius;}
   return low*2/Math.min(width,height);
  });
  expect(ratio,JSON.stringify(await camera(page))).toBeGreaterThan(.90);expect(ratio,JSON.stringify(await camera(page))).toBeLessThan(.92);
 };
 await fittedGlobe();
 for(const [zoom,rotation]of [[1,[0,0,0]],[1,[-90,-80,0]],[5,[-179,-45,0]],[5,[-90,-80,0]]]){
  await page.evaluate(({zoom,rotation})=>{const host=window.__PANDOLAB_MAP_HOST__,current=host.getViewState();host.setViewState({projection:'globe',view:{zoom:zoom,globeRotation:rotation}});},{zoom,rotation});
  await ready(page,`camera zoom=${zoom} rotation=${rotation.join(',')}`);
  await expect.poll(()=>page.evaluate(()=>{const host=window.__PANDOLAB_MAP_HOST__,map=window.__PANDOLAB_MAPLIBRE__,center=map.getCenter(),point=host.project([center.lng,center.lat]),actual=map.project([center.lng,center.lat]);return Math.hypot(point[0]-actual.x,point[1]-actual.y);})).toBeLessThan(0.01);
  const result=await page.evaluate(()=>{const host=window.__PANDOLAB_MAP_HOST__,map=window.__PANDOLAB_MAPLIBRE__,center=map.getCenter(),point=map.project([center.lng,center.lat]),coordinate=host.unproject([point.x,point.y]);return Math.hypot(coordinate[0]-center.lng,coordinate[1]-center.lat);});expect(result).toBeLessThan(0.001);
  const bounded=await page.evaluate(()=>{
   const host=window.__PANDOLAB_MAP_HOST__,view=host.getViewState(),[west,south,east,north]=view.geographicBounds;
   for(let lat=-90;lat<=90;lat+=10)for(let lon=-180;lon<180;lon+=10){const point=host.project([lon,lat]);if(point&&point[0]>=0&&point[0]<=view.size.width&&point[1]>=0&&point[1]<=view.size.height){const offset=((lon-west)%360+360)%360;if(lat<south||lat>north||offset>east-west)return false;}}
   return true;
  });expect(bounded).toBe(true);
  expect((await camera(page)).zoom).toBeCloseTo(zoom,5);
  await page.setViewportSize({width:1024,height:768});
  await expect.poll(async()=>{const view=await camera(page),bounds=await page.locator('#map').boundingBox();return Math.abs(view.size.width-bounds.width)+Math.abs(view.size.height-bounds.height);}).toBeLessThan(0.1);
  await ready(page,`resize zoom=${zoom} rotation=${rotation.join(',')}`);
  expect((await camera(page)).zoom).toBeCloseTo(zoom,5);
  expect((await camera(page)).zoom).toBeCloseTo(zoom,5);
 }
 const before=await camera(page);
 await page.mouse.move(500,390);await page.mouse.down();await page.mouse.move(610,420,{steps:6});await page.mouse.up();
 await expect.poll(()=>camera(page)).not.toEqual(before);await ready(page);
 await page.getByRole('button',{name:'전체 지도 보기',exact:true}).click();await ready(page);
 await fittedGlobe();
});

test('visible city and dated lake clicks reach the canonical Viewer selection',async({page})=>{
 await open(page);
 await page.evaluate(()=>{const host=window.__PANDOLAB_MAP_HOST__,current=host.getViewState();host.setViewState({projection:'globe',view:{zoom:4,globeRotation:[-3.4,-6.45,0]}});});
 await ready(page,'city camera');
 await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.queryRenderedFeatures({layers:['viewer-label-text']}).filter(f=>f.properties.kind==='label').length)).toBeGreaterThan(0);
 const {id:cityId,name:cityName,point:cityPoint}=await page.evaluate(()=>{const map=window.__PANDOLAB_MAPLIBRE__,f=map.queryRenderedFeatures({layers:['viewer-label-text']}).find(f=>f.properties.kind==='label'),p=map.project(f.geometry.coordinates);return {id:decodeURIComponent(f.properties.objectKey.split(':').slice(2).join(':')),name:f.properties.text.split('\n')[0],point:[p.x,p.y]};});
 const cityBounds=await page.locator('#map').boundingBox();await page.mouse.click(cityBounds.x+cityPoint[0],cityBounds.y+cityPoint[1]);
 await expect.poll(async()=>await page.locator('#objectChooser').isVisible()||await page.evaluate(id=>window.__PANDOLAB_VIEWER__.selectionSnapshot().items.some(item=>item.id===id),cityId)).toBe(true);
 if(await page.locator('#objectChooser').isVisible())await page.locator('#objectChooserList [role="option"]').filter({hasText:cityName}).first().click();
 await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_VIEWER__.selectionSnapshot().items.map(item=>item.id))).toContain(cityId);
 await page.evaluate(()=>{const host=window.__PANDOLAB_MAP_HOST__,current=host.getViewState();host.setViewState({projection:'globe',view:{zoom:4,globeRotation:[-51,-42,0]}});});
 await ready(page,'Caspian camera');const point=await page.evaluate(()=>window.__PANDOLAB_MAP_HOST__.project([51,42])),bounds=await page.locator('#map').boundingBox();
 await page.mouse.click(bounds.x+point[0],bounds.y+point[1]);
 await expect.poll(async()=>await page.locator('#objectChooser').isVisible()||await page.evaluate(()=>window.__PANDOLAB_VIEWER__.selectionSnapshot().items.some(item=>item.id==='waterbody:caspian'))).toBe(true);
 if(await page.locator('#objectChooser').isVisible())await page.locator('#objectChooserList [role="option"]').filter({hasText:'카스피'}).first().click();
 await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_VIEWER__.selectionSnapshot().items.map(item=>item.id))).toContain('waterbody:caspian');
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

test('touch Viewer searches, navigates and changes time in a mobile context',async({browser,baseURL})=>{
  const context=await browser.newContext({baseURL,viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  try{
    const page=await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.emulateMedia({colorScheme:'light'});
    await open(page);
    expect(await page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.getPixelRatio()))
      .toBe(await page.evaluate(()=>window.devicePixelRatio));
    const searchBar=page.getByRole('search'),dateBar=page.getByRole('group',{name:'시점 이동'});
    const details=page.getByRole('dialog',{name:'객체 정보'}),handle=page.getByRole('slider',{name:'정보창 높이 조절'});
    const menuButton=page.locator('#mobileMenuBtn');
    const chrome=viewerChrome;
    for(const viewport of [{width:320,height:690},{width:844,height:390},{width:768,height:1024},{width:390,height:844}]){
      await page.setViewportSize(viewport);
      await expect(page.locator('#viewer')).toHaveAttribute('data-layout',viewport.width===844?'phone-landscape':'mobile');
      await expect(searchBar).toBeVisible();
      const bar=await dateBar.boundingBox(),dock=await searchBar.boundingBox();
      expect(dock.height).toBe(bar.height);
      expect(bar.height).toBe(56);
      expect(await chrome(searchBar)).toEqual(await chrome(dateBar));
      expect(await viewerFaceRgba(dateBar)).toEqual([255,255,255,255]);
      await expect(dateBar).toHaveCSS('backdrop-filter','none');
      await expect(menuButton).toHaveCSS('width','40px');
      await expect(menuButton).toHaveCSS('height','40px');
      expect(bar.x).toBeGreaterThanOrEqual(0);
      expect(bar.x+bar.width).toBeLessThanOrEqual(viewport.width);
      if(viewport.width===844)expect(dock.x).toBeGreaterThan(bar.x+bar.width);
    }
    const normalMenu=await chrome(menuButton);
    await menuButton.tap();
    const menu=page.locator('#mobileGlobalMenu');
    await expect(menu).toBeVisible();
    await expect(menuButton).toHaveAttribute('aria-expanded','true');
    await expect.poll(async()=>(await chrome(menuButton)).face).not.toBe(normalMenu.face);
    expect(await chrome(menu)).toEqual(await chrome(dateBar));
    await menu.getByRole('menuitem',{name:'설정'}).tap();
    const settings=page.getByRole('dialog',{name:'설정'});
    await expect(settings).toBeVisible();
    expect((await chrome(settings.locator('.ui-dialog-card'))).face).toBe(normalMenu.face);
    await expect(settings.getByRole('button',{name:'닫기'})).toHaveCSS('min-height','48px');
    await settings.getByRole('button',{name:'닫기'}).tap();
    const searchBounds=await searchBar.boundingBox();
    expect(searchBounds.height).toBe((await dateBar.boundingBox()).height);
    await search(page,true);
    await expect(searchBar).toBeHidden();
    await expect(handle).toHaveAttribute('aria-valuenow','0');
    expect(await details.boundingBox()).toEqual(searchBounds);
    expect(await chrome(details)).toEqual(await chrome(dateBar));
    await handle.tap();
    await expect(handle).toHaveAttribute('aria-valuenow','2');
    expect((await details.boundingBox()).height).toBeGreaterThan(searchBounds.height);
    await handle.tap();
    await expect(handle).toHaveAttribute('aria-valuenow','0');
    expect(await details.boundingBox()).toEqual(searchBounds);
    await page.setViewportSize({width:1024,height:768});
    await expect(page.locator('#viewer')).toHaveAttribute('data-layout','compact');
    const tabletDetails=page.locator('#objectDetailSurface');
    await expect(tabletDetails).toBeVisible();
    const tabletDetailsRect=await tabletDetails.boundingBox();
    expect(tabletDetailsRect.x).toBeGreaterThan(512);
    expect(tabletDetailsRect.y+tabletDetailsRect.height).toBeLessThan((await dateBar.boundingBox()).y);
    await expect(page.locator('#objectSearchBtn')).toHaveCSS('width','40px');
    await expect(page.locator('#preferencesBtn')).toHaveCSS('min-height','48px');
    await expect(tabletDetails.getByRole('tab',{name:'정보'})).toHaveCSS('min-height','48px');
    expect(await viewerFaceRgba(dateBar)).toEqual([255,255,255,255]);
    await page.locator('#objectSearchBtn').tap();
    const tabletInput=page.getByRole('searchbox',{name:'객체 검색'});
    await expect(tabletInput).toBeFocused();
    const tabletSearchRect=await tabletInput.boundingBox(),tabletDateRect=await dateBar.boundingBox();
    expect(tabletSearchRect.y+tabletSearchRect.height).toBeLessThan(tabletDateRect.y);
    await page.keyboard.press('Escape');
    await page.setViewportSize({width:390,height:844});
    await expect(page.locator('#viewer')).toHaveAttribute('data-layout','mobile');
    await search(page,true);
    await expect(handle).toHaveAttribute('aria-valuenow','0');
    const reset=page.getByRole('button',{name:'전체 지도 보기'});
    await page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.jumpTo({center:[127,37],zoom:3}));
    await expect(reset).toBeVisible();
    expect((await reset.boundingBox()).y).toBeLessThan(60);
    const monthBeforeReset=await page.evaluate(()=>window.__PANDOLAB_VIEWER__.documentState().timelineCursor);
    await reset.tap();
    await expect(reset).toBeHidden();
    expect(await page.evaluate(()=>window.__PANDOLAB_VIEWER__.documentState().timelineCursor)).toBe(monthBeforeReset);
    expect(await page.evaluate(()=>window.__PANDOLAB_VIEWER__.selectionSnapshot().items.map(item=>item.id))).toContain('KOR');
    await page.getByRole('button',{name:'객체 정보 닫기'}).tap();
    await expect(searchBar).toBeVisible();
    expect(await searchBar.boundingBox()).toEqual(searchBounds);
    await expect.poll(()=>chrome(menuButton)).toEqual(normalMenu);
    await ready(page,'mobile selection presentation');
    await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.dragPan.isEnabled()&&!window.__PANDOLAB_VIEWER__.rendererStats().projectReplacing)).toBe(true);
    await page.evaluate(()=>{window.__touchProbe={start:0,move:0,drag:0};const map=window.__PANDOLAB_MAPLIBRE__;map.on('touchstart',()=>window.__touchProbe.start++);map.on('touchmove',()=>window.__touchProbe.move++);map.on('dragstart',()=>window.__touchProbe.drag++);});
    const before=await camera(page),cdp=await context.newCDPSession(page);
    const rect=await page.locator('.maplibregl-canvas').boundingBox(),touch={x:rect.x+rect.width/2,y:rect.y+rect.height/2};
    await expect.poll(()=>page.evaluate(point=>document.elementFromPoint(point.x,point.y)?.classList.contains('maplibregl-canvas'),touch)).toBe(true);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch]});
    for(let step=1;step<=6;step++){
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:touch.x+step*14,y:touch.y+step*5}]});
      await page.evaluate(()=>new Promise(requestAnimationFrame));
    }
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await cdp.detach();
    const touchEvidence=await page.evaluate(()=>window.__touchProbe);
    await expect.poll(()=>camera(page),{message:JSON.stringify(touchEvidence)}).not.toEqual(before);
    await month(page,'2025-12');
    expect(await page.evaluate(()=>window.__PANDOLAB_VIEWER__.selectionSnapshot().items.map(x=>x.id))).toContain('KOR');
  }finally{await context.close();}
});

test('built-in map opens in the read-only inspector and exports diagnostics without changing its project',async({page})=>{
  await page.setViewportSize({width:1280,height:800});
  await page.emulateMedia({colorScheme:'light'});
  await open(page,'&inspect=1');
  await expect(page.locator('#openProjectBtn, #projectFileInput')).toHaveCount(0);
  const before=await page.evaluate(()=>({project:window.__PANDOLAB_VIEWER__.documentSnapshot(),state:window.__PANDOLAB_VIEWER__.documentState()}));
  expect(await page.evaluate(()=>window.__PANDOLAB_VIEWER__.readOnly)).toBe(true);
  const inspector=page.locator('#reviewPanel'),dateBar=page.locator('.timeline-controls');
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
  expect(diagnostics.map.renderer).toBe('maplibre');expect(diagnostics.map.frameAcknowledged).toBe(true);
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
  expect(await page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.getLayer('physical-land-fill').source)).toBe('physical-land');
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

test('MapLibre context restoration preserves project, selection and camera',async({page})=>{
 const placeErrors=[];page.on('console',message=>{if(message.type()==='error'&&message.text().includes('PL-PLACE-LOAD-001'))placeErrors.push(message.text());});
 await open(page);await search(page);
 const before=await page.evaluate(()=>({project:window.__PANDOLAB_VIEWER__.documentSnapshot(),selection:window.__PANDOLAB_VIEWER__.selectionSnapshot().items,camera:window.__PANDOLAB_MAP_HOST__.getViewState().globeRotation}));
 await page.evaluate(()=>{const canvas=window.__PANDOLAB_MAPLIBRE__.getCanvas(),gl=canvas.getContext('webgl2'),extension=gl.getExtension('WEBGL_lose_context');if(!extension)throw new Error('Context loss unavailable');window.__contextLoss=extension;window.__contextLostObserved=false;canvas.addEventListener('webglcontextlost',()=>{window.__contextLostObserved=true;},{once:true});extension.loseContext();});
 await expect.poll(()=>page.evaluate(()=>window.__contextLostObserved)).toBe(true);
 await page.evaluate(()=>window.__contextLoss.restoreContext());await ready(page);
 expect(await page.evaluate(()=>({project:window.__PANDOLAB_VIEWER__.documentSnapshot(),selection:window.__PANDOLAB_VIEWER__.selectionSnapshot().items,camera:window.__PANDOLAB_MAP_HOST__.getViewState().globeRotation}))).toEqual(before);
 expect(placeErrors).toEqual([]);
});


test('base rivers actually draw visible pixels after source admission',async({page})=>{
 await page.setViewportSize({width:1280,height:800});await open(page);
 await page.evaluate(()=>window.__PANDOLAB_MAP_HOST__.setViewState({projection:'globe',view:{zoom:8,globeRotation:[-31,-26,0]}}));await ready(page);
 await expect.poll(()=>page.evaluate(async()=>{const map=window.__PANDOLAB_MAPLIBRE__,data=await map.getSource('hydro').getData();return data.features.filter(f=>f.properties.category==='river').length;}),{timeout:30000}).toBeGreaterThan(0);
 await expect.poll(()=>page.evaluate(()=>{
  const map=window.__PANDOLAB_MAPLIBRE__;
  const layers=map.getLayersOrder().filter(id=>/^rivers(?:-\d+)?$/.test(id));
  return map.queryRenderedFeatures({layers}).length;
 }),{timeout:30000}).toBeGreaterThan(0);
 const matches=await page.evaluate(async()=>{
  const map=window.__PANDOLAB_MAPLIBRE__,source=await map.getSource('hydro').getData(),canvas=map.getCanvas(),ratio=map.getPixelRatio();
  const style=map.getPaintProperty('rivers','line-color'),color=Number.parseInt(style.replace('#',''),16),expected=[color>>16&255,color>>8&255,color&255];
  return new Promise(resolve=>{map.once('render',()=>{const gl=canvas.getContext('webgl2'),pixels=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);let matches=0;
   for(const feature of source.features.filter(f=>f.properties.category==='river'))for(const line of feature.geometry.type==='MultiLineString'?feature.geometry.coordinates:[feature.geometry.coordinates])for(const coordinate of line){const point=map.project(coordinate),x=Math.round(point.x*ratio),y=canvas.height-Math.round(point.y*ratio);if(x<2||y<2||x>=canvas.width-2||y>=canvas.height-2)continue;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const offset=((y+dy)*canvas.width+x+dx)*4;if(expected.every((value,i)=>Math.abs(value-pixels[offset+i])<12))matches++;}if(matches>3){resolve(matches);return;}}
   resolve(matches);
  });map.triggerRepaint();});
 });expect(matches,'the admitted base river must be visible, not merely selectable').toBeGreaterThan(0);
 await page.evaluate(()=>{window.__PANDOLAB_MAPLIBRE__.jumpTo({zoom:1.99});});
 await ready(page,'below native hydro minimum');
 await expect.poll(()=>page.evaluate(async()=>{
  const source=window.__PANDOLAB_MAPLIBRE__.getSource('hydro');
  return (await source.getData()).features.length;
 })).toBe(0);
});

test('lake pixels follow area and width thresholds on the published water source',async({page})=>{
 await page.setViewportSize({width:1280,height:800});
 await open(page);
 const jump=async(center,zoom)=>{
  await page.evaluate(({center,zoom})=>window.__PANDOLAB_MAPLIBRE__.jumpTo({center,zoom}),{center,zoom});
  await ready(page,'lake camera '+zoom);
 };
 const superior={id:'lakes_base:1159112991',point:[-87.7,47.7],minZoom:2};
 const tahoe={id:'lakes_base:1159106907',point:[-120.02,39.09],minZoom:4};
 const champlain={id:'lakes_base:1159106953',point:[-73.34,44.49],minZoom:5};
 const sample=points=>page.evaluate(async points=>{
   const map=window.__PANDOLAB_MAPLIBRE__;
   const features=map.querySourceFeatures('hydro',{filter:['in',['get','logicalId'],['literal',points.map(row=>row.id)]]});
   const color=Number.parseInt(map.getPaintProperty('lakes','fill-color').slice(1),16),expected=[color>>16&255,color>>8&255,color&255];
   const ratio=map.getPixelRatio(),canvas=map.getCanvas();
   return new Promise(resolve=>{
    map.once('render',()=>{
     const gl=canvas.getContext('webgl2'),pixels=new Uint8Array(5*5*4);
     resolve(points.map(({id,point})=>{
      const feature=features.find(row=>row.properties.logicalId===id);
      const {x,y}=map.project(point);
      gl.readPixels(Math.floor(x*ratio)-2,canvas.height-3-Math.floor(y*ratio),5,5,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      const painted=Array.from({length:25},(_,index)=>index*4)
       .some(offset=>expected.every((channel,index)=>Math.abs(channel-pixels[offset+index])<=5));
      return {painted,minZoom:feature?.properties.viewerMinZoom,stage:feature?.properties.stage};
     }));
    });
    map.triggerRepaint();
   });
 },points);
 const overview=[superior,tahoe,champlain];
 await jump([-100,44],2);
 await expect.poll(()=>sample(overview),{timeout:20000})
  .toEqual(overview.map(({minZoom})=>({painted:minZoom===2,minZoom,stage:0})));
 await jump(tahoe.point,4);
 await expect.poll(()=>sample([tahoe]),{timeout:20000}).toEqual([{painted:true,minZoom:4,stage:0}]);
});

test('native world fit contains the globe at desktop, narrow and high-resolution sizes',async({page})=>{
 await open(page);
 for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:3840,height:2160}]){
  await page.setViewportSize(viewport);
  await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.getCanvas().clientWidth)).toBe(viewport.width);
  await page.evaluate(()=>{window.__PANDOLAB_MAPLIBRE__.jumpTo({center:[127,37],zoom:15});});
  await ready(page,'regional camera above old limit');
  expect((await camera(page)).zoom).toBe(15);
  await page.locator('#resetViewBtn').click();
  await ready(page,'native world fit '+viewport.width);
  const result=await page.evaluate(()=>{
   const map=window.__PANDOLAB_MAPLIBRE__,canvas=map.getCanvas(),center=map.getCenter();
   const w=canvas.clientWidth,h=canvas.clientHeight;
   const points=[[0,h/2],[w-1,h/2],[w/2,0],[w/2,h-1]];
   const edgeOutside=points.map(([x,y])=>{
    const projected=map.project(map.unproject([x,y]));
    return Math.hypot(projected.x-x,projected.y-y)>1;
   });
   return {zoom:map.getZoom(),center:[center.lng,center.lat],edgeOutside};
  });
  expect(result.zoom).toBeLessThan(5);
  expect(Math.abs(result.center[0])).toBeLessThan(60);
  expect(Math.abs(result.center[1])).toBeLessThan(50);
  expect(result.edgeOutside).toEqual([true,true,true,true]);
 }
});

for(const viewport of [{width:1280,height:800},{width:390,height:844}])test('native zoom controls label visibility and survives resize '+viewport.width,async({page})=>{
 await page.setViewportSize(viewport);await open(page);
 const initial=await page.evaluate(()=>{const map=window.__PANDOLAB_MAPLIBRE__;return {zoom:map.getZoom(),state:window.__PANDOLAB_MAP_HOST__.getViewState().zoom,cityCount:map.queryRenderedFeatures({layers:['viewer-label-dot']}).length,colors:[map.getPaintProperty('ocean','background-color'),map.getPaintProperty('lakes','fill-color'),map.getPaintProperty('rivers','line-color')]};});
 expect(initial.state).toBeCloseTo(initial.zoom,6);expect(initial.cityCount).toBe(0);expect(new Set(initial.colors).size).toBe(1);
 const layers=['viewer-label-country','viewer-label-dot','viewer-label-text'];
 const read=()=>page.evaluate(layers=>{
  const map=window.__PANDOLAB_MAPLIBRE__;
  return {minZooms:layers.map(id=>map.getLayer(id).minzoom),
   counts:layers.map(id=>map.queryRenderedFeatures({layers:[id]}).length)};
 },layers);
 const jump=(center,zoom)=>page.evaluate(({center,zoom})=>{window.__PANDOLAB_MAPLIBRE__.jumpTo({center,zoom});},{center,zoom});
 for(const center of [[13.84,50.77],[18,0]]){
  await jump(center,3);await ready(page,'native zoom');
  expect(await page.evaluate(()=>window.__PANDOLAB_MAP_HOST__.getViewState().zoom)).toBeCloseTo(3,6);
  for(const [zoom,country,places] of [[2.99,false,false],[3.02,true,false],[3.49,true,false],[3.52,true,true],[2.99,false,false]]){
   await jump(center,zoom);await ready(page,'label threshold '+zoom);
   const current=await read();
   expect(current.minZooms).toEqual([3,3.5,3.5]);
   if(country)expect(current.counts[0]).toBeGreaterThan(0);
   else expect(current.counts[0]).toBe(0);
   if(!places)expect(current.counts.slice(1)).toEqual([0,0]);
  }
  await jump(center,5.5);await ready(page,'eligible places above native threshold');
  await expect.poll(async()=>{const {counts}=await read();return Math.min(...counts.slice(1));}).toBeGreaterThan(0);
 }
 await jump([127,37],3);await ready(page,'resize camera');
 await page.setViewportSize({width:viewport.width-20,height:viewport.height-20});await ready(page,'native resize');
 expect(await page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.getZoom())).toBeCloseTo(3,6);
 expect((await read()).counts.slice(1)).toEqual([0,0]);
});

test('the city marker gains and loses its capital ring at the recorded dates',async({page})=>{
 await page.addInitScript(()=>{
  const handler=Object.getOwnPropertyDescriptor(Worker.prototype,'onmessage');
  Object.defineProperty(Worker.prototype,'onmessage',{...handler,set(callback){
   handler.set.call(this,typeof callback==='function'?function(event){
    if(event.data?.operation==='place.viewport'){
     const city=event.data.result?.records?.find(row=>row.sourceId==='2988507');
     if(city)city.capitalPeriods=[{countryId:'historical-country:fixture',
      fromDate:'2026-10-31',untilDateExclusive:'2026-11-30',source:'Browser test fixture'}];
    }
    return callback.call(this,event);
   }:callback);
  }});
 });
 await open(page);
 await page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.jumpTo({center:[2.35,48.85],zoom:5.5}));
 const read=()=>page.evaluate(()=>{
  const map=window.__PANDOLAB_MAPLIBRE__,dot='viewer-label-dot',ring='viewer-label-capital-ring';
  const find=layer=>map.queryRenderedFeatures({layers:[layer]}).find(row=>String(row.id).includes('2988507'));
  const city=find(dot);
  return city?{id:city.id,coordinates:city.geometry.coordinates,rank:city.properties.rank,ring:!!find(ring),
   minZoom:map.getLayer(dot).minzoom,ringMinZoom:map.getLayer(ring).minzoom,
   dotRadius:map.getPaintProperty(dot,'circle-radius'),ringRadius:map.getPaintProperty(ring,'circle-radius')}:null;
 });
 await month(page,'2026-09');
 await expect.poll(read).toMatchObject({ring:false,minZoom:3.5,ringMinZoom:3.5,dotRadius:2.5,ringRadius:4});
 const ordinary=await read();
 await month(page,'2026-10');
 await expect.poll(read).toEqual({...ordinary,ring:true});
 await month(page,'2026-11');
 await expect.poll(read).toEqual(ordinary);
});

test('a delayed highlight keeps the previous outline and fill until both new features draw',async({page})=>{
 await open(page);
 await page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.jumpTo({center:[5,48.5],zoom:4}));
 await ready(page,'highlight camera');
 const point=coord=>page.evaluate(coord=>{
  const map=window.__PANDOLAB_MAPLIBRE__,p=map.project(coord),bounds=map.getCanvas().getBoundingClientRect();
  return {x:p.x+bounds.x,y:p.y+bounds.y};
 },coord);
 const shown=()=>page.evaluate(async()=>{
  const map=window.__PANDOLAB_MAPLIBRE__,highlight=window.__PANDOLAB_VIEWER__.rendererStats().highlight;
  const slot=highlight?.sourceId;
  if(!slot)return [];
  return (await map.getSource(slot).getData()).features.map(feature=>[feature.properties.objectKey,feature.geometry.type]);
 });
 const france='territorial:entity:FRA',germany='territorial:entity:DEU';
 const visiblePair=id=>[[id,'MultiPolygon'],[id,'MultiLineString']];
 const paris=await point([2.35,48.86]);
 await page.mouse.move(paris.x,paris.y);
 await expect.poll(shown).toEqual(visiblePair(france));
 await page.evaluate(target=>{
  const map=window.__PANDOLAB_MAPLIBRE__;
  const proto=Object.getPrototypeOf(map.getSource('interaction'));
  const original=proto.setData;
  proto.setData=async function(data,...args){
   if(this.id.startsWith('interaction')&&data.features?.some(feature=>feature.properties.objectKey===target)){
    proto.setData=original;
    await new Promise(resolve=>{window.releaseHighlightFixture=resolve;});
   }
   return original.call(this,data,...args);
  };
 },germany);
 const berlin=await point([10.2,51.12]);
 await page.mouse.move(berlin.x,berlin.y);
 await page.waitForFunction(()=>typeof window.releaseHighlightFixture==='function');
 expect(await shown()).toEqual(visiblePair(france));
 await page.evaluate(()=>window.releaseHighlightFixture());
 await expect.poll(shown).toEqual(visiblePair(germany));
});

test('large globe highlights stay within the native line vertex budget',async({page})=>{
 test.setTimeout(180_000);
 const warnings=[];
 page.on('console',message=>{if(message.text().includes('Max vertices per segment'))warnings.push(message.text());});
 await open(page);
 for(const [id,center] of [['RUS',[100,55]],['CAN',[-100,61]],['BRA',[-52,-10]]]){
  await page.evaluate(center=>window.__PANDOLAB_MAP_HOST__.setViewState({projection:'globe',view:{zoom:2.7,globeRotation:[-center[0],-center[1],0]}}),center);
  await ready(page,id+' highlight camera');
  const bounds=await page.locator('#map').boundingBox(),x=bounds.x+bounds.width/2,y=bounds.y+bounds.height/2;
  const key='territorial:entity:'+id;
  const shown=()=>page.evaluate(async key=>{
   const map=window.__PANDOLAB_MAPLIBRE__,highlight=window.__PANDOLAB_VIEWER__.rendererStats().highlight;
   if(!highlight?.sourceId||highlight.pending)return [];
   const data=await map.getSource(highlight.sourceId).getData();
   return data.features.filter(feature=>feature.properties.objectKey===key).map(feature=>feature.geometry.type);
  },key);
  await page.mouse.move(x,y);await expect.poll(shown).toEqual(['MultiPolygon','MultiLineString']);
  if(id==='CAN')await page.keyboard.down('Control');
  await page.mouse.click(x,y);
  if(id==='CAN')await page.keyboard.up('Control');
  await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_VIEWER__.selectionSnapshot().primaryKey)).toBe(key);
  await expect.poll(shown).toEqual(['MultiPolygon','MultiLineString']);
  expect(warnings).toEqual([]);
  if(id!=='CAN')continue;
  const secondary='territorial:entity:RUS';
  const seam=await page.evaluate(async key=>{
   const map=window.__PANDOLAB_MAPLIBRE__,{sourceId}=window.__PANDOLAB_VIEWER__.rendererStats().highlight;
   const data=await map.getSource(sourceId).getData();
   const {coordinates}=data.features.find(row=>row.properties.objectKey===key&&row.geometry.type==='MultiLineString').geometry;
   return coordinates.slice(1).find((line,index)=>line[0][0]===coordinates[index].at(-1)[0]&&line[0][1]===coordinates[index].at(-1)[1]&&Math.abs(line[0][1])<80)?.[0];
  },secondary);
  expect(seam,'the detailed outline should contain a split').toBeDefined();
  await page.evaluate(([longitude,latitude])=>window.__PANDOLAB_MAP_HOST__.setViewState({projection:'globe',view:{zoom:7,globeRotation:[-longitude,-latitude,0]}}),seam);
  await ready(page,'detailed highlight split');
  const sample=await page.evaluate(async({key,seam})=>{
   const map=window.__PANDOLAB_MAPLIBRE__,viewer=window.__PANDOLAB_VIEWER__;
   const source=map.getSource(viewer.rendererStats().highlight.sourceId),original=await source.getData();
   const {coordinates}=original.features.find(row=>row.properties.objectKey===key&&row.geometry.type==='MultiLineString').geometry;
   const index=coordinates.findIndex((line,i)=>i>0&&line[0][0]===seam[0]&&line[0][1]===seam[1]&&coordinates[i-1].at(-1)[0]===seam[0]&&coordinates[i-1].at(-1)[1]===seam[1]);
   const capture=()=>new Promise(resolve=>{map.once('render',()=>{
    const canvas=map.getCanvas(),dpr=map.getPixelRatio(),gl=canvas.getContext('webgl2'),point=map.project(seam),pixels=new Uint8Array(9*9*4);
    gl.readPixels(Math.round(point.x*dpr)-4,canvas.height-5-Math.round(point.y*dpr),9,9,gl.RGBA,gl.UNSIGNED_BYTE,pixels);resolve([...pixels]);
   });map.triggerRepaint();});
   const composite=map.getLayersOrder().find(id=>id.startsWith('interaction-line-opacity-')&&map.getLayer(id).source===source.id&&map.getPaintProperty(id,'line-layer-opacity')===0.72);
   if(!composite)throw Error('The split secondary outline did not use native opacity compositing');
   const split=await capture(),merged=structuredClone(original);
   const lines=merged.features.find(row=>row.properties.objectKey===key&&row.geometry.type==='MultiLineString').geometry.coordinates;
   lines.splice(index-1,2,[...lines[index-1],...lines[index].slice(1)]);
   try{
    await source.setData(merged);
    while(!map.isSourceLoaded(source.id))await new Promise(resolve=>map.once('render',resolve));
    const continuous=await capture();
    map.setPaintProperty(composite,'line-layer-opacity',0);
    const background=await capture();
    const strength=pixels=>pixels.reduce((total,value,i)=>total+Math.abs(value-background[i]),0);
    return {centerDelta:Math.max(...split.slice(160,163).map((value,i)=>Math.abs(value-continuous[160+i]))),
     splitStrength:strength(split),continuousStrength:strength(continuous)};
   }finally{map.setPaintProperty(composite,'line-layer-opacity',0.72);await source.setData(original);}
  },{key:secondary,seam});
  // The rasterized fringes of a joined line and two round ends can differ
  // per pixel. Check the center and the total stroke contribution separately.
  expect(sample.continuousStrength).toBeGreaterThan(0);
  expect(sample.centerDelta,JSON.stringify(sample)).toBeLessThanOrEqual(24);
  expect(sample.splitStrength/sample.continuousStrength,JSON.stringify(sample)).toBeGreaterThan(0.85);
  expect(sample.splitStrength/sample.continuousStrength,JSON.stringify(sample)).toBeLessThan(1.15);
 }
});

test('selection outlines omit the antimeridian polygon closure',async({page})=>{
 await open(page);await page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.jumpTo({center:[179,66],zoom:4}));await ready(page,'dateline camera');
 const point=await page.evaluate(()=>{const m=window.__PANDOLAB_MAPLIBRE__,r=m.getCanvas().getBoundingClientRect(),p=m.project([175,66]);return {x:p.x+r.x,y:p.y+r.y};});await page.mouse.click(point.x,point.y);
 await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_VIEWER__.selectionSnapshot().primaryKey)).toBe('territorial:entity:RUS');
 await ready(page,'dateline selection');
 const result=()=>page.evaluate(async()=>{
  const m=window.__PANDOLAB_MAPLIBRE__,id=window.__PANDOLAB_VIEWER__.rendererStats().highlight?.sourceId;
  const d=id&&await m.getSource(id)?.getData();let edges=0,closures=0;
  for(const f of d?.features||[]){
   if(f.properties.objectKey!=='territorial:entity:RUS'||f.geometry.type!=='MultiLineString')continue;
   for(const line of f.geometry.coordinates)for(let i=1;i<line.length;i++){
    edges++;const a=line[i-1],b=line[i];
    if(Math.abs(Math.abs(a[0])-180)<1e-6&&Math.abs(Math.abs(b[0])-180)<1e-6&&Math.abs(a[1]-b[1])>1e-6)closures++;
   }
  }
  return {edges,closures};
 });
 await expect.poll(async()=> (await result()).edges).toBeGreaterThan(100);
 expect((await result()).closures).toBe(0);
});

test('first Antarctic hover colors both sides of the polar handoff in one frame',async({page})=>{
 await page.setViewportSize({width:900,height:850});await open(page);
 await page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.jumpTo({center:[20,-85],zoom:3}));await ready(page,'polar hover camera');
 const point=await page.evaluate(async()=>{
  const map=window.__PANDOLAB_MAPLIBRE__,canvas=map.getCanvas(),gl=canvas.getContext('webgl2');
  const proto=Object.getPrototypeOf(map.getSource('interaction')),setData=proto.setData;
  proto.setData=async function(data,...args){
   if(this.id.startsWith('interaction')&&data.features?.some(feature=>feature.properties.objectKey==='territorial:entity:ATA')){
    proto.setData=setData;
    await new Promise(resolve=>setTimeout(resolve,350));
   }
   return setData.call(this,data,...args);
  };
  const samples=[-84.9,-85.1].map(lat=>map.project([21,lat]));
  await new Promise(resolve=>{
   const read=()=>samples.map(({x,y})=>{
    const pixel=new Uint8Array(4);
    gl.readPixels(Math.round(x*map.getPixelRatio()),canvas.height-1-Math.round(y*map.getPixelRatio()),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
    return pixel[0];
   });
   map.once('render',()=>{
    const baseline=read();
    const frames=[];
    const capture=()=>{
     const colors=read(),lit=colors.map((red,i)=>baseline[i]-red>3);
     frames.push({colors,lit});
     if(lit.every(Boolean))map.off('render',capture);
    };
    map.on('render',capture);window.__antarcticHoverFrames=frames;
    resolve();
   });
   map.triggerRepaint();
  });
  const rect=canvas.getBoundingClientRect(),p=map.project([21,-87]);
  return {x:p.x+rect.x,y:p.y+rect.y};
 });
 await page.mouse.move(point.x,point.y);
 await expect(page.locator('#uiTooltip')).toContainText('남극');
 await expect.poll(()=>page.evaluate(()=>window.__antarcticHoverFrames.at(-1)?.lit),{timeout:20000}).toEqual([true,true]);
 const frames=await page.evaluate(()=>window.__antarcticHoverFrames);
 expect(frames.filter(({lit:[body,cap]})=>body!==cap),'the first hover must never color just one side').toEqual([]);
});

test('selected Antarctic coastline has no Mercator-edge connection',async({page})=>{
 test.setTimeout(180000);await page.setViewportSize({width:900,height:850});await open(page);
 await page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.jumpTo({center:[-157.5,-85.051129],zoom:5}));await ready(page,'coastline at the Mercator edge');
 const point=await page.evaluate(()=>{const m=window.__PANDOLAB_MAPLIBRE__,r=m.getCanvas().getBoundingClientRect(),q=m.project([-160,-85.3]);return {x:q.x+r.x,y:q.y+r.y};});await page.mouse.click(point.x,point.y);
 await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_VIEWER__.selectionSnapshot().primaryKey)).toBe('territorial:entity:ATA');await ready(page,'selected coastline at the Mercator edge');
 const sample=()=>page.evaluate(()=>new Promise(resolve=>{const m=window.__PANDOLAB_MAPLIBRE__;m.once('render',()=>{const c=m.getCanvas(),gl=c.getContext('webgl2'),pixels=new Uint8Array(c.width*c.height*4);gl.readPixels(0,0,c.width,c.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);resolve([[-157,-85.051129],[-158.67317,-85.1325]].map(coordinate=>{const p=m.project(coordinate),x=Math.round(p.x*m.getPixelRatio()),y=c.height-1-Math.round(p.y*m.getPixelRatio());let blue=0;for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++){const i=((y+dy)*c.width+x+dx)*4;if(pixels[i]<80&&pixels[i+1]>70&&pixels[i+1]<190&&pixels[i+2]>200)blue++;}return blue;}));});m.triggerRepaint();}));
 await expect.poll(async()=>(await sample())[1],{timeout:15000,message:'the real polar coastline must retain its selection outline'}).toBeGreaterThan(0);
 expect((await sample())[0],'the Mercator edge must not draw a blue connection across actual sea').toBe(0);
});

test('direct polar caps preserve land, selection and context recovery',async({page})=>{
 test.setTimeout(180000);
 await page.setViewportSize({width:900,height:850});await open(page);
 await page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.jumpTo({center:[-160,-85.051],zoom:3}));await ready(page,'Ross Sea coastline');
 const coast=await page.evaluate(()=>new Promise(resolve=>{const m=window.__PANDOLAB_MAPLIBRE__;m.once('render',()=>{const c=m.getCanvas(),gl=c.getContext('webgl2'),pixels=new Uint8Array(c.width*c.height*4);gl.readPixels(0,0,c.width,c.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);resolve([[-157.77,-85.1],[-158.2,-85.04],[-155.6,-85.15],[-160.33,-86.35]].map(coordinate=>{const p=m.project(coordinate),x=Math.round(p.x*m.getPixelRatio()),y=c.height-1-Math.round(p.y*m.getPixelRatio()),i=(y*c.width+x)*4;return Array.from(pixels.slice(i,i+3));}));});m.triggerRepaint();}));
 expect(coast.map(rgb=>rgb.every(value=>value>245)),'real Ross Sea water must remain water on both sides of the Mercator limit').toEqual([true,true,false,false]);
 const capOutline=await page.evaluate(()=>new Promise(resolve=>{
  const map=window.__PANDOLAB_MAPLIBRE__,canvas=map.getCanvas(),gl=canvas.getContext('webgl2');
  map.once('render',()=>{
   const bytes=new Uint8Array(canvas.width*canvas.height*4),ratio=map.getPixelRatio();
   gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
   let dark=0;
   for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
    const i=(y*canvas.width+x)*4;
    if(bytes[i]<170&&bytes[i+1]<170&&bytes[i+2]<170&&
       map.unproject([x/ratio,(canvas.height-1-y)/ratio]).lat< -85)dark++;
   }
   resolve(dark);
  });
  map.triggerRepaint();
 }));
 expect(capOutline,'ordinary Antarctic coastline must not draw a country outline').toBe(0);
 await page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.jumpTo({center:[0,-89],zoom:2}));await ready(page,'south cap');
 const sample=()=>page.evaluate(()=>{const m=window.__PANDOLAB_MAPLIBRE__,c=m.getCanvas(),t=document.createElement('canvas');t.width=c.width;t.height=c.height;const g=t.getContext('2d');g.drawImage(c,0,0);const data=g.getImageData(0,0,t.width,t.height).data;let tested=0,white=0;for(let y=10;y<c.clientHeight-10;y+=8)for(let x=10;x<c.clientWidth-10;x+=8){const ll=m.unproject([x,y]);if(ll.lat>=-86)continue;const i=(Math.round(y*c.height/c.clientHeight)*c.width+Math.round(x*c.width/c.clientWidth))*4;tested++;if(data[i]>245&&data[i+1]>245&&data[i+2]>245)white++;}return {tested,white,polar:window.__PANDOLAB_VIEWER__.rendererStats().polar};});
 const before=await sample();expect(before.tested).toBeGreaterThan(100);expect(before.white).toBe(0);expect(before.polar.pending).toBe(false);
 const point=await page.evaluate(()=>{const m=window.__PANDOLAB_MAPLIBRE__,r=m.getCanvas().getBoundingClientRect(),q=m.project([-160,-87]);return {x:q.x+r.x,y:q.y+r.y};});await page.mouse.click(point.x,point.y);
 await expect.poll(()=>page.evaluate(()=>window.__PANDOLAB_VIEWER__.selectionSnapshot().primaryKey)).toBe('territorial:entity:ATA');await ready(page,'polar selected');
 const prepared=await page.evaluate(()=>window.__PANDOLAB_VIEWER__.rendererStats().polar.preparations);
 await page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.jumpTo({center:[20,-87],zoom:2}));await ready(page,'polar pan');expect(await page.evaluate(()=>window.__PANDOLAB_VIEWER__.rendererStats().polar.preparations)).toBe(prepared);
 await page.evaluate(()=>{const gl=window.__PANDOLAB_MAPLIBRE__.getCanvas().getContext('webgl2'),e=gl.getExtension('WEBGL_lose_context');if(!e)throw Error('context loss unavailable');e.loseContext();setTimeout(()=>e.restoreContext(),150);});await ready(page,'polar context recovery');expect((await sample()).white).toBe(0);
 await page.evaluate(()=>window.__PANDOLAB_MAPLIBRE__.jumpTo({center:[0,89],zoom:2}));await ready(page,'north cap');expect(await page.evaluate(()=>window.__PANDOLAB_VIEWER__.rendererStats().polar.pending)).toBe(false);
});
