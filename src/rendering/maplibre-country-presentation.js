import {createTerritorialFillResolver} from './territorial-fill-style.js';
import {normalizeObjectRef} from '../document/object-ref-identity.js';
import {layerObjectRank,layerStyle} from '../ui/layer-presentation.js';
import {admittedGeometryKey as geometryKey} from '../geometry/geometry-version-store.js';
import {changedRenderProperties} from './render-identity.js';
export function prepareCountryPresentation(features,{state,entityRepository,style,layerPresentation,previousRows=null,fillCache=null}){
  if(state.layerVisibility.objects===false)return {presented:[],nextBatches:[],key:[]};
  const resolve=createTerritorialFillResolver({state,entityRepository,resolveStoredColors:true,previousResults:fillCache});
  const nextBatches=[],ordered=[],key=[],border=style.countryStroke;
  for(const feature of features){
   const id=String(feature.id);
   if(!layerPresentation.isLayerItemVisible('objects',id))continue;
   const ref=normalizeObjectRef({domain:'territorial',type:'entity',id});
   ordered.push({feature,fill:resolve(feature),ref,rank:layerObjectRank(state.layerPresentation,ref.key)});
  }
  ordered.sort((a,b)=>a.fill.depth-b.fill.depth||a.rank-b.rank||a.ref.key.localeCompare(b.ref.key));
  const presented=ordered.map(({feature,fill,ref},paintOrder)=>{
   const objectStyle=layerStyle(state.layerPresentation,'objects',ref.key);
   // Object color and opacity belong to territorial presentation, not the base.
   const effectiveAlpha=fill.fillAlpha;
   const blendMode=effectiveAlpha>0?fill.blendMode:'normal';
   let batch=nextBatches.at(-1);
   if(!batch||batch.blendMode!==blendMode){batch={index:nextBatches.length,blendMode,ids:[]};nextBatches.push(batch);}
   batch.ids.push(ref.key);
   const properties={objectKey:ref.key,displayRole:'country-fill',color:fill.color||null,displayAlpha:fill.fillAlpha,alpha:blendMode==='multiply'?0:fill.fillAlpha,blendMode,paintOrder,paintBatch:batch.index,borderColor:border.color,borderAlpha:objectStyle.boundaryVisible?style.borderAlpha:0,borderWidth:border.width||0.6};
   const prior=previousRows?.get(ref.key);
   const row=prior&&prior.geometry===feature.geometry&&!changedRenderProperties(prior.properties,properties).length
    ?prior:{type:'Feature',geometry:feature.geometry,id:ref.key,properties};
   key.push([row.id,geometryKey(row.geometry),row.properties]);
   return row;
  });
  return {presented,nextBatches,key};
}
export function countryPaintOnly(active,presented,changed){
 if(active?.rows?.size!==presented.length)return false;
 for(const row of presented){
  const {id,geometry,properties}=row,old=active.rows.get(id);
  if(old===row)continue;
  if(!old||(old.geometry!==geometry&&geometryKey(old.geometry)!==geometryKey(geometry))
   ||Object.keys(properties).some(name=>name!=='color'&&old.properties[name]!==properties[name]))return false;
  if(old.properties.color!==properties.color)changed?.push(id);
 }
 return true;
}
export function countryTileDiff(previousTileRows,tileFeatures){
 const next=new Map(tileFeatures.map(feature=>[feature.id,feature]));
 const remove=[],add=[],update=[];
 for(const id of previousTileRows.keys())if(!next.has(id))remove.push(id);
 for(const [id,feature]of next){const previous=previousTileRows.get(id);if(!previous){add.push(feature);continue;}if(previous===feature)continue;
  const geometryChanged=previous.geometry!==feature.geometry&&geometryKey(previous.geometry)!==geometryKey(feature.geometry);
  const properties=changedRenderProperties(previous.properties,feature.properties);
  if(geometryChanged||properties.length)update.push({id,...(geometryChanged?{newGeometry:feature.geometry}:{}),...(properties.length?{addOrUpdateProperties:properties}:{})});
 }
 return {next,remove,add,update};
}
