// A renderer generation is owned by frame admission. Capture the same
// map/context/generation certificate in every asynchronous source writer;
// never invent a second project revision counter in a resource cache.
export function createRenderLifetime({getMap,getGeneration,getContextRevision=()=>0,isDisposed=()=>false}){
 function capture(){
  const map=getMap(),generation=getGeneration(),context=getContextRevision();
  const live=()=>!isDisposed()&&getMap()===map&&getContextRevision()===context;
  return Object.freeze({map,generation,context,live,
   current:({retainGeneration=false}={})=>live()&&(retainGeneration||getGeneration()===generation),
   sourceCurrent:(id,source)=>live()&&map?.getSource(id)===source});
 }
 return Object.freeze({capture});
}

// A single latest request per logical owner. Aborting an obsolete request
// is separate from acknowledging native state that may already be written.
export function createLatestRenderRequests(){
 const entries=new Map();let closed=false;
 function cancel(key){
  const prior=entries.get(key);
  if(prior){entries.delete(key);prior.controller.abort();}
 }
 function begin(key,fields={}){
  if(closed)throw new DOMException('Render requests disposed','AbortError');
  cancel(key);
  const controller=new AbortController(),entry={...fields,controller,signal:controller.signal};
  entries.set(key,entry);return entry;
 }
 function current(key,entry){return !closed&&entries.get(key)===entry&&!entry.signal.aborted;}
 function finish(key,entry){if(!current(key,entry))return false;entries.delete(key);return true;}
 function clear(){for(const key of entries.keys())cancel(key);}
 return Object.freeze({begin,current,finish,cancel,clear,get:key=>entries.get(key),has:key=>entries.has(key),
  dispose(){closed=true;clear();}});
}
