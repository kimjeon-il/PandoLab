/** The physical-land source is the only MapLibre base. No raster mode switch. */
export function syncMapLibreBaseLayer(map,{style=null,landGeometry=null}={}){
 if(!style?.paint?.['map-base-fallback'])throw new TypeError('White map base style required');
 let changed=false;
 if(!map.getSource('physical-land')){
  const features=landGeometry?[{type:'Feature',properties:{},geometry:landGeometry}]:[];
  map.addSource('physical-land',{type:'geojson',data:{type:'FeatureCollection',features}});
  changed=true;
 }
 const layer=map.getLayer('map-base-fallback');
 if(layer&&layer.source!=='physical-land')throw new Error('Incorrect canonical land owner');
 if(!layer){map.addLayer({id:'map-base-fallback',type:'fill',source:'physical-land',
  paint:style.paint['map-base-fallback']},'territories');changed=true;}
 return changed;
}
