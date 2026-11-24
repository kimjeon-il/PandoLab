import {mapLibreGeoJsonSource,mapLibreVectorSourceKind} from './maplibre-source-spec.js';
import {clipMercatorLines} from './maplibre-polar-layer.js';
// Standard MapLibre sources/layers own drawing and context restoration.
export function geographicStrokeChains(values){
 const lines=[],nodes=new Map(),edges=[];
 const node=point=>{const key=point.map(value=>Math.round(value*1e9)).join(',');if(!nodes.has(key))nodes.set(key,{point,edges:[]});return nodes.get(key);};
 for(let offset=0;offset+3<values.length;offset+=4){const start=[values[offset],values[offset+1]],end=[values[offset+2],values[offset+3]];
  if(![...start,...end].every(Number.isFinite))continue;
  const a=node(start),b=node(end);if(a===b)continue;
  const edge={a,b,used:false};edges.push(edge);a.edges.push(edge);b.edges.push(edge);
 }
 const walk=(start,edge)=>{const line=[start.point];let current=start;while(edge&&!edge.used){edge.used=true;current=edge.a===current?edge.b:edge.a;line.push(current.point);if(current.edges.length!==2)break;edge=current.edges.find(value=>!value.used);}if(line.length>1)lines.push(line);};
 for(const start of nodes.values())if(start.edges.length!==2)for(const edge of start.edges)if(!edge.used)walk(start,edge);
 for(const edge of edges)if(!edge.used)walk(edge.a,edge);
 return {type:'MultiLineString',coordinates:lines};
}
export function createMapLibreVectorGroup(map,{id,before,onChange,sharedSource}){
 let version=0,disposed=false,pending=false,tail=Promise.resolve(),sourceOwner=null,sourceRows=null;
 const noLayers=Object.freeze([]),definitions=new Map();
 let layerIds=noLayers;
 function clear(){for(const layer of [...layerIds].reverse())if(map.getLayer(layer))map.removeLayer(layer);layerIds=noLayers;definitions.clear();}
 function update(next){const request=++version;pending=true;const task=tail.catch(()=>{}).then(()=>apply(next,request));tail=task;return task;}
 const clippedLines=new WeakMap();
 const nativeGeometry=row=>{
  if(row.kind!=='line')return row.geometry;
  const cached=clippedLines.get(row.geometry);
  if(cached?.revision===row.geometryRevision)return cached.geometry;
  const geometry=clipMercatorLines(row.geometry);clippedLines.set(row.geometry,{revision:row.geometryRevision,geometry});return geometry;
 };
 const feature=row=>({type:'Feature',id:row.key,geometry:nativeGeometry(row),properties:{key:row.key,objectKey:row.objectKey||''}});
 async function apply(next,request){
  if(disposed||request!==version)return;
  if(!sharedSource){
   let source=map.getSource(id);
   const rows=new Map(next.map(row=>[row.key,row]));
   if(!source||source!==sourceOwner){
    const data={type:'FeatureCollection',features:next.map(feature)};
    if(source)await source.setData(data);
    else{map.addSource(id,mapLibreGeoJsonSource(mapLibreVectorSourceKind(next),data));source=map.getSource(id);}
   }else{
    const add=[],update=[],remove=[...sourceRows.keys()].filter(key=>!rows.has(key));
    for(const row of next){
     const before=sourceRows.get(row.key);
     if(!before){add.push(feature(row));continue;}
     const moved=before.geometryRevision!==row.geometryRevision;
     const refChanged=before.objectKey!==row.objectKey;
     if(moved||refChanged)update.push({id:row.key,
      ...(moved?{newGeometry:nativeGeometry(row)}:{}),
      ...(refChanged?{addOrUpdateProperties:[{key:'objectKey',value:row.objectKey||''}]}:{})});
    }
    if(add.length||update.length||remove.length)await source.updateData({add,update,remove});
   }
   if(map.getSource(id)===source){sourceOwner=source;sourceRows=rows;}
  }
  if(disposed||request!==version)return;
  const desired=new Map();
  next.forEach((row,index)=>{
   const style=row.style||{},kind=row.kind==='line'?'line':row.kind==='point'?'circle':'fill';
   const layerId=index===next.length-1?id:id+'-'+index;
   const filter=['==',['get',sharedSource?'objectKey':'key'],row.key],blend=row.blendMode||'normal';
   const layout=kind==='line'?{'line-cap':style.cap==='butt'?'butt':'round','line-join':style.join||'round'}:{};
   const paint=kind==='fill'?{'fill-color':style.color,'fill-opacity':style.fillAlpha??1,'fill-layer-blend':blend,'fill-antialias':true}:kind==='circle'?{'circle-color':style.color,'circle-opacity':style.alpha??1,'circle-radius':5}:{'line-color':style.color,'line-opacity':style.alpha??1,'line-width':style.width??1,'line-layer-blend':blend};
   if(kind==='line'&&style.dash?.some(value=>value>0))paint['line-dasharray']=style.dash.map(value=>value/Math.max(.01,style.width||1));
   const add=(key,value)=>desired.set(key,{id:key,type:kind,source:(typeof sharedSource==='function'?sharedSource():sharedSource)||id,filter,layout,paint:value});
   if(kind==='line'&&style.casing?.width>0)add(layerId+'-casing',{...paint,'line-color':style.casing.color,'line-opacity':style.casing.alpha??1,'line-width':(style.width||1)+2*style.casing.width});
   add(layerId,paint);
  });
  const nextLayerIds=[...desired.keys()];
  const orderChanged=nextLayerIds.length!==layerIds.length||nextLayerIds.some((key,index)=>key!==layerIds[index]);
  let structureChanged=orderChanged;
  for(const key of layerIds)if(!desired.has(key)){if(map.getLayer(key))map.removeLayer(key);definitions.delete(key);}
  for(const [key,spec]of desired){
   const previous=definitions.get(key);
   if(map.getLayer(key)&&(!previous||previous.type!==spec.type||previous.source!==spec.source))map.removeLayer(key);
   if(!map.getLayer(key)){map.addLayer(spec,before&&map.getLayer(before)?before:undefined);structureChanged=true;}
   else {
    for(const [section,setter]of [['paint','setPaintProperty'],['layout','setLayoutProperty']])for(const property of new Set([...Object.keys(previous[section]),...Object.keys(spec[section])]))
     if(JSON.stringify(previous[section][property])!==JSON.stringify(spec[section][property]))map[setter](key,property,spec[section][property]??null);
    if(JSON.stringify(previous.filter)!==JSON.stringify(spec.filter))map.setFilter(key,spec.filter);
   }
   definitions.set(key,spec);
  }
  if(orderChanged)layerIds=Object.freeze(nextLayerIds);
  pending=false;onChange({structureChanged});
 }
 return {update,getLayerIds:()=>layerIds,get pending(){return pending;},
  dispose(){disposed=true;version++;clear();if(!sharedSource&&map.getSource(id))map.removeSource(id);}};
}
