// Single native document owner. A queued request is removable before it
// starts; once dispatched, its operation owns its acknowledgement.
export function createCoreRequestQueue(cancelled){
 let running=false,scheduled=false,closed=false;
 const pending=[];
 function detach(entry){entry.signal?.removeEventListener('abort',entry.abort);}
 function schedule(){
  if(running||scheduled||closed)return;
  scheduled=true;queueMicrotask(drain);
 }
 async function drain(){
  scheduled=false;if(running||closed)return;
  running=true;
  try{
   while(pending.length&&!closed){
    const entry=pending.shift();detach(entry);
    if(entry.signal?.aborted){entry.reject(cancelled());continue;}
    try{entry.resolve(await entry.run());}catch(error){entry.reject(error);}
   }
  }finally{running=false;if(pending.length)schedule();}
 }
 function submit(run,signal){
  if(closed||signal?.aborted)return Promise.reject(cancelled());
  return new Promise((resolve,reject)=>{
   const entry={run,signal,resolve,reject,abort:null};
   entry.abort=()=>{
    const index=pending.indexOf(entry);
    if(index<0)return;
    pending.splice(index,1);detach(entry);reject(cancelled());
   };
   pending.push(entry);signal?.addEventListener('abort',entry.abort,{once:true});schedule();
  });
 }
 function close(){
  if(closed)return;closed=true;
  for(const entry of pending.splice(0)){detach(entry);entry.reject(cancelled());}
 }
 return Object.freeze({submit,close});
}
