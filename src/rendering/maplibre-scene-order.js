import {MAPLIBRE_LABEL_LAYERS} from './maplibre-label-presentation.js';

function moveInOrder(order,id,before){
  const from=order.indexOf(id);
  if(from<0||id===before||order[from+1]===before)return false;
  order.splice(from,1);
  const to=before===undefined?order.length:order.indexOf(before);
  order.splice(to<0?order.length:to,0,id);
  return true;
 }
// Derive native layer order from the current scene and active source identities.
export function orderMapLibreSceneLayers({map,sceneOrder,vectorLayers,countryFillGroups,
 sourceLayer,datedSources,getHighlight,getPolarLayer,isInitialMapLoading}){
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
  return moved;
 }
