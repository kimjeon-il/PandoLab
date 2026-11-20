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
 let version=0,disposed=false,pending=false,rows=[],dataKey='',tail=Promise.resolve(),sourceOwner=null;
 const layers=new Set(),definitions=new Map();
 function clear(){for(const layer of [...layers].reverse())if(map.getLayer(layer))map.removeLayer(layer);layers.clear();definitions.clear();}
 function update(next){const request=++version;pending=true;const task=tail.catch(()=>{}).then(()=>apply(next,request));tail=task;return task;}
 async function apply(next,request){
  if(disposed||request!==version)return;
  const nextKey=JSON.stringify(next.map(row=>[row.key,row.geometryRevision]));
  const needsData=!sharedSource&&(map.getSource(id)!==sourceOwner||nextKey!==dataKey);
  const features=[];
  for(const row of needsData?next:[]){
   const geometry=row.kind==='line'?clipMercatorLines(row.geometry):row.geometry;
   features.push({type:'Feature',id:row.key,geometry,properties:{key:row.key,objectKey:row.objectKey||''}});
  }
  if(disposed||request!==version)return;
  rows=next;
  if(!sharedSource){
   if(map.getSource(id)!==sourceOwner)dataKey='';
   if(!map.getSource(id)){map.addSource(id,{type:'geojson',data:{type:'FeatureCollection',features}});sourceOwner=map.getSource(id);dataKey=nextKey;}
   else if(nextKey!==dataKey){const source=map.getSource(id);sourceOwner=source;await source.setData({type:'FeatureCollection',features});if(map.getSource(id)===source)dataKey=nextKey;}
  }
  if(disposed||request!==version)return;
  const desired=new Map();
  rows.forEach((row,index)=>{
   const style=row.style||{},kind=row.kind==='line'?'line':row.kind==='point'?'circle':'fill';
   const layerId=index===rows.length-1?id:id+'-'+index;
   const filter=['==',['get',sharedSource?'objectKey':'key'],row.key],blend=row.blendMode||'normal';
   const layout=kind==='line'?{'line-cap':style.cap==='butt'?'butt':'round','line-join':style.join||'round'}:{};
   const paint=kind==='fill'?{'fill-color':style.color,'fill-opacity':style.fillAlpha??1,'fill-layer-blend':blend,'fill-antialias':true}:kind==='circle'?{'circle-color':style.color,'circle-opacity':style.alpha??1,'circle-radius':5}:{'line-color':style.color,'line-opacity':style.alpha??1,'line-width':style.width??1,'line-layer-blend':blend};
   if(kind==='line'&&style.dash?.some(value=>value>0))paint['line-dasharray']=style.dash.map(value=>value/Math.max(.01,style.width||1));
   const add=(key,value)=>desired.set(key,{id:key,type:kind,source:(typeof sharedSource==='function'?sharedSource():sharedSource)||id,filter,layout,paint:value});
   if(kind==='line'&&style.casing?.width>0)add(layerId+'-casing',{...paint,'line-color':style.casing.color,'line-opacity':style.casing.alpha??1,'line-width':(style.width||1)+2*style.casing.width});
   add(layerId,paint);
  });
  for(const key of layers)if(!desired.has(key)){if(map.getLayer(key))map.removeLayer(key);definitions.delete(key);layers.delete(key);}
  for(const [key,spec]of desired){
   const previous=definitions.get(key);
   if(map.getLayer(key)&&(!previous||previous.type!==spec.type||previous.source!==spec.source))map.removeLayer(key);
   if(!map.getLayer(key))map.addLayer(spec,before&&map.getLayer(before)?before:undefined);
   else {
    for(const [section,setter]of [['paint','setPaintProperty'],['layout','setLayoutProperty']])for(const property of new Set([...Object.keys(previous[section]),...Object.keys(spec[section])]))
     if(JSON.stringify(previous[section][property])!==JSON.stringify(spec[section][property]))map[setter](key,property,spec[section][property]??null);
    if(JSON.stringify(previous.filter)!==JSON.stringify(spec.filter))map.setFilter(key,spec.filter);
   }
   definitions.set(key,spec);layers.add(key);
  }
  layers.clear();for(const key of desired.keys())layers.add(key);
  pending=false;onChange();
 }
 return {update,move(before){for(const layer of layers)if(map.getLayer(layer))map.moveLayer(layer,before);},get pending(){return pending;},
  dispose(){disposed=true;version++;clear();if(!sharedSource&&map.getSource(id))map.removeSource(id);}};
}
