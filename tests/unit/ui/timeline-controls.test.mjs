import test from 'node:test';
import assert from 'node:assert/strict';
import {installTimelineControls} from '../../../src/ui/timeline-controls.js';
import {createProjectMonthClock} from '../../../src/document/project-month-clock.js';

const stepIds=['timelinePreviousDecade','timelinePreviousYear','timelineNextYear','timelineNextDecade'];
function node(){
 const listeners=new Map(),attrs=new Map();
 return {value:'',hidden:false,disabled:false,textContent:'',
  addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},
  removeEventListener(name,fn){listeners.get(name)?.delete(fn);},
  setAttribute:(name,value)=>attrs.set(name,String(value)),getAttribute:name=>attrs.get(name),
  focus(){},select(){},contains(){return true;},
  fire(name,event={}){for(const fn of [...(listeners.get(name)||[])])fn({preventDefault(){},stopPropagation(){},...event});}};
}
function fixture(){
 const ids=['timelineControls','timelinePopover','timelineDateForm','timelineYearInput','timelineMonthInput',
  'timelineGoBtn','timelineDateButton','timelineDateButtonText','timelineDateError','timelineViewUnit','timelineMonthFields',...stepIds];
 const nodes=new Map(ids.map(id=>[id,node()])),get=id=>nodes.get(id);
 const window=node(),document={...node(),getElementById:get};
 let month='2025-12';const requests=[];
 const clock=createProjectMonthClock({now:()=>new Date(2026,10,25),coalesceRequests:false,
  onPendingChange:()=>window.fire('pandolab:timeline-pending'),
  applyMonth:(value,{commit})=>new Promise((resolve,reject)=>requests.push({value,complete:()=>{
   month=value;commit();resolve(true);
  },reject,cancel:()=>resolve(false)}))});
 const dispose=installTimelineControls({document,window,getMonth:()=>month,isPending:clock.isPending,
  setMonth:clock.selectMonth,getRange:()=>({start:'1900-12',end:'2026-11'}),now:()=>new Date(2026,10,25)});
 const locked=()=>[...stepIds,'timelineDateButton','timelineGoBtn','timelineYearInput','timelineMonthInput','timelineViewUnit'].every(id=>get(id).disabled);
 const flush=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
 return {get,window,clock,requests,locked,flush,dispose(){dispose();clock.dispose();}};
}

test('timeline buttons reject repeated and synthetic input until the date promise settles',async()=>{
 const f=fixture(),{get,requests}=f;
 try{
  get('timelinePreviousYear').fire('click');
  assert.equal(requests.length,1);assert.equal(requests[0].value,'2024-12');
  assert.equal(f.locked(),true);assert.equal(get('timelineControls').getAttribute('aria-busy'),'true');
  get('timelinePreviousDecade').fire('click');get('timelineDateButton').fire('click');
  get('timelineDateForm').fire('submit');assert.equal(requests.length,1);
  // An unrelated sync or an input event may not release the lock.
  f.window.fire('pandolab:project-changed');assert.equal(f.locked(),true);
  requests[0].complete();await f.flush();
  assert.equal(get('timelineDateButton').disabled,false);
  assert.equal(get('timelineControls').getAttribute('aria-busy'),'false');
  get('timelineDateButton').fire('click');get('timelineYearInput').value='1922';
  get('timelineDateForm').fire('submit');assert.equal(requests.length,2);assert.equal(f.locked(),true);
  get('timelineDateForm').fire('submit');get('timelineNextYear').fire('click');
  assert.equal(requests.length,2);
  requests[1].reject(Error('date preparation failed'));await f.flush();
  assert.equal(get('timelineGoBtn').disabled,false);
  assert.equal(get('timelineYearInput').value,'1922');assert.equal(get('timelineDateError').textContent,'date preparation failed');
  get('timelineDateForm').fire('submit');assert.equal(requests.length,3);
  requests[2].cancel();await f.flush();assert.equal(get('timelineGoBtn').disabled,false);
  get('timelineDateForm').fire('submit');requests[3].complete();await f.flush();
  assert.equal(get('timelinePopover').hidden,true);assert.equal(get('timelineDateButtonText').textContent,'1922년 말');
 }finally{f.dispose();}
});

test('external date requests also lock controls but can still supersede each other',async()=>{
 const f=fixture(),{get,clock,requests}=f;
 try{
  const first=clock.selectMonth('1912-12');assert.equal(f.locked(),true);
  get('timelineNextDecade').fire('click');assert.equal(requests.length,1);
  const second=clock.selectMonth('1900-12');assert.equal(requests.length,2);
  requests[0].cancel();assert.equal(await first,false);assert.equal(f.locked(),true);
  requests[1].complete();assert.equal(await second,true);await f.flush();
  assert.equal(get('timelineDateButton').disabled,false);
  assert.equal(get('timelinePreviousYear').disabled,true,'Project range remains enforced after unlocking');
  assert.equal(get('timelineNextYear').disabled,false);
 }finally{f.dispose();}
});
