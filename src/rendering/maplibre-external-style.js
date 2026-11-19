/** Combine an optional basemap with the current map-owned historical layers. */
export function mergeExternalBasemapStyle(previous,external){
 if(previous?.version!==8||external?.version!==8||!Array.isArray(previous.layers)||!Array.isArray(external.layers)||!previous.sources||!external.sources)throw new TypeError('A complete MapLibre style is required.');
 const ids=new Set(previous.layers.map(layer=>layer.id));
 for(const id of Object.keys(external.sources))if(Object.hasOwn(previous.sources,id))throw new Error('Basemap source collision: '+id);
 for(const layer of external.layers){if(!layer?.id||ids.has(layer.id))throw new Error('Basemap layer collision: '+layer?.id);ids.add(layer.id);}
 const before=previous.layers.findIndex(layer=>layer.id==='territories');
 if(before<0)throw new Error('The historical map layer is missing.');
 return {...previous,...external,projection:previous.projection,
  ...((previous['font-faces']||external['font-faces'])?{'font-faces':{...external['font-faces'],...previous['font-faces']}}:{}),
  sources:{...previous.sources,...external.sources},
  layers:[...previous.layers.slice(0,before),...external.layers,...previous.layers.slice(before)]};
}

/** Installs a test basemap and removes only its own sources and layers. */
export function createExternalBasemap(map,{onFailure=()=>{},onChange=()=>{},onCancelled=()=>{},onRemoveStart=()=>{},onRemoveEnd=()=>{},getRevision=()=>null}={}){
 let current=null,disposed=false,removing=null,installing=false,installEpoch=0,loadingStyle=null,recovering=null,cancelSnapshot=null;const waiters=new Set();
 const waitForRender=(change,ready,ownsSource)=>new Promise((resolve,reject)=>{
  let finished=false;
  const previousStyle=map.style;let styleReady=false;
  const clean=()=>{waiters.delete(cancel);map.off('render',render);map.off('style.load',loaded);map.off('error',failed);};
  const failed=event=>{if(finished||(event.sourceId&&!ownsSource(event.sourceId)))return;finished=true;clean();reject(event.error||new Error('Basemap style failed.'));};
  const cancel=()=>failed({error:Object.assign(new Error('Basemap operation disposed.'),{name:'AbortError'})});
  const loaded=()=>{styleReady=true;};
  const render=()=>{if(finished||(!styleReady&&map.style!==previousStyle)||!ready())return;finished=true;clean();resolve();};
  waiters.add(cancel);
  map.on('render',render);map.on('style.load',loaded);map.on('error',failed);
  try{change();map.triggerRepaint();}catch(error){failed({error});}
 });
 async function snapshot(){
  const revision=getRevision();
  const style=map.getStyle();
  let cancel;const interrupted=new Promise((_,reject)=>{cancel=()=>reject(new DOMException('Basemap snapshot superseded','AbortError'));});cancelSnapshot=cancel;
  try{await Promise.race([Promise.all(Object.entries(style.sources).map(async([id,source])=>{
   if(source.type==='geojson'&&typeof source.data!=='string')source.data=await map.getSource(id).getData();
  })),interrupted]);}finally{if(cancelSnapshot===cancel)cancelSnapshot=null;}
  if(disposed||revision!==getRevision())throw new DOMException('Basemap snapshot superseded','AbortError');
  return style;
 }
 function remove(){
  if(removing)return removing;
  if(!current)return Promise.resolve(false);
  onRemoveStart();
  const item=current;if(item.onError)map.off('error',item.onError);
  removing=(async()=>{
  const existing=await snapshot(),layers=existing.layers.filter(layer=>!item.layers.has(layer.id));
  const sources=Object.fromEntries(Object.entries(existing.sources).filter(([id])=>!item.sources.has(id)));
  const style={...existing,layers,sources};
  for(const [key,value]of item.rootFields){if(value.present)style[key]=value.value;else delete style[key];}
  loadingStyle={item,previous:style};
  await waitForRender(()=>map.setStyle(style),()=>[...item.layers].every(id=>!map.getLayer(id)),id=>item.sources.has(id));
  loadingStyle=null;
  current=null;
  onChange();
  return true;
  })().catch(error=>{loadingStyle=null;if(!disposed&&current===item&&item.onError)map.on('error',item.onError);throw error;}).finally(()=>{removing=null;onRemoveEnd();});
  return removing;
 }
 async function install(style){
  if(disposed||current||removing||installing||recovering)throw new Error('A basemap is already active or disposed.');
  installing=true;const epoch=++installEpoch;
  let previous;try{previous=await snapshot();if(disposed||epoch!==installEpoch)throw new DOMException('Basemap installation superseded','AbortError');mergeExternalBasemapStyle(previous,style);}finally{installing=false;}
  const rootFields=new Map(Object.keys(style).filter(key=>!['version','sources','layers','projection'].includes(key)).map(key=>[key,{present:Object.hasOwn(previous,key),value:previous[key]}]));
  const item={layers:new Set(style.layers.map(layer=>layer.id)),sources:new Set(Object.keys(style.sources)),rootFields,onError:null};
  current=item;
  try{
   loadingStyle={item,previous};
   await waitForRender(()=>map.setStyle(style,{transformStyle:()=>mergeExternalBasemapStyle(previous,style)}),()=>[...item.layers].every(id=>!!map.getLayer(id)),id=>item.sources.has(id));
   loadingStyle=null;
   onChange();
  }catch(error){try{if(loadingStyle?.item===item)await cancelPending();else await remove();}catch(restoreError){error.restoreError=restoreError;}throw error;}
  item.onError=event=>{if(current!==item||!item.sources.has(event.sourceId))return;const cause=event.error||new Error('External basemap failed.');remove().then(()=>onFailure(cause,{removed:true}),restoreError=>{cause.restoreError=restoreError;onFailure(cause,{removed:false});});};
  map.on('error',item.onError);
  return ()=>current===item?remove():Promise.resolve(false);
 }
 function cancelPending(){
  installEpoch++;
  cancelSnapshot?.();
  if(recovering)return recovering;
  if(!loadingStyle)return Promise.resolve(false);
  const {item,previous}=loadingStyle;loadingStyle=null;
  if(current===item)current=null;
  for(const cancel of [...waiters])cancel();
  recovering=waitForRender(()=>map.setStyle(previous,{diff:false}),()=>!!map.getLayer('territories'),()=>false)
   .then(()=>{onChange();onCancelled();return true;}).finally(()=>{recovering=null;});
  return recovering;
 }
 function reposition(){if(!current||!map.getLayer('territories'))return;for(const id of current.layers)if(map.getLayer(id))map.moveLayer(id,'territories');}
 return Object.freeze({install,remove,reposition,cancelPending,ownsSource:id=>current?.sources.has(id)===true,dispose(){
  if(disposed)return;disposed=true;
  cancelSnapshot?.();
  if(current?.onError)map.off('error',current.onError);
  if(current){for(const id of [...current.layers].reverse())if(map.getLayer(id))map.removeLayer(id);for(const id of current.sources)if(map.getSource(id))map.removeSource(id);}
  current=null;for(const cancel of [...waiters])cancel();
 }});
}
