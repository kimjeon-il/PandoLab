import {MAPLIBRE_LABEL_LAYERS} from './maplibre-label-presentation.js';
import {mapLibreHydroLayer,mapLibreHydroPaint} from './maplibre-hydro-presentation.js';

const hardLineLayer=layer=>layer.id.split('--',1)[0]==='borders'||
 (layer.source==='hydro'&&mapLibreHydroLayer(layer.id)?.baseId==='rivers');

/** Apply MapLibre paint/layout changes without resetting style, sources or camera. */
export function createMapLibreStyleController(map){
 if(!map||typeof map.getLayer!=='function'||typeof map.setPaintProperty!=='function')
  throw new TypeError('The style controller requires a MapLibre map.');

 function paint(id,properties){
  if(!map.getLayer(id))return false;
  let changed=false;
  for(const [key,value] of Object.entries(properties)){
   if(typeof map.getPaintProperty==='function'
     &&JSON.stringify(map.getPaintProperty(id,key))===JSON.stringify(value))continue;
   map.setPaintProperty(id,key,value);changed=true;
  }
  return changed;
 }
 function visibility(id,properties){
  if(!map.getLayer(id))return false;
  let changed=false;
  for(const [key,value] of Object.entries(properties)){
   if(typeof map.getLayoutProperty==='function'&&map.getLayoutProperty(id,key)===value)continue;
   map.setLayoutProperty(id,key,value);changed=true;
  }
  return changed;
 }
 function apply(style,{updateVisibility=true}={}){
  if(!style?.paint||!style?.layout)throw new TypeError('A resolved white map style is required.');
  const hardEdges=style.smoothLines===false?hardLineLayer:undefined;
  let changed=map.painter.pandoHardLineEdges!==hardEdges;
  if(changed){
   map.painter.pandoHardLineEdges=hardEdges;
   map.triggerRepaint();
  }
  for(const [id,properties] of Object.entries(style.paint)){
   if(id.startsWith('initial-map-'))continue;
   changed=paint(id,properties)||changed;
  }
  // Country hierarchy can create additional normal-fill batches. They use the
  // same centralized style rather than painting from the renderer.
  for(const id of map.getLayersOrder()){
   const layer=map.getLayer(id);
   const name=layer.id.split('--',1)[0];
   if(layer.id!==name&&style.paint[name]&&['territories','borders','physical-water','physical-land-fill'].includes(name))
    changed=paint(layer.id,style.paint[name])||changed;
   if(style.territorialFillPaint&&/^territories-(fill|multiply)-/.test(layer.id)&&layer.type==='fill')
    changed=paint(layer.id,style.territorialFillPaint)||changed;
   const hydro=layer.source==='hydro'&&mapLibreHydroLayer(layer.id);
   if(hydro&&layer.id!==hydro.baseId)changed=paint(layer.id,mapLibreHydroPaint(style.paint[hydro.baseId],layer.type,hydro.zoom))||changed;
  }
  if(updateVisibility)for(const [id,properties] of Object.entries(style.layout))
   changed=visibility(id,properties)||changed;
  return changed;
 }
 function syncLabelVisibility(loading){
  let changed=false;
  for(const id of MAPLIBRE_LABEL_LAYERS){
   changed=visibility(id,{visibility:loading?'none':'visible'})||changed;
  }
  return changed;
 }
 function syncLoadingSurface(style,enabled,before){
  if(!enabled){
   for(const id of ['initial-map-land','initial-map-ocean'])
    if(map.getLayer(id))map.removeLayer(id);
   return;
  }
  if(!style?.paint)throw new TypeError('A resolved white map style is required.');
  if(!map.getLayer('initial-map-ocean'))
   map.addLayer({id:'initial-map-ocean',type:'background',paint:style.paint['initial-map-ocean']});
  if(!map.getLayer('initial-map-land'))
   map.addLayer({id:'initial-map-land',type:'fill',source:'physical-land',paint:style.paint['initial-map-land']});
  paint('initial-map-ocean',style.paint['initial-map-ocean']);
  paint('initial-map-land',style.paint['initial-map-land']);
  const layers=map.getLayersOrder();
  const end=before?layers.indexOf(before):layers.length;
  if(layers[end-2]!=='initial-map-ocean'||layers[end-1]!=='initial-map-land'){
   map.moveLayer('initial-map-ocean',before);map.moveLayer('initial-map-land',before);
  }
 }
 return Object.freeze({apply,syncLoadingSurface,syncLabelVisibility});
}
