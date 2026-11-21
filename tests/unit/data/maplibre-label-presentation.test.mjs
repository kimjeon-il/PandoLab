import test from 'node:test';
import assert from 'node:assert/strict';
import {createMapLibreLabelPresentation} from '../../../src/rendering/maplibre-label-presentation.js';
import {selectPlaceLabelCandidates,territorialLabelSize} from '../../../src/rendering/label-layout.js';
import {createCountryIndex} from '../../../src/map/country-index.js';
import {countryGeometrySignature} from '../../../src/rendering/country-shared-boundary-cache.js';
import {createGeometryVersionStore} from '../../../src/geometry/geometry-version-store.js';

test('territorial symbols scale with the visible component near the anchor',()=>{
 const bounds=[[0,0,40,250],[150,20,300,180]];
 const frame={size:{width:400,height:400},projectVisibleCoordinate:point=>point};
 assert.deepEqual(territorialLabelSize(bounds,[20,80],frame),{name:13.9,flag:12.9});
 assert.deepEqual(territorialLabelSize(bounds,[200,80],frame),{name:19,flag:18});
 const narrow={...frame,size:{width:22,height:400}};
 assert.deepEqual(territorialLabelSize(bounds,[20,80],narrow),{name:13,flag:12});
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

test('anchor cloning yields to dated frames and retries after an obsolete document response',async()=>{
 const previous={document:globalThis.document,Worker:globalThis.Worker};globalThis.document={hidden:false};
 const requests=[],scheduled=[];let worker,generation=1,temporalPending=true,publications=0;
 globalThis.Worker=class{constructor(){worker=this;}postMessage(value){requests.push(value);}terminate(){}};
 const feature={id:'A',geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[0,1],[0,0]]]}},state={countryVisualPhase:'canonical',mapMoving:false};
 const index=createCountryIndex();
 index.connect({projectState:{state,mapWorkScheduler:{cancel(){},scheduleIdle(_key,callback){scheduled.push(callback);}}},
  countries:{builtinTerritorialScene:()=>({labelById:new Map([['A',feature]])}),territorialLabelFeatureById:()=>feature},
  objectDisplay:{invalidateObjectPresentation(){}},platform:{runtimeAssetUrl:()=>''},domains:{projectDomain:{getGeneration:()=>generation},renderingDomain:{invalidateLabels(){publications++;},isPreparingTemporalFrame:()=>temporalPending}}});
 index.initializeCountryLandRevision();index.initializeCountryLabelAnchorWorker();index.initializeLabelFallbackQueue();
 try{
  index.scheduleCountryLabelAnchors(null,0);await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(requests.length,0,'background geometry cloning cannot compete with a pending dated frame');
  temporalPending=false;scheduled.shift()();assert.equal(requests.length,1);
  generation=2;worker.onmessage({data:{type:'anchors',requestId:requests[0].requestId,results:[{id:'A',version:requests[0].items[0].version,anchor:[.2,.2]}]}});
  assert.equal(index.countryLabelAnchors.size,0,'the obsolete generation cannot publish');assert.equal(scheduled.length,1,'its queued anchor work must resume for the current generation');
  scheduled.shift()();assert.equal(requests.length,2);assert.equal(requests[1].generation,2);
  temporalPending=true;worker.onmessage({data:{type:'anchors',requestId:requests[1].requestId,results:[{id:'A',version:requests[1].items[0].version,anchor:[.2,.2]}]}});
  assert.equal(index.countryLabelAnchors.size,0,'a background result cannot replace labels inside a dated-frame transition');
  temporalPending=false;scheduled.shift()();
  assert.deepEqual(index.countryLabelAnchors.get('A'),[.2,.2]);
  assert.equal(publications,0,'small anchor batches must coalesce before rebuilding the native label tiles');
  for(const callback of scheduled.splice(0))callback();assert.equal(publications,1);
 }finally{index.resetCountryLabelAnchorRuntime();globalThis.document=previous.document;globalThis.Worker=previous.Worker;}
});

test('hidden high priority places cannot exhaust the visible place candidate budget',()=>{
 const hidden=Array.from({length:128},(_,i)=>({key:'hidden-'+i,priority:100,viewportVisible:false}));
 const visible={key:'visible-city',priority:40,viewportVisible:true};
 const selected=selectPlaceLabelCandidates([...hidden,visible],128);
 assert.equal(selected.length,128);assert.ok(selected.includes(visible));
});

test('place viewport results publish during movement and coalesce the next view',async()=>{
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
  assert.equal(published.length,1,'A completed geographic snapshot can publish while dragging');
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

test('optional flag failures never block the dated map and do not retry every frame',async()=>{
 let calls=0;const errors=[];
 const map={loadImage:async()=>{calls++;throw Error('offline');},getLayer:()=>null,getSource:()=>null,hasImage:()=>false};
 const labels=createMapLibreLabelPresentation({renderer:{map},labels:{},onChange(){},onError:error=>errors.push(error)});
 const layout={territorialFlags:new Map([['a',{url:'https://fixture.invalid/flag.svg'}]])};
 assert.equal(labels.prepareFlags(layout),true);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(labels.pending,false);assert.equal(errors.length,1);assert.equal(labels.prepareFlags(layout),true);assert.equal(calls,1);labels.dispose();
});

test('a flag finishing after label disposal cannot recreate an image',async()=>{
 let resolveImage,added=0;
 const map={loadImage:()=>new Promise(resolve=>{resolveImage=resolve;}),getLayer:()=>null,getSource:()=>null,hasImage:()=>false,addImage:()=>added++};
 const labels=createMapLibreLabelPresentation({renderer:{map},labels:{},onChange(){},onError:assert.fail});
 labels.prepareFlags({territorialFlags:new Map([['a',{url:'flag.png'}]])});labels.dispose();resolveImage({data:{width:12,height:8}});await new Promise(resolve=>setImmediate(resolve));assert.equal(added,0);
});

test('neither unchanged nor new pending flags can hold a dated map',()=>{
 const map={loadImage:()=>new Promise(()=>{}),getLayer:()=>null,getSource:()=>null,hasImage:()=>false};
 const presentation=createMapLibreLabelPresentation({renderer:{map},labels:{},onChange(){},onError:assert.fail});
 const layout={territorialFlags:new Map([['same',{url:'same.png'}]])};
 assert.equal(presentation.prepareFlags(layout),true);
 assert.equal(presentation.prepareFlags(layout),true);
 assert.equal(presentation.prepareFlags({territorialFlags:new Map([['new',{url:'new.png'}]])}),true);
 presentation.dispose();
});

test('eligible geographic flags are prepared before panning reveals their hemisphere',async()=>{
 const requests=[],finishes=[];
 const map={loadImage:url=>{requests.push(url);return new Promise(resolve=>finishes.push(resolve));},getLayer:()=>null,getSource:()=>null,hasImage:()=>false,addImage(){},removeImage(){}};
 const resources={countryLabelAnchors:()=>new Map([['visible',[0,0]],['hidden',[100,0]]])};
 const presentation=createMapLibreLabelPresentation({renderer:{map,projection:{projectVisibleCoordinate:point=>point[0]<10?[0,0]:null}},labels:resources,onChange(){},onError:assert.fail});
 const layout={territorialFlags:new Map([['visible',{url:'visible.png'}],['hidden',{url:'hidden.png'}]])};
 assert.equal(presentation.prepareFlags(layout),true);assert.deepEqual(requests,['visible.png','hidden.png']);
 for(const finish of finishes)finish({data:{width:24,height:12}});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(presentation.prepareFlags(layout),true);assert.equal(requests.length,2);presentation.dispose();
});

test('bundled flag cache busting does not reload the same image during a date change',()=>{
 const previous=globalThis.document;globalThis.document={baseURI:'https://fixture.test/Pando/'};
 const OriginalURL=globalThis.URL;let parses=0;globalThis.URL=class extends OriginalURL{constructor(...args){super(...args);parses++;}};
 let requests=0;const map={loadImage:()=>{requests++;return new Promise(()=>{});},getLayer:()=>null,getSource:()=>null,hasImage:()=>false};
 const presentation=createMapLibreLabelPresentation({renderer:{map},labels:{},onChange(){},onError:assert.fail});
 const layout=url=>({territorialFlags:new Map([['same',{url}]])});
 try{
  presentation.prepareFlags(layout('assets/vendor/flag-icons/7.5.0/flags/4x3/fr.svg?v=build'));
  const prepared=parses;for(let i=0;i<10;i++)presentation.prepareFlags(layout('assets/vendor/flag-icons/7.5.0/flags/4x3/fr.svg?v=build'));assert.equal(parses,prepared,'camera frames do not parse the same immutable image URL again');
  assert.equal(presentation.prepareFlags(layout('https://fixture.test/Pando/assets/vendor/flag-icons/7.5.0/flags/4x3/fr.svg')),true);
  assert.equal(requests,1);
  assert.equal(presentation.prepareFlags(layout('https://external.test/flag.png?v=new')),true);assert.equal(requests,2);
 }finally{presentation.dispose();globalThis.document=previous;globalThis.URL=OriginalURL;}
});

test('flag completions share one image installation frame after the dated map is admitted',async()=>{
 const previous=globalThis.requestAnimationFrame;let flush;globalThis.requestAnimationFrame=callback=>{flush=callback;return 1;};
 const finishes=[],images=new Set();let changes=0;
 const map={loadImage:()=>new Promise(resolve=>finishes.push(resolve)),getLayer:()=>null,getSource:()=>null,hasImage:id=>images.has(id),addImage:id=>images.add(id),removeImage:id=>images.delete(id)};
 let temporalPending=true;
 const presentation=createMapLibreLabelPresentation({renderer:{map,getRuntimeState:()=>({temporalPresentationPending:temporalPending})},labels:{},onChange:assert.fail,onFlagsReady:()=>changes++,onError:assert.fail});
 try{
  presentation.prepareFlags({territorialFlags:new Map([['a',{url:'a.png'}],['b',{url:'b.png'}]])});
  for(const finish of finishes)finish({data:{width:24,height:12}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(images.size,0);assert.equal(typeof flush,'function');flush();
  assert.equal(images.size,0,'optional image uploads yield to the required dated frame');
  temporalPending=false;presentation.publishOptionalFlags();flush();
  assert.equal(images.size,2);assert.equal(changes,1);
 }finally{presentation.dispose();globalThis.requestAnimationFrame=previous;}
});

test('labels publish before flags and change selection without mutating tile feature state',async()=>{
 const previous=globalThis.document;globalThis.document={baseURI:'https://fixture.test/'};
 const sources=new Map(),layers=new Map(),images=new Map(),errors=[],diffs=[],finishes=new Map();
 let fontWrites=0,fullUploads=0,tilesReady=true,selected=null,faces={External:[{url:'external.woff2'}]};
 const map={getStyle:()=>({'font-faces':faces}),setFontFaces:value=>{faces=value;fontWrites++;},getSource:id=>sources.get(id),getLayer:id=>layers.get(id),hasImage:id=>images.has(id),addImage:(id,image)=>images.set(id,image),removeImage:id=>images.delete(id),loadImage:url=>new Promise(resolve=>finishes.set(url,resolve)),isSourceLoaded:()=>tilesReady,
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
 const presentation=createMapLibreLabelPresentation({renderer:{map},labels:resources,onChange(){},onFlagsReady:()=>presentation.renderTerritorialLabels(activeLayout),onError:error=>errors.push(error)});
 const layout=ids=>({territorialLabels:ids.map(id=>({id})),territorialFlags:new Map(ids.map(id=>[id,{url:id+'.png'}])),territorialLabelNames:new Map(),territorialLabelRows:new Map(ids.map(id=>[id,[{text:id}]])),territorialLabelSizes:new Map(ids.map(id=>[id,{name:19,flag:18}])),userLabels:[]});
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 const show=async (ids,flag)=>{activeLayout=layout(ids);if(flag)activeLayout.territorialFlags.set('c',{url:flag});presentation.prepareFlags(activeLayout);presentation.renderTerritorialLabels(activeLayout);await flush();};
 const rows=()=>sources.get('viewer-labels').data.features.map(f=>f.properties);
 try{
  await show(['a','b']);
  assert.deepEqual(rows().map(({primary,icon})=>[primary,icon]),[['a',''],['b','']]);
  assert.equal(presentation.pending,false,'image decoding cannot hold the label source');
  for(const url of ['a.png','b.png'])finishes.get(url)({data:{width:24,height:12}});
  await flush();
  const first=rows().map(row=>row.icon);
  assert.equal(new Set(first).size,2);
  assert.ok(first.every(id=>images.has(id)));
  assert.deepEqual(rows().map(({size,iconScale})=>[size,iconScale]),[[19,1.5],[19,1.5]]);
  const countryLayout=layers.get('viewer-label-country').layout;
  assert.equal(countryLayout['text-justify'],'center');
  assert.equal(countryLayout['icon-optional'],false);
  assert.equal(countryLayout['text-optional'],false);
  assert.match(faces[countryLayout['text-font'][0]][0].url,/Pretendard-ExtraBold\.woff2$/);
  assert.deepEqual(layers.get('viewer-label-text').layout['text-variable-anchor'],['left','right','top','bottom']);
  assert.deepEqual(layers.get('viewer-label-country').paint['text-color'].slice(0,2),['case',['get','selected']]);
  const writes=diffs.length;
  presentation.renderTerritorialLabels(activeLayout);await flush();
  assert.equal(diffs.length,writes,'unchanged sizes and coordinates must reuse the label tiles');
  activeLayout.territorialLabelNames.set('a',false);
  activeLayout.territorialFlags.delete('b');
  presentation.renderTerritorialLabels(activeLayout);await flush();
  assert.deepEqual(rows().map(({primary,icon})=>[primary,icon]),[['',first[0]],['b','']]);
  assert.equal(countryLayout['text-anchor'].at(-1),'center');
  assert.equal(countryLayout['icon-anchor'].at(-1),'center');
  selected='b';await show(['a','b']);assert.equal(rows()[1].selected,true);
  assert.ok(diffs.at(-1).update.find(row=>row.id==='territorial:entity:b').addOrUpdateProperties.some(p=>p.key==='selected'&&p.value===true));
  tilesReady=false;await show(['b']);presentation.publishOptionalFlags();assert.ok(images.has(first[0]));
  tilesReady=true;presentation.publishOptionalFlags();assert.ok(!images.has(first[0]));
  await show(['b','c']);
  assert.deepEqual(rows().map(row=>row.icon),[first[1],'']);
  await show(['b','c'],'new-c.png');
  presentation.publishOptionalFlags();
  finishes.get('c.png')({data:{width:24,height:12}});
  finishes.get('new-c.png')({data:{width:24,height:12}});await flush();
  assert.equal(images.size,2);assert.ok(rows().every(row=>images.has(row.icon)));
  assert.equal(fullUploads,1);assert.equal(fontWrites,1);assert.equal(faces.External[0].url,'external.woff2');
  sources.get('viewer-labels').listener({error:new Error('font unavailable')});
  assert.equal(errors.length,1);assert.equal(presentation.pending,false);await show(['b','c'],'new-c.png');assert.equal(sources.size,0);
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
