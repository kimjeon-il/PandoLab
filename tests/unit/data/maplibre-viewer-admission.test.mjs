import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,sep} from 'node:path';
import {chromium} from '@playwright/test';

test('MapLibre certifies the admitted dated geometry before resolving its presentation waiter',{timeout:120000},async()=>{
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 const roles=['world','territorial','rivers','lakes','places','placeLifetimes','physicalLand','preparedMeshes'];
 const meta={assetRevision:'fixture',dataRevision:'fixture',resourceProfile:'test-fixture',mapProject:{format:'pandolab-map-project-manifest',schemaVersion:1,projectId:'fixture',name:'Fixture map',documentFormat:'pandolab-project-state',resources:Object.fromEntries(roles.map(role=>[role,{catalog:'assets/data/fixture/catalog.json'}]))},projectCatalogs:{preparedMeshes:{catalog:'assets/data/fixture/catalog.json',bytes:2,sha256:'a'.repeat(64),current:false}}};
 const server=createServer(async(request,response)=>{
  try{
   const path=new URL(request.url,'http://localhost').pathname;
   if(path.startsWith('/optional/'))return;
   if(path==='/'){response.setHeader('Content-Type','text/html');response.end('<script src="/assets/js-vendor/d3.min.js"></script><div id="map" style="position:relative;width:800px;height:600px"></div>');return;}
   if(path==='/src/rendering/build-meta.js'){response.setHeader('Content-Type','text/javascript');response.end('globalThis.PANDOLAB_BUILD_META='+JSON.stringify(meta));return;}
   const workerAliases={'/src/rendering/workers/geographic-boundary-core.js':'src/geometry/workers/geographic-boundary-core.js','/src/rendering/workers/worker-rpc-host.js':'src/runtime/workers/worker-rpc-host.js'};
   const file=workerAliases[path]?resolve(root,workerAliases[path]):path.startsWith('/assets/vendor/maplibre-gl/')?resolve(root,'node_modules/maplibre-gl/dist',path.slice('/assets/vendor/maplibre-gl/'.length)):path.startsWith('/wasm/')?resolve(root,'assets/wasm',path.slice('/wasm/'.length)):resolve(root,path.slice(1));
   if(!file.startsWith(root.endsWith(sep)?root:root+sep))throw new Error('Invalid fixture route');
   response.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':file.endsWith('.wasm')?'application/wasm':'text/javascript');response.end(await readFile(file));
  }catch{response.statusCode=404;response.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,args:process.platform==='win32'?['--use-angle=d3d11']:[]});
 try{
  const page=await browser.newPage();page.on('pageerror',error=>console.error('Fixture page error:',error));await page.goto('http://127.0.0.1:'+server.address().port);
  const result=await page.evaluate(async()=>{
   const {createMapLibreViewerRenderer}=await import('/src/rendering/maplibre-viewer-renderer.js');
   const square=(id,left)=>({type:'Feature',id,properties:{entityKind:'general',parentId:null,style:{color:'#66aa44'}},geometry:{type:'Polygon',coordinates:[[[left,-5],[left+8,-5],[left+8,5],[left,5],[left,-5]]]}});
   const before=square('old',-8),after=square('current:상태%2',18),entities=new Map([[before.id,before],[after.id,after]]),errors=[];let visible=true,loadingPalette={ocean:'#4477aa',land:'#aaaaaa'};
   const state={size:{width:800,height:600},projection:'globe',view:{globeRotation:[0,0,0],zoom:1},layerVisibility:{objects:true},layerPresentation:{},hydroFeatureCache:new Map(),hydroEdits:[],genericFeatures:[],distributionEntries:[],labels:[]};
   const land={revision:'fixture-land',geometry:{type:'MultiPolygon',coordinates:[[[[-40,-40],[0,-40],[.1,0],[0,40],[-40,40],[-40,-40]]],[[[0,-40],[40,-40],[40,40],[0,40],[.1,0],[0,-40]]]]}};
   let landAvailable=false,hydroEnabled=false;
   const renderer=createMapLibreViewerRenderer({projectState:{state},physicalConfig:{},countryLabelModel:{labelLayoutMetrics:{}},layerPresentation:{isLayerItemVisible:()=>true},
    preferences:{mapPalette:()=>({loadingSurface:loadingPalette,ocean:'#4477aa',defaultLand:'#aaaaaa',countryColorAlpha:1,borderAlpha:1,strokes:{country:{color:'#ffffff',width:1},river:{width:1}}})},
    surfaces:{isMobile:()=>false},physicalResources:{get physicalLand(){return landAvailable?land:null;},physicalContextState:{ready:true},hydroVisibilityThreshold:()=>0,hydroDetailEnabled:()=>hydroEnabled,prepareHydroFeature:feature=>feature,admitHydroFeatures:async()=>true},physicalServices:{isHydroFeatureVisible:()=>true},hydroPresentation:{hydroDisplayColor:()=> '#4477aa'},objectRefVisible:()=>visible,territorialModel:{entityRepository:{get:id=>entities.get(id),parent:id=>entities.get(entities.get(id)?.properties.parentId)}},
    platform:{d3:globalThis.d3,runtimeAssetUrl:path=>{const url=new URL('/src/rendering/'+path,globalThis.location.href);url.searchParams.set('v','fixture');url.searchParams.set('dataRevision','fixture');return url;}},domains:{renderingDomain:{invalidateView(){},beginInteraction(){},endInteraction(){}}},feedback:{reportOperationError:error=>errors.push(error.message)}});
   renderer.attach(globalThis.document.getElementById('map'));await renderer.initialize();
   if(!renderer.map.isStyleLoaded())await new Promise(resolve=>renderer.map.once('load',resolve));
   renderer.invalidateCountryPalette();
   if(errors.length)throw new Error('A palette refresh before land availability failed: '+errors.join('\n'));
   landAvailable=true;renderer.resetProjectRenderState({generation:1});await renderer.setTerritorialFeatures([before]);
   let featureDisposals=0;const removeFeature=renderer.registerFeature('fixture',()=>()=>{featureDisposals++;});removeFeature();removeFeature();
   renderer.registerFeature('remaining',()=>()=>{featureDisposals++;});
   let featureInstalls=0;const removeCustom=renderer.registerFeature('custom-fixture',map=>{featureInstalls++;map.addLayer({id:'custom-fixture',type:'custom',render(){}});return ()=>{if(map.getLayer('custom-fixture'))map.removeLayer('custom-fixture');};});
   let frameId=0;
   const frame=()=>({frameId:++frameId,projectGeneration:1,viewRevision:1,projectionRevision:0});
   const settle=async()=>{for(let i=0;i<300;i++){if(errors.length)throw new Error(errors.join('\n'));const current=frame(),result=renderer.renderFrame(current);if(result.succeeded&&renderer.canPresentVisualFrame(current,result)){renderer.commitVisualFrame(current);return;}await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Fixture map did not present');};
   renderer.setInitialMapLoading(true);
   if(renderer.map.getMinZoom()!==-2||renderer.map.getMaxZoom()!==22)throw new Error('Expected native MapLibre zoom range');
   renderer.map.jumpTo({center:[-4,0],zoom:renderer.map.getMaxZoom()});
   if(renderer.map.getCanvas().style.visibility!=='hidden'||globalThis.document.querySelector('[data-map-preserved-frame]'))
    throw new Error('A jump before first publication exposed an unprepared canvas');
   await settle();
   if(renderer.map.getCanvas().style.visibility!=='hidden')throw new Error('The loading surface retired before the full map drew');
   renderer.setInitialMapLoading(false);
   await settle();
   if(renderer.map.getCanvas().style.visibility==='hidden')throw new Error('The first full map never became visible');
   const originalGetStyle=renderer.map.getStyle;
   let approvalSerializations=0;
   renderer.map.getStyle=function(...args){
    if(new Error().stack.includes('requiredSourcesReady'))approvalSerializations++;
    return originalGetStyle.apply(this,args);
   };
   await settle();
   renderer.map.getStyle=originalGetStyle;
   if(approvalSerializations)throw new Error('Frame approval serialized the entire style '+approvalSerializations+' times');

   const refFor=feature=>({domain:'territorial',type:'entity',id:feature.id,key:'territorial:entity:'+encodeURIComponent(feature.id)});
   const beforeRef=refFor(before),afterRef=refFor(after);
   const interactionSnapshot=(items,hover=null)=>({selection:{items,primaryKey:items[0]?.key},hover});
   renderer.setSelection(interactionSnapshot([]));await settle();
   const interaction=renderer.map.getSource('interaction'),writeInteraction=interaction.setData.bind(interaction);
   const writes=[];
   let beginWrite,releaseWrite;
   const began=new Promise(resolve=>beginWrite=resolve);
   interaction.setData=data=>{
    writes.push(data);
    if(writes.length!==1)return writeInteraction(data);
    beginWrite();
    return new Promise(resolve=>releaseWrite=()=>resolve(writeInteraction(data)));
   };
   renderer.setSelection(interactionSnapshot([beforeRef]));
   await began;
   renderer.setSelection(interactionSnapshot([beforeRef],afterRef));
   renderer.setSelection(interactionSnapshot([afterRef],beforeRef));
   renderer.setSelection(interactionSnapshot([afterRef]));
   releaseWrite();
   await settle();
   interaction.setData=writeInteraction;
   if(writes.length!==2||writes[1].features.length!==1||writes[1].features[0].geometry!==after.geometry)
    throw new Error('The interaction queue applied a superseded hover or lost the final selection');
   const originalMoveLayer=renderer.map.moveLayer;
   let orderMoves=0;
   renderer.map.moveLayer=function(...args){orderMoves++;return originalMoveLayer.apply(this,args);};
   renderer.setSelection(interactionSnapshot([afterRef]));
   await settle();
   renderer.map.moveLayer=originalMoveLayer;
   if(orderMoves)throw new Error('An unchanged interaction moved '+orderMoves+' layers');
   renderer.syncHydroState();
   const visibilityScans=renderer.getStats().hydroVisibilityScans;
   renderer.syncHydroState();renderer.syncHydroState();
   if(renderer.getStats().hydroVisibilityScans!==visibilityScans)throw new Error('An unchanged frame rescanned all visible hydrology');
   renderer.setSelection(interactionSnapshot([]));await settle();

   renderer.map.jumpTo({center:[0,0],zoom:1});
   await settle();
   for(const center of [[13.84,50.77],[18,0]]){
    for(const [zoom,country,places] of [[2.99,false,false],[3,true,false],[3.49,true,false],[3.5,true,true]]){
     renderer.map.jumpTo({center,zoom});
     const actual=renderer.labelZoomVisibility();
     if(actual.country!==country||actual.places!==places)
      throw new Error('Label visibility must follow the native zoom at '+center+' / '+zoom);
    }
   }
   renderer.map.jumpTo({center:[0,0],zoom:1});
   await settle();
   if(!renderer.fitMapBounds([[170,-8],[-170,8]],{left:32,right:32}))throw new Error('Native fit did not handle a dateline-crossing project range');
   await settle();
   if(Math.abs(renderer.map.getCenter().lng)<170)throw new Error('Crossing project bounds fitted the wrong hemisphere');
   renderer.map.jumpTo({center:[0,0],zoom:1});
   await settle();
   const territoryId=renderer.map.getLayer('territories').source;
   if(renderer.map.getLayer('borders').source!==territoryId||renderer.map.getStyle().sources[territoryId].tolerance!==0)
     throw new Error('Country fill and shared borders must publish in the same unsimplified source tile');
   if((await renderer.map.getSource('physical-land').getData()).features[0].geometry.coordinates.length!==1)throw new Error('Native land source retained its internal administrative seam');
   const waterLayer=renderer.map.getStyle().layers.find(layer=>layer.id==='physical-water');renderer.map.removeLayer('physical-water');
   await new Promise(resolve=>{renderer.map.once('render',resolve);renderer.map.triggerRepaint();});
   if(!renderer.renderFrame(frame()).deferred)throw new Error('A frame without the required physical-water layer was approved');
   renderer.map.addLayer(waterLayer,'rivers');await settle();
   const bordersLayer=renderer.map.getStyle().layers.find(layer=>layer.id==='borders');
   renderer.map.addSource('wrong-border-source',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
   renderer.map.removeLayer('borders');renderer.map.addLayer({...bordersLayer,source:'wrong-border-source'});
   await new Promise(resolve=>{renderer.map.once('render',resolve);renderer.map.triggerRepaint();});
   if(!renderer.renderFrame(frame()).deferred)throw new Error('A boundary rebound to an unrelated source was approved');
   renderer.map.removeLayer('borders');renderer.map.addLayer(bordersLayer);renderer.map.removeSource('wrong-border-source');await settle();
   let countrySource=renderer.map.getSource('territories'),originalUpdate=countrySource.updateData.bind(countrySource);
   let failedOnce=false;countrySource.updateData=(...args)=>{if(!failedOnce){failedOnce=true;return Promise.reject(new Error('fixture country update failed'));}return originalUpdate(...args);};
   try{await renderer.setTerritorialFeatures([after]);throw new Error('Expected country update failure');}catch(error){if(error.message!=='fixture country update failed')throw error;}
   renderer.retryMapPreparation();errors.length=0;
   await renderer.setTerritorialFeatures([after]);await settle();
   if(!(await countrySource.getData()).features.some(feature=>feature.id.includes('current')))throw new Error('Country retry did not publish the new source');
   countrySource.updateData=originalUpdate;await renderer.setTerritorialFeatures([before]);await settle();
   countrySource.updateData=(...args)=>{const pending=originalUpdate(...args);queueMicrotask(()=>countrySource.fire('error',{error:new Error('worker source failed')}));return pending;};
   try{await renderer.setTerritorialFeatures([after]);throw new Error('Expected worker event failure');}catch(error){if(error.message!=='worker source failed')throw error;}
   renderer.retryMapPreparation();errors.length=0;countrySource.updateData=originalUpdate;
   await renderer.setTerritorialFeatures([after]);await settle();
   if(!(await countrySource.getData()).features.some(feature=>feature.id.includes('current')))throw new Error('Country source event failure was treated as success');
   await renderer.setTerritorialFeatures([before]);await settle();
   let rejectOlderSame,olderSameStarted;const olderSameStartedPromise=new Promise(resolve=>{olderSameStarted=resolve;});
   countrySource.updateData=()=>new Promise((_resolve,reject)=>{rejectOlderSame=reject;olderSameStarted();});
   const olderSame=renderer.setTerritorialFeatures([after]);await olderSameStartedPromise;
   const latestSame=renderer.setTerritorialFeatures([before]);
   if(await Promise.race([latestSame,new Promise(resolve=>setTimeout(()=>resolve('blocked'),1500))])==='blocked')throw new Error('Latest country change waited for an obsolete same-generation update');
   rejectOlderSame(new Error('old same-generation failure'));if(await olderSame!==false)throw new Error('Old same-generation update escaped');
   countrySource=renderer.map.getSource(renderer.map.getLayer('territories').source);originalUpdate=countrySource.updateData.bind(countrySource);await settle();
   let rejectOld,oldStarted;const oldStartedPromise=new Promise(resolve=>{oldStarted=resolve;});
   countrySource.updateData=()=>new Promise((_resolve,reject)=>{rejectOld=reject;oldStarted();});
   const staleUpdate=renderer.setTerritorialFeatures([after]);await oldStartedPromise;
   renderer.resetProjectRenderState({generation:2});
   const latestUpdate=renderer.setTerritorialFeatures([before]);
   if(await Promise.race([latestUpdate,new Promise(resolve=>setTimeout(()=>resolve('blocked'),1500))])==='blocked')throw new Error('Latest country update waited for an obsolete source');
   rejectOld(new Error('old generation failed'));
   if(await staleUpdate!==false)throw new Error('Obsolete country failure escaped to its caller');await Promise.resolve();
   if(renderer.getRuntimeState().projectRenderBlocked)throw new Error('Old source error blocked the new project');
   countrySource=renderer.map.getSource(renderer.map.getLayer('territories').source);originalUpdate=countrySource.updateData.bind(countrySource);renderer.resetProjectRenderState({generation:1});await renderer.setTerritorialFeatures([before]);await settle();
   let releaseOldSuccess,oldSuccessStarted;const oldSuccessStartedPromise=new Promise(resolve=>{oldSuccessStarted=resolve;});
   countrySource.updateData=(...args)=>originalUpdate(...args).then(()=>new Promise(resolve=>{releaseOldSuccess=resolve;oldSuccessStarted();}));
   const staleSuccess=renderer.setTerritorialFeatures([after]);await oldSuccessStartedPromise;renderer.resetProjectRenderState({generation:2});
   const newestSuccess=renderer.setTerritorialFeatures([before]);if(await Promise.race([newestSuccess,new Promise(resolve=>setTimeout(()=>resolve('blocked'),1500))])==='blocked')throw new Error('Latest country source did not bypass an obsolete worker');
   releaseOldSuccess();await staleSuccess;countrySource=renderer.map.getSource(renderer.map.getLayer('territories').source);originalUpdate=countrySource.updateData.bind(countrySource);
   if((await countrySource.getData()).features.some(feature=>feature.id.includes('current')))throw new Error('Obsolete country data replaced the latest source');
   renderer.resetProjectRenderState({generation:1});await renderer.setTerritorialFeatures([before]);await settle();
   const waterSource=renderer.map.getSource('physical-water'),originalWaterSet=waterSource.setData.bind(waterSource);let rejectWater,waterAttempts=0;
   waterSource.setData=(...args)=>{waterAttempts++;if(waterAttempts===1)return new Promise((_resolve,reject)=>{rejectWater=reject;});return originalWaterSet(...args);};
   const landSource=renderer.map.getSource('physical-land');
   const originalLandSet=landSource.setData.bind(landSource);let landUploads=0;
   landSource.setData=(...args)=>{landUploads++;return originalLandSet(...args);};
   land.waterRevision='fixture-water-new';renderer.renderFrame(frame());await new Promise(resolve=>setTimeout(resolve,0));
   renderer.resetProjectRenderState({generation:2});rejectWater(new Error('old physical source failed'));await new Promise(resolve=>setTimeout(resolve,0));
   if(renderer.getRuntimeState().projectRenderBlocked)throw new Error('Old physical source failure blocked the new project');
   renderer.resetProjectRenderState({generation:1});await renderer.setTerritorialFeatures([before]);await settle();
   if(waterAttempts<2)throw new Error('Physical source failure was not retried');waterSource.setData=originalWaterSet;
   if(landUploads)throw new Error('A water-only revision re-uploaded unchanged land');
   landSource.setData=originalLandSet;
   let releaseOldWater;waterAttempts=0;
   waterSource.setData=(...args)=>{waterAttempts++;return new Promise(resolve=>{releaseOldWater=()=>resolve(originalWaterSet(...args));});};
   land.waterRevision='fixture-water-old';renderer.renderFrame(frame());await new Promise(resolve=>setTimeout(resolve,0));
   renderer.resetProjectRenderState({generation:2});land.waterRevision='fixture-water-current';land.water={type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]};renderer.renderFrame(frame());
   let currentWater;
   for(let i=0;i<100;i++){
    currentWater=renderer.map.getSource(renderer.getStats().datedSources.water);
    if(currentWater!==waterSource)break;
    await new Promise(resolve=>setTimeout(resolve,10));
   }
   if(currentWater===waterSource||!(await currentWater.getData()).features.length)throw new Error('Current water data waited for the obsolete source');
   waterSource.fire('error',{error:new Error('old physical worker failed')});releaseOldWater();
   await new Promise(resolve=>setTimeout(resolve,100));
   if(renderer.getRuntimeState().projectRenderBlocked)throw new Error('Old physical worker error was assigned to the current update');
   renderer.resetProjectRenderState({generation:1});await renderer.setTerritorialFeatures([before]);await settle();
   const failWater=renderer.map.getSource(renderer.getStats().datedSources.water),originalFailWaterSet=failWater.setData.bind(failWater);
   failWater.setData=(...args)=>{const pending=originalFailWaterSet(...args);queueMicrotask(()=>failWater.fire('error',{error:new Error('current physical worker failed')}));return pending;};
   land.waterRevision='fixture-water-a';renderer.renderFrame(frame());
   for(let i=0;i<200&&!renderer.getRuntimeState().projectRenderBlocked;i++)await new Promise(resolve=>setTimeout(resolve,10));
   if(!renderer.getRuntimeState().projectRenderBlocked)throw new Error('A current physical worker error did not block the frame');
   failWater.setData=originalFailWaterSet;renderer.retryMapPreparation();errors.length=0;await settle();
   try{renderer.registerFeature('broken-example',()=>{throw new Error('optional setup failed');});throw new Error('Expected setup failure');}catch(error){if(error.message!=='optional setup failed')throw error;}
   // Installation is atomic even if failure happens after native resources and
   // a map event have been registered. External code still uses native APIs.
   let leakedEvents=0,freedGpu=false;
   const onAudit=()=>{leakedEvents++;};
   try{renderer.registerFeature('partially-broken',(map,scope)=>{
    map.addSource('partial-feature',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
    map.addLayer({id:'partial-feature-fill',source:'partial-feature',type:'fill'});
    scope.on('pando-feature-audit',onAudit);
    const buffer=map.getCanvas().getContext('webgl2').createBuffer();
    scope.track(buffer,resource=>{map.getCanvas().getContext('webgl2').deleteBuffer(resource);freedGpu=true;});
    throw new Error('partial source, listener and GPU failure');
   });throw new Error('Expected partial installation failure');}
   catch(error){if(error.message!=='partial source, listener and GPU failure')throw error;}
   renderer.map.fire('pando-feature-audit');
   if(renderer.map.getLayer('partial-feature-fill')||renderer.map.getSource('partial-feature')||leakedEvents||!freedGpu)
    throw new Error('Partially installed extension leaked native, event or GPU resources');
   if(renderer.getRuntimeState().projectRenderBlocked)throw new Error('Optional setup failure blocked historical map');
   const beforeTilt=renderer.map.project([-3,1]);renderer.map.jumpTo({pitch:35,bearing:20});
   const afterTilt=renderer.map.project([-3,1]);
   if(Math.hypot(beforeTilt.x-afterTilt.x,beforeTilt.y-afterTilt.y)<1)throw new Error('3D camera did not change projected position');
   renderer.map.jumpTo({pitch:0,bearing:0});
   renderer.syncCameraFromState({...state.view,bearing:20,pitch:35,roll:0});
   if(Math.abs(renderer.map.getPitch()-35)>0.001||Math.abs(renderer.map.getBearing()-20)>0.001)throw new Error('Saved 3D camera orientation was not restored');
   renderer.map.addSource('untrusted-fixture',{type:'geojson',data:{type:'FeatureCollection',features:[{type:'Feature',properties:{objectKey:'territorial:entity:forged'},geometry:before.geometry}]}});
   renderer.map.addLayer({id:'untrusted-fixture',type:'fill',source:'untrusted-fixture'});
   for(let i=0;i<100&&!renderer.map.isSourceLoaded('untrusted-fixture');i++)await new Promise(resolve=>setTimeout(resolve,10));
   await new Promise(resolve=>{renderer.map.once('render',resolve);renderer.map.triggerRepaint();});
   if(renderer.queryObjectRefs(renderer.projection.projectCoordinate([-4,0])).some(ref=>ref.id==='forged'))throw new Error('Optional source impersonated a historical object');
   renderer.map.removeLayer('untrusted-fixture');renderer.map.removeSource('untrusted-fixture');
   const customLayers=renderer.map.getLayersOrder().filter(id=>renderer.map.getLayer(id)?.type==='custom');
   const originalGlyphs=renderer.map.getStyle().glyphs;
   const external={version:8,glyphs:'https://example.test/{fontstack}/{range}.pbf',sources:{'test-basemap':{type:'geojson',data:{type:'FeatureCollection',features:[]}}},layers:[{id:'test-basemap',type:'fill',source:'test-basemap'}]};
   const currentData=await countrySource.getData(),getData=countrySource.getData.bind(countrySource);let releaseSnapshot,snapshotStarted;
   const snapshotStartedPromise=new Promise(resolve=>{snapshotStarted=resolve;});
   countrySource.getData=()=>new Promise(resolve=>{releaseSnapshot=()=>resolve(currentData);snapshotStarted();});
   const staleStyle=renderer.previewExternalBasemap(external);await snapshotStartedPromise;
   await renderer.setTerritorialFeatures([after]);releaseSnapshot();
   let styleCancelled=false;try{await staleStyle;}catch(error){styleCancelled=error.name==='AbortError';}
   countrySource.getData=getData;
   if(!styleCancelled||renderer.map.getLayer('test-basemap'))throw new Error('A stale basemap snapshot replaced current country data');
   errors.length=0;await renderer.setTerritorialFeatures([before]);await settle();
   const rawSetStyle=renderer.map.setStyle.bind(renderer.map);let styleStarted;
   const styleStartedPromise=new Promise(resolve=>{styleStarted=resolve;});
   renderer.map.setStyle=(style,options={})=>{const result=rawSetStyle(style,{...options,diff:false});if(style.sprite)styleStarted();return result;};
   const delayedStyle=renderer.previewExternalBasemap({...external,sprite:globalThis.location.origin+'/optional/sprite'}).then(()=>false,error=>error.name==='AbortError');
   await styleStartedPromise;
   renderer.setSelection({selection:{items:[{domain:'territorial',type:'entity',id:'old',key:'territorial:entity:old'}],primaryKey:'territorial:entity:old'},hover:null});
   renderer.syncHydroState();renderer.invalidateHydroVisibility();renderer.setInteractionStyle({antiAlias:true,selection:{primary:{},secondary:{},color:'#ffd453'},hover:{}});
   const concurrentTicket=renderer.beginTemporalViewTransition();renderer.preserveTemporalFrame();
   await renderer.setTerritorialFeatures([after]);
   if(!await delayedStyle)throw new Error('A pending external style survived a temporal transition');
   renderer.finishTemporalViewTransition(concurrentTicket);renderer.releaseTemporalFrame();renderer.map.setStyle=rawSetStyle;
   await renderer.setTerritorialFeatures([before]);await settle();
   if(!(await renderer.map.getSource('interaction').getData()).features.length)throw new Error('Selection queued during style loading was lost');
   const beforeSource=renderer.map.getSource(renderer.map.getLayer('territories').source);
   const removeBasemap=await renderer.previewExternalBasemap(external);const externalInstalled=!!renderer.map.getLayer('test-basemap')&&renderer.map.getSource(renderer.map.getLayer('territories').source)===beforeSource;
   await settle();const externalPick=renderer.queryObjectRefs(renderer.projection.projectCoordinate([-4,0])).some(ref=>ref.id==='old');
   const customPreserved=customLayers.length>0&&customLayers.every(id=>!!renderer.map.getLayer(id));
   await removeBasemap();const externalRemoved=!renderer.map.getLayer('test-basemap')&&renderer.map.getSource(renderer.map.getLayer('territories').source)===beforeSource;
   if(renderer.map.getStyle().glyphs!==originalGlyphs)throw new Error('Basemap removal did not restore style configuration');
   const removeNextBasemap=await renderer.previewExternalBasemap(external);
   await removeBasemap();
   if(!renderer.map.getLayer('test-basemap')||!renderer.map.getContainer().querySelector('.maplibregl-ctrl-attrib'))throw new Error('An old basemap cleanup removed the current basemap');
   await removeNextBasemap();
   const removeSlow=await renderer.previewExternalBasemap(external),nativeStyle=renderer.map.setStyle.bind(renderer.map);let slowRemovalStarted,firstRemoval=true;
   const slowRemovalStartedPromise=new Promise(resolve=>{slowRemovalStarted=resolve;});
   renderer.map.setStyle=(style,options={})=>{if(firstRemoval){firstRemoval=false;const result=nativeStyle({...style,sprite:globalThis.location.origin+'/optional/sprite'},{...options,diff:false});slowRemovalStarted();return result;}return nativeStyle(style,options);};
   const removingSlow=removeSlow().then(()=>false,error=>error.name==='AbortError');await slowRemovalStartedPromise;
   const removalTicket=renderer.beginTemporalViewTransition();renderer.preserveTemporalFrame();await renderer.setTerritorialFeatures([after]);
   if(!await removingSlow||renderer.map.getLayer('test-basemap')||renderer.map.getContainer().querySelector('.maplibregl-ctrl-attrib'))throw new Error('Pending basemap removal was not safely cancelled');
   renderer.finishTemporalViewTransition(removalTicket);renderer.releaseTemporalFrame();renderer.map.setStyle=nativeStyle;await renderer.setTerritorialFeatures([before]);await settle();
   const afterRemovalStyle=renderer.map.setStyle.bind(renderer.map);let failEarly=true;
   renderer.map.setStyle=(style,options={})=>{const result=afterRemovalStyle(style,{...options,diff:false});if(failEarly){failEarly=false;renderer.map.fire('error',{sourceId:'test-basemap',error:new Error('early basemap failure')});}return result;};
   try{await renderer.previewExternalBasemap(external);throw new Error('Expected early basemap failure');}catch(error){if(error.message!=='early basemap failure')throw error;}
   renderer.map.setStyle=afterRemovalStyle;
   if(renderer.map.getLayer('test-basemap')||!renderer.map.getLayer('territories'))throw new Error('Early basemap failure did not restore the map');
   errors.length=0;await settle();
   const installsBeforeFull=featureInstalls;
   const landPreparationsBeforeFull=renderer.getStats().physicalLandPreparations;
   const originalSetStyle=renderer.map.setStyle.bind(renderer.map);
   renderer.map.setStyle=(style,options={})=>originalSetStyle(style,{...options,diff:false});
   const removeFull=await renderer.previewExternalBasemap(external);
   await settle();
   const fullRestored=renderer.queryObjectRefs(renderer.projection.projectCoordinate([-4,0])).some(ref=>ref.id==='old')&&customLayers.every(id=>!!renderer.map.getLayer(id))&&featureInstalls===installsBeforeFull+1;
   await removeFull();await settle();renderer.map.setStyle=originalSetStyle;
   if(renderer.getStats().physicalLandPreparations!==landPreparationsBeforeFull)throw new Error('Style restoration discarded valid CPU land preparation');
   if(!fullRestored||!renderer.map.getLayer('custom-fixture')||featureInstalls!==installsBeforeFull+2)throw new Error('Full style rebuild lost historical or custom layers');
   await renderer.previewExternalBasemap(external);renderer.map.fire('error',{sourceId:'test-basemap',error:new Error('external source failed')});
   for(let i=0;i<100&&(renderer.map.getLayer('test-basemap')||!renderer.isStyleReady()||!errors.includes('external source failed'));i++)await new Promise(resolve=>setTimeout(resolve,10));
   const externalFailureRecovered=!renderer.map.getLayer('test-basemap')&&!renderer.getRuntimeState().projectRenderBlocked&&errors.includes('external source failed');errors.length=0;
   renderer.map.jumpTo({center:[0,0],zoom:2});await settle();
   const river=(id,stage,lat)=>({type:'Feature',id,properties:{featureId:id,logicalId:id,category:'river',stage},geometry:{type:'LineString',coordinates:[[-5,lat],[5,lat]]}});
   const features=[river('river-fixture',0,0),river('detail-3',1,1),river('detail-4',2,2),river('detail-5',3,3)];
   const BrowserWorker=globalThis.Worker;
   globalThis.Worker=class {
    constructor(url,options){if(!new URL(url).pathname.endsWith('/hydro-tile-worker.js'))return new BrowserWorker(url,options);}
    postMessage(message){
     if(message.type==='init')queueMicrotask(()=>this.onmessage({data:{type:'ready'}}));
     if(message.type==='view')queueMicrotask(()=>{
      const {revision}=message;
      this.onmessage({data:{type:'pack',revision,packId:1,features}});
      this.onmessage({data:{type:'view-ready',revision,packIds:[1]}});
     });
    }
    terminate(){}
   };
   hydroEnabled=true;
   try{
    await renderer.setHydroManifest({stages:[6,6.7,7,7.5].map((minZoom,id)=>({id,minZoom,columns:1,rows:1}))},globalThis.location.href);
   }finally{globalThis.Worker=BrowserWorker;}
   for(let attempt=0;attempt<500&&!renderer.map.isSourceLoaded('hydro');attempt++)await new Promise(resolve=>setTimeout(resolve,10));
   await settle();let riverHit=false;
   for(let attempt=0;attempt<100&&!riverHit;attempt++){
    await new Promise(resolve=>{renderer.map.once('render',resolve);renderer.map.triggerRepaint();});
    riverHit=renderer.queryObjectRefs(renderer.projection.projectCoordinate([0,0])).some(ref=>ref.domain==='hydro'&&ref.id==='river-fixture');
    if(!riverHit)await new Promise(resolve=>setTimeout(resolve,20));
   }
   if(!riverHit)throw new Error('River source did not become selectable: '+JSON.stringify({visibility:renderer.map.getLayoutProperty('rivers','visibility'),filter:renderer.map.getFilter('rivers'),loaded:renderer.map.isSourceLoaded('hydro')}));
   renderer.map.jumpTo({zoom:1.99});await settle();
   if(renderer.queryObjectRefs(renderer.projection.projectCoordinate([0,0])).some(ref=>ref.id==='river-fixture'))
    throw new Error('A river below the native minimum remained selectable');
   for(const threshold of [3,4,5]){
    for(const offset of [-.01,0]){
     renderer.map.jumpTo({zoom:threshold+offset});
     await settle();
     await new Promise(resolve=>{renderer.map.once('idle',resolve);renderer.map.triggerRepaint();});
     const point=renderer.projection.projectCoordinate([.5,threshold-2]);
     const visible=renderer.queryObjectRefs(point).some(ref=>ref.id==='detail-'+threshold);
     if(visible!==(offset===0))throw new Error('River picking did not follow camera zoom '+renderer.map.getZoom());
     const painted=await new Promise(resolve=>{
      renderer.map.once('render',()=>{
       const canvas=renderer.map.getCanvas(),gl=canvas.getContext('webgl2'),ratio=renderer.map.getPixelRatio(),pixels=new Uint8Array(36);
       gl.readPixels(Math.round(point[0]*ratio)-1,canvas.height-2-Math.round(point[1]*ratio),3,3,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
       resolve(Array.from({length:9},(_,i)=>pixels[i*4+2]-pixels[i*4]).some(value=>value>28));
      });
      renderer.map.triggerRepaint();
     });
     if(painted!==(offset===0))throw new Error('River pixels did not follow camera zoom '+renderer.map.getZoom());
    }
   }
   hydroEnabled=false;renderer.invalidateHydroVisibility();
   await renderer.map.getSource('hydro').setData({type:'FeatureCollection',features:[]});await settle();
   renderer.setInitialMapLoading(true);await settle();
   const skeletonPixel=await new Promise(resolve=>{renderer.map.once('render',()=>{const point=renderer.projection.projectCoordinate([-4,0]),canvas=renderer.map.getCanvas(),gl=canvas.getContext('webgl2'),pixel=new Uint8Array(4);gl.readPixels(Math.round(point[0]),canvas.height-Math.round(point[1]),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);resolve([...pixel]);});renderer.map.triggerRepaint();});
   loadingPalette={ocean:'#112233',land:'#779966'};renderer.setInitialMapLoading(true);await settle();const loadingColors=[renderer.map.getPaintProperty('initial-map-ocean','background-color'),renderer.map.getPaintProperty('initial-map-land','fill-color')];
   const {resolveMapPalette}=await import('/src/ui/map-palette.js');const whitePalette=resolveMapPalette({state}).loadingSurface;
   const skeletonGeometry=(await renderer.map.getSource(renderer.map.getLayer('initial-map-land').source).getData()).features[0].geometry;
   renderer.setInitialMapLoading(false);await settle();const skeletonRemoved=!renderer.map.getLayer('initial-map-land')&&!renderer.map.getSource('initial-map-land');
   renderer.map.addSource('optional-fixture',{type:'raster',tiles:[new URL('/optional/{z}/{x}/{y}.png',globalThis.location.href).href],tileSize:256});
   renderer.map.addLayer({id:'optional-fixture',type:'raster',source:'optional-fixture'});
   await new Promise(resolve=>setTimeout(resolve,100));
   renderer.map.fire('error',{sourceId:'optional-fixture',error:new Error('optional source failure')});
   const optionalFailureIsolated=!renderer.getRuntimeState().projectRenderBlocked;
   errors.length=0;
   const ticket=renderer.beginTemporalViewTransition();renderer.preserveTemporalFrame();
   const removeLate=renderer.registerFeature('late',map=>{map.addSource('late',{type:'geojson',data:{type:'FeatureCollection',features:[]}});map.addLayer({id:'late',type:'circle',source:'late'});return ()=>{map.removeLayer('late');map.removeSource('late');};});
   const lateSuspended=renderer.map.getLayoutProperty('late','visibility')==='none';
   const overlay=globalThis.document.querySelector('#map > div:last-child'),snapshot=overlay.querySelector('canvas');
   const oldPixels=snapshot.getContext('2d').getImageData(0,0,snapshot.width,snapshot.height).data;
   const noLegacySvg=overlay.querySelector('svg')===null;
   renderer.admitTemporalViewTransition(ticket);
   const beforePrepared=renderer.renderFrame(frame()).deferred;
   await renderer.prepareTemporalCountrySource([after]);
   const beforeSourceApplied=renderer.renderFrame(frame()).deferred;
   let presented=false;const waiting=renderer.waitForTemporalPresentation().then(()=>{presented=true;});
   await new Promise(resolve=>setTimeout(resolve,50));const premature=presented;
   const map=renderer.map,addSource=map.addSource.bind(map);let releaseCountry;
   map.addSource=(id,...args)=>{
    const result=addSource(id,...args);
    if(id.startsWith('territories')){
     const source=map.getSource(id),setData=source.setData.bind(source);
     source.setData=(...data)=>new Promise((resolve,reject)=>{releaseCountry=()=>{source.setData=setData;return setData(...data).then(resolve,reject);};});
    }
    return result;
   };
   const countryPreparing=renderer.setTerritorialFeatures([after]);
   for(let i=0;i<100&&!releaseCountry;i++)await new Promise(resolve=>setTimeout(resolve,10));
   if(!releaseCountry)throw new Error('Country update was not requested');
   const requiredBlocked=renderer.renderFrame(frame()).deferred&&overlay.isConnected&&!presented;
   map.addSource=addSource;releaseCountry();await countryPreparing;
   const activeTerritories=()=>renderer.map.getSource(renderer.getStats().datedSources.territories);
   const nextPixels=snapshot.getContext('2d').getImageData(0,0,snapshot.width,snapshot.height).data;
   const frozenBeforeAdmission=overlay.isConnected&&noLegacySvg&&oldPixels.some((value,index)=>index%4===3&&value>0)&&oldPixels.every((value,index)=>value===nextPixels[index]);
   await settle();await waiting;const releasedAfterAdmission=!overlay.isConnected;const lateRestored=renderer.map.getLayoutProperty('late','visibility')!=='none';removeLate();
   await new Promise(resolve=>setTimeout(resolve,100));const optionalStillLoading=!renderer.map.areTilesLoaded();renderer.map.removeLayer('optional-fixture');renderer.map.removeSource('optional-fixture');
   const first=renderer.beginTemporalViewTransition();renderer.preserveTemporalFrame();const retained=globalThis.document.querySelector('#map > div:last-child');
   const second=renderer.beginTemporalViewTransition();renderer.preserveTemporalFrame();
   const supersededKept=renderer.finishTemporalViewTransition(first)===false&&retained.isConnected;
   const failed=renderer.waitForTemporalPresentation().then(()=>false,()=>true);
   renderer.failMapPreparation(new Error('delayed source failed'));
   const failureKept=await failed&&retained.isConnected;
   renderer.finishTemporalViewTransition(second);renderer.retryMapPreparation();errors.pop();renderer.releaseTemporalFrame();
   const superseded=renderer.setTerritorialFeatures([before,after]);await new Promise(resolve=>setTimeout(resolve,0));const latest=renderer.setTerritorialFeatures([after]);await Promise.all([superseded,latest]);await settle();
   renderer.map.jumpTo({center:[-60,0],zoom:0});await settle();renderer.fitGeometry({type:'FeatureCollection',features:[after]});await settle();const focused=renderer.map.getCenter();
   let point=renderer.projection.projectCoordinate([22,0]);const picked=renderer.queryObjectRefs(point).map(ref=>ref.id);
   const countryFills=async source=>(await source.getData()).features.filter(feature=>feature.properties.displayRole==='country-fill');
   const source=await countryFills(activeTerritories());
   state.layerPresentation={styles:{objects:{blendMode:'multiply'}}};await renderer.setTerritorialFeatures([after]);await settle();
   const sample=()=>new Promise(resolve=>{renderer.map.once('render',()=>{const canvas=renderer.map.getCanvas(),gl=canvas.getContext('webgl2'),pixel=new Uint8Array(4);gl.readPixels(Math.round(point[0]),canvas.height-Math.round(point[1]),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);resolve([...pixel]);});renderer.map.triggerRepaint();});
   const adjacent=square('adjacent',26);adjacent.geometry.coordinates[0].splice(4,0,[26,0]);entities.set(adjacent.id,adjacent);await renderer.setTerritorialFeatures([after,adjacent]);await settle();
   const sharedSource=activeTerritories();
   if(!(await sharedSource.getData()).features.some(feature=>feature.properties.displayRole==='country-border'&&feature.geometry.type==='MultiLineString'))
    throw new Error('The shared tile source did not receive a line for adjacent countries');
   const interior=point;point=renderer.projection.projectCoordinate([26,0]);const borderPixel=await sample();point=interior;await renderer.setTerritorialFeatures([after]);await settle();
   const multiplied=await sample(),multiplyHits=renderer.queryObjectRefs(point).map(ref=>ref.id);
   renderer.setSceneDomains(new Map([['generic-features',{polygons:[],strokes:[{key:'line',objectKey:'generic:feature:line%3A1',geometryRevision:'line-1',geometry:{type:'LineString',coordinates:[[18,0],[26,0]]},order:5000,blendMode:'multiply',style:{color:'#66aa44',alpha:1,width:10,cap:'round',dash:[0,0],casing:{color:'#ffffff',width:2,alpha:1}}}]}]]));await settle();
   const stroke=await sample();
   if(!renderer.queryObjectRefs(renderer.projection.projectCoordinate([22,0])).some(ref=>ref.key==='generic:feature:line%3A1'))throw new Error('The visible native stroke lost canonical selection');
   if(Object.keys(renderer.map.getStyle().sources).some(id=>id.startsWith('scene-line-')))throw new Error('A transparent duplicate stroke source survived native migration');
   const gl=renderer.map.getCanvas().getContext('webgl2'),extension=gl.getExtension('WEBGL_lose_context');
   await new Promise(resolve=>{renderer.map.once('webglcontextlost',resolve);extension.loseContext();});
   await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Context did not restore')),5000);renderer.map.once('webglcontextrestored',()=>{clearTimeout(timeout);resolve();});setTimeout(()=>extension.restoreContext(),100);});
   await settle();const restored=await sample();
   if(!renderer.map.getLayer('custom-fixture'))throw new Error('Registered native custom layer was not restored after WebGL context loss');
   removeCustom();
   if(renderer.map.getLayer('custom-fixture'))throw new Error('Registered custom layer did not release after context restoration');
   renderer.map.setMaxZoom(8);renderer.map.jumpTo({center:[22,0],zoom:7});await settle();point=renderer.projection.projectCoordinate([22,0]);const highZoom=await sample();
   const linePixels=()=>new Promise(resolve=>{renderer.map.once('render',()=>{const canvas=renderer.map.getCanvas(),gl=canvas.getContext('webgl2'),pixels=new Uint8Array(4*12);gl.readPixels(Math.round(point[0]),canvas.height-Math.round(point[1])-6,1,12,gl.RGBA,gl.UNSIGNED_BYTE,pixels);resolve([...pixels]);});renderer.map.triggerRepaint();});
   const lineMode=async (antiAlias,blendMode='multiply')=>{renderer.setInteractionStyle({antiAlias,selection:{primary:{},secondary:{},color:'#ffd453'},hover:{}});renderer.setSceneDomains(new Map([['generic-features',{polygons:[],strokes:[{key:'line',objectKey:'generic:feature:line%3A1',geometryRevision:'line-1',geometry:{type:'LineString',coordinates:[[18,0],[26,0]]},order:5000,blendMode,style:{color:'#66aa44',alpha:1,width:3,cap:'round',dash:[0,0],antiAlias}}]}]]));await settle();return linePixels();};
   const smoothPixels=await lineMode(true),preparedBefore=renderer.getRuntimeState().strokePreparedPackets,pixelPixels=await lineMode(false),normalPixels=await lineMode(false,'normal'),preparedAfter=renderer.getRuntimeState().strokePreparedPackets;
   renderer.setSceneDomains(new Map());renderer.map.jumpTo({center:[30,0],zoom:4});
   const far=square('far',34);entities.set(far.id,far);
   state.layerPresentation={objectStyles:{'territorial:entity:adjacent':{boundaryVisible:false},'territorial:entity:far':{boundaryVisible:false}}};
   await renderer.setTerritorialFeatures([after,adjacent,far]);await settle();point=renderer.projection.projectCoordinate([26,0]);const partlyVisibleBorder=await sample();point=renderer.projection.projectCoordinate([34,0]);const hiddenBorder=await sample();
   const boundaryBeforeStyle=renderer.getRuntimeState();
   state.layerPresentation={};await renderer.setTerritorialFeatures([after,adjacent,far]);await settle();
   const boundaryAfterStyle=renderer.getRuntimeState();
   if(boundaryAfterStyle.boundaryRequests!==boundaryBeforeStyle.boundaryRequests+1||boundaryAfterStyle.boundaryGeometryRows!==boundaryBeforeStyle.boundaryGeometryRows)
    throw new Error('A change of border groups must reuse the Worker topology without sending the country coordinates again');
   renderer.map.jumpTo({center:[22,0],zoom:2});
   const child=square('child:영역%',20);child.geometry.coordinates=[[[20,-2],[24,-2],[24,2],[20,2],[20,-2]]];child.properties.parentId=after.id;child.properties.style={};entities.set(child.id,child);
   state.layerPresentation={};await renderer.setTerritorialFeatures([child,after]);await settle();point=renderer.projection.projectCoordinate([22,0]);
   const unified=await countryFills(activeTerritories()),hierarchyHits=renderer.queryObjectRefs(point).map(ref=>ref.id);
   const updates=[],territories=activeTerritories(),updateData=territories.updateData.bind(territories);territories.updateData=(diff,...args)=>{updates.push(diff);return updateData(diff,...args);};
   state.layerPresentation={styles:{objects:{colorVisible:false}}};renderer.invalidateCountryColors();await settle();
   const neutralPixel=await sample(),neutralUpdates=updates.length;
   const updateCount=updates.length;renderer.map.panBy([10,0],{animate:false});await settle();const panUpdates=updates.length-updateCount;
   state.layerPresentation={objectStyles:{['territorial:entity:'+after.id]:{blendMode:'multiply'},['territorial:entity:'+child.id]:{blendMode:'normal'}}};
   child.properties.style={color:'#ee5544'};await renderer.setTerritorialFeatures([child,after]);await settle();point=renderer.projection.projectCoordinate([22,0]);const normalChild=await sample();
   state.layerPresentation={objectStyles:{['territorial:entity:'+child.id]:{blendMode:'multiply'}}};await renderer.setTerritorialFeatures([child,after]);await settle();const multiplyChild=await sample();
   const other=square('other',50);other.properties.style={color:'#9944cc'};entities.set(other.id,other);child.properties.style={};child.properties.parentId=other.id;state.layerPresentation={};
   await renderer.setTerritorialFeatures([child,after,other]);await settle();const rebound=(await territories.getData()).features.find(f=>f.id.includes('child')).properties.color;
   child.properties.parentId=after.id;await renderer.setTerritorialFeatures([child,after]);await settle();const returned=(await territories.getData()).features.find(f=>f.id.includes('child')).properties.color;
   const propertyOnly=updates[0].update.every(row=>!row.newGeometry);
   visible=false;renderer.setSelection({selection:{items:[{domain:'territorial',type:'entity',id:after.id,key:'territorial:entity:'+encodeURIComponent(after.id)}],primaryKey:'territorial:entity:'+encodeURIComponent(after.id)},hover:null});await settle();const hiddenHighlight=(await renderer.map.getSource('interaction').getData()).features.length;
   const boundaryRefresh=renderer.setTerritorialFeatures([after,adjacent]);
   renderer.setSceneDomains(new Map([['top-overlay',{polygons:[{key:'top-overlay',geometryRevision:'top-overlay-v1',geometry:{type:'Polygon',coordinates:[[[24,-2],[28,-2],[28,2],[24,2],[24,-2]]]},order:5000,style:{color:'#1234ff',fillAlpha:1},blendMode:'normal'}],strokes:[]}]]));
   await boundaryRefresh;await settle();point=renderer.projection.projectCoordinate([26,0]);const topPixel=await sample();
   if(![18,52,255].every((value,index)=>Math.abs(topPixel[index]-value)<=3))throw new Error('An asynchronously completed country boundary covered a later overlay: '+topPixel);
   renderer.setSceneDomains(new Map());await settle();
   const optionalStroke={key:'optional-hydro',role:'hydro-detail',geometryRevision:'one',geometry:{type:'LineString',coordinates:[[24,0],[26,0]]},order:200,style:{color:'#1234ff',width:1,alpha:1}};
   const optionalScene=()=>new Map([['water-detail',{polygons:[],strokes:[optionalStroke]}]]);
   renderer.setSceneDomains(optionalScene());await settle();
   const optionalSource=renderer.map.getSource('vector-line-200-hydro-detail'),writeOptional=optionalSource.setData.bind(optionalSource);let releaseOptional;
   optionalSource.setData=data=>new Promise(resolve=>{releaseOptional=()=>resolve(writeOptional(data));});
   optionalStroke.geometryRevision='two';renderer.setSceneDomains(optionalScene());
   for(let i=0;i<100&&!releaseOptional;i++)await new Promise(resolve=>setTimeout(resolve,5));
   if(!releaseOptional)throw Error('Optional stroke did not request its changed geometry');
   let optionalStrokeIndependent=false;
   for(let i=0;i<20;i++){const candidate=frame(),result=renderer.renderFrame(candidate);if(result.succeeded){renderer.commitVisualFrame(candidate);optionalStrokeIndependent=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
   if(!optionalStrokeIndependent)throw Error('Optional hydro stroke preparation blocked the required frame');
   releaseOptional();await settle();renderer.setSceneDomains(new Map());await settle();
   renderer.map.panBy([1,0],{animate:false});let unpublished;
   for(let attempt=0;attempt<300;attempt++){const candidate=frame(),result=renderer.renderFrame(candidate);if(result.succeeded){unpublished=candidate;break;}await new Promise(resolve=>setTimeout(resolve,20));}
   if(!unpublished||renderer.getRuntimeState().mapReady)throw new Error('Prepared geometry was reported as a published frame');
   renderer.commitVisualFrame(unpublished);if(!renderer.getRuntimeState().mapReady)throw new Error('Committed geometry was not published');
   {
    const {createGeometryVersionStore}=await import('/src/geometry/geometry-version-store.js');
    const ref={id:'document-local-geometry',version:1};
    const item=(lng,color='#66aa44')=>{
     const row=square('shared-reference',lng);row.properties.style.color=color;
     return Object.freeze({...row,properties:Object.freeze(row.properties),geometry:createGeometryVersionStore([{...ref,geojson:row.geometry}]).get(ref)});
    };
    state.layerPresentation={};
    renderer.resetProjectRenderState({generation:2});await renderer.setTerritorialFeatures([item(10)]);
    renderer.resetProjectRenderState({generation:3});await renderer.setTerritorialFeatures([item(60)]);
    const native=activeTerritories(),rows=await countryFills(native);
    if(rows[0].geometry.coordinates[0][0][0]!==60)throw Error('A project-local geometry reference reused other coordinates');
    visible=true;renderer.map.jumpTo({center:[64,0],zoom:2});
    for(let i=0;i<100&&!renderer.queryObjectRefs(renderer.projection.projectCoordinate([64,0])).some(ref=>ref.id==='shared-reference');i++)
     await new Promise(resolve=>setTimeout(resolve,10));
    if(!renderer.queryObjectRefs(renderer.projection.projectCoordinate([64,0])).some(ref=>ref.id==='shared-reference'))
     throw Error('The replacement geometry did not become pickable');
    const before=renderer.getStats();
    await renderer.setTerritorialFeatures([item(60)]);
    const same=renderer.getStats();
    if(same.boundaryRequests!==before.boundaryRequests||same.sourceUpdates!==before.sourceUpdates)
     throw Error('An independent copy with exactly the same coordinates re-tiled or rebuilt its borders');
    let nativeWrites=0;
    for(const method of ['updateData','setData']){const original=native[method].bind(native);native[method]=(...args)=>{nativeWrites++;return original(...args);};}
    await renderer.setTerritorialFeatures([item(60,'#ee5544')]);
    const painted=renderer.getStats();
    const paint=renderer.map.getFeatureState({source:painted.datedSources.territories,id:'territorial:entity:shared-reference'});
    if(nativeWrites||painted.boundaryRequests!==same.boundaryRequests||paint.countryColor!=='#ee5544')
     throw Error('Country color changes must preserve the native tile and shared border geometry');
   }
   let otherDisposed=false;renderer.registerFeature('failing-cleanup',()=>()=>{throw new Error('fixture cleanup failed');});renderer.registerFeature('other-cleanup',()=>()=>{otherDisposed=true;});
   renderer.dispose();if(!otherDisposed||!errors.includes('fixture cleanup failed')||globalThis.document.querySelector('.maplibregl-canvas'))throw new Error('An optional cleanup prevented map cleanup');errors.length=0;
   return {customPreserved,externalPick,externalInstalled,externalRemoved,externalFailureRecovered,riverHit,lateSuspended,lateRestored,featureDisposals,requiredBlocked,optionalFailureIsolated,optionalStillLoading,frozenBeforeAdmission,releasedAfterAdmission,supersededKept,failureKept,whitePalette,loadingColors,skeletonPixel,skeletonGeometry,skeletonRemoved,partlyVisibleBorder,hiddenBorder,unified,hierarchyHits,neutralPixel,neutralUpdates,panUpdates,normalChild,multiplyChild,rebound,returned,propertyOnly,beforePrepared,beforeSourceApplied,premature,presented,picked,borderPixel,multiplied,multiplyHits,stroke,restored,highZoom,hiddenHighlight,smoothPixels,pixelPixels,normalPixels,preparedBefore,preparedAfter,focused:[focused.lng,focused.lat],sourceIds:source.map(feature=>feature.id),errors};
  });
  assert.equal(result.unified.length,2);
  assert.deepEqual(result.unified.map(f=>f.properties.color),['#66aa44','#66aa44']);
  assert.ok(result.unified[0].properties.paintOrder<result.unified[1].properties.paintOrder,'parent must paint before child regardless of input order');
  assert.equal(result.hierarchyHits[0],'child:영역%');
  assert.deepEqual(result.neutralPixel,[170,170,170,255]);assert.equal(result.neutralUpdates,0);assert.equal(result.propertyOnly,true);assert.equal(result.panUpdates,0);
  assert.ok([238,85,68].every((value,i)=>Math.abs(result.normalChild[i]-value)<=3),'normal child must cover multiply parent: '+result.normalChild);
  assert.ok([95,57,18].every((value,i)=>Math.abs(result.multiplyChild[i]-value)<=3),'multiply child must follow normal parent: '+result.multiplyChild);
  assert.equal(result.rebound,'#9944cc');assert.equal(result.returned,'#66aa44');
  assert.ok(result.partlyVisibleBorder[0]>150&&result.partlyVisibleBorder[2]>130,'a shared border must remain when either owner shows it: '+result.partlyVisibleBorder);
  assert.ok([102,170,68].every((value,i)=>Math.abs(result.hiddenBorder[i]-value)<=3),'a shared border must disappear when both owners hide it: '+result.hiddenBorder);
  assert.deepEqual(result.whitePalette,{ocean:'#ffffff',land:'#f1f1f1'},'white map has a single loading palette');
  assert.deepEqual(result.loadingColors,['#112233','#779966']);
  assert.deepEqual(result.skeletonPixel,[170,170,170,255]);assert.equal(result.skeletonGeometry.type,'MultiPolygon');assert.equal(result.skeletonRemoved,true);
  assert.equal(result.beforePrepared,true);assert.equal(result.beforeSourceApplied,true);assert.equal(result.premature,false);assert.equal(result.presented,true);
  assert.equal(result.optionalStillLoading,true);
  assert.equal(result.optionalFailureIsolated,true);assert.equal(result.requiredBlocked,true);
  assert.equal(result.featureDisposals,2);
  assert.equal(result.lateSuspended,true);assert.equal(result.lateRestored,true);
  assert.equal(result.riverHit,true);
  assert.equal(result.externalInstalled,true);assert.equal(result.externalRemoved,true);
  assert.equal(result.externalFailureRecovered,true);
  assert.equal(result.externalPick,true);
  assert.equal(result.customPreserved,true);
  assert.equal(result.frozenBeforeAdmission,true);assert.equal(result.releasedAfterAdmission,true);assert.equal(result.supersededKept,true);assert.equal(result.failureKept,true);
  assert.deepEqual(result.picked,['current:상태%2']);assert.deepEqual(result.sourceIds,['territorial:entity:current%3A%EC%83%81%ED%83%9C%252']);assert.deepEqual(result.errors,[]);
  assert.ok(result.borderPixel[0]>110&&result.borderPixel[1]>140&&result.borderPixel[2]>90,'native antialiased country boundary is missing: '+result.borderPixel);
  assert.deepEqual(result.multiplyHits,['current:상태%2']);
  for(const [index,expected]of [68,113,45].entries())assert.ok(Math.abs(result.multiplied[index]-expected)<=3,JSON.stringify(result.multiplied));
  for(const [index,expected]of [27,75,12].entries())assert.ok(Math.abs(result.stroke[index]-expected)<=3,JSON.stringify(result));
  assert.deepEqual(result.restored,result.stroke);
  assert.deepEqual(result.highZoom,result.stroke);
  assert.ok(result.pixelPixels.every(Number.isFinite),'MapLibre owns stroke edge coverage in both quality modes');
  assert.ok(Array.from({length:12},(_,i)=>result.normalPixels.slice(i*4,i*4+3)).some(pixel=>[102,170,68].every((value,i)=>Math.abs(value-pixel[i])<=2)),'normal strokes must retain their color instead of multiplying the background');
  assert.equal(result.preparedAfter,result.preparedBefore,'edge mode and blend changes must reuse prepared geometry');
  assert.equal(result.hiddenHighlight,0);
  assert.ok(Math.abs(result.focused[0]-22)<0.001);assert.ok(Math.abs(result.focused[1])<0.001);
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
