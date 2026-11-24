import {createPolarLayer,clipMercatorLines,polarLinePacket,compactPolarPacket,polarCapsVisible} from '../../../src/rendering/maplibre-polar-layer.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapLibreVectorGroup,geographicStrokeChains} from '../../../src/rendering/maplibre-vector-group.js';

test('native strokes stop inside the Mercator edge without joining across a polar excursion',()=>{
 const geometry={type:'MultiLineString',coordinates:[[[0,84],[2,86],[4,84]],[[10,-84],[12,-86]],[[20,86],[22,87]]]};
 assert.deepEqual(clipMercatorLines(geometry).coordinates,[[[0,84],[1,85]],[[3,85],[4,84]],[[10,-84],[11,-85]]]);
 assert.equal(geometry.coordinates[0][1][1],86,'canonical input is preserved');
});

test('polar line packets meet native line endpoints at the same latitude cut',()=>{
 const coordinates=[[[0,84],[2,86]],[[10,-84],[14,-88]],[[20,85],[22,85]]];
 const native=clipMercatorLines({type:'MultiLineString',coordinates});
 const polar=polarLinePacket(coordinates);
 assert.deepEqual(native.coordinates.map(line=>line.at(-1)),[[1,85],[11,-85],[22,85]]);
 assert.deepEqual([Array.from(polar.values.slice(0,4)),Array.from(polar.values.slice(20,24))].sort((a,b)=>a[0]-b[0]),
  [[1,85,2,86],[11,-85,14,-88]]);
 assert.equal(polar.indices.length,12,'native owns a line lying on the exact cutoff');
});

test('polar filtering keeps triangles that may reach the cap and conservatively handles unknown projections',()=>{
 const packet={positions:new Float32Array([0,60,1,60,0,61,0,84.8,1,84.9,0,84.85]),indices:new Uint32Array([0,1,2,3,4,5]),maxEdgeDegrees:.499};
 const compact=compactPolarPacket(packet);
 assert.deepEqual(compact.indices,new Uint32Array([0,1,2]));
 assert.deepEqual(compact.positions,packet.positions.slice(6));
 assert.equal(compactPolarPacket({...packet,maxEdgeDegrees:undefined}).indices,packet.indices);
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
 const sources=new Map(),layers=new Map([['other',{}]]),diffs=[];let uploads=0,removals=0;
 const map={getSource:id=>sources.get(id),getLayer:id=>layers.get(id),addSource(id,value){sources.set(id,{...value,setData:async()=>{uploads++;},updateData:async diff=>{diffs.push(diff);}});},addLayer:layer=>layers.set(layer.id,layer),removeLayer(id){removals++;layers.delete(id);},removeSource:id=>sources.delete(id),moveLayer(){},setPaintProperty(id,key,value){layers.get(id).paint[key]=value;},setLayoutProperty(id,key,value){layers.get(id).layout[key]=value;},setFilter(id,value){layers.get(id).filter=value;}};
 const row={key:'a',kind:'fill',geometryRevision:'shape-1',geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]},style:{color:'#ffaa00',fillAlpha:.5},blendMode:'multiply'};
 const group=createMapLibreVectorGroup(map,{id:'owned',onChange(){}});
 await group.update([row]);assert.equal(layers.get('owned').paint['fill-layer-blend'],'multiply');
 await group.update([{...row,style:{color:'#00aaff',fillAlpha:.25}}]);assert.equal(uploads,0);assert.equal(layers.get('owned').paint['fill-opacity'],.25);
 assert.equal(removals,0,'changing paint must not remove a live layer');
 await group.update([row,{...row,key:'b'}]);
 assert.deepEqual(diffs[0].add.map(feature=>feature.id),['b']);
 assert.deepEqual(diffs[0].remove,[]);assert.deepEqual(diffs[0].update,[]);
 await group.update([{...row,geometryRevision:'shape-2'}]);
 assert.deepEqual(diffs[1].remove,['b']);assert.deepEqual(diffs[1].update.map(row=>row.id),['a']);
 assert.equal(uploads,0);
 group.dispose();group.dispose();assert.equal(sources.size,0);assert.deepEqual([...layers.keys()],['other']);
});

test('vector group reports concrete layer order only when its structure changes',async()=>{
 const sources=new Map(),layers=new Map(),changes=[];
 const map={getSource:id=>sources.get(id),getLayer:id=>layers.get(id),
  addSource(id){sources.set(id,{updateData:async()=>{}});},removeSource:id=>sources.delete(id),
  addLayer:layer=>layers.set(layer.id,layer),removeLayer:id=>layers.delete(id),
  setPaintProperty(){},setLayoutProperty(){},setFilter(){}};
 const geometry={type:'LineString',coordinates:[[0,0],[1,1]]};
 const rows=[{key:'a',kind:'line',geometryRevision:'shape-1',geometry,style:{color:'#ffaa00',casing:{color:'#fff',width:1}}},
  {key:'b',kind:'line',geometryRevision:'shape-1',geometry,style:{color:'#003311'}}];
 const group=createMapLibreVectorGroup(map,{id:'owned',onChange:change=>changes.push(change.structureChanged)});
 try{
  await group.update(rows);
  const originalOrder=group.getLayerIds();
  assert.deepEqual(originalOrder,['owned-0-casing','owned-0','owned']);
  await group.update([{...rows[0],geometryRevision:'shape-2'},rows[1]]);
  assert.equal(group.getLayerIds(),originalOrder);
  await group.update([{...rows[0],style:{color:'#111100'}},rows[1]]);
  assert.deepEqual(group.getLayerIds(),['owned-0','owned']);
  assert.deepEqual(changes,[true,false,true]);
 }finally{group.dispose();}
});

test('an obsolete applied upload cannot make a return to the prior geometry look unchanged',async()=>{
 const sources=new Map(),layers=new Map();let release,block=false;
 const map={getSource:id=>sources.get(id),getLayer:id=>layers.get(id),addSource(id,value){sources.set(id,{...value,updateData:async diff=>{if(block){block=false;await new Promise(resolve=>{release=resolve;});}sources.get(id).data.features[0].geometry=diff.update[0].newGeometry;}});},addLayer:layer=>layers.set(layer.id,layer),removeLayer:id=>layers.delete(id),removeSource:id=>sources.delete(id),moveLayer(){}};
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
 const gl={createVertexArray:()=>({}),deleteVertexArray(){},isContextLost:()=>false,
  getParameter:()=>null,bindVertexArray(){},createBuffer:()=>({}),bindBuffer(){},bufferData(){},deleteBuffer(){}};
 const map={getLayer:id=>layers.get(id),addLayer(layer){layers.set(layer.id,layer);layer.onAdd(map,gl);},removeLayer(id){layers.get(id).onRemove();layers.delete(id);}};
 const owner=createPolarLayer({map,prepare:async()=>{if(++attempts===1)throw Error('temporary');return {positions:new Float32Array([0,-90,1,-86,-1,-86]),indices:new Uint32Array([0,1,2])};},onChange:()=>changes.push(1),onError:error=>errors.push(error)});
 owner.ensure();const geometry={type:'Polygon',coordinates:[[[0,-90],[1,-86],[-1,-86],[0,-90]]]};const items=[{geometry,color:[1,1,1,1]}];owner.update('same',items,[1,1,1,1]);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(errors.length,1);owner.retry();owner.update('same',items,[1,1,1,1]);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(attempts,2);assert.equal(changes.length,1);assert.equal(owner.pending,false);owner.dispose();
});

test('polar drawing uses MapLibre custom-layer state restoration without synchronous GL readbacks',async()=>{
 let layer,lastVao,drawing=false;const errors=[],colors=[];
 const gl=new Proxy({createVertexArray:()=>({}),getShaderParameter:()=>true,getProgramParameter:()=>true,isContextLost:()=>false,
  getParameter(){if(drawing)throw Error('synchronous GL readback during render');return null;},
  isEnabled(){if(drawing)throw Error('synchronous GL readback during render');return false;},
  getUniformLocation:(_program,name)=>name,
  uniform4fv:(name,value)=>{if(name==='u_color')colors.push(value);},
  bindVertexArray:value=>{lastVao=value;}},
  {get:(target,key)=>key in target?target[key]:key===String(key).toUpperCase()?key:()=>({})});
 const map={getCanvas:()=>({clientWidth:800,clientHeight:600}),getZoom:()=>3,getLayer:()=>layer,addLayer(value){layer=value;layer.onAdd(map,gl);},removeLayer(){layer.onRemove();layer=null;}};
 const owner=createPolarLayer({map,prepare:assert.fail,onChange(){},onError:error=>errors.push(error)});
 const packet={positions:new Float32Array([0,-90,1,-86,-1,-86]),indices:new Uint32Array([0,1,2])};
 const ocean=[1,1,1,1],land=[.9,.9,.9,1],grid=[.5,.5,.5,.15],border=[0,0,0,1];
 const loadingOcean=[.99,.99,.99,1],loadingLand=[.95,.95,.95,1];
 const render=()=>{drawing=true;try{layer.render(gl,{shaderData:{variantName:'fixture',vertexShaderPrelude:'',define:''},defaultProjectionData:{mainMatrix:new Float32Array(16),fallbackMatrix:new Float32Array(16),clippingPlane:[0,0,0,1],tileMercatorCoords:[0,0,1,1],projectionTransition:0}});}finally{drawing=false;}};
 try{owner.ensure();owner.update('scene',[
   {packet,color:land,loadingRole:'land'},{packet,color:border},{packet,color:grid,loadingRole:'grid'},
  ],ocean);await new Promise(resolve=>setImmediate(resolve));
  owner.setLoadingSurface({ocean:loadingOcean,land:loadingLand});render();
  assert.deepEqual(colors.splice(0),[loadingOcean,loadingLand]);
  owner.setLoadingSurface(null);render();
  assert.deepEqual(colors,[ocean,land,border,grid]);
  assert.deepEqual(errors,[]);assert.equal(lastVao,null);
 }finally{owner.dispose();}
});

test('a staged polar highlight uploads before commit and cannot survive context replacement',async()=>{
 let layer,uploads=0;const colors=[],errors=[];
 const gl=new Proxy({createVertexArray:()=>({}),getShaderParameter:()=>true,getProgramParameter:()=>true,isContextLost:()=>false,
  getParameter:()=>null,getUniformLocation:(_program,name)=>name,
  uniform4fv:(name,value)=>{if(name==='u_color')colors.push(value);},bufferData(){uploads++;}},
  {get:(target,key)=>key in target?target[key]:key===String(key).toUpperCase()?key:()=>({})});
 const map={getCanvas:()=>({clientWidth:800,clientHeight:600}),getZoom:()=>3,getLayer:()=>layer,
  addLayer(value){layer=value;layer.onAdd(map,gl);},removeLayer(){layer.onRemove();layer=null;}};
 const owner=createPolarLayer({map,prepare:assert.fail,onChange(){},onError:error=>errors.push(error)});
 const packet=()=>({positions:new Float32Array([0,-90,1,-86,-1,-86]),indices:new Uint32Array([0,1,2])});
 const ocean=[1,1,1,1],land=[.9,.9,.9,1],highlight=[1,0,0,.5];
 const render=()=>layer.render(gl,{shaderData:{variantName:'fixture',vertexShaderPrelude:'',define:''},defaultProjectionData:{mainMatrix:new Float32Array(16),fallbackMatrix:new Float32Array(16),clippingPlane:[0,0,0,1],tileMercatorCoords:[0,0,1,1],projectionTransition:0}});
 try{
  owner.ensure();owner.update('static',[{packet:packet(),color:land}],ocean);
  await new Promise(resolve=>setImmediate(resolve));render();assert.deepEqual(colors.splice(0),[ocean,land]);
  const baseUploads=uploads;
  const fill={packet:packet(),color:highlight};
  const stale=await owner.prepareHighlights([fill]);
  assert.equal(uploads,baseUploads+2);
  render();assert.deepEqual(colors.splice(0),[ocean,land]);
  owner.resetContext();assert.equal(stale(),false);
  const commit=await owner.prepareHighlights([fill]);assert.equal(commit(),true);
  render();assert.deepEqual(colors.splice(0),[ocean,land,highlight]);
  const committedUploads=uploads;
  owner.clearHighlights();render();assert.deepEqual(colors.splice(0),[ocean,land]);
  assert.equal(uploads,committedUploads,'clearing a highlight must preserve the static buffers');
  assert.deepEqual(errors,[]);
 }finally{owner.dispose();}
});

test('a failed vector source update can retry the same geometry without a stuck pending flag',async()=>{
 const sources=new Map(),layers=new Map();
 let fail=true,fullWrites=0;
 const map={getSource:id=>sources.get(id),getLayer:id=>layers.get(id),
  addSource(id,value){sources.set(id,{...value,async updateData(){if(fail){fail=false;throw Error('source update rejected');}},async setData(data){this.data=data;fullWrites++;}});},
  addLayer:layer=>layers.set(layer.id,layer),removeLayer:id=>layers.delete(id),removeSource:id=>sources.delete(id),
  setPaintProperty(){},setLayoutProperty(){},setFilter(){}};
 const row={key:'a',kind:'fill',geometryRevision:'one',geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[0,1],[0,0]]]},style:{color:'#ffffff'}};
 const group=createMapLibreVectorGroup(map,{id:'retry',onChange(){}});
 try{
  await group.update([row]);
  const changed={...row,geometryRevision:'two',geometry:{type:'Polygon',coordinates:[[[1,0],[2,0],[1,1],[1,0]]]}};
  await assert.rejects(group.update([changed]),/source update rejected/);
  assert.equal(group.pending,false);
  await group.update([changed]);
  assert.equal(fullWrites,1);
  assert.deepEqual(sources.get('retry').data.features[0].geometry,changed.geometry);
 }finally{group.dispose();}
});


test('vector queue keeps only the latest undispatched snapshot and clears pending on disposal',async()=>{
 const sources=new Map(),layers=new Map(),writes=[];
 let release;
 const map={getSource:id=>sources.get(id),getLayer:id=>layers.get(id),
  addSource(id,value){sources.set(id,{...value,async updateData(diff){
   writes.push(diff.update[0].newGeometry.coordinates[0][0][0]);
   if(writes.length===1)await new Promise(resolve=>{release=resolve;});
  }});},
  removeSource:id=>sources.delete(id),addLayer:layer=>layers.set(layer.id,layer),removeLayer:id=>layers.delete(id),
  setPaintProperty(){},setLayoutProperty(){},setFilter(){}};
 const group=createMapLibreVectorGroup(map,{id:'coalesced',onChange(){}});
 const rows=n=>[{key:'a',kind:'fill',geometryRevision:String(n),geometry:{type:'Polygon',coordinates:[[[n,0],[n+1,0],[n,1],[n,0]]]},style:{color:'#ffffff'}}];
 try{
  await group.update(rows(0));const active=group.update(rows(1));
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  const skipped=group.update(rows(2)),latest=group.update(rows(3));
  await skipped;release();await Promise.all([active,latest]);
  assert.deepEqual(writes,[1,3]);
  const pending=group.update(rows(4));group.dispose();await pending;
  assert.equal(group.pending,false);assert.equal(sources.size,0);
 }finally{group.dispose();}
});
