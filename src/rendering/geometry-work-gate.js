// A bounded, priority-aware lease queue for independent Worker jobs.
export function createGeometryWorkGate(limit=2){
 let active=0,sequence=0;const waiting=[];
 function pump(){
  while(active<limit&&waiting.length){
   waiting.sort((a,b)=>b.priority-a.priority||a.sequence-b.sequence);
   const entry=waiting.shift();entry.detach();
   if(entry.context.signal?.aborted){entry.reject(entry.context.signal.reason);continue;}
   active++;
   Promise.resolve().then(()=>{entry.context.throwIfCancelled();return entry.work();})
    .then(entry.resolve,entry.reject).finally(()=>{active--;pump();});
  }
 }
 function run(context,work){
  context.throwIfCancelled();
  return new Promise((resolve,reject)=>{
   const signal=context.signal,entry={context,work,resolve,reject,priority:context.priority||0,sequence:++sequence};
   const cancel=()=>{const index=waiting.indexOf(entry);if(index>=0){waiting.splice(index,1);entry.detach();reject(signal.reason||new DOMException('Cancelled','AbortError'));}};
   entry.detach=()=>signal?.removeEventListener('abort',cancel);
   waiting.push(entry);signal?.addEventListener('abort',cancel,{once:true});pump();
  });
 }
 return {run};
}
