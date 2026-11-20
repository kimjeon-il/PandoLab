import "../../runtime/workers/worker-rpc-host.js";
// Install request reception before the compiled calculation module finishes loading.
const displayReady=import("../map-display-preparation.js").then(module=>module.createMapDisplayPreparation()).catch(cause=>{
 const error=new Error(cause?.message||'Territorial boundary Worker initialization failed.',{cause});
 error.code='PL-MAP-DISPLAY-INITIALIZATION';
 if(cause?.stack)error.stack=cause.stack;
 throw error;
});
displayReady.catch(()=>{});
self.PandoLabWorkerRpc.install({handlers:{'map.display':async(payload,context)=>{
 const checkpoint=async()=>{context.throwIfCancelled();await new Promise(resolve=>setTimeout(resolve,0));context.throwIfCancelled();};
 const display=await displayReady;context.throwIfCancelled();
 return display.prepare(payload,checkpoint);
}}});
