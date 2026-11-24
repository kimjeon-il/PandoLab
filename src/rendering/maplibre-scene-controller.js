import {mapLibreGeoJsonSource} from './maplibre-source-spec.js';
import {buildRenderableBoundarySegments} from '../geometry/geographic-boundary.js';
import {connectBoundarySegments} from '../geometry/boundary-lines.js';
import {admittedGeometryKey as geometryKey} from '../geometry/geometry-version-store.js';
import {layerStyle} from '../ui/layer-presentation.js';
import {MAPLIBRE_LABEL_LAYERS} from './maplibre-label-presentation.js';
import {createMapLibreVectorGroup} from './maplibre-vector-group.js';
import {resolveMapLibreMapStyle} from './maplibre-map-style.js';
import {syncMapLibreBaseLayer} from './maplibre-base-layer.js';
import {createMapLibreStyleController} from './maplibre-style-controller.js';
import {sameRenderIdentity} from './render-identity.js';
import {isPreparedSceneDomain} from './map-scene.js';
import {isWithinDisplayZoom} from '../map/map-display-zoom.js';
const collection=features=>({type:'FeatureCollection',features});
const countryFillFilter=batch=>['all',['==',['get','displayRole'],'country-fill'],['==',['get','paintBatch'],batch],['==',['get','blendMode'],'normal']];
const layerVisibleAtZoom=(layer,zoom)=>layer.visible&&isWithinDisplayZoom(zoom,layer.minzoom,layer.maxzoom);
/** Owns MapLibre scene source/layer order, vector groups, and style changes. */
export function createMapLibreSceneController({getMap,isLoaded,isStyleReady,isDisposed,isTemporalOverlay,
 isInitialMapLoading,getPolarLayer,getHighlight,isPhysicalPending,getPhysicalGeometry,getExternalBasemap,
 getSelectionSnapshot,setSelection,invalidatePickingLayers,preferences,state,datedSources,sourceWrites,
 sourceLayer,sourceGroups,dirty,invalidate,failMapPreparation,feedback}){
 let sceneKey=0,sceneIdentity=null,sceneStyle=null,vectorRevision=0,interactionStyle=null,pendingSceneDomains=null,pendingInteractionStyle=null,sceneVectors=[],sceneOrder=[];
 const dynamicLayers=new Set(),dynamicSources=new Set(),sceneGroups=new Map(),vectorLayers=new Map(),strokeDomains=new Map(),strokeGroupCache=new Map();
 const countryFillGroups=new Map(),countryPaintState=new WeakMap();
 let sourceLayers=[],indexedStyle=null,requiredLayerCache=null,styleController=null;
 const getStyle=()=>resolveMapLibreMapStyle({palette:preferences.mapPalette(),
  antiAlias:interactionStyle?.antiAlias!==false,layerVisibility:state.layerVisibility});
 const preparedDomainRows=new WeakMap();
 const identityFor=rows=>rows.map(row=>[row.key,row.objectKey,row.geometryRevision??geometryKey(row.geometry),row.order,row.role,row.kind,row.blendMode,JSON.stringify(row.style)]);
 const colorsEnabled=()=>layerStyle(state.layerPresentation,'objects').colorVisible;
 function invalidateLayerIndex(){indexedStyle=null;requiredLayerCache=null;invalidatePickingLayers();}
 function attachMap(){styleController=createMapLibreStyleController(getMap());invalidateLayerIndex();}
 function applyStyle(style,options){styleController?.apply(style,options);}
 function syncLabelVisibility(loading){return !!styleController?.syncLabelVisibility(loading);}
 function syncLoadingSurface(style,enabled,before){styleController?.syncLoadingSurface(style,enabled,before);}
 function strokeDomain(name,features,styleFor,order){
  const groups=new Map();
  for(const feature of features){
   const style=styleFor(feature),geometry=feature.geometry;
   if(!(style.width>0)||!(style.alpha>0)||!['Polygon','MultiPolygon','LineString','MultiLineString'].includes(geometry.type))continue;
   const key=JSON.stringify(style);
   if(!groups.has(key))groups.set(key,{style,geometries:[],revisions:[]});
   const group=groups.get(key);group.geometries.push(geometry);group.revisions.push(geometryKey(geometry));
  }
  const previous=strokeGroupCache.get(name)||new Map(),next=new Map();
  let changed=previous.size!==groups.size;
  const lines=geometry=>geometry.type==='LineString'?[geometry.coordinates]:geometry.type==='MultiLineString'
   ?geometry.coordinates:connectBoundarySegments(buildRenderableBoundarySegments(geometry));
  for(const [key,group]of groups){
   const old=previous.get(key);
   if(old&&old.order===order&&sameRenderIdentity(old.revisions,group.revisions)){next.set(key,old);continue;}
   changed=true;
   next.set(key,{order,revisions:group.revisions,row:{key:name+key,kind:'line',order,
    role:name==='edited-water-strokes'?'project-hydro':undefined,
    geometryRevision:'stroke:'+ ++vectorRevision,geometry:{type:'MultiLineString',coordinates:group.geometries.flatMap(lines)},
    style:group.style,blendMode:'normal'}});
  }
  if(!changed&&sameRenderIdentity([...previous.keys()],[...next.keys()]))return;
  strokeGroupCache.set(name,next);strokeDomains.set(name,[...next.values()].map(group=>group.row));
  syncVectorGroups();
 }

 const requiredSource=id=>[datedSources.active('territories'),datedSources.active('physical-land'),datedSources.active('physical-water'),'hydro-edits','viewer-labels'].includes(id)
  ||dynamicSources.has(id)||(vectorLayers.has(id)&&vectorLayers.get(id).role!=='hydro-detail');
 function mapSourceLayers(){
  const map=getMap();
  if(indexedStyle!==map.style){
   indexedStyle=map.style;
   sourceLayers=map.getLayersOrder().flatMap(id=>{
    const layer=map.getLayer(id);
    return layer?.source?[{id,source:layer.source,visible:map.getLayoutProperty(id,'visibility')!=='none',
     minzoom:layer.minzoom??-Infinity,maxzoom:layer.maxzoom??Infinity}]:[];
   });
   requiredLayerCache=null;invalidatePickingLayers();
  }
  return sourceLayers;
 }
 function requiredSourcesReady(){
  const map=getMap();
  if(!map?.style)return false;
  if(isPhysicalPending('physical-land')||isPhysicalPending('physical-water'))return false;
  for(const [kind,ids] of Object.entries(sourceGroups)){
   const source=datedSources.active(kind);
   if(!map.getSource(source)||ids.some(id=>!map.getLayer(sourceLayer(id,source))))return false;
  }
  const zoom=map.getZoom(),layers=mapSourceLayers();
  if(!requiredLayerCache||zoom<requiredLayerCache.min||zoom>=requiredLayerCache.max){
   let min=-Infinity,max=Infinity;
   const sources=new Set();
   for(const layer of layers){
    if(!layer.visible||!requiredSource(layer.source))continue;
    for(const cutoff of [layer.minzoom,layer.maxzoom]){
     if(cutoff<=zoom)min=Math.max(min,cutoff);else max=Math.min(max,cutoff);
    }
    if(layerVisibleAtZoom(layer,zoom))sources.add(layer.source);
   }
   requiredLayerCache={min,max,sources};
  }
  for(const source of requiredLayerCache.sources){
   if(!map.getSource(source)){indexedStyle=null;return false;}
   if(!map.isSourceLoaded(source))return false;
  }
  return true;
 }

 function syncVectorGroups(){
  if(!isLoaded())return;
  const map=getMap();
  const groups=new Map();
  for(const row of [...sceneVectors,...[...strokeDomains.values()].flat()].sort((a,b)=>a.order-b.order)){
   const kind=row.kind||'fill',id=row.role==='graticule'?'map-graticule':'vector-'+kind+'-'+row.order+'-'+(row.role==='territorial-fill'?'territorial':row.role==='hydro-detail'?'hydro-detail':'independent');
   if(!groups.has(id))groups.set(id,[]);groups.get(id).push({...row,style:kind==='line'?{...row.style,antiAlias:interactionStyle?.antiAlias??row.style?.antiAlias??true}:row.style,geometryRevision:kind+':'+(row.geometryRevision??geometryKey(row.geometry))});
  }
  for(const [id,entry]of vectorLayers)if(!groups.has(id)){entry.layer.dispose();vectorLayers.delete(id);indexedStyle=null;}
  for(const [id,originalItems]of groups){
   let entry=vectorLayers.get(id),items=originalItems;
   const previousBatches=entry?.batches??new Map(),nextBatches=new Map();
   if(items[0]?.kind==='line'&&items.length>1){
    const batches=new Map();
    for(const row of items){
     const merge=!row.objectKey&&(row.style?.alpha??1)===1&&(!row.style?.casing||(row.style.casing.alpha??1)===1);
     const key=JSON.stringify([row.blendMode,row.style,merge?'':row.key]);
     if(!batches.has(key))batches.set(key,[]);batches.get(key).push(row);
    }
    items=[...batches].map(([key,rows])=>{
     if(rows.length===1)return rows[0];
     const identity=identityFor(rows),previous=previousBatches.get(key);
     if(previous&&sameRenderIdentity(previous.identity,identity)){nextBatches.set(key,previous);return previous.row;}
     const row={...rows[0],key:JSON.stringify(['merged-stroke',key]),geometryRevision:'merged:'+ ++vectorRevision,
      geometry:{type:'MultiLineString',coordinates:rows.flatMap(r=>r.geometry.type==='MultiLineString'?r.geometry.coordinates:[r.geometry.coordinates])}};
     nextBatches.set(key,{identity,row});return row;
    });
   }
   const signature=identityFor(items);
   if(!entry){
    const layer=createMapLibreVectorGroup(map,{id,sharedSource:items[0].role==='territorial-fill'?()=>datedSources.active('territories'):undefined,before:items[0].role==='territorial-fill'?'physical-water':map.getLayer('interaction-fill')?'interaction-fill':undefined,
     onChange:({structureChanged})=>{if(!isDisposed()){if(structureChanged){indexedStyle=null;orderSceneLayers();}if(items[0].role!=='hydro-detail')dirty();invalidate('vector-ready');}}});
    entry={layer,signature:null,order:items[0].order,role:items[0].role};vectorLayers.set(id,entry);
   }
   else if(!map.getLayer(id))entry.signature=null;
   entry.batches=nextBatches;
   const boundSource=items[0].role==='territorial-fill'?datedSources.active('territories'):id;
   if(entry.boundSource!==boundSource||!sameRenderIdentity(entry.signature,signature)){
    entry.boundSource=boundSource;entry.signature=signature;
    entry.layer.update(items).catch(cause=>{
     if(isDisposed()||vectorLayers.get(id)!==entry||entry.signature!==signature)return;
     entry.signature=null;sceneIdentity=null;sceneKey++;
     if(entry.role==='hydro-detail')feedback.reportOperationError(cause,'강 상세 표시를 준비하지 못했습니다.','PL-HYDRO-DETAIL-002');
     else failMapPreparation(cause);
    });
   }
  }
 }
 function moveInOrder(order,id,before){
  const from=order.indexOf(id);
  if(from<0||id===before||order[from+1]===before)return false;
  order.splice(from,1);
  const to=before===undefined?order.length:order.indexOf(before);
  order.splice(to<0?order.length:to,0,id);
  return true;
 }
 function orderSceneLayers(){
  const map=getMap();
  const order=map.getLayersOrder(),desired=order.slice(),managed=new Set();
  const place=(id,before)=>{if(id&&map.getLayer(id)){managed.add(id);moveInOrder(desired,id,before);}};
  const water=sourceLayer('physical-water',datedSources.active('physical-water'));
  const country=sourceLayer('territories',datedSources.active('territories'));
  const ordered=[...sceneOrder,{id:sourceLayer('borders',datedSources.active('territories')),order:100},
   ...[...vectorLayers].map(([id,entry])=>({id,order:entry.order,role:entry.role}))];
  for(const row of ordered.sort((a,b)=>a.order-b.order)){
   if(row.role==='graticule')continue;
   const before=row.role==='territorial-fill'?water:row.order<0?country:undefined;
   for(const id of vectorLayers.get(row.id)?.layer.getLayerIds()||[row.id])place(id,before);
  }
  let before=water;
  for(const {id} of [...(countryFillGroups.get(datedSources.active('territories'))||[])].reverse())
   if(map.getLayer(id)){place(id,before);before=id;}
  for(const id of ['map-graticule',...(getHighlight()?.ids()||[]),...MAPLIBRE_LABEL_LAYERS,'initial-map-ocean','initial-map-land'])place(id);
  place(getPolarLayer()?.id,!isInitialMapLoading()&&map.getLayer('viewer-label-dot')?'viewer-label-dot':undefined);
  let moved=false;
  for(let index=desired.length-1;index>=0;index--){
   const id=desired[index],next=desired[index+1];
   if(managed.has(id)&&moveInOrder(order,id,next)){map.moveLayer(id,next);moved=true;}
  }
  if(moved)indexedStyle=null;
 }
 function syncTerritorialFills(source,batches){
  const map=getMap();
  const base=sourceLayer('territories',source),paint=getStyle().territorialFillPaint;
  const suffix=base.slice('territories'.length);
  const next=batches.flatMap(({index,blendMode,ids})=>blendMode==='normal'
   ?[{id:index===0?base:'territories-fill-'+index+suffix,multiply:false,filter:countryFillFilter(index)}]
   :ids.map(id=>({id:'territories-multiply-'+id+suffix,multiply:true,filter:['==',['get','objectKey'],id]})));
  const wanted=new Set(next.map(group=>group.id));
  for(const {id} of countryFillGroups.get(source)||[])if(id!==base&&!wanted.has(id)&&map.getLayer(id)){map.removeLayer(id);indexedStyle=null;}
  for(const {id,multiply,filter} of next)if(!map.getLayer(id)){
   map.addLayer({id,type:'fill',source,filter,layout:{'fill-sort-key':['get','paintOrder'],visibility:'visible'},paint:{...paint,
    'fill-layer-blend':multiply&&colorsEnabled()?'multiply':'normal',
    'fill-layer-opacity':source===datedSources.active('territories')?1:0,'fill-layer-opacity-transition':{duration:0}}},sourceLayer('physical-water',datedSources.active('physical-water')));
   indexedStyle=null;
  }
  countryFillGroups.set(source,next);
 }
 function syncCountryPaint(id,rows){
  const map=getMap();
  const source=map.getSource(id),neutral=!colorsEnabled();
  const previous=countryPaintState.get(source);
  if(previous?.neutral===neutral&&previous.rows===rows)return;
  for(const key of previous?.rows.keys()||[])if(!rows.has(key))map.removeFeatureState({source:id,id:key});
  for(const [key,row] of rows)if(previous?.neutral!==neutral||previous.rows.get(key)?.properties.color!==row.properties.color)
   map.setFeatureState({source:id,id:key},{neutral,countryColor:row.properties.color});
  for(const group of countryFillGroups.get(id)||[])if(group.multiply&&map.getLayer(group.id))
   map.setPaintProperty(group.id,'fill-layer-blend',neutral?'normal':'multiply');
  countryPaintState.set(source,{rows,neutral});
 }
 function syncBaseLayer(){
  if(!isLoaded())return false;
  const map=getMap(),style=getStyle();
  const changed=syncMapLibreBaseLayer(map,{style,landGeometry:getPhysicalGeometry()});
  styleController?.apply(style,{updateVisibility:!isTemporalOverlay()});
  if(changed)getExternalBasemap()?.reposition();
  return changed;
 }

 function setSceneDomains(domains){
  if(!isLoaded())return;
  if(!isStyleReady()){pendingSceneDomains=domains;return;}
  const map=getMap();
  // Domain snapshots are immutable and reused by the upstream scene owner.
  // Prepare the per-object identities only for changed domains, not on each
  // camera/style refresh. Raw callers still get value-based comparisons.
  const prepared=[];
  for(const [name,value]of domains){
   if(name==='physical-land'||name==='physical-water')continue;
   let entry=preparedDomainRows.get(value);
   if(!entry){
    const rows=[...value.polygons.map(item=>({...item,kind:'fill'})),...value.strokes.map(item=>({...item,kind:'line'}))];
    entry={rows,identity:identityFor(rows)};
    if(isPreparedSceneDomain(value))preparedDomainRows.set(value,entry);
   }
   prepared.push([name,entry]);
  }
  const identity=prepared.map(([name,entry])=>[name,entry.identity]);
  if(sceneStyle===map.style&&sameRenderIdentity(sceneIdentity,identity))return;
  sceneIdentity=identity;sceneStyle=map.style;sceneKey++;
  const rows=prepared.flatMap(([,entry])=>entry.rows);
  const native=row=>row.kind==='line'||row.blendMode==='multiply'||row.style?.blendMode==='multiply';
  sceneVectors=rows.filter(native).filter(row=>row.kind==='fill'?(row.style?.fillAlpha??1)>0:(row.style?.alpha??1)>0).map(row=>['Point','MultiPoint'].includes(row.geometry?.type)?{...row,kind:'point'}:row);
  const groups=new Map();
  rows.filter(row=>!native(row)).sort((a,b)=>a.order-b.order).forEach(row=>{const kind=['Point','MultiPoint'].includes(row.geometry?.type)?'circle':row.kind,band=row.role==='territorial-fill'?'territorial':row.order<0?'base':'independent';const id='scene-'+kind+'-'+row.order+'-'+band;if(!groups.has(id))groups.set(id,[]);groups.get(id).push({...row,kind});});
  for(const id of dynamicLayers)if(!groups.has(id)){map.removeLayer(id);map.removeSource(id);dynamicLayers.delete(id);dynamicSources.delete(id);sceneGroups.delete(id);indexedStyle=null;}
  for(const [id,items]of groups){
   const signature=identityFor(items);
   const currentSource=map.getSource(id),previous=sceneGroups.get(id);
   if(previous&&previous.source===currentSource&&sameRenderIdentity(previous.signature,signature))continue;
   const next=new Map(items.filter(item=>item.geometry).map(item=>[item.key,{revision:item.geometryRevision,
    feature:{type:'Feature',id:item.key,geometry:item.geometry,properties:{objectKey:item.objectKey||'',color:item.style?.color||'#ffffff',alpha:item.style?.fillAlpha??item.style?.alpha??1}}}]));
   if(!next.size)continue;
   const data=()=>collection(Array.from(next.values(),row=>row.feature));
   if(currentSource){
    const group=previous?.source===currentSource?previous:{source:currentSource,rows:null};
    group.signature=signature;sceneGroups.set(id,group);
    sourceWrites.update(async source=>{
     const before=group.rows;
     if(!before)await source.setData(data());
     else{
      const remove=[...before.keys()].filter(key=>!next.has(key)),add=[],update=[];
      for(const [key,{feature,revision}] of next){
       const old=before.get(key);
       if(!old){add.push(feature);continue;}
       const newGeometry=old.revision!==revision||revision==null&&old.feature.geometry!==feature.geometry?feature.geometry:null;
       const properties=Object.entries(feature.properties).filter(([name,value])=>old.feature.properties[name]!==value)
        .map(([key,value])=>({key,value}));
       if(newGeometry||properties.length)update.push({id:key,...(newGeometry?{newGeometry}:{}),
        ...(properties.length?{addOrUpdateProperties:properties}:{})});
      }
      if(add.length||remove.length||update.length)await source.updateData({add,remove,update});
     }
    },id,()=>sceneGroups.get(id)===group&&group.signature===signature)
     .then(applied=>{
      if(applied){group.rows=next;return;}
      if(sceneGroups.get(id)===group&&group.signature===signature){group.signature=null;sceneIdentity=null;sceneKey++;}
     },()=>{
      if(sceneGroups.get(id)!==group)return;
      group.rows=null;
      if(group.signature===signature){group.signature=null;sceneIdentity=null;sceneKey++;}
     });
   }
   else{
    map.addSource(id,mapLibreGeoJsonSource('overlay',data()));dynamicSources.add(id);indexedStyle=null;
    sceneGroups.set(id,{source:map.getSource(id),rows:next,signature});
    const kind=items[0].kind;
    const paint=kind==='fill'?{'fill-color':['get','color'],'fill-opacity':['get','alpha']}:{'circle-color':['get','color'],'circle-radius':5,'circle-opacity':['get','alpha']};
    const before=items[0].role==='territorial-fill'?'physical-water':items[0].order<0?'territories':undefined;
    map.addLayer({id,type:kind,source:id,paint},before);dynamicLayers.add(id);
   }
  }
  syncVectorGroups();
  sceneOrder=[...groups].map(([id,items])=>({id,order:items[0].order,role:items[0].role}));orderSceneLayers();
  dirty();
 }

 function setInteractionStyle(value){if(isLoaded()&&!isStyleReady()){pendingInteractionStyle=value;return;}const changed=interactionStyle?.antiAlias!==value.antiAlias;interactionStyle=value;
  if(changed&&isLoaded()){styleController?.apply(getStyle(),{updateVisibility:!isTemporalOverlay()});if(getMap().getLayer('hydro-edits-fill')?.type==='fill')getMap().setPaintProperty('hydro-edits-fill','fill-antialias',value.antiAlias!==false);}
  syncVectorGroups();const selection=getSelectionSnapshot();if(selection)setSelection(selection);invalidate('interaction-style');
 }

 return Object.freeze({getStyle,colorsEnabled,attachMap,applyStyle,syncLabelVisibility,syncLoadingSurface,
  hasStyleController:()=>!!styleController,strokeDomain,mapSourceLayers,requiredSource,requiredSourcesReady,
  syncVectorGroups,orderSceneLayers,syncTerritorialFills,syncCountryPaint,syncBaseLayer,setSceneDomains,setInteractionStyle,
  get vectors(){return sceneVectors;},get key(){return sceneKey;},get interactionStyle(){return interactionStyle;},
  vectorRole:id=>vectorLayers.get(id)?.role,requiredVectorPending:()=>[...vectorLayers.values()].some(entry=>entry.role!=='hydro-detail'&&entry.layer.pending),
  removeCountryFillSource:id=>countryFillGroups.delete(id),
  resetPendingDomains(){pendingSceneDomains=null;sceneIdentity=null;sceneStyle=null;},
  flushPendingInteractionStyle(){if(pendingInteractionStyle){const value=pendingInteractionStyle;pendingInteractionStyle=null;setInteractionStyle(value);}},
  flushPendingDomains(){if(pendingSceneDomains){const value=pendingSceneDomains;pendingSceneDomains=null;setSceneDomains(value);}},
  invalidateLayerIndex,
  dispose(){for(const entry of vectorLayers.values())entry.layer.dispose();vectorLayers.clear();styleController=null;
   dynamicLayers.clear();dynamicSources.clear();sceneGroups.clear();countryFillGroups.clear();
   strokeDomains.clear();strokeGroupCache.clear();sceneOrder=[];sceneVectors=[];sceneIdentity=null;sceneKey++;}
 });
}
