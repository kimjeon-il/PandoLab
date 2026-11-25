import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createMapLibreLabelPresentation} from '../../../src/rendering/maplibre-label-presentation.js';
import {bufferedPlaceBounds,selectPlaceLabelCandidates,territorialLabelShortSide,TERRITORIAL_NAME_SIZE,territorialNameUnits} from '../../../src/rendering/label-layout.js';
import {referenceZoomPixelsPerDegree} from '../../../src/map/map-display-zoom.js';
import {createCountryIndex} from '../../../src/map/country-index.js';
import {countryGeometrySignature} from '../../../src/rendering/country-shared-boundary-cache.js';
import {createGeometryVersionStore} from '../../../src/geometry/geometry-version-store.js';
import {createLabelGlyphPreparation} from '../../../scripts/lib/maplibre-label-glyphs.mjs';

test('pending glyphs share rasterization and yield between bounded batches',async()=>{
 const frames=[],drawn=[];let time=0;
 const prepare=createLabelGlyphPreparation({now:()=>time,schedule:task=>frames.push(task)});
 const font={};
 const draw=text=>()=>{time+=4;drawn.push(text);return text;};
 const a=prepare(font,'가',draw('가'));
 assert.strictEqual(prepare(font,'가',()=>assert.fail('duplicate draw')),a);
 const b=prepare(font,'나',draw('나'));
 const alternate=prepare({},'가',draw('bold 가'));
 frames.shift()();assert.deepEqual(drawn,['가']);
 frames.shift()();assert.deepEqual(drawn,['가','나']);
 frames.shift()();assert.deepEqual(await Promise.all([a,b,alternate]),['가','나','bold 가']);
 assert.equal(frames.length,0);
});

const requireMapLibre=createRequire(import.meta.resolve('maplibre-gl/package.json'));
const {expression,latest}=requireMapLibre('@maplibre/maplibre-gl-style-spec');
function compileSize(value,property){
 const result=expression.createPropertyExpression(value,property,latest.layout_symbol[property]);
 assert.equal(result.result,'success',JSON.stringify(result.value));
 return result.value;
}
const nameSize=compileSize(TERRITORIAL_NAME_SIZE,'text-size');
function sizeAt(territorialShortSide,zoom,territorialNameUnits=1){
 return nameSize.evaluate({zoom},{properties:{territorialShortSide,territorialNameUnits}});
}

test('territorial symbols scale with the component near the anchor',()=>{
 const bounds=[[0,0,40,70],[150,20,300,80]];
 assert.equal(territorialLabelShortSide(bounds,[20,30]),40);
 assert.equal(territorialLabelShortSide(bounds,[200,75]),150);
 assert.equal(territorialLabelShortSide(bounds,[-160,75]),150);
 assert.equal(territorialLabelShortSide([],[0,0]),0);
});

test('territorial names keep a 13px minimum and increase their size contrast',()=>{
 const zoom=3;
 const size=shortSide=>sizeAt(shortSide/referenceZoomPixelsPerDegree(zoom),zoom);
 assert.equal(size(21),13);
 assert.equal(size(22),13);
 assert.equal(size(84.5),18);
 assert.equal(size(147),23);
 assert.equal(size(293.5),34);
 assert.equal(size(440),45);
 assert.equal(size(800),45);
});

test('large territorial names grow smoothly to 80px and long names have a conservative fit limit',()=>{
 const size=(zoom,width=100)=>sizeAt(width,zoom);
 assert.equal(size(4),45);
 assert.equal(size(6),60);
 assert.ok(Math.abs(size(7.5)-70)<1e-8);
 assert.equal(size(9),80);
 assert.equal(size(12),80);
 assert.equal(size(9,.01),13);
 const low=size(4,4),high=size(5,4),middle=size(4.25,4);
 assert.ok(Math.abs(middle-(low+(high-low)*.25))<1e-8);
 assert.equal(territorialNameUnits([{text:'대한민국'}]),4);
 assert.ok(territorialNameUnits([{text:'대한민국'},{text:'Republic of Korea'}])>4);
 const width=147/referenceZoomPixelsPerDegree(3);
 assert.ok(sizeAt(width,3,8)<sizeAt(width,3,2));
 assert.equal(sizeAt(.01,3,20),13);
});

test('place query keeps its buffered bounds through small pans and longitude wraps',()=>{
 const coverage=bufferedPlaceBounds([170,-10,190,10],null);
 assert.deepEqual(coverage,[167,-13,193,13]);
 assert.equal(bufferedPlaceBounds([-188,-11,-168,9],coverage),coverage);
 assert.notEqual(bufferedPlaceBounds([-185,-11,-165,9],coverage),coverage);
 assert.deepEqual(bufferedPlaceBounds([-180,75,180,89],null),[-180,72.9,180,90]);
});

test('matching baked anchors avoid browser geometry work but changed shapes still use the worker',async()=>{
 const previous={document:globalThis.document,Worker:globalThis.Worker};globalThis.document={hidden:false};let requests=0,generation=1;
 globalThis.Worker=class{postMessage(){requests++;}terminate(){}};
 const feature={id:'A',geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[0,1],[0,0]]]}},state={countryVisualPhase:'canonical'};
 const ref={id:'geometry:A',version:1},copy=geometry=>createGeometryVersionStore([{...ref,geojson:structuredClone(geometry)}]).get(ref);feature.geometry=copy(feature.geometry);
 const buildMeta={projectCatalogs:{world:{sha256:'world'},territorial:{sha256:'territory'}},countryBoundarySeed:{worldCatalogSha256:'world',territorialCatalogSha256:'territory',labelAnchors:{A:{signature:countryGeometrySignature(feature),coordinates:[.2,.2]}}}};
 const index=createCountryIndex({buildMeta});index.connect({projectState:{state,mapWorkScheduler:{cancel(){},scheduleIdle(){}}},countries:{builtinTerritorialScene:()=>({labelById:new Map([['A',feature]])}),territorialLabelFeatureById:()=>feature},objectDisplay:{invalidateObjectPresentation(){}},platform:{runtimeAssetUrl:()=>''},domains:{projectDomain:{getGeneration:()=>generation},renderingDomain:{invalidateLabels(){}}}});
 index.initializeCountryLandRevision();index.initializeCountryLabelAnchorWorker();index.initializeLabelFallbackQueue();
 try{index.scheduleCountryLabelAnchors(null,0);await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(index.countryLabelAnchors.get('A'),[.2,.2]);assert.equal(requests,0);
  const anchor=index.countryLabelAnchors.get('A');feature.geometry=copy(feature.geometry);index.scheduleCountryLabelAnchors(null,0);assert.equal(index.countryLabelAnchors.get('A'),anchor,'a copied Core geometry version reuses its accepted anchor');
  generation=2;feature.geometry=copy({type:'Polygon',coordinates:[[[0,0],[2,0],[0,1],[0,0]]]});index.scheduleCountryLabelAnchors(null,0);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(index.countryLabelAnchors.has('A'),false,'another document may reuse the ID/version for a different shape');assert.equal(requests,1);
 }finally{index.resetCountryLabelAnchorRuntime();globalThis.document=previous.document;globalThis.Worker=previous.Worker;}
});

test('computed anchors follow verified geometry content across documents',async()=>{
 const previous={document:globalThis.document,Worker:globalThis.Worker};
 globalThis.document={hidden:false};
 const requests=[];
 let worker,generation=1;
 globalThis.Worker=class{
  constructor(){worker=this;}
  postMessage(request){requests.push(request);}
  terminate(){}
 };
 const ref={id:'geometry:A',version:1};
 const geometry=longitude=>createGeometryVersionStore([{...ref,geojson:{
  type:'Polygon',coordinates:[[[longitude,0],[longitude+1,0],[longitude,1],[longitude,0]]],
 }}]).get(ref);
 const feature={id:'A',geometry:geometry(0)};
 const index=createCountryIndex();
 index.connect({
  projectState:{state:{countryVisualPhase:'canonical'},mapWorkScheduler:{cancel(){},scheduleIdle(){}}},
  countries:{builtinTerritorialScene:()=>({labelById:new Map([['A',feature]])}),territorialLabelFeatureById:()=>feature},
  objectDisplay:{invalidateObjectPresentation(){}},
  platform:{runtimeAssetUrl:()=>''},
  domains:{projectDomain:{getGeneration:()=>generation},renderingDomain:{invalidateLabels(){}}},
 });
 index.initializeCountryLandRevision();index.initializeCountryLabelAnchorWorker();index.initializeLabelFallbackQueue();
 const schedule=async()=>{index.scheduleCountryLabelAnchors(null,0);await new Promise(resolve=>setTimeout(resolve,10));};
 const receive=(request,anchor)=>worker.onmessage({data:{type:'anchors',requestId:request.requestId,
  results:[{id:'A',version:request.items[0].version,anchor}]}});
 try{
  await schedule();
  receive(requests[0],[.2,.2]);
  assert.deepEqual(index.countryLabelAnchors.get('A'),[.2,.2]);
  index.resetCountryLabelAnchorRuntime();generation++;
  feature.geometry=geometry(0);
  await schedule();
  assert.equal(requests.length,1,'identical content can reuse the computed anchor across documents');
  assert.deepEqual(index.countryLabelAnchors.get('A'),[.2,.2]);
  index.resetCountryLabelAnchorRuntime();generation++;
  feature.geometry=geometry(30);
  await schedule();
  assert.equal(requests.length,2,'same ID and version with different content needs a new anchor');
  receive(requests[1],[30.2,.2]);
  assert.deepEqual(index.countryLabelAnchors.get('A'),[30.2,.2]);
 }finally{index.resetCountryLabelAnchorRuntime();globalThis.document=previous.document;globalThis.Worker=previous.Worker;}
});

test('dated anchor preparation starts immediately and rejects obsolete generation and geometry results',async()=>{
 const previous={document:globalThis.document,Worker:globalThis.Worker};globalThis.document={hidden:false};
 const requests=[],scheduled=new Map();let worker,generation=1,temporalPending=true,publications=0;
 globalThis.Worker=class{constructor(){worker=this;}postMessage(value){requests.push(value);}terminate(){}};
 const shape=x=>({id:'A',geometry:{type:'Polygon',coordinates:[[[x,0],[x+1,0],[x,1],[x,0]]]}});
 let feature=shape(0);const state={countryVisualPhase:'canonical',mapMoving:false};
 const index=createCountryIndex();
 index.connect({projectState:{state,mapWorkScheduler:{cancel:key=>scheduled.delete(key),scheduleIdle:(key,callback)=>scheduled.set(key,callback)}},
  countries:{builtinTerritorialScene:()=>({labelById:new Map([['A',feature]])}),territorialLabelFeatureById:()=>feature},
  objectDisplay:{invalidateObjectPresentation(){}},platform:{runtimeAssetUrl:()=>''},domains:{projectDomain:{getGeneration:()=>generation},renderingDomain:{invalidateLabels(){publications++;},isPreparingTemporalFrame:()=>temporalPending}}});
 index.initializeCountryLandRevision();index.initializeCountryLabelAnchorWorker();index.initializeLabelFallbackQueue();
 const wait=()=>new Promise(resolve=>setTimeout(resolve,10));
 const answer=(request,anchor)=>worker.onmessage({data:{type:'anchors',requestId:request.requestId,results:[{id:'A',version:request.items[0].version,anchor}]}});
 try{
  index.scheduleCountryLabelAnchors(null,0);await wait();
  assert.equal(requests.length,1,'An accepted dated view may prepare its anchors before publication');
  generation=2;feature=shape(2);index.scheduleCountryLabelAnchors(null,0);
  answer(requests[0],[.2,.2]);await wait();
  assert.equal(index.countryLabelAnchors.size,0);assert.equal(publications,0);
  assert.equal(requests.length,2);assert.equal(requests[1].generation,2);
  feature=shape(4);index.scheduleCountryLabelAnchors(null,0);
  answer(requests[1],[2.2,.2]);await wait();
  assert.equal(index.countryLabelAnchors.size,0);assert.equal(requests.length,3);assert.equal(publications,0);
  answer(requests[2],[4.2,.2]);
  assert.deepEqual(index.countryLabelAnchors.get('A'),[4.2,.2]);
  assert.equal(publications,1,'The current dated result wakes the rendering domain immediately');
  temporalPending=false;feature=shape(6);index.scheduleCountryLabelAnchors(null,0);await wait();
  answer(requests[3],[6.2,.2]);
  assert.equal(publications,1,'Ordinary background results still coalesce');
  const publish=scheduled.get('country-label-anchor-publication');assert.equal(typeof publish,'function');publish();
  assert.equal(publications,2);
 }finally{index.resetCountryLabelAnchorRuntime();globalThis.document=previous.document;globalThis.Worker=previous.Worker;}
});

test('hidden high priority places cannot exhaust the visible place candidate budget',()=>{
 const hidden=Array.from({length:128},(_,i)=>({key:'hidden-'+i,priority:100,viewportVisible:false}));
 const visible={key:'visible-city',priority:40,viewportVisible:true};
 const selected=selectPlaceLabelCandidates([...hidden,visible],128);
 assert.equal(selected.length,129);assert.equal(selected[0],visible);
});

test('accepted city records stay warm across views and expire with the project date',async()=>{
 const {createPlaceRuntime}=await import('../../../src/data/place-runtime.js');
 const make=(sourceId,lon)=>({source:'fixture',sourceId,name:sourceId,coordinates:[lon,0]});
 let presentation={month:'2025-01'};
 const runtime=createPlaceRuntime({manifestUrl:'https://fixture.test/places.json',
  getPresentation:()=>presentation,admitReferences:async()=>{},onError:assert.fail,
  rpc:{async request(_method,{view}){
   const records=view.presentation.month[0]==='-'?[]:[make(view.bounds[0]===0?'west':'east',view.bounds[0])];
   return {result:{records,signature:String(view.bounds[0])}};
  },stop(){}}});
 const read=()=>runtime.snapshot().records.map(row=>row.sourceId).sort();
 try{
  await runtime.settle({bounds:[0,0,10,10],presentation});assert.deepEqual(read(),['west']);
  await runtime.settle({bounds:[10,0,20,10],presentation});assert.deepEqual(read(),['east','west']);
  presentation={month:'-1000-01'};
  await runtime.settle({bounds:[10,0,20,10],presentation});assert.deepEqual(read(),[]);
  runtime.resetProject();assert.deepEqual(read(),[]);
 }finally{runtime.dispose();}
});

test('superseded place viewport results cannot publish before the final settled view',async()=>{
 const {createPlaceRuntime}=await import('../../../src/data/place-runtime.js');
 const calls=[],published=[];let presentation=null;
 const runtime=createPlaceRuntime({manifestUrl:'https://fixture.test/places.json',getPresentation:()=>presentation,admitReferences:async()=>{},onSnapshot:snapshot=>published.push(snapshot),rpc:{request(_method,payload){return new Promise(resolve=>calls.push({payload,resolve}));},stop(){}}});
 const a={bounds:[0,0,10,10]},b={bounds:[10,0,20,10]},c={bounds:[20,0,30,10]};
 try{
  runtime.beginInteraction();const first=runtime.prepare(a);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,1,'Dragging must not postpone the viewport request until moveend');
  runtime.prepare(b);let settled=false;
  const final=runtime.settle(c).then(()=>{settled=true;});
  assert.equal(calls.length,1,'Keep only one running viewport query');
  calls[0].resolve({result:{records:[],signature:'a'}});await first;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(published.length,0,'The obsolete viewport cannot publish or replace the current view');
  assert.equal(calls.length,2);assert.deepEqual(calls[1].payload.view,c);
  assert.equal(settled,false,'A protected frame must wait for the requested final viewport');
  calls[1].resolve({result:{records:[],signature:'c'}});await final;
  assert.equal(runtime.snapshot().signature,'c');
  const stale=runtime.prepare(b);await new Promise(resolve=>setImmediate(resolve));
  runtime.resetProject();
  calls[2].resolve({result:{records:[],signature:'stale'}});await stale;
  assert.equal(runtime.snapshot().revision,0);
  presentation={month:'2025-12'};const dated=runtime.prepare({...a,presentation});await new Promise(resolve=>setImmediate(resolve));
  presentation={month:'2024-12'};calls[3].resolve({result:{records:[],signature:'wrong-date'}});await dated;
  assert.equal(runtime.snapshot().revision,0,'A late viewport response cannot publish into another displayed month');
 }finally{runtime.dispose();}
});

test('text-only territorial labels reuse tiles and change selection without feature state',async()=>{
 const previous=globalThis.document;globalThis.document={baseURI:'https://fixture.test/'};
 const sources=new Map(),layers=new Map(),errors=[],diffs=[];
 let fontWrites=0,fullUploads=0,selected=null,moving=false,faces={External:[{url:'external.woff2'}]};
 const map={isMoving:()=>moving,getFontFaces:()=>faces,setFontFaces:value=>{faces=value;fontWrites++;},getSource:id=>sources.get(id),getLayer:id=>layers.get(id),loadImage:assert.fail,addImage:assert.fail,
  addSource:(id,value)=>sources.set(id,{...value,on(_type,listener){this.listener=listener;},off(){this.listener=null;},
   async setData(data){fullUploads++;this.data=data;},
   async updateData(diff){
    diffs.push(diff);
    this.data.features=[...this.data.features.filter(feature=>!diff.remove.includes(feature.id)),...diff.add];
    for(const update of diff.update){
     const feature=this.data.features.find(f=>f.id===update.id);
     for(const {key,value} of update.addOrUpdateProperties)feature.properties[key]=value;
    }
   }
  }),addLayer:layer=>layers.set(layer.id,layer),removeLayer:id=>layers.delete(id),removeSource:id=>sources.delete(id),setPaintProperty(){assert.fail('Unchanged paint must not be reapplied');},setFeatureState:assert.fail,removeFeatureState:assert.fail};
 const resources={getState:()=>({layerVisibility:{labels:false}}),getTerritorialLabelRef:id=>({id,key:'territorial:entity:'+id}),automaticLabelSettings:()=>({}),labelSettings:()=>({}),countryLabelAnchors:()=>new Map(['a','b','c'].map(id=>[id,[0,0]])),selectionHas:ref=>ref.id===selected};
 let activeLayout;
 const presentation=createMapLibreLabelPresentation({renderer:{map},labels:resources,onChange(){},onSourceError:error=>errors.push(error)});
 const layout=ids=>({territorialLabels:ids.map(id=>({id})),territorialLabelRows:new Map(ids.map(id=>[id,[{text:id}]])),territorialLabelShortSides:new Map(ids.map(id=>[id,8])),userLabels:[]});
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 const show=async ids=>{activeLayout=layout(ids);presentation.renderTerritorialLabels(activeLayout);await flush();};
 const rows=()=>sources.get('viewer-labels').data.features.map(f=>f.properties);
 try{
  await show(['a','b']);
  assert.deepEqual(rows().map(row=>row.primary),['a','b']);
  assert.ok(rows().every(row=>!Object.hasOwn(row,'icon')));
  assert.equal(presentation.pending,false);
  assert.deepEqual(rows().map(({territorialShortSide})=>territorialShortSide),[8,8]);
  const countryLayout=layers.get('viewer-label-country').layout;
  assert.equal(countryLayout['text-justify'],'center');
  assert.equal(countryLayout['icon-image'],undefined);
  assert.equal(countryLayout['text-anchor'],'center');
  assert.match(faces[countryLayout['text-font'][0]][0].url,/Pretendard-ExtraBold\.woff2$/);
  const cityLayout=layers.get('viewer-label-text').layout;
  assert.equal(cityLayout['text-anchor'],'left');
  assert.ok(cityLayout['text-offset'][0]>0);
  assert.equal(cityLayout['text-variable-anchor'],undefined);
  const labelPaint=()=>['viewer-label-country','viewer-label-text'].map(id=>layers.get(id).paint['text-color']);
  assert.deepEqual(labelPaint(),['#343840','#343840']);
  const markerColor=expression.createPropertyExpression(layers.get('viewer-label-dot').paint['circle-color'],
   'circle-color',latest.paint_circle['circle-color']);
  assert.equal(markerColor.result,'success');
  const color=(markerRing,selected)=>markerColor.value.evaluate({zoom:5},{properties:{markerRing,selected}});
  assert.equal(color(true,true).a,0);
  assert.equal(color(false,true).a,1);
  assert.notDeepEqual(color(false,true),color(false,false));
  const writes=diffs.length;
  presentation.renderTerritorialLabels(activeLayout);await flush();
  assert.equal(diffs.length,writes,'unchanged sizes and coordinates must reuse the label tiles');
  activeLayout.territorialLabels=activeLayout.territorialLabels.filter(item=>item.id!=='a');
  presentation.renderTerritorialLabels(activeLayout,{deferWhileMoving:true});
  moving=true;await flush();
  assert.equal(diffs.length,writes,'A newly started gesture defers a queued viewport label write');
  assert.equal(presentation.pending,false);
  moving=false;
  presentation.renderTerritorialLabels(activeLayout);await flush();
  assert.deepEqual(rows().map(row=>row.primary),['b']);
  selected='b';await show(['a','b']);assert.equal(rows().find(row=>row.primary==='b').selected,true);
  assert.deepEqual(labelPaint(),['#343840','#343840']);
  assert.ok(diffs.at(-1).update.find(row=>row.id==='territorial:entity:b').addOrUpdateProperties.some(p=>p.key==='selected'&&p.value===true));
  await show(['b','c']);
  assert.deepEqual(rows().map(row=>row.primary),['b','c']);
  assert.ok(rows().every(row=>!Object.hasOwn(row,'icon')));
  assert.equal(fullUploads,1);assert.equal(fontWrites,1);assert.equal(faces.External[0].url,'external.woff2');
  sources.get('viewer-labels').listener({error:new Error('font unavailable')});
  assert.equal(errors.length,1);assert.equal(presentation.pending,false);await show(['b','c']);assert.equal(sources.size,0);
  presentation.retry();
  await show(['b','c']);
  assert.deepEqual(rows().map(row=>row.primary),['b','c']);
 }
 finally{presentation.dispose();globalThis.document=previous;}
});

test('geographic label selection includes a wrapped viewport without projecting every candidate',async()=>{
 const {coordinateInGeographicBounds}=await import('../../../src/rendering/label-layout.js');
 const bounds=[175,-20,190,20];
 assert.equal(coordinateInGeographicBounds([179,0],bounds),true);
 assert.equal(coordinateInGeographicBounds([-178,0],bounds),true);
 assert.equal(coordinateInGeographicBounds([-169,0],bounds),false);
 assert.equal(coordinateInGeographicBounds([179,30],bounds),false);
 assert.equal(coordinateInGeographicBounds([0,0],[-180,-90,180,90]),true);
 assert.equal(coordinateInGeographicBounds([0,0],null),true,'unknown bounds cannot hide selected place data');
 assert.equal(coordinateInGeographicBounds([0,100],null),false);
});
