import {mapLibreHydroOpacity} from './maplibre-hydro-presentation.js';

// One MapLibre paint/layout contract for the white map. Neither the source
// geometry nor stored object color is modified by this presentation.
const freezeEntries=entries=>Object.freeze(Object.fromEntries(
 Object.entries(entries).map(([key,value])=>[key,Object.freeze(value)])
));

export function resolveMapLibreMapStyle({
 palette={},antiAlias=true,layerVisibility={},
}={}){
 const smooth=antiAlias!==false,land=palette.defaultLand||'#f1f1f1',ocean=palette.ocean||'#ffffff';
 const water=ocean,river=ocean;
 const neutral=['boolean',['feature-state','neutral'],false];
 const sourceOpacity=['case',neutral,1,['coalesce',['get','displayAlpha'],0]];
 const fillColor=['case',neutral,land,['coalesce',['feature-state','countryColor'],['get','color'],land]];
 const territorialFillPaint=Object.freeze({
  'fill-antialias':false,'fill-color':fillColor,'fill-opacity':sourceOpacity,
 });
 const countryStroke=Object.freeze({...palette.strokes?.country});
 const loading=palette.loadingSurface||{};
 const paint=freezeEntries({
  ocean:{'background-color':ocean},
  'physical-land-fill':{'fill-color':land,'fill-antialias':smooth},
  territories:territorialFillPaint,
  borders:{
   'line-color':['coalesce',['get','borderColor'],countryStroke.color||'#515151'],
   'line-opacity':['coalesce',['get','borderAlpha'],0],'line-width':['coalesce',['get','borderWidth'],0.6],
  },
  'physical-water':{'fill-antialias':smooth,'fill-color':water,'fill-opacity':1},
  lakes:{'fill-antialias':smooth,'fill-color':water,'fill-opacity':mapLibreHydroOpacity()},
  rivers:{'line-color':river,'line-width':palette.strokes?.river?.width??0.8,'line-opacity':mapLibreHydroOpacity()},
  'initial-map-ocean':{'background-color':loading.ocean||ocean},
  'initial-map-land':{'fill-color':loading.land||land,'fill-antialias':true},
 });
 const layout=freezeEntries({
  lakes:{visibility:layerVisibility?.lakes===false?'none':'visible'},
  rivers:{visibility:layerVisibility?.rivers===false?'none':'visible'},
 });
 return Object.freeze({paint,layout,territorialFillPaint,countryStroke,
  borderAlpha:palette.borderAlpha??1});
}
