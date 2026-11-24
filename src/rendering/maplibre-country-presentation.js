import {createTerritorialFillResolver} from './territorial-fill-style.js';
import {normalizeObjectRef} from '../document/object-ref-identity.js';
import {layerObjectRank,layerStyle} from '../ui/layer-presentation.js';
import {admittedGeometryKey as geometryKey} from '../geometry/geometry-version-store.js';
export function prepareCountryPresentation(features,{state,entityRepository,style,layerPresentation}){
  const resolvedStyle=style;
  const resolve=createTerritorialFillResolver({state,entityRepository,resolveStoredColors:true});
  const nextBatches=[];
  const ordered=features.filter(feature=>state.layerVisibility.objects!==false&&layerPresentation.isLayerItemVisible('objects',String(feature.id))).map(feature=>({feature,fill:resolve(feature),ref:normalizeObjectRef({domain:'territorial',type:'entity',id:String(feature.id)})}));
  ordered.sort((a,b)=>a.fill.depth-b.fill.depth||layerObjectRank(state.layerPresentation,a.ref.key)-layerObjectRank(state.layerPresentation,b.ref.key)||a.ref.key.localeCompare(b.ref.key));
  const presented=ordered.map(({feature,fill,ref},paintOrder)=>{

   const border=resolvedStyle.countryStroke,style=layerStyle(state.layerPresentation,'objects',ref.key);
   // Object color and opacity belong to territorial presentation, not the base.
   const effectiveAlpha=fill.fillAlpha;
   const blendMode=effectiveAlpha>0?fill.blendMode:'normal';
   let batch=nextBatches.at(-1);
   if(!batch||batch.blendMode!==blendMode){batch={index:nextBatches.length,blendMode,ids:[]};nextBatches.push(batch);}
   batch.ids.push(ref.key);
   return {type:'Feature',geometry:feature.geometry,id:ref.key,properties:{objectKey:ref.key,displayRole:'country-fill',color:fill.color||null,displayAlpha:fill.fillAlpha,alpha:blendMode==='multiply'?0:fill.fillAlpha,blendMode,paintOrder,paintBatch:batch.index,borderColor:border.color,borderAlpha:style.boundaryVisible?resolvedStyle.borderAlpha:0,borderWidth:border.width||0.6}};
  });
  const key=presented.map(feature=>[feature.id,geometryKey(feature.geometry),feature.properties]);

 return {presented,nextBatches,key};
}
export function countryPaintOnly(active,presented){
 return active?.rows?.size===presented.length&&presented.every(({id,geometry,properties})=>{
  const old=active.rows.get(id);
  return old&&geometryKey(old.geometry)===geometryKey(geometry)
   &&Object.entries(properties).every(([name,value])=>name==='color'||old.properties[name]===value);
 });
}
export function countryTileDiff(previousTileRows,tileFeatures){
 const next=new Map(tileFeatures.map(feature=>[feature.id,feature]));
 const remove=[...previousTileRows.keys()].filter(id=>!next.has(id)),add=[],update=[];
 for(const [id,feature]of next){const previous=previousTileRows.get(id);if(!previous){add.push(feature);continue;}
  const geometryChanged=previous.geometry!==feature.geometry&&geometryKey(previous.geometry)!==geometryKey(feature.geometry);
  const properties=Object.entries(feature.properties).filter(([name,value])=>previous.properties[name]!==value).map(([key,value])=>({key,value}));
  if(geometryChanged||properties.length)update.push({id,...(geometryChanged?{newGeometry:feature.geometry}:{}),...(properties.length?{addOrUpdateProperties:properties}:{})});
 }
 return {next,remove,add,update};
}
