// Country display caches are owned by this controller, never by the map
// orchestration closure. The source itself remains owned by MapLibre.
export function createMapLibreCountryDisplay(){
 let rows=new Map(),tiles=new Map(),borders=new Map(),key='',sourceSerial=0,sourceNeedsSwap=false;
 function replaceObsoleteCountrySource({map,datedSources,sourceLayer,sourceLayers,countryTileSource,onCountrySourceRemoved,onStyleInvalidated,dirty}){
  if(!sourceNeedsSwap)return;
  const oldId=datedSources.active('territories'),newId='territories-generation-'+(++sourceSerial),layers=map.getStyle().layers;
  const affected=layers.map((layer,index)=>({layer,index})).filter(({layer})=>layer.source===oldId);
  const mandatory=new Set(sourceLayers.map(id=>sourceLayer(id,oldId)));
  map.addSource(newId,countryTileSource());
  for(const {layer}of affected)map.removeLayer(layer.id);
  for(const {layer,index}of affected.reverse()){
   if(!mandatory.has(layer.id))continue;
   const before=layers.slice(index+1).find(candidate=>map.getLayer(candidate.id));
   const base=layer.id.split('--',1)[0];
   map.addLayer({...layer,id:map.getLayer(base)?base+'--'+newId:base,source:newId},before?.id);
  }
  if(map.getSource(oldId))map.removeSource(oldId);
  onStyleInvalidated();
  datedSources.replaceActive('territories',newId);onCountrySourceRemoved?.(oldId);
  rows=new Map();tiles=new Map();borders=new Map();key='';sourceNeedsSwap=false;dirty();
 }

 return Object.freeze({
  get rows(){return rows;},get tiles(){return tiles;},get borders(){return borders;},get key(){return key;},get needsSwap(){return sourceNeedsSwap;},
  markSourceStale(){sourceNeedsSwap=true;},clearSwap(){sourceNeedsSwap=false;},replaceObsoleteCountrySource,
  publish(record,signature){rows=record.rows;tiles=record.tiles;borders=record.borders;key=signature;},
  clearSource(){rows=new Map();tiles=new Map();key='';borders=new Map();},
  clearTiles(){rows=new Map();tiles=new Map();key='';},
 });
}
