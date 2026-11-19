import {createPolarLayer,clipMercatorLines,polarTriangleIndices,polarCapsVisible} from '../../../src/rendering/maplibre-polar-layer.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapLibreVectorGroup,geographicStrokeChains} from '../../../src/rendering/maplibre-vector-group.js';

test('native strokes stop inside the Mercator edge without joining across a polar excursion',()=>{
 const geometry={type:'MultiLineString',coordinates:[[[0,84],[2,86],[4,84]],[[10,-84],[12,-86]],[[20,86],[22,87]]]};
 assert.deepEqual(clipMercatorLines(geometry).coordinates,[[[0,84],[1,85]],[[3,85],[4,84]],[[10,-84],[11,-85]]]);
 assert.equal(geometry.coordinates[0][1][1],86,'canonical input is preserved');
});

test('polar filtering keeps triangles that may reach the cap and conservatively handles unknown projections',()=>{
 const packet={positions:new Float32Array([0,60,1,60,0,61,0,84.8,1,84.9,0,84.85]),indices:new Uint32Array([0,1,2,3,4,5]),maxEdgeDegrees:.499};
 assert.deepEqual([...polarTriangleIndices(packet)],[3,4,5]);
 assert.equal(polarTriangleIndices({...packet,maxEdgeDegrees:undefined}),packet.indices);
 const mainMatrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
 assert.equal(polarCapsVisible({projectionTransition:1,mainMatrix,clippingPlane:[0,0,1,-.5]}),false);
 assert.equal(polarCapsVisible({projectionTransition:1,mainMatrix,clippingPlane:[0,1,0,-.99]}),true);
 assert.equal(polarCapsVisible({projectionTransition:.5,mainMatrix,clippingPlane:[0,0,1,-.5]}),true);
});

test('shared boundary segments retain continuous chains for dash and join placement',()=>{
 assert.deepEqual(geographicStrokeChains(new Float32Array([0,0,1,1,1,1,2,1,5,5,6,6])).coordinates,[[[0,0],[1,1],[2,1]],[[5,5],[6,6]]]);
 const reordered=geographicStrokeChains([1,1,2,1,0,0,1,1]);assert.equal(reordered.coordinates.length,1);assert.equal(reordered.coordinates[0].length,3);
 const junction=geographicStrokeChains([0,0,1,1,1,1,2,1,1,1,1,2]);assert.equal(junction.coordinates.length,3);assert.ok(junction.coordinates.every(line=>line.length===2));
});

test('native vector style changes reuse geometry and dispose only owned resources',async()=>{
 const sources=new Map(),layers=new Map([['other',{}]]);let uploads=0,removals=0;
 const map={getSource:id=>sources.get(id),getLayer:id=>layers.get(id),addSource(id,value){sources.set(id,{...value,setData:async()=>{uploads++;}});},addLayer:layer=>layers.set(layer.id,layer),removeLayer(id){removals++;layers.delete(id);},removeSource:id=>sources.delete(id),moveLayer(){},setPaintProperty(id,key,value){layers.get(id).paint[key]=value;},setLayoutProperty(id,key,value){layers.get(id).layout[key]=value;},setFilter(id,value){layers.get(id).filter=value;}};
 const row={key:'a',kind:'fill',geometryRevision:'shape-1',geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]},style:{color:'#ffaa00',fillAlpha:.5},blendMode:'multiply'};
 const group=createMapLibreVectorGroup(map,{id:'owned',onChange(){}});
 await group.update([row]);assert.equal(layers.get('owned').paint['fill-layer-blend'],'multiply');
 await group.update([{...row,style:{color:'#00aaff',fillAlpha:.25}}]);assert.equal(uploads,0);assert.equal(layers.get('owned').paint['fill-opacity'],.25);
 assert.equal(removals,0,'changing paint must not remove a live layer');
 await group.update([{...row,geometryRevision:'shape-2'}]);assert.equal(uploads,1);
 group.dispose();group.dispose();assert.equal(sources.size,0);assert.deepEqual([...layers.keys()],['other']);
});

test('an obsolete applied upload cannot make a return to the prior geometry look unchanged',async()=>{
 const sources=new Map(),layers=new Map();let release,block=false;
 const map={getSource:id=>sources.get(id),getLayer:id=>layers.get(id),addSource(id,value){sources.set(id,{...value,setData:async data=>{if(block){block=false;await new Promise(resolve=>{release=resolve;});}sources.get(id).data=data;}});},addLayer:layer=>layers.set(layer.id,layer),removeLayer:id=>layers.delete(id),removeSource:id=>sources.delete(id),moveLayer(){}};
 const row={key:'a',kind:'fill',geometryRevision:'A',geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]},style:{color:'#ffaa00'}};
 const group=createMapLibreVectorGroup(map,{id:'owned',onChange(){}});await group.update([row]);block=true;
 const intermediate=group.update([{...row,geometryRevision:'B',geometry:{type:'Polygon',coordinates:[[[5,0],[6,0],[6,1],[5,0]]]}}]);
 while(!release)await new Promise(resolve=>setImmediate(resolve));const latest=group.update([row]);release();await Promise.all([intermediate,latest]);
 assert.deepEqual(sources.get('owned').data.features[0].geometry,row.geometry);group.dispose();
});

test('territorial fill layers reuse the admitted country source without duplicating geometry',async()=>{
 const sources=new Map([['countries',{}]]),layers=new Map();
 const map={getSource:id=>sources.get(id),getLayer:id=>layers.get(id),addSource(){assert.fail('Shared geometry must not be uploaded twice');},addLayer:layer=>layers.set(layer.id,layer),removeLayer:id=>layers.delete(id),removeSource(){assert.fail('The country owner retains its source');},moveLayer(){}};
 let sharedSource='countries';
 const group=createMapLibreVectorGroup(map,{id:'fills',sharedSource:()=>sharedSource,onChange(){}});
 const rows=[{key:'country:a',geometryRevision:'A',style:{color:'#ffaa00',fillAlpha:.5},blendMode:'multiply'}];
 await group.update(rows);
 assert.equal(layers.get('fills').source,'countries');
 assert.deepEqual(layers.get('fills').filter,['==',['get','objectKey'],'country:a']);
 sharedSource='countries-new';sources.set(sharedSource,{});await group.update(rows);
 assert.equal(layers.get('fills').source,sharedSource);
 group.dispose();assert.equal(sources.size,2);assert.equal(layers.size,0);
});

test('polar preparation retries the same revision after a transient failure',async()=>{
 const layers=new Map(),errors=[],changes=[];let attempts=0;
 const gl={createVertexArray:()=>({}),deleteVertexArray(){}};
 const map={getLayer:id=>layers.get(id),addLayer(layer){layers.set(layer.id,layer);layer.onAdd(map,gl);},removeLayer(id){layers.get(id).onRemove();layers.delete(id);}};
 const owner=createPolarLayer({map,prepare:async()=>{if(++attempts===1)throw Error('temporary');return {positions:new Float32Array([0,-90,1,-86,-1,-86]),indices:new Uint32Array([0,1,2])};},onChange:()=>changes.push(1),onError:error=>errors.push(error)});
 owner.ensure();const geometry={type:'Polygon',coordinates:[[[0,-90],[1,-86],[-1,-86],[0,-90]]]};const items=[{geometry,color:[1,1,1,1]}];owner.update('same',items,[1,1,1,1]);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(errors.length,1);owner.retry();owner.update('same',items,[1,1,1,1]);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(attempts,2);assert.equal(changes.length,1);assert.equal(owner.pending,false);owner.dispose();
});

test('polar drawing uses MapLibre custom-layer state restoration without synchronous GL readbacks',async()=>{
 let layer,lastVao;const errors=[],colors=[];
 const gl=new Proxy({createVertexArray:()=>({}),getShaderParameter:()=>true,getProgramParameter:()=>true,
  getParameter(){throw Error('synchronous GL readback');},isEnabled(){throw Error('synchronous GL readback');},
  getUniformLocation:(_program,name)=>name,
  uniform4fv:(name,value)=>{if(name==='u_color')colors.push(value);},
  bindVertexArray:value=>{lastVao=value;}},
  {get:(target,key)=>key in target?target[key]:key===String(key).toUpperCase()?key:()=>({})});
 const map={getCanvas:()=>({clientWidth:800,clientHeight:600}),getLayer:()=>layer,addLayer(value){layer=value;layer.onAdd(map,gl);},removeLayer(){layer.onRemove();layer=null;}};
 const owner=createPolarLayer({map,prepare:assert.fail,onChange(){},onError:error=>errors.push(error)});
 const packet={positions:new Float32Array([0,-90,1,-86,-1,-86]),indices:new Uint32Array([0,1,2])};
 const ocean=[1,1,1,1],land=[.9,.9,.9,1],grid=[.5,.5,.5,.15],border=[0,0,0,1];
 const loadingOcean=[.99,.99,.99,1],loadingLand=[.95,.95,.95,1];
 const render=()=>layer.render(gl,{shaderData:{variantName:'fixture',vertexShaderPrelude:'',define:''},defaultProjectionData:{mainMatrix:new Float32Array(16),fallbackMatrix:new Float32Array(16),clippingPlane:[0,0,0,1],tileMercatorCoords:[0,0,1,1],projectionTransition:0}});
 try{owner.ensure();owner.update('scene',[
   {packet,color:land,loadingRole:'land'},{packet,color:border},{packet,color:grid,loadingRole:'grid'},
  ],ocean);await new Promise(resolve=>setImmediate(resolve));
  owner.setLoadingSurface({ocean:loadingOcean,land:loadingLand});render();
  assert.deepEqual(colors.splice(0),[loadingOcean,loadingLand,grid]);
  owner.setLoadingSurface(null);render();
  assert.deepEqual(colors,[ocean,land,border,grid]);
  assert.deepEqual(errors,[]);assert.equal(lastVao,null);
 }finally{owner.dispose();}
});
