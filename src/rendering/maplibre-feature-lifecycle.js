/** One atomic install boundary for optional MapLibre extensions.
 * Sources/layers/images added synchronously are rolled back on failures;
 * event listeners, controls, Workers and GPU objects must register disposal
 * as they are acquired using the supplied scope.
 */
export function installManagedMapLibreFeature(map, install) {
 if(typeof install!=='function'||typeof map?.getStyle!=='function'||typeof map?.getLayersOrder!=='function')
  throw new TypeError('A loaded MapLibre map and synchronous feature installer are required.');
 const snapshot=()=>{
  const style=map.getStyle();
  if(!style?.sources||!Array.isArray(style.layers))throw new Error('MapLibre feature requires a loaded style.');
  return {
   layers:new Map(map.getLayersOrder().map(id=>[id,map.getLayer(id)])),
   sources:new Map(Object.keys(style.sources).map(id=>[id,map.getSource(id)])),
   images:new Set(map.listImages?.()||[]),
  };
 };
 const before=snapshot(),deferred=[];
 let completed=false;
 const scope=Object.freeze({
  defer(cleanup) {
   if(typeof cleanup!=='function')throw new TypeError('Feature cleanup must be a function.');
   deferred.push(cleanup);return cleanup;
  },
  on(type,listener,layerId) {
   // Register undo before acquisition: an event source may register and
   // then throw while installing a delegated listener.
   deferred.push(()=>{if(layerId===undefined)map.off(type,listener);else map.off(type,layerId,listener);});
   if(layerId===undefined)map.on(type,listener);else map.on(type,layerId,listener);
  },
  addControl(control,position) {
   // onAdd may throw after MapLibre has already attached the control.
   deferred.push(()=>{if(!map.hasControl||map.hasControl(control))map.removeControl(control);});
   map.addControl(control,position);return control;
  },
  track(resource,release) {
   if(typeof release!=='function')throw new TypeError('Tracked resource needs a release function.');
   deferred.push(()=>release(resource));return resource;
  },
 });
 const own=()=>{
  const after=snapshot();
  return {
   layers:[...after.layers].filter(([id])=>!before.layers.has(id)),
   sources:[...after.sources].filter(([id])=>!before.sources.has(id)),
   images:[...after.images].filter(id=>!before.images.has(id)),
  };
 };
 const rollback=(uninstall,resources)=>{
  const failures=[];
  const run=fn=>{try{fn();}catch(error){failures.push(error);}};
  if(uninstall)run(uninstall);
  for(const cleanup of deferred.reverse())run(cleanup);
  for(const [id,layer] of resources.layers.reverse())
   if(map.getLayer(id)===layer)run(()=>map.removeLayer(id));
  for(const [id,source] of resources.sources.reverse())
   if(map.getSource(id)===source)run(()=>map.removeSource(id));
  for(const id of resources.images.reverse())
   if(map.hasImage?.(id))run(()=>map.removeImage(id));
  return failures;
 };
 let uninstall,resources;
 try{
  uninstall=install(map,scope);
  if(typeof uninstall!=='function')throw new TypeError('MapLibre feature must return its cleanup function.');
  resources=own();completed=true;
 }catch(error){
  const failures=rollback(null,own());
  if(failures.length&&error&&typeof error==='object')
   error.rollbackError=new AggregateError(failures,'Feature rollback failed');
  throw error;
 }
 if(!completed)throw new Error('MapLibre feature was not installed');
 let disposed=false;
 return Object.freeze({
  layers:Object.freeze(resources.layers.map(([id])=>id)),
  dispose(){
   if(disposed)return;disposed=true;
   const failures=rollback(uninstall,{
    layers:[...resources.layers],sources:[...resources.sources],images:[...resources.images],
   });
   if(failures.length===1)throw failures[0];
   if(failures.length)throw new AggregateError(failures,'Feature cleanup failed');
  },
 });
}
