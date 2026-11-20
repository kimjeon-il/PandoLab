/** The physical-land source is the only MapLibre base. No raster mode switch. */
export function syncMapLibreBaseLayer(map,{style=null,landGeometry=null}={}){
 if(!style?.paint?.['physical-land-fill'])throw new TypeError('White map base style required');
 let changed=false;
 if(!map.getSource('physical-land')){
  const features=landGeometry?[{type:'Feature',properties:{},geometry:landGeometry}]:[];
  map.addSource('physical-land',{type:'geojson',data:{type:'FeatureCollection',features}});
  changed=true;
 }
 const layer=map.getLayer('physical-land-fill');
 if(layer&&layer.source!=='physical-land')throw new Error('Incorrect canonical land owner');
 if(!layer){map.addLayer({id:'physical-land-fill',type:'fill',source:'physical-land',
  paint:style.paint['physical-land-fill']},'territories');changed=true;}
 return changed;
}
