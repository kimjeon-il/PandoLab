import {temporalMonthEnd} from '../document/temporal.js';
import {MAP_LABEL_SIZE_STOPS,TERRITORIAL_NAME_SIZE,territorialNameUnits} from './label-layout.js';
import {PLACE_DISPLAY_ZOOM_FLOOR} from '../map/map-display-zoom.js';
import {sameRenderIdentity} from './render-identity.js';

/** Ordinary geographic labels use MapLibre symbols, shaping and collision placement. */
const labelTextLayers=['viewer-label-text','viewer-label-country'];
export const MAPLIBRE_LABEL_LAYERS=Object.freeze(['viewer-label-dot',...labelTextLayers]);
export const MAPLIBRE_LABEL_MIN_ZOOM=Object.freeze({country:3,places:PLACE_DISPLAY_ZOOM_FLOOR});

const zoomSize=size=>['interpolate',['linear'],['zoom'],...MAP_LABEL_SIZE_STOPS.flatMap(stop=>[stop.zoom,size(stop)])];
const urbanSize=(size,base)=>['case',['boolean',['get','urban'],false],size,base];
const markerRing=['boolean',['get','markerRing'],false];
const markerRadius=zoomSize(stop=>['case',markerRing,stop.cityDiameter/2+1.5,urbanSize(stop.cityDiameter/2,2.5)]);
const cityNameSize=zoomSize(stop=>urbanSize(stop.cityName,12));

export function createMapLibreLabelPresentation({renderer,labels,onChange,onSourceError}){
 const sourceId='viewer-labels';let requestedLayout=null,failedKey='',pending=false,disposed=false,sequence=0,tail=Promise.resolve();
 const measure=renderer.measureWork??((_name,work)=>work());
 let paintKey='';
 let observedSource=null,observedError=null,sourceRows=null;
 const font='Pando Pretendard';
 const territorialFont='Pando Pretendard ExtraBold';
 function sourceFailed(error){
  if(disposed)return;const map=renderer.map;pending=false;
  // Suppress automatic resubmission of the failed layout until explicit retry.
  failedKey=JSON.stringify(requestedLayout??{
   features:Array.from(sourceRows?.values()??[]),palette:paintKey?JSON.parse(paintKey):null,
  });
  requestedLayout=null;paintKey='';sequence++;
  for(const id of MAPLIBRE_LABEL_LAYERS)if(map.getLayer(id))map.removeLayer(id);
  const source=map.getSource(sourceId);observedSource?.off?.('error',observedError);observedSource=null;sourceRows=null;if(source)map.removeSource(sourceId);
  onSourceError(error.error||error);
 }
 function sync(layout,{deferWhileMoving=false}={}){
  const map=renderer.map,state=labels.getState(),features=[];
  const palette=labels.mapPalette?.().labels||{text:'#343840',halo:'#ffffff',point:'#373b42',selection:'#315e9d'};
  const hasCapitalPeriods=layout.userLabels?.some(item=>item.capitalPeriods?.length);
  const placeDate=hasCapitalPeriods&&state.timelineCursor?temporalMonthEnd(state.timelineCursor).canonical:null;
  const add=(item,domain,coordinate,rows)=>{
   if(!coordinate)return;
   const ref=domain==='territorial'?labels.getTerritorialLabelRef(item.id):labels.normalizeObjectRef({domain:'label',type:item.kind||'label',id:item.id});
   if(!ref)return;
   const selected=labels.selectionHas?.(ref),priority=(domain==='territorial'?layout.territorialLabelPriorities:layout.userLabelPriorities)?.get(String(item.id))??(domain==='territorial'?100:item.priority||40);
   const capital=domain==='label'&&placeDate!==null&&item.capitalPeriods?.some(({fromDate,untilDateExclusive})=>
    fromDate<=placeDate&&(untilDateExclusive===null||placeDate<untilDateExclusive));
   const row={type:'Feature',id:ref.key,geometry:{type:'Point',coordinates:coordinate},properties:{objectKey:ref.key,renderKey:ref.key,
    text:rows.map(row=>row.text).join('\n'),primary:rows[0]?.text||'',secondary:rows.slice(1).map(row=>row.text).join('\n'),kind:domain,rank:selected?-1e12:-priority,
    selected:!!selected,capital:!!capital,
    ...(domain==='label'?{viewerMinZoom:layout.userLabelMinZooms.get(String(item.id)),
     urban:!!capital||['capital','city','town'].includes(item.kind)}:{
      territorialShortSide:layout.territorialLabelShortSides.get(String(item.id)),territorialNameUnits:territorialNameUnits(rows)})}};
   features.push(row);
   if(capital){
    const renderKey='capital-ring:'+ref.key;
    features.push({...row,id:renderKey,properties:{...row.properties,renderKey,markerRing:true}});
   }
  };
  for(const item of layout.territorialLabels||[]){const settings=labels.automaticLabelSettings('country',labels.labelSettings(state,'territorial',labels.getTerritorialLabelRef(item.id).id));
   add(item,'territorial',settings.pinned&&settings.manualPosition?settings.manualPosition:labels.countryLabelAnchors().get(String(item.id)),layout.territorialLabelRows.get(String(item.id))||[]);}
  for(const item of state.layerVisibility.labels?layout.userLabels||[]:[]){const settings=labels.automaticLabelSettings(item.kind,labels.labelSettings(state,'label',item.id));
   add(item,'label',settings.pinned&&settings.manualPosition?settings.manualPosition:item.coordinates,layout.userLabelRows.get(String(item.id))||[{text:item.name}]);}
  const request={features,palette};
  if(failedKey&&JSON.stringify(request)===failedKey)return;
  const rows=new Map(features.map(feature=>[feature.id,feature]));
  const sameSource=observedSource&&map.getSource(sourceId)===observedSource;
  if(pending&&sameSource&&requestedLayout&&sameRenderIdentity(requestedLayout,request)
    &&MAPLIBRE_LABEL_LAYERS.every(id=>map.getLayer(id)))return;
  const preparedDiff=!pending&&sameSource&&sourceRows?labelSourceDiff(sourceRows,rows):null;
  const nextPaintKey=JSON.stringify(palette);
  if(preparedDiff&&!hasSourceDiff(preparedDiff)&&nextPaintKey===paintKey&&MAPLIBRE_LABEL_LAYERS.every(id=>map.getLayer(id)))return;
  requestedLayout=request;pending=true;const version=++sequence;
  const faces=map.getFontFaces()||{};
  const fontUrl=new URL('assets/fonts/pretendard-v1.3.9/PretendardVariable.woff2',document.baseURI).href;
  const territorialFontUrl=new URL('assets/fonts/pretendard-v1.3.9/Pretendard-ExtraBold.woff2',document.baseURI).href;
  if(faces[font]?.[0]?.url!==fontUrl||faces[territorialFont]?.[0]?.url!==territorialFontUrl)
   map.setFontFaces({...faces,[font]:[{url:fontUrl}],[territorialFont]:[{url:territorialFontUrl}]});
  if(!map.getSource(sourceId))map.addSource(sourceId,{type:'geojson',promoteId:'renderKey',data:{type:'FeatureCollection',features:[]}});
  if(map.getSource(sourceId)!==observedSource){observedSource?.off?.('error',observedError);sourceRows=null;paintKey='';observedSource=map.getSource(sourceId);const source=observedSource;observedError=event=>{if(map.getSource(sourceId)===source)sourceFailed(event);};source.on?.('error',observedError);}
  const placeFilter=['==',['get','kind'],'label'];
  const applyPaint=(layer,paint)=>{
   if(!map.getLayer(layer.id))map.addLayer({...layer,paint});
   else if(nextPaintKey!==paintKey)for(const [name,value]of Object.entries(paint))map.setPaintProperty(layer.id,name,value);
  };
  const marker={type:'circle',source:sourceId,minzoom:MAPLIBRE_LABEL_MIN_ZOOM.places,layout:{
   visibility:'none','circle-sort-key':['case',markerRing,1,0],
  }};
  const pointColor=['case',['get','selected'],palette.selection,palette.point];
  applyPaint({id:'viewer-label-dot',...marker,filter:placeFilter},{
   'circle-stroke-width':['case',markerRing,1,.5],
   'circle-color':['case',markerRing,'rgba(0,0,0,0)',pointColor],
   'circle-stroke-color':['case',markerRing,pointColor,palette.halo],
   'circle-radius':markerRadius,
  });
  const textLayout={'text-field':['format',['get','primary'],{'font-scale':1},['case',['==',['get','secondary'],''],'',['concat','\n',['get','secondary']]],{'font-scale':.82}],'text-letter-spacing':.015,'text-line-height':1.25,'symbol-sort-key':['get','rank'],'text-max-width':12};
  const countryLayout={
   'text-font':[territorialFont],'text-size':TERRITORIAL_NAME_SIZE,'text-justify':'center',
   'text-anchor':'center','text-offset':[0,0],
  };
  const cityLayout={'text-font':[font],'text-size':cityNameSize,'text-anchor':'left','text-offset':[.85,0],'text-justify':'left'};
  // Selection is part of the label row, so tile reloads never replay a separate feature state.
  for(const id of labelTextLayers){
   const country=id==='viewer-label-country';
   applyPaint({id,type:'symbol',source:sourceId,minzoom:MAPLIBRE_LABEL_MIN_ZOOM[country?'country':'places'],
    filter:country?['==',['get','kind'],'territorial']:['all',placeFilter,['!',markerRing]],
    layout:{...textLayout,...(country?countryLayout:cityLayout),visibility:'none'}},
    {'text-halo-width':1,'text-halo-blur':.35,'text-color':palette.text,'text-halo-color':palette.halo});
  }
  paintKey=nextPaintKey;
  const source=map.getSource(sourceId);
  const current=()=>!disposed&&version===sequence&&map.getSource(sourceId)===source;
  tail=tail.catch(()=>{}).then(async()=>{
   if(!current())return;
   if(deferWhileMoving&&map.isMoving?.()){
    requestedLayout=null;
    pending=false;
    return;
   }
   const previous=sourceRows;
   if(!previous)await measure('labels.source.write',()=>source.setData({type:'FeatureCollection',features}));
   else {
    const diff=preparedDiff??labelSourceDiff(previous,rows);
    if(hasSourceDiff(diff))await measure('labels.source.write',()=>source.updateData(diff));
   }
   if(disposed||map.getSource(sourceId)!==source)return;
   // The source has applied these rows even if a newer layout is queued.
   sourceRows=rows;
   if(!current())return;
   requestedLayout=null;pending=false;onChange();
  }).catch(error=>{if(current())sourceFailed(error);});
 }
 return {renderTerritorialLabels:sync,retry(){failedKey='';},
  get pending(){return pending;},dispose(){disposed=true;sequence++;observedSource?.off?.('error',observedError);for(const id of MAPLIBRE_LABEL_LAYERS)if(renderer.map.getLayer(id))renderer.map.removeLayer(id);if(renderer.map.getSource(sourceId))renderer.map.removeSource(sourceId);}};
}

function hasSourceDiff({remove,add,update}){return remove.length||add.length||update.length;}

function labelSourceDiff(previous,rows){
 const remove=[...previous.keys()].filter(id=>!rows.has(id)),add=[],update=[];
 for(const [id,feature] of rows){
  const before=previous.get(id);
  if(!before){add.push(feature);continue;}
  const pointChanged=feature.geometry.coordinates.some((value,index)=>value!==before.geometry.coordinates[index]);
  const properties=Object.entries(feature.properties)
   .filter(([key,value])=>value!==before.properties[key]).map(([key,value])=>({key,value}));
  if(pointChanged||properties.length)update.push({id,
   ...(pointChanged?{newGeometry:feature.geometry}:{}),...(properties.length?{addOrUpdateProperties:properties}:{})});
 }
 return {remove,add,update};
}
