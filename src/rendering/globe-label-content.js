import {normalizeObjectRef} from '../document/object-ref-identity.js';
import {territorialNamesVisible} from '../ui/layer-presentation.js';
import {PLACE_DISPLAY_ZOOM_FLOOR} from '../map/map-display-zoom.js';
import {COUNTRY_LABEL_MIN_ZOOM} from './three-globe-labels.js';
import {territorialNativeLabelRows} from '../ui/territorial-native-label.js';
import {automaticLabelSettings,labelKey} from './label-layout.js';

// Candidate lists are a presentation cache, not a second source of map labels.
export function createGlobeLabelContent({
 state,refs,labelsBySlot,territorialName,readPreferences,objectRefVisible,isLayerItemVisible,placeLabelCandidates,
}){
 const dirtyCountryLabels=new Set(),countryLabels=new Map();
 let allCountryLabelsDirty=true,labelContentDirty=true,placeLabelContentDirty=true;
 let countryLabelList=[],placeLabelList=[],selection=null,placeCandidateUpdates=0;
 function invalidate({countries=true,places=true}={}){
  labelContentDirty=true;
  if(countries)allCountryLabelsDirty=true;
  if(places)placeLabelContentDirty=true;
 }
 function markCountrySlot(slot){dirtyCountryLabels.add(slot);labelContentDirty=true;}
 function setSelection(value){
  const prior=(selection?.selection?.items??[]).filter(ref=>ref.domain==='label').map(ref=>ref.key);
  const next=(value?.selection?.items??[]).filter(ref=>ref.domain==='label').map(ref=>ref.key);
  if(prior.length!==next.length||prior.some((key,i)=>key!==next[i]))invalidate({countries:false});
  selection=value;
 }
 function update({surface,camera,view,features,activeSlots,fontReady,needed}){
  if(!needed||!fontReady){surface.labels.setCandidateGroups([],[]);labelContentDirty=false;return;}
  const namesVisible=territorialNamesVisible(state)&&view.zoom>=COUNTRY_LABEL_MIN_ZOOM;
  if(namesVisible){
   const changed=allCountryLabelsDirty?new Set([...countryLabels.keys(),...activeSlots]):dirtyCountryLabels;
   for(const slot of changed){
    if(!activeSlots.has(slot)){countryLabels.delete(slot);continue;}
    const ref=refs[slot],metadata=labelsBySlot[slot];
    if(!metadata){countryLabels.delete(slot);continue;}
    const row=features.get(ref.id),primaryName=territorialName(row,{fallback:''});
    const settings=automaticLabelSettings('country',state.labelSettings[labelKey('territorial',ref.id)]||{});
    const lines=territorialNativeLabelRows(row,state.timelineCursor,{
     enabled:readPreferences().labels.place.showNativeNames===true,primaryName,
    }).map(label=>label.text);
    if(lines.length)countryLabels.set(slot,{ref,key:ref.key,area:metadata.area,shortSide:metadata.shortSide,
     coordinate:settings.pinned&&settings.manualPosition?settings.manualPosition:metadata.coordinate,
     minZoom:settings.minZoom,maxZoom:settings.maxZoom,lines,visible:objectRefVisible(ref)
       &&isLayerItemVisible('objectLabels',ref.id)});
    else countryLabels.delete(slot);
   }
   if(changed.size||allCountryLabelsDirty)countryLabelList=[...countryLabels.values()];
   allCountryLabelsDirty=false;dirtyCountryLabels.clear();
  }
  if(placeLabelContentDirty){
   const placeCandidates=view.zoom>=PLACE_DISPLAY_ZOOM_FLOOR&&state.layerVisibility.labels!==false?
    placeLabelCandidates({zoom:view.zoom,geographicBounds:camera.geographicBounds()}).rows:[];
   placeLabelList=placeCandidates.filter(row=>row.viewportVisible||row.selected).flatMap(row=>{
   const ref=normalizeObjectRef({domain:'label',type:row.source.kind,id:row.source.id});
   if(!ref||!objectRefVisible(ref))return [];
   return [{ref,key:ref.key,place:true,coordinate:row.coordinate,selected:row.selected,priority:row.priority,
    marker:['capital','city','town'].includes(row.source.kind)?row.source.kind:'',
    minZoom:row.minZoom,maxZoom:row.maxZoom,lines:row.rows.map(label=>label.text)}];
   });
   placeLabelContentDirty=false;placeCandidateUpdates++;
  }
  surface.labels.setCandidateGroups(namesVisible?countryLabelList:[],view.zoom>=PLACE_DISPLAY_ZOOM_FLOOR&&state.layerVisibility.labels!==false?placeLabelList:[]);labelContentDirty=false;
 }
 function clear(){countryLabels.clear();countryLabelList=[];dirtyCountryLabels.clear();placeLabelList=[];}
 function resetProject(){clear();invalidate();}
 return Object.freeze({
  invalidate,markCountrySlot,setSelection,update,resetProject,
  needsUpdate:()=>labelContentDirty,pendingCountrySlots:()=>dirtyCountryLabels.size,
  stats:()=>({placeCandidateUpdates}),dispose:clear,
 });
}
