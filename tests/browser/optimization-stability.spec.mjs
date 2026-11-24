import {test,expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';

// Real browser end-to-end coverage. Run on the verification branch only.
test('100 date transitions and 30 minute renderer stability',async({page},testInfo)=>{
 test.skip(process.env.PANDO_STABILITY_CAPTURE!=='1','Explicit stability capture required');
 test.setTimeout(85*60*1000);
 const errors=[],samples=[],transitions=[];
 page.on('pageerror',error=>errors.push(error.message));
 const session=await page.context().newCDPSession(page);
 await session.send('Performance.enable');
 async function ready(expected=null){
  await page.waitForFunction(month=>{
   const viewer=window.__PANDOLAB_VIEWER__,stats=viewer?.rendererStats?.();
   if(stats?.projectRenderBlocked)throw Error(stats.errorMessage||'Renderer blocked');
   return viewer?.initialMapPresented?.()&&stats?.mapReadiness?.mapReady
    &&stats.displayedRevision>0&&stats.certifiedRevision===stats.sourceRevision
    &&document.querySelector('#viewerStatus')?.dataset.ready==='true'
    &&(!month||viewer.documentState().timelineCursor===month);
  },expected,{timeout:90000});
 }
 async function changeDate(month){
  const current=await page.evaluate(()=>window.__PANDOLAB_VIEWER__.documentState().timelineCursor);
  if(current===month)return;
  const [year,number]=month.split('-'),started=performance.now();
  await page.locator('#timelineDateButton').click();
  await page.locator('#timelineViewUnit').selectOption('month');
  await page.locator('#timelineYearInput').fill(year);
  await page.locator('#timelineMonthInput').selectOption(String(Number(number)));
  await page.locator('#timelineGoBtn').click();
  await ready(month);
  transitions.push({from:current,to:month,ms:performance.now()-started});
 }
 async function sample(label){
  // Force GC only at comparable quiescent checkpoints. This isolates
  // retained JS heap from short-lived allocations; GPU is not measured.
  await session.send('HeapProfiler.collectGarbage');
  const perf=await session.send('Performance.getMetrics');
  const stats=await page.evaluate(()=>window.__PANDOLAB_VIEWER__.rendererStats());
  samples.push({label,elapsedMs:performance.now()-start,
   heapBytes:perf.metrics.find(metric=>metric.name==='JSHeapUsedSize')?.value??null,
   nodes:perf.metrics.find(metric=>metric.name==='Nodes')?.value??null,stats});
 }
 const dates=['1801-01','1922-12','2025-12','1950-06','1912-12','2025-12'];
 const start=performance.now();
 try{
  await page.goto('./?debug=1',{waitUntil:'domcontentloaded'});await ready();
  // Warm the same finite set before comparing heap checkpoints.
  for(const month of dates)await changeDate(month);
  await sample('warm');
  for(let i=0;i<100;i++){
   await changeDate(dates[i%dates.length]);
   if((i+1)%10===0)await sample('date-'+(i+1));
  }
  const soakStart=performance.now();let iteration=0;
  while(performance.now()-soakStart<30*60*1000){
   const index=iteration++;
   await page.evaluate(i=>{
    window.__PANDOLAB_MAP_HOST__.setViewState({projection:'globe',
     view:{zoom:[1,3,5,8][i%4],globeRotation:[-((i*31)%360-180),[-25,45,83,-70][i%4],0]}});
   },index);
   await ready();
   await changeDate(dates[index%dates.length]);
   if(iteration%5===0)await sample('soak-'+iteration);
   await page.waitForTimeout(1000);
  }
  await changeDate(dates.at(-1));
  await page.evaluate(()=>window.__PANDOLAB_MAP_HOST__.setViewState({projection:'globe',view:{zoom:3,globeRotation:[-90,-25,0]}}));
  await ready();await sample('final');
  expect(errors,'Uncaught browser errors').toEqual([]);
  expect(transitions.length).toBeGreaterThanOrEqual(100);
  // Report retained heap trend rather than treating one peak or heuristic
  // threshold as a conclusive leak diagnosis.
 }finally{
  await writeFile(testInfo.outputPath('stability.json'),JSON.stringify({samples,transitions,errors},null,2));
  await session.detach();
 }
});
