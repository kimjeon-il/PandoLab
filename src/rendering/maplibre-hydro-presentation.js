const VIEWER_ZOOM_BY_SOURCE_STAGE=new Map([[6,2],[6.7,3],[7,4],[7.5,5]]);
const NATIVE_HYDRO_ZOOMS=[...VIEWER_ZOOM_BY_SOURCE_STAGE.values()];
const layerFilter=(category,zoom,hiddenIds)=>['all',['==',['get','category'],category],['==',['get','viewerMinZoom'],zoom],
 ...(hiddenIds.length?[['!',['in',['get','logicalId'],['literal',hiddenIds]]]]:[])];
const hydroLayers=[['lakes','lake','fill'],['rivers','river','line']].flatMap(([baseId,category,type])=>
 NATIVE_HYDRO_ZOOMS.map((zoom,index)=>({id:index===0?baseId:baseId+'-'+zoom,baseId,category,type,zoom})));

// Globe coverage can use more than one tile zoom at the same time.
// Paint expressions use the camera zoom regardless of the source tile level.
export const mapLibreHydroOpacity=(zoom=NATIVE_HYDRO_ZOOMS[0],opacity=1)=>['step',['zoom'],0,zoom,opacity];
export function mapLibreHydroPaint(paint,type,zoom,opacity=1){
 return {...paint,[type+'-opacity']:mapLibreHydroOpacity(zoom,opacity)};
}

export function mapLibreHydroStages(stages){
 return stages.map(stage=>{
  const minZoom=VIEWER_ZOOM_BY_SOURCE_STAGE.get(stage.minZoom);
  if(minZoom===undefined)throw new RangeError('Unsupported hydro source stage '+stage.minZoom);
  return {...stage,minZoom};
 });
}

export function mapLibreHydroStyle({antiAlias=true,historical=false,stylePaint=null}={}){
 const paints=stylePaint||{
  lakes:{'fill-antialias':antiAlias,'fill-color':'#5aa9d6'},
  rivers:{'line-color':'#3b82c4','line-width':0.8},
 };
 return {sources:{hydro:{type:'geojson',data:{type:'FeatureCollection',features:[]},promoteId:'featureId'}},
  layers:hydroLayers.map(({id,baseId,category,type,zoom})=>({
   id,type,source:'hydro',filter:layerFilter(category,zoom,[]),
   paint:mapLibreHydroPaint(paints[baseId],type,zoom,historical&&type==='fill'?0.48:1),
   ...(category==='river'?{layout:{'line-join':'round','line-cap':'round'}}:{}),
  }))};
}

export function syncMapLibreHydroVisibility(map,hiddenIds,visibility){
 for(const {id,baseId,category,zoom}of hydroLayers){
  const filter=layerFilter(category,zoom,hiddenIds);
  if(JSON.stringify(map.getFilter(id))!==JSON.stringify(filter))map.setFilter(id,filter);
  const value=visibility[baseId]===false?'none':'visible';
  if(map.getLayoutProperty(id,'visibility')!==value)map.setLayoutProperty(id,'visibility',value);
 }
}

export function hiddenMapLibreHydroIds(features,isVisible){
 const hidden=new Set(),checked=new Set();
 for(const feature of features){
  const {logicalId,layerId}=feature.properties;
  if(checked.has(logicalId))continue;
  checked.add(logicalId);
  if(!isVisible({...feature,id:logicalId,properties:{...feature.properties,pandolab_id:logicalId,layer_id:layerId}}))
   hidden.add(logicalId);
 }
 return [...hidden].sort();
}

export function prepareMapLibreHydroFeatures(features,prepare){
 const groups=new Map();
 for(const feature of features){const id=String(feature.properties.logicalId);if(!groups.has(id))groups.set(id,[]);groups.get(id).push(feature);}
 return [...groups].map(([id,fragments])=>{
  const first=fragments[0],polygon=first.properties.category==='lake';
  const coordinates=fragments.flatMap(feature=>feature.geometry.type===(polygon?'MultiPolygon':'MultiLineString')?feature.geometry.coordinates:[feature.geometry.coordinates]);
  return prepare({type:'Feature',id,geometry:{type:polygon?'MultiPolygon':'MultiLineString',coordinates},properties:{...first.properties,pandolab_id:id,layer_id:first.properties.layerId}});
 });
}

export function createMapLibreHydroPresentation({map,admitFeatures,onFeatures,load,cancel,onError,updateSource,
 beforePublish=async()=>{},waitForSource=async()=>true,needsSourceRestore=()=>false,isEnabled=()=>true}){
 if(!map||typeof admitFeatures!=='function'||typeof onFeatures!=='function'||typeof load!=='function'||typeof onError!=='function'||typeof updateSource!=='function')
  throw new TypeError('Hydro presentation requires the map, data and selection owners');
 let generation=0,disposed=false,pending=Promise.resolve(),tail=Promise.resolve(),presentedKey=null,publishedKey=null,activePacks=new Map();
 const fragmentsById=new Map();
 const needsAdmission=new Set();
 let selectable=new Set(),lastFailureKey='';
 let presentedFeatures=()=>[];
 async function publish(version,key){
  const current=()=>!disposed&&version===generation&&isEnabled();
  if(await waitForSource(current)===false||!current())return;
  const changed=[...needsAdmission].flatMap(id=>[...fragmentsById.get(id)?.values()||[]]);
  if(changed.length&&await admitFeatures(changed,current)===false)return;
  if(!current())return;
  const features=presentedFeatures();
  needsAdmission.clear();
  selectable=new Set(features.map(feature=>String(feature.id)));
  onFeatures(features);publishedKey=key;
 }
 async function refresh(version){
  const current=()=>!disposed&&version===generation&&isEnabled();
  const center=map.getCenter(),canvas=map.getCanvas();
  const result=await load({center:[center.lng,center.lat],zoom:map.getZoom(),width:canvas.clientWidth,height:canvas.clientHeight,knownKey:presentedKey},current);
  const {key,addPacks,removePacks,failedPacks=[]}=result;
  if(!current())return;
  const failureKey=failedPacks.map(({id,message})=>id+':'+message).sort().join('|');
  if(failureKey&&failureKey!==lastFailureKey)onError(Object.assign(Error(failedPacks[0].message),{failedPacks,diagnostic:failedPacks[0].diagnostic}));
  lastFailureKey=failureKey;
  if(key===presentedKey&&!needsSourceRestore()&&publishedKey===key&&!needsAdmission.size)return;
  await beforePublish(current);
  if(!current())return;
  if(key===presentedKey){
   if(needsSourceRestore()&&!await updateSource({add:[],remove:[]},presentedFeatures,current))return;
   if(current())await publish(version,key);
   return;
  }
  const next=new Map(activePacks),remove=[],add=[],changed=new Map();
  const fragmentsFor=feature=>{
   const id=String(feature.properties.logicalId);
   if(!changed.has(id))changed.set(id,new Map(fragmentsById.get(id)));
   return changed.get(id);
  };
  for(const id of removePacks||[]){
   for(const feature of next.get(id)||[]){remove.push(feature.id);fragmentsFor(feature).delete(feature.id);}
   next.delete(id);
  }
  for(const pack of addPacks||[]){
   next.set(pack.id,pack.features);
   for(const feature of pack.features){add.push(feature);fragmentsFor(feature).set(feature.id,feature);}
  }
  let snapshot;
  const allFeatures=()=>snapshot??=[...next.values()].flat();
  if(add.length||remove.length||needsSourceRestore()){
   for(const id of changed.keys())needsAdmission.add(id);
   const applied=await updateSource({add,remove},allFeatures,current);
   if(!applied)return;
  }
  if(!disposed){
   // updateData has already changed the source, so retain its actual pack
   // baseline even when a newer view arrived while the worker was applying it.
   for(const [id,fragments]of changed){
    if(fragments.size)fragmentsById.set(id,fragments);else fragmentsById.delete(id);
   }
   activePacks=next;presentedKey=key;presentedFeatures=allFeatures;
   if(current())await publish(version,key);
  }
 }
 const suspend=()=>{generation++;cancel?.();};
 const settle=()=>{
  if(disposed||!isEnabled())return Promise.resolve();
  const version=++generation,cancelled=cancel?Promise.resolve().then(cancel):Promise.resolve();cancelled.catch(()=>{});
  pending=tail.then(async()=>{await cancelled;if(!disposed&&version===generation&&isEnabled())await refresh(version);})
   .catch(error=>{if(!disposed&&version===generation&&isEnabled()&&error?.name!=='AbortError')throw error;});
  tail=pending.catch(()=>{});pending.catch(onError);return pending;
 };
 map.on('movestart',suspend);
 map.on('moveend',settle);
 return {refresh:settle,suspend,ready:()=>pending,
  canPick:(id,logicalId)=>isEnabled()&&!needsSourceRestore()&&selectable.has(String(id))&&!needsAdmission.has(String(logicalId)),
  dispose(){disposed=true;suspend();map.off('movestart',suspend);map.off('moveend',settle);activePacks.clear();fragmentsById.clear();selectable.clear();needsAdmission.clear();presentedFeatures=()=>[];}};
}
