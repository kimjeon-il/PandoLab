import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveMapLibreMapStyle} from '../../../src/rendering/maplibre-map-style.js';
import {createMapLibreStyleController} from '../../../src/rendering/maplibre-style-controller.js';
const types={ocean:'background','map-base-fallback':'fill',territories:'fill',
 'territories-fill-1':'fill',borders:'line','physical-water':'fill',lakes:'fill',rivers:'line'};
function fixture(){
 const layers=new Map(Object.entries(types).map(([id,type])=>[id,{id,type,paint:{},layout:{}}])),calls=[];
 return {layers,calls,getLayer:id=>layers.get(id),getStyle:()=>({layers:[...layers.values()]}),
  getPaintProperty:(id,key)=>layers.get(id)?.paint?.[key],
  getLayoutProperty:(id,key)=>layers.get(id)?.layout?.[key],
  setPaintProperty(id,key,value){layers.get(id).paint[key]=value;calls.push(['paint',id,key]);},
  setLayoutProperty(id,key,value){layers.get(id).layout[key]=value;calls.push(['layout',id,key]);},
  addLayer(layer){assert.equal(layers.has(layer.id),false);layers.set(layer.id,{...layer,layout:layer.layout||{}});calls.push(['add',layer.id]);},
  removeLayer(id){layers.delete(id);calls.push(['remove',id]);},
  moveLayer(id,before){
   const layer=layers.get(id);layers.delete(id);
   if(before){
    const entries=[...layers],index=entries.findIndex(([key])=>key===before);
    assert.ok(index>=0);
    entries.splice(index,0,[id,layer]);layers.clear();
    for(const [key,value] of entries)layers.set(key,value);
   }else layers.set(id,layer);
   calls.push(['move',id]);
  }
 };
}
const palette={ocean:'#ffffff',defaultLand:'#f1f1f1',borderAlpha:1,
 strokes:{country:{color:'#515151',width:1},river:{width:1}},
 loadingSurface:{ocean:'#ffffff',land:'#f1f1f1'}};

test('single white-map styles expose only canonical active paint and layout',()=>{
 const style=resolveMapLibreMapStyle({palette,layerVisibility:{rivers:false,lakes:true}});
 assert.deepEqual(Object.keys(style.layout).sort(),['lakes','rivers']);
 assert.equal(style.paint['map-base-fallback']['fill-color'],'#f1f1f1');
 assert.equal(style.paint.ocean['background-color'],'#ffffff');
 assert.equal(style.paint.lakes['fill-color'],style.paint.ocean['background-color']);
 assert.equal(style.paint.rivers['line-color'],style.paint.ocean['background-color']);
 assert.equal(style.paint['physical-water']['fill-opacity'],1);
 assert.equal(style.layout.rivers.visibility,'none');
 assert.deepEqual(style.paint.territories,style.territorialFillPaint);
});
test('country paint updates are idempotent and never change sources or geometry',()=>{
 const map=fixture(),controller=createMapLibreStyleController(map);
 const first=resolveMapLibreMapStyle({palette,layerVisibility:{rivers:false,lakes:true}});
 assert.equal(controller.apply(first),true);
 assert.equal(map.layers.get('rivers').layout.visibility,'none');
 assert.equal(map.layers.get('ocean').paint['background-color'],'#ffffff');
 assert.deepEqual(map.layers.get('territories-fill-1').paint,first.territorialFillPaint);
 const before=map.calls.length;
 assert.equal(controller.apply(first),false);
 assert.equal(map.calls.length,before);
 const second=resolveMapLibreMapStyle({palette,layerVisibility:{rivers:true,lakes:false},antiAlias:false});
 assert.equal(controller.apply(second),true);
 assert.equal(map.layers.get('rivers').layout.visibility,'visible');
 assert.equal(map.layers.get('lakes').layout.visibility,'none');
 assert.equal(map.layers.get('map-base-fallback').paint['fill-antialias'],false);
 assert.ok(map.calls.every(row=>['paint','layout'].includes(row[0])));
 map.layers.get('ocean').paint={};
 assert.equal(controller.apply(first),true);
 assert.equal(map.layers.get('ocean').paint['background-color'],'#ffffff');
});
test('loading skeleton uses white palette without adding sources',()=>{
 const map=fixture(),controller=createMapLibreStyleController(map);
 map.addLayer({id:'viewer-label-dot',type:'circle'});
 map.addLayer({id:'viewer-label-text',type:'symbol'});
 map.addLayer({id:'viewer-label-country',type:'symbol'});
 const style=resolveMapLibreMapStyle({palette});
 controller.syncLoadingSurface(style,true);
 controller.syncLabelVisibility(true);
 assert.equal(map.getLayoutProperty('viewer-label-text','visibility'),'none');
 assert.equal(map.getLayoutProperty('viewer-label-dot','visibility'),'none');
 assert.equal(map.layers.get('initial-map-ocean').paint['background-color'],'#ffffff');
 assert.equal(map.layers.get('initial-map-land').paint['fill-color'],'#f1f1f1');
 assert.equal(map.getStyle().layers.at(-1).id,'initial-map-land');
 map.addLayer({id:'pando-polar-caps',type:'custom'});
 controller.syncLoadingSurface(style,true,'pando-polar-caps');
 assert.deepEqual([...map.layers.keys()].slice(-3),['initial-map-ocean','initial-map-land','pando-polar-caps']);
 const before=map.calls.length;
 controller.syncLoadingSurface(style,true,'pando-polar-caps');
 assert.equal(map.calls.length,before);
 controller.syncLoadingSurface(style,false);
 controller.syncLabelVisibility(false);
 assert.equal(map.getLayoutProperty('viewer-label-country','visibility'),'visible');
 assert.equal(map.getLayoutProperty('viewer-label-text','visibility'),'visible');
 assert.equal(map.getLayoutProperty('viewer-label-dot','visibility'),'visible');
 assert.equal(map.getLayer('initial-map-ocean'),undefined);
 assert.equal(map.getLayer('initial-map-land'),undefined);
});
