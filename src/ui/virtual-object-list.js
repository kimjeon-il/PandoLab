// Fixed-size virtual windows for the Viewer's flat search and child grid.
// Coordinates are relative to the first item, including scroll padding.
export function objectListWindow(count,{scroll=0,height=0,stride=32,columns=1,overscan=4}={}) {
  const cols=Math.max(1,Math.floor(columns)||1),step=Math.max(1,Number(stride)||32);
  const rows=Math.ceil(Math.max(0,count)/cols);
  if (!rows)return {start:0,end:0,before:0,after:0};
  const first=Math.min(rows-1,Math.max(0,Math.floor(scroll/step)-overscan));
  const last=Math.min(rows,Math.max(first+1,Math.ceil((scroll+Math.max(0,height))/step)+overscan));
  return {start:first*cols,end:Math.min(count,last*cols),before:first*step,after:(rows-last)*step};
}
export function objectListSpacer(document,pixels,gap=0) {
  const row=document.createElement('div');
  row.className='object-list-spacer';
  row.setAttribute('aria-hidden','true');
  row.style.height=Math.max(0,pixels-gap)+'px';
  return row;
}
export function observeObjectList(window,element,render) {
  if (!window||!element)return ()=>{};
  let frame=null,disposed=false;
  const schedule=()=>{
    if (disposed||frame!==null)return;
    frame=window.requestAnimationFrame(()=>{frame=null;if(!disposed)render();});
  };
  const observer=window.ResizeObserver?new window.ResizeObserver(schedule):null;
  observer?.observe(element);element.addEventListener('scroll',schedule,{passive:true});
  return ()=>{disposed=true;observer?.disconnect();element.removeEventListener('scroll',schedule);
    if(frame!==null)window.cancelAnimationFrame(frame);};
}
export function virtualListMetrics(window,element,sample,{grid=false}={}) {
  const style=window.getComputedStyle(element),rowStyle=sample?window.getComputedStyle(sample):null;
  const gap=parseFloat(style.rowGap)||0;
  const height=sample?.getBoundingClientRect().height||parseFloat(rowStyle?.minHeight)||parseFloat(style.getPropertyValue('--ui-control-height'))||36;
  const columns=grid?Math.max(1,style.gridTemplateColumns.split(/\s+/).filter(Boolean).length):1;
  return {gap,stride:height+gap,columns};
}
