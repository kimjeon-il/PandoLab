/** Ordinary geographic labels use MapLibre symbols, shaping and collision placement. */
export const MAPLIBRE_LABEL_LAYERS=Object.freeze(['viewer-label-dot','viewer-label-text','viewer-label-country']);
export const MAPLIBRE_LABEL_MIN_ZOOM=Object.freeze({country:3,places:3.5});

export function createMapLibreLabelPresentation({renderer,labels,onChange,onError,onSourceError=onError}){
 const sourceId='viewer-labels';let signature='',failedKey='',pending=false,disposed=false,sequence=0,tail=Promise.resolve(),nextImageId=0;
 const images=new Map();
 const imageKeys=new Map();let imageBase=null,imageBasePath='';
 const decodedImages=new Map();let imageFrame=null;
 function scheduleImages(){if(imageFrame!==null)return;imageFrame=0;if(typeof requestAnimationFrame==='function')imageFrame=requestAnimationFrame(installDecodedImages);else queueMicrotask(installDecodedImages);}
 function installDecodedImages(){
  imageFrame=null;if(disposed){decodedImages.clear();return;}
  if(typeof requestAnimationFrame==='function'&&renderer.getRuntimeState?.().temporalViewPending){scheduleImages();return;}
  for(const [key,entry]of decodedImages){if(images.get(key)!==entry)continue;
   try{if(!renderer.map.hasImage(entry.id))renderer.map.addImage(entry.id,entry.image,{pixelRatio:Math.max(.01,entry.image.height/12)});entry.ready=true;}
   catch(error){entry.failed=true;onError(error);}
  }
  decodedImages.clear();
 }
 // Only bundled immutable paths share the build's cache-busting alias.
 // User URLs, SVG fragments and other query parameters retain their identity.
 const imageKey=value=>{
  if(typeof value!=='string'||!value.includes('assets/vendor/'))return value;
  if(imageKeys.has(value))return imageKeys.get(value);
  try{if(!imageBase){imageBase=new URL(document.baseURI);imageBasePath=new URL('.',imageBase).pathname;}const url=new URL(value,imageBase);
   if(url.origin!==imageBase.origin||!/^assets\/vendor\/(?:country-flags\/[a-f0-9]{40}\/svg|flag-icons\/[\d.]+\/flags\/(?:4x3|1x1)|political-flags)\/[^/]+\.svg$/.test(url.pathname.slice(imageBasePath.length)))return value;
   url.searchParams.delete('v');const key=url.href;if(imageKeys.size>=1024)imageKeys.delete(imageKeys.keys().next().value);imageKeys.set(value,key);return key;
  }catch{return value;}
 };
 let flagRequests=0;
 let observedSource=null,observedError=null,sourceRows=null;
 const font='Pando Pretendard';
 function sourceFailed(error){
  if(disposed)return;const map=renderer.map;pending=false;failedKey=signature;signature='';sequence++;
  for(const id of MAPLIBRE_LABEL_LAYERS)if(map.getLayer(id))map.removeLayer(id);
  const source=map.getSource(sourceId);observedSource?.off?.('error',observedError);observedSource=null;sourceRows=null;if(source)map.removeSource(sourceId);
  onSourceError(error.error||error);
 }
 function prepareFlags(layout,load=true){
  const map=renderer.map;
  for(const [,flag]of layout.territorialFlags||[]){
   if(!flag?.url)continue;
   const key=imageKey(flag.url);
   let entry=images.get(key);
   if(!entry){
    const id='pando-flag-'+nextImageId++;
    entry={id,ready:false,failed:false,started:false};
    images.set(key,entry);
   }
   if(!load||entry.ready||entry.failed)continue;
   if(!entry.started){
    entry.started=true;flagRequests++;
    const loadDom=async()=>{
     const image=new Image();
     image.crossOrigin='anonymous';
     image.src=flag.url;
     await image.decode();
     return {data:image};
    };
    const request=typeof Image==='function'&&/\.svg(?:[?#]|$)/i.test(flag.url)?loadDom():map.loadImage(flag.url).catch(loadDom);
    request.then(result=>{
     if(disposed||images.get(key)!==entry)return;
     entry.image=result.data;
     decodedImages.set(key,entry);
     scheduleImages();
    }).catch(error=>{
     if(disposed||images.get(key)!==entry)return;
     entry.failed=true;
     onError(error);
    });
   }
  }
  return true;
 }
 function sync(layout){
  const map=renderer.map,state=labels.getState(),features=[];
  const palette=labels.mapPalette?.().labels||{text:'#343840',halo:'#ffffff',point:'#c23934',selection:'#9d3a16',marker:'filled'};
  const add=(item,domain,coordinate,rows,flag)=>{
   if(!coordinate)return;
   const ref=domain==='territorial'?labels.getTerritorialLabelRef(item.id):labels.normalizeObjectRef({domain:'label',type:item.kind||'label',id:item.id});
   if(!ref)return;
   const selected=labels.selectionHas?.(ref),image=images.get(imageKey(flag?.url)),priority=(domain==='territorial'?layout.territorialLabelPriorities:layout.userLabelPriorities)?.get(String(item.id))??(domain==='territorial'?100:item.priority||40);
   features.push({type:'Feature',id:ref.key,geometry:{type:'Point',coordinates:coordinate},properties:{objectKey:ref.key,
    text:rows.map(row=>row.text).join('\n'),primary:rows[0]?.text||'',secondary:rows.slice(1).map(row=>row.text).join('\n'),kind:domain,rank:selected?-1e12:-priority,
    selected:!!selected,icon:image?.id||'',iconScale:(flag?.height||12)/12,size:domain==='territorial'?13:12}});
  };
  for(const item of layout.territorialLabels||[]){const settings=labels.automaticLabelSettings('country',labels.labelSettings(state,'territorial',labels.getTerritorialLabelRef(item.id).id));
   add(item,'territorial',settings.pinned&&settings.manualPosition?settings.manualPosition:labels.countryLabelAnchors().get(String(item.id)),layout.territorialLabelNames.get(String(item.id))===false?[]:layout.territorialLabelRows.get(String(item.id))||[],layout.territorialFlags.get(String(item.id)));}
  for(const item of state.layerVisibility.labels?layout.userLabels||[]:[]){const settings=labels.automaticLabelSettings(item.kind,labels.labelSettings(state,'label',item.id));
   add(item,'label',settings.pinned&&settings.manualPosition?settings.manualPosition:item.coordinates,layout.userLabelRows.get(String(item.id))||[{text:item.name}]);}
  for(const entry of images.values())if(entry.ready&&!map.hasImage(entry.id))map.addImage(entry.id,entry.image,{pixelRatio:Math.max(.01,entry.image.height/12)});
  const next=JSON.stringify({features,palette});if(next===failedKey||(next===signature&&MAPLIBRE_LABEL_LAYERS.every(id=>map.getLayer(id))&&map.getSource(sourceId)===observedSource))return;
  signature=next;pending=true;const version=++sequence;
  const faces=map.getStyle()['font-faces']||{},url=new URL('assets/fonts/pretendard-v1.3.9/PretendardVariable.woff2',document.baseURI).href;
  if(faces[font]?.[0]?.url!==url)map.setFontFaces({...faces,[font]:[{url}]});
  if(!map.getSource(sourceId))map.addSource(sourceId,{type:'geojson',promoteId:'objectKey',data:{type:'FeatureCollection',features:[]}});
  if(map.getSource(sourceId)!==observedSource){observedSource?.off?.('error',observedError);sourceRows=null;observedSource=map.getSource(sourceId);const source=observedSource;observedError=event=>{if(map.getSource(sourceId)===source)sourceFailed(event);};source.on?.('error',observedError);}
  const placeFilter=['==',['get','kind'],'label'];
  if(!map.getLayer('viewer-label-dot'))map.addLayer({id:'viewer-label-dot',type:'circle',source:sourceId,minzoom:MAPLIBRE_LABEL_MIN_ZOOM.places,filter:placeFilter,layout:{visibility:'none'},paint:{'circle-radius':['case',['get','selected'],5,3],'circle-color':'#c23934','circle-stroke-color':'#ffffff','circle-stroke-width':1}});
  const textLayout={'text-field':['format',['get','primary'],{'font-scale':1},['case',['==',['get','secondary'],''],'',['concat','\n',['get','secondary']]],{'font-scale':.82}],'text-font':[font],'text-size':['get','size'],'text-variable-anchor':['left','right','top','bottom'],'text-radial-offset':.85,'text-letter-spacing':.015,'text-line-height':1.25,'text-justify':'auto','symbol-sort-key':['get','rank'],'text-max-width':12};
  for(const id of MAPLIBRE_LABEL_LAYERS.slice(1)){
   const country=id==='viewer-label-country';
   if(!map.getLayer(id))map.addLayer({id,type:'symbol',source:sourceId,minzoom:MAPLIBRE_LABEL_MIN_ZOOM[country?'country':'places'],
    filter:country?['==',['get','kind'],'territorial']:placeFilter,
    layout:{...textLayout,visibility:'none',...(country?{'icon-image':['get','icon'],'icon-size':['get','iconScale'],'icon-optional':true}:{})},
    paint:{'text-halo-width':1,'text-halo-blur':.35}});
   map.setPaintProperty(id,'text-color',['case',['boolean',['feature-state','selected'],false],palette.selection,palette.text]);
   map.setPaintProperty(id,'text-halo-color',palette.halo);
  }
  map.setPaintProperty('viewer-label-dot','circle-color',palette.marker==='outline'?'rgba(0,0,0,0)':palette.point);
  map.setPaintProperty('viewer-label-dot','circle-stroke-color',palette.marker==='outline'?palette.point:palette.halo);
  map.setPaintProperty('viewer-label-dot','circle-radius',['case',['get','selected'],5,palette.marker==='compact'?2.6:palette.marker==='outline'?4.5:4]);
  const source=map.getSource(sourceId),activeFlags=new Set([...layout.territorialFlags.values()].map(flag=>imageKey(flag?.url)));
  const current=()=>!disposed&&version===sequence&&map.getSource(sourceId)===source;
  tail=tail.catch(()=>{}).then(async()=>{
   if(!current())return;
   const previous=sourceRows;
   const rows=new Map(features.map(feature=>[feature.id,feature]));
   const remove=[],add=[],update=[];
   if(!previous)await source.setData({type:'FeatureCollection',features});
   else {
    for(const id of previous.keys())if(!rows.has(id))remove.push(id);
    for(const feature of features){
     const before=previous.get(feature.id);
     if(!before){add.push(feature);continue;}
     const pointChanged=feature.geometry.coordinates.some((value,index)=>value!==before.geometry.coordinates[index]);
     const properties=Object.entries(feature.properties)
      .filter(([key,value])=>value!==before.properties[key]).map(([key,value])=>({key,value}));
     if(pointChanged||properties.length)update.push({id:feature.id,
      ...(pointChanged?{newGeometry:feature.geometry}:{}),...(properties.length?{addOrUpdateProperties:properties}:{})});
    }
    if(remove.length||add.length||update.length)await source.updateData({remove,add,update});
   }
   if(disposed||map.getSource(sourceId)!==source)return;
   // The source has applied these rows even if a newer layout is queued.
   sourceRows=rows;
   for(const id of remove)map.removeFeatureState({source:sourceId,id});
   for(const feature of features){
    const before=previous?.get(feature.id);
    if(!before||before.properties.selected!==feature.properties.selected)
     map.setFeatureState({source:sourceId,id:feature.id},{selected:feature.properties.selected});
   }
   if(!current())return;
   for(const [url,entry]of images)if(!activeFlags.has(url)){images.delete(url);if(map.hasImage(entry.id))map.removeImage(entry.id);}
   pending=false;onChange();
  }).catch(error=>{if(current())sourceFailed(error);});
 }
 return {prepareFlags,renderTerritorialLabels:sync,retry(){failedKey='';},getStats:()=>({flagRequests,imageCount:images.size}),
  get pending(){return pending;},dispose(){disposed=true;sequence++;if(imageFrame!==null)globalThis.cancelAnimationFrame?.(imageFrame);decodedImages.clear();observedSource?.off?.('error',observedError);for(const id of MAPLIBRE_LABEL_LAYERS)if(renderer.map.getLayer(id))renderer.map.removeLayer(id);if(renderer.map.getSource(sourceId))renderer.map.removeSource(sourceId);for(const entry of images.values())if(renderer.map.hasImage(entry.id))renderer.map.removeImage(entry.id);images.clear();imageKeys.clear();}};
}
