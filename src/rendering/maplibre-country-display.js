// Country display caches are owned by this controller, never by the map
// orchestration closure. The source itself remains owned by MapLibre.
export function createMapLibreCountryDisplay(){
 let rows=new Map(),tiles=new Map(),borders=new Map(),key='';
 return Object.freeze({
  get rows(){return rows;},get tiles(){return tiles;},get borders(){return borders;},get key(){return key;},
  publish(record,signature){rows=record.rows;tiles=record.tiles;borders=record.borders;key=signature;},
  clearSource(){rows=new Map();tiles=new Map();key='';borders=new Map();},
  clearTiles(){rows=new Map();tiles=new Map();key='';},
 });
}
