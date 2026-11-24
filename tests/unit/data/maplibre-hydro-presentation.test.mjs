import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapLibreHydroPresentation,hiddenMapLibreHydroIds,mapLibreHydroStyle,syncMapLibreHydroVisibility,prepareMapLibreHydroFeatures,riverWidthAtZoom,joinHydroLineParts} from '../../../src/rendering/maplibre-hydro-presentation.js';
import {resolveMapLibreMapStyle} from '../../../src/rendering/maplibre-map-style.js';
import {hydroDisplayStages,hydroLakeDisplayMinZoom} from '../../../src/map/map-display-zoom.js';
import {hydroDisplayReview,applyReviewedHydroReaches} from '../../../tools/gis/hydro-display-review.mjs';

test('reviewed Hydro source cuts and traced centerlines preserve unrelated reaches and junctions',()=>{
 const sourceSha256='a'.repeat(64),sources=[{specification:{datasetCode:'af',files:[{file:'af.shp',sha256:sourceSha256}]}}];
 const inside=[[0,0],[0.0005,0.01],[0.01,0.02]];
 const region={datasetCode:'af',sourceSha256,exclusions:[{systemId:'20',reachIds:[2],evidence:['review']}],
  replacements:[{id:3,systemId:'20',evidence:['review'],sourceStart:inside[0],sourceEnd:inside.at(-1),coordinates:inside}]};
 const review=hydroDisplayReview({version:1,regions:[region]},sources).get('af');
 const reaches=[{id:1,next:2,mainRiver:20,endorheic:true},{id:2,next:3,mainRiver:20,endorheic:true},
  {id:3,next:4,mainRiver:20,width:1.1,parts:[[[0,0],[0,0.01],[0.01,0.02]]]},
  {id:4,next:0,mainRiver:20,parts:[[[0.01,0.02],[0.02,0.04]]]}];
 const [first,redrawn,untouched]=applyReviewedHydroReaches(reaches,review);
 assert.equal(first.next,0);assert.equal(redrawn.width,1.1);assert.deepEqual(redrawn.parts,[inside]);
 assert.equal(untouched,reaches[3]);assert.deepEqual(redrawn.parts[0].at(-1),untouched.parts[0][0]);
 assert.throws(()=>applyReviewedHydroReaches([{...reaches[0],endorheic:false},...reaches.slice(1)],review),/outward-draining/);
 assert.throws(()=>applyReviewedHydroReaches([reaches[0],{...reaches[1],mainRiver:99}],review),/another source system/);
 const moved={...region,replacements:[{...region.replacements[0],coordinates:[...inside.slice(0,-1),[0.01,0.03]]}]};
 assert.throws(()=>applyReviewedHydroReaches(reaches,hydroDisplayReview({version:1,regions:[moved]},sources).get('af')),/disconnects its downstream/);
});

test('hydro display joins consecutive exact endpoints within one feature',()=>{
 const geometry={type:'MultiLineString',coordinates:[
  [[0,0],[1,1]],[[1,1],[2,2]],[[2,2],[3,3]],[[3.000001,3],[4,4]],
 ]};
 const original=structuredClone(geometry);
 assert.deepEqual(joinHydroLineParts(geometry),{type:'MultiLineString',coordinates:[
  [[0,0],[1,1],[2,2],[3,3]],[[3.000001,3],[4,4]],
 ]});
 assert.deepEqual(geometry,original);
 const independent={type:'LineString',coordinates:[[4,4],[5,5]]};
 assert.equal(joinHydroLineParts(independent),independent);
});

test('visible rivers taper from 1.5px to 1px without changing their zoom thresholds',()=>{
 const {paint}=resolveMapLibreMapStyle({palette:{strokes:{river:{width:1}}}});
 const rivers=mapLibreHydroStyle({stylePaint:paint}).layers.filter(layer=>layer.type==='line');
 for(const [index,layer] of rivers.entries()){
  assert.deepEqual(layer.paint['line-width'],['interpolate',['linear'],['zoom'],3,1.5,4,1]);
  assert.deepEqual(layer.paint['line-opacity'],['step',['zoom'],0,index+2,1]);
 }
 assert.deepEqual([2,3,3.5,4,5].map(zoom=>riverWidthAtZoom(zoom,1)),[1.5,1.5,1.25,1,1]);
});

test('optional water publication yields before aggregation and rejects a disposed result',async()=>{
 let release,entered=false,admitted=0,updated=0;
 const map={getCenter:()=>({lng:0,lat:0}),getZoom:()=>1,getCanvas:()=>({clientWidth:100,clientHeight:100}),on(){},off(){}};
 const water=createMapLibreHydroPresentation({map,beforePublish:()=>{entered=true;return new Promise(resolve=>{release=resolve;});},
  admitFeatures:async()=>{admitted++;},updateSource:async()=>{updated++;return true;},onFeatures(){},onError:error=>{throw error;},
  load:async()=>({key:'late',addPacks:[{id:1,features:[{id:'a',properties:{logicalId:'a'}}]}]})});
 const pending=water.refresh();while(!entered)await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(admitted,0);assert.equal(updated,0);water.dispose();release();await pending;
 assert.equal(admitted,0);assert.equal(updated,0);
});

test('hydro presentation groups selectable fragments and applies visibility thresholds',()=>{
 const stages=hydroDisplayStages([6,6.7,7,7.5].map((minZoom,id)=>({id,minZoom})));
 const fragment=(id,coordinates,stage=0)=>({type:'Feature',id:id+coordinates[0][0],geometry:{type:'LineString',coordinates},properties:{logicalId:id,category:'river',layerId:'rivers',stage}});
 const features=[fragment('a',[[0,0],[1,0]]),fragment('a',[[1,0],[2,0]]),fragment('b',[[2,0],[3,0]],3)];
 const prepared=prepareMapLibreHydroFeatures(features,feature=>feature);
 assert.deepEqual(prepared.map(feature=>[feature.id,feature.geometry.coordinates.length]),[['a',2],['b',1]]);
 assert.deepEqual(hiddenMapLibreHydroIds(features,feature=>feature.id==='b'),['a']);
 assert.deepEqual(stages.map(stage=>stage.minZoom),[2,3,4,5]);
 for(const [type,attribute] of [['line','line-opacity'],['fill','fill-opacity']])
  assert.deepEqual(mapLibreHydroStyle().layers.filter(layer=>layer.type===type).map(layer=>layer.paint[attribute][3]),stages.map(stage=>stage.minZoom));
});

test('hydro presentation applies layer filters and visibility to the existing source',()=>{
 const calls=[],filters=new Map(mapLibreHydroStyle().layers.map(layer=>[layer.id,layer.filter])),visibility=new Map();
 const map={getFilter:id=>filters.get(id),getLayoutProperty:id=>visibility.get(id),
  setFilter:(id,filter)=>{calls.push(id);filters.set(id,filter);},
  setLayoutProperty:(id,_key,value)=>{calls.push(id);visibility.set(id,value);}};
 for(let i=0;i<2;i++)syncMapLibreHydroVisibility(map,['old-river'],{rivers:false,lakes:true});
 assert.equal(calls.length,16,'Unchanged filters and visibility must not reload native tiles');
 assert.deepEqual(filters.get('rivers').at(-1),['!',['in',['get','logicalId'],['literal',['old-river']]]]);
 assert.equal(visibility.get('rivers'),'none');
});

test('lake display zoom weighs both surface area and effective width',()=>{
 assert.equal(hydroLakeDisplayMinZoom(82078,53),2,'a broad large lake opens at the first stage');
 assert.equal(hydroLakeDisplayMinZoom(19427,26),2,'a Great Lake remains visible at the first stage');
 assert.equal(hydroLakeDisplayMinZoom(19427,8),4,'equal area does not put a long narrow lake at the same zoom');
 assert.equal(hydroLakeDisplayMinZoom(485,10),4,'a medium lake waits despite sufficient width');
 assert.equal(hydroLakeDisplayMinZoom(1247,5),5,'a narrow lake waits for the finest existing stage');
 assert.equal(hydroLakeDisplayMinZoom(20,2),5,'small lakes retain their finest-stage display');
});

test('a superseded water request cannot replace the latest view',async()=>{
 const tasks=[],published=[];
 const map={getCenter:()=>({lng:0,lat:0}),getZoom:()=>4,getCanvas:()=>({clientWidth:100,clientHeight:100}),
  getSource:()=>({updateData:async data=>published.push(data)}),on(){},off(){}};

 const water=createMapLibreHydroPresentation({map,updateSource:async(diff)=>{await map.getSource('hydro').updateData(diff);return true;},admitFeatures:async()=>{},onFeatures:()=>{},load:()=>new Promise(resolve=>tasks.push(resolve)),onError:error=>{throw error;}});
 const first=water.refresh();while(!tasks.length)await new Promise(resolve=>setTimeout(resolve,0));const second=water.refresh();
 tasks[0]({key:'old',addPacks:[],removePacks:[]});await first;while(tasks.length<2)await new Promise(resolve=>setTimeout(resolve,0));
 tasks[1]({key:'new',addPacks:[{id:1,features:[{id:'new',properties:{logicalId:'new',category:'lake'}}]}],removePacks:[]});await second;
 assert.equal(published.length,1);assert.equal(published[0].add[0].id,'new');water.dispose();
});
test('an unchanged active pack set does not transfer or replace water data again',async()=>{
 let count=0;const map={getCenter:()=>({lng:0,lat:0}),getZoom:()=>4,getCanvas:()=>({clientWidth:1,clientHeight:1}),getSource:()=>({updateData:async()=>{count++;}}),on(){},off(){}};
 const water=createMapLibreHydroPresentation({map,updateSource:async(diff)=>{await map.getSource('hydro').updateData(diff);return true;},admitFeatures:async()=>{},onFeatures:()=>{},load:async({knownKey})=>knownKey==='same'?{key:'same'}:{key:'same',addPacks:[{id:1,features:[{id:'a',properties:{logicalId:'a',category:'lake'}}]}],removePacks:[]},onError:error=>{throw error;}});
 await water.refresh();await water.refresh();assert.equal(count,1);water.dispose();
});
test('water updates only added and removed packs',async()=>{
 const diffs=[];const map={getCenter:()=>({lng:0,lat:0}),getZoom:()=>4,getCanvas:()=>({clientWidth:1,clientHeight:1}),getSource:()=>({updateData:async diff=>diffs.push(diff)}),on(){},off(){}};
 let n=0;const feature=(id)=>({id,properties:{logicalId:id,category:'lake',sourceId:''}});
 const water=createMapLibreHydroPresentation({map,updateSource:async(diff)=>{await map.getSource('hydro').updateData(diff);return true;},admitFeatures:async()=>{},onFeatures:()=>{},load:async()=>++n===1?{key:'1',addPacks:[{id:1,features:[feature('a')]}],removePacks:[]}:{key:'2',addPacks:[{id:2,features:[feature('b')]}],removePacks:[1]},onError:error=>{throw error;}});
 await water.refresh();await water.refresh();assert.deepEqual(diffs[0].add.map(f=>f.id),['a']);assert.deepEqual(diffs[1].remove,['a']);assert.deepEqual(diffs[1].add.map(f=>f.id),['b']);water.dispose();
});
test('a newer viewport retargets the loader without cancelling its shared downloads',async()=>{
 let rejectLoad,cancellations=0,loads=0;const map={getCenter:()=>({lng:0,lat:0}),getZoom:()=>4,getCanvas:()=>({clientWidth:1,clientHeight:1}),getSource:()=>({updateData:async()=>{}}),on(){},off(){}};
 const water=createMapLibreHydroPresentation({map,updateSource:async(diff)=>{await map.getSource('hydro').updateData(diff);return true;},admitFeatures:async()=>{},onFeatures:()=>{},
  load:()=>{
   if(++loads===1)return new Promise((_resolve,reject)=>{rejectLoad=reject;});
   rejectLoad(new DOMException('superseded','AbortError'));
   return Promise.resolve({key:'new',addPacks:[],removePacks:[]});
  },cancel:()=>{cancellations++;},onError:error=>{throw error;}});
 const first=water.refresh();while(!rejectLoad)await new Promise(resolve=>setTimeout(resolve,0));const second=water.refresh();
 await Promise.all([first,second]);assert.equal(loads,2);assert.equal(cancellations,0);water.dispose();
});

test('a superseded source update is not published as the current selection catalog',async()=>{
 let release;const published=[],known=[],diffs=[];
 const source={updateData:async diff=>{diffs.push(diff);if(diffs.length===1)await new Promise(resolve=>{release=resolve;});}};
 const map={getCenter:()=>({lng:0,lat:0}),getZoom:()=>4,getCanvas:()=>({clientWidth:1,clientHeight:1}),getSource:()=>source,on(){},off(){}};
 const feature=id=>({id,properties:{logicalId:id,category:'lake'}});
 const water=createMapLibreHydroPresentation({map,updateSource:async(diff)=>{await map.getSource('hydro').updateData(diff);return true;},admitFeatures:async()=>{},onFeatures:features=>published.push(features.map(f=>f.id)),
  load:async({knownKey})=>{const id=known.push(knownKey);return {key:String(id),packIds:[id],packs:[{id,features:[feature(id===1?'a':'b')]}]};},onError:error=>{throw error;}});
 const first=water.refresh();while(!release)await new Promise(resolve=>setTimeout(resolve,0));
 const second=water.refresh();release();await Promise.all([first,second]);
 assert.deepEqual(known,[null,null]);
 assert.deepEqual(diffs[1].remove,['a']);
 assert.deepEqual(published,[['b']]);water.dispose();
});

test('an existing water scene keeps its coverage until one final viewport delivery',async()=>{
 const layouts=new Map(),shown=[],writes=[];let generation=0,notify,last,moving=false;
 const map={getCenter:()=>({lng:generation,lat:0}),getZoom:()=>4,getCanvas:()=>({clientWidth:1,clientHeight:1}),
  isMoving:()=>moving,on:(type,fn)=>layouts.set(type,fn),off(){}};
 const pack=id=>({id,features:[{id:String(id),properties:{logicalId:String(id)}}]});
 const water=createMapLibreHydroPresentation({map,viewportTiles:()=>[{stage:'base',x:generation,y:0}],
  updateSource:async diff=>{writes.push(diff);return true;},admitFeatures:async()=>true,
  onFeatures:features=>shown.push(features.map(feature=>feature.id)),onError:assert.fail,
  load:async(_view,_current,{onProgress})=>{
   if(!generation)return {key:'1',packIds:[1],packs:[pack(1)]};
   notify=onProgress;return new Promise(resolve=>{last=resolve;});
  }});
 try{
  await water.refresh();generation=1;moving=true;
  const pending=water.refresh();
  await new Promise(resolve=>setImmediate(resolve));
  notify({packs:[pack(2)]});
  notify({packs:[pack(3)]});
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.deepEqual(shown,[['1']],'Download progress must not re-tile the active drag');
  moving=false;layouts.get('moveend')();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(shown,[['1']],'Settling the camera must not flush an intermediate source delta');
  assert.equal(water.canPick('2','2'),false);
  last({key:'2,3',packIds:[2,3],packs:[pack(2),pack(3)]});await pending;
  assert.equal(writes.length,2);
  assert.deepEqual(writes.at(-1).add.map(feature=>feature.id),['2','3']);
  assert.deepEqual(writes.at(-1).remove,['1']);
  assert.deepEqual(shown.at(-1),['2','3']);
 }finally{water.dispose();}
});

test('completed motion-time windows submit only the final settled pack set',async()=>{
 const events=new Map(),writes=[];let x=0,moving=false,completed;
 const map={getCenter:()=>({lng:x,lat:0}),getZoom:()=>4,getCanvas:()=>({clientWidth:1,clientHeight:1}),
  isMoving:()=>moving,on:(type,fn)=>events.set(type,fn),off(){}};
 const water=createMapLibreHydroPresentation({map,viewportTiles:()=>[{stage:'base',x,y:0}],
  updateSource:async diff=>{writes.push(diff);return true;},admitFeatures:async()=>true,onFeatures:()=>{},onError:assert.fail,
  load:async({center:[id]})=>{completed=id;return {key:String(id),packIds:[id],packs:[{id,features:[{id:String(id),properties:{logicalId:String(id)}}]}]};}});
 try{
  await water.refresh();moving=true;x=1;
  const old=water.refresh();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(completed,1);
  assert.equal(writes.length,1);
  x=2;moving=false;await events.get('moveend')();await old;
  assert.deepEqual(writes.map(diff=>diff.add.map(feature=>feature.id)),[['0'],['2']]);
  assert.deepEqual(writes.at(-1).remove,['0']);
 }finally{water.dispose();}
});

test('the latest view publishes a completed pack set even when it uses the same packs',async()=>{
 let release;const published=[];
 const source={updateData:async()=>{await new Promise(resolve=>{release=resolve;});}};
 const map={getCenter:()=>({lng:0,lat:0}),getZoom:()=>4,getCanvas:()=>({clientWidth:1,clientHeight:1}),getSource:()=>source,on(){},off(){}};
 const feature={id:'a',properties:{logicalId:'a',category:'lake'}};
 const water=createMapLibreHydroPresentation({map,updateSource:async(diff)=>{await map.getSource('hydro').updateData(diff);return true;},admitFeatures:async()=>{},onFeatures:features=>published.push(features.map(f=>f.id)),
  load:async({knownKey})=>knownKey==='1'?{key:'1'}:{key:'1',addPacks:[{id:1,features:[feature]}],removePacks:[]},onError:error=>{throw error;}});
 const first=water.refresh();while(!release)await new Promise(resolve=>setTimeout(resolve,0));
 const second=water.refresh();release();await Promise.all([first,second]);
 assert.deepEqual(published,[['a']]);water.dispose();
});

test('the selection owner receives changed fragments for an already known river',async()=>{
 const admitted=[];let index=0;
 const fragment=id=>({id,properties:{logicalId:'river',category:'river'},geometry:{type:'LineString',coordinates:[[index,0],[index+1,0]]}});
 const a=fragment('a'),b=fragment('b');
 const views=[{key:'1',addPacks:[{id:1,features:[a]}]},{key:'1,2',addPacks:[{id:2,features:[b]}]},{key:'2',removePacks:[1]}];
 const map={getCenter:()=>({lng:0,lat:0}),getZoom:()=>4,getCanvas:()=>({clientWidth:1,clientHeight:1}),getSource:()=>({updateData:async()=>{}}),on(){},off(){}};
 const water=createMapLibreHydroPresentation({map,updateSource:async(diff)=>{await map.getSource('hydro').updateData(diff);return true;},admitFeatures:async features=>admitted.push(features.map(feature=>feature.id)),onFeatures:()=>{},load:async()=>views[index++],onError:error=>{throw error;}});
 await water.refresh();await water.refresh();await water.refresh();
 assert.deepEqual(admitted,[['a'],['a','b'],['b']]);water.dispose();
});

test('a superseded admission failure cannot fail the newer water view',async()=>{
 let rejectAdmission,loads=0;const errors=[],published=[];
 const map={getCenter:()=>({lng:0,lat:0}),getZoom:()=>4,getCanvas:()=>({clientWidth:1,clientHeight:1}),getSource:()=>({updateData:async value=>published.push(value)}),on(){},off(){}};
 const water=createMapLibreHydroPresentation({map,updateSource:async(diff)=>{await map.getSource('hydro').updateData(diff);return true;},admitFeatures:()=>rejectAdmission?Promise.resolve():new Promise((_resolve,reject)=>{rejectAdmission=reject;}),onFeatures:()=>{},
  load:async()=>({key:String(++loads),addPacks:[{id:loads,features:[{id:String(loads),properties:{logicalId:'river',category:'river'}}]}]}),onError:error=>errors.push(error)});
 const first=water.refresh();while(!rejectAdmission)await new Promise(resolve=>setTimeout(resolve,0));
 const second=water.refresh();rejectAdmission(new Error('obsolete admission'));
 await Promise.all([first,second]);assert.deepEqual(errors,[]);assert.equal(published.at(-1).add[0].id,'2');water.dispose();
});

test('adding a nearby pack does not readmit unchanged logical water objects',async()=>{
 let index=0;const admitted=[],feature=id=>({id,properties:{logicalId:id,category:'lake'}});
 const views=[{key:'1',addPacks:[{id:1,features:[feature('a')]}]},{key:'1,2',addPacks:[{id:2,features:[feature('b')]}]}];
 const map={getCenter:()=>({lng:0,lat:0}),getZoom:()=>4,getCanvas:()=>({clientWidth:1,clientHeight:1}),getSource:()=>({updateData:async()=>{}}),on(){},off(){}};
 const water=createMapLibreHydroPresentation({map,updateSource:async(diff)=>{await map.getSource('hydro').updateData(diff);return true;},admitFeatures:async features=>admitted.push(features.map(feature=>feature.id)),onFeatures:()=>{},load:async()=>views[index++],onError:error=>{throw error;}});
 await water.refresh();await water.refresh();assert.deepEqual(admitted,[['a'],['b']]);water.dispose();
});

test('water source updates wait while the map style is being rebuilt',async()=>{
 let releaseStyle,source=null,updates=0;const ready=new Promise(resolve=>{releaseStyle=resolve;});
 const map={getCenter:()=>({lng:0,lat:0}),getZoom:()=>4,getCanvas:()=>({clientWidth:1,clientHeight:1}),getSource:()=>source,on(){},off(){}};
 const water=createMapLibreHydroPresentation({map,updateSource:async(diff)=>{await ready;await map.getSource('hydro').updateData(diff);return true;},admitFeatures:async()=>{},onFeatures:()=>{},load:async()=>({key:'new',addPacks:[{id:1,features:[{id:'a',properties:{logicalId:'a',category:'lake'}}]}]}),onError:()=>{}});
 const pending=water.refresh();await new Promise(resolve=>setTimeout(resolve,0));
 source={updateData:async()=>{updates++;}};releaseStyle();await pending;
 assert.equal(updates,1);water.dispose();
});

test('partial water stays optional and only native tiles admitted to Core are selectable',async()=>{
 const handlers=new Map(),errors=[],visible=[];
 let enabled=false,loads=0,releaseTiles,releaseCore;
 const map={getCenter:()=>({lng:0,lat:0}),getZoom:()=>5,getCanvas:()=>({clientWidth:100,clientHeight:100}),
  on:(type,fn)=>handlers.set(type,fn),off:type=>handlers.delete(type)};
 const feature={id:'1:1',properties:{logicalId:'lake-a'}};
 const water=createMapLibreHydroPresentation({map,isEnabled:()=>enabled,updateSource:async()=>true,
  waitForSource:()=>new Promise(resolve=>{releaseTiles=resolve;}),
  admitFeatures:()=>new Promise(resolve=>{releaseCore=resolve;}),onFeatures:features=>visible.push(features),
  load:async()=>{loads++;return {key:'1',addPacks:[{id:1,features:[feature]}],failedPacks:[{id:2,message:'bad pack'}]};},
  onError:error=>errors.push(error),
 });
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 try{
  await handlers.get('moveend')();assert.equal(loads,0);
  enabled=true;const task=water.refresh();await tick();
  assert.equal(water.canPick(feature.id,'lake-a'),false);
  releaseTiles(true);await tick();
  assert.equal(water.canPick(feature.id,'lake-a'),false);
  releaseCore(true);await task;
  assert.equal(water.canPick(feature.id,'lake-a'),true);assert.equal(water.canPick('2:1','lake-a'),false);
  assert.deepEqual(visible,[[feature]]);assert.equal(errors[0].failedPacks[0].id,2);
  enabled=false;water.suspend();await handlers.get('moveend')();assert.equal(loads,1);
  assert.equal(water.canPick(feature.id,'lake-a'),false);
 }finally{water.dispose();}
});


test('hydro selection changes only published packs and retains unchanged fragment eligibility',async()=>{
 let view=0;
 const map={getCenter:()=>({lng:0,lat:0}),getZoom:()=>4,getCanvas:()=>({clientWidth:1,clientHeight:1}),on(){},off(){}};
 const pack=id=>({id,features:[{id:id+':f',properties:{logicalId:'water'+id}}]});
 const first=pack(1),second=pack(2),third=pack(3);
 const water=createMapLibreHydroPresentation({map,updateSource:async()=>true,admitFeatures:async()=>true,
  onFeatures(){},onError:assert.fail,load:async()=>++view===1?{key:'1,2',packs:[first,second],packIds:[1,2]}:
   {key:'2,3',packs:[second,third],packIds:[2,3]}});
 try{
  await water.refresh();
  assert.equal(water.canPick('1:f','water1'),true);
  assert.equal(water.canPick('2:f','water2'),true);
  await water.refresh();
  assert.equal(water.canPick('1:f','water1'),false);
  assert.equal(water.canPick('2:f','water2'),true);
  assert.equal(water.canPick('3:f','water3'),true);
 }finally{water.dispose();}
});


test('project reset readmits the same hydro viewport without rewriting its native source',async()=>{
 const map={getCenter:()=>({lng:0,lat:0}),getZoom:()=>4,getCanvas:()=>({clientWidth:1,clientHeight:1}),on(){},off(){}};
 const pack={id:1,features:[{id:'1:f',properties:{logicalId:'river'}}]};
 let writes=0,admissions=0;
 const water=createMapLibreHydroPresentation({map,updateSource:async()=>{writes++;return true;},
  admitFeatures:async()=>{admissions++;return true;},onFeatures(){},onError:assert.fail,
  load:async()=>({key:'1',packs:[pack],packIds:[1]})});
 try{
  await water.refresh();water.resetAdmission();assert.equal(water.canPick('1:f','river'),false);
  await water.refresh();assert.equal(writes,1);assert.equal(admissions,2);assert.equal(water.canPick('1:f','river'),true);
 }finally{water.dispose();}
});
test('evicted aggregate geometry is retired unless it still belongs to a selection',async()=>{
 const map={getCenter:()=>({lng:0,lat:0}),getZoom:()=>4,getCanvas:()=>({clientWidth:1,clientHeight:1}),on(){},off(){}};
 const pack=id=>({id,features:[{id:id+':f',properties:{logicalId:'river'+id}}]});
 const removals=[];let viewport=1,pinned=true;
 const water=createMapLibreHydroPresentation({map,updateSource:async()=>true,onFeatures(){},onError:assert.fail,
  preserveLogicalId:id=>pinned&&id==='river1',admitFeatures:async(_features,_current,{removedIds}={})=>{removals.push(...removedIds);return true;},
  load:async()=>({key:String(viewport),packs:[pack(viewport)],packIds:[viewport]})});
 try{
  await water.refresh();viewport=2;await water.refresh();assert.deepEqual(removals,[]);
  pinned=false;await water.refresh();assert.deepEqual(removals,['river1']);
 }finally{water.dispose();}
});
