import {loadPhysicalLandGeometry} from '../data/physical-land-patch.js';
import {geometryReferenceFor} from '../geometry/geometry-version-store.js';
import {timelineObjectKey} from '../document/timeline-records.js';
import {normalizeObjectRef} from '../document/object-ref-identity.js';
import {projectResourceOverlay} from '../document/project-resource-overlay.js';
import {createPhysicalAssetReader} from '../data/physical-asset-reader.js';
import {mapProjectResourcePath} from '../data/map-project-manifest.js';
import {resolvePhysicalWaterObjects,physicalWaterContextKey,physicalWaterReferenceView,composePhysicalWaterGeometry} from '../data/physical-water-model.js';
import {createPhysicalWaterPresentation} from './physical-water-presentation.js';

// Runtime coordinator: the data layer owns source reads and the C++ owner
// owns admitted identities; this rendering layer owns visual preparation.
export function createPhysicalResources({ buildMeta,capabilities = {builtinHydro:true,eagerBuiltinHydro:true} } = {}) {
  // The same Hydro reader currently serves both river and lake layers.
  const projectHydro=buildMeta?.mapProject?mapProjectResourcePath(buildMeta.mapProject,'rivers'):null;
  let dependencies;
  let hydroService;
  // Data-layer reader owns immutable asset loading and retries; rendering only
  // coordinates accepted source selection, Core admission and visual readiness.
  const assetReader=createPhysicalAssetReader({buildMeta,
    resolveBaseUrl:()=>dependencies.physicalConfig.PHYSICAL_DATA_BASE_URL,
    onLandReady:()=>dependencies.domains.renderingDomain.invalidateProject('physical-land-ready')});
  const storedPhysicalAssets=()=>assetReader.storedPhysicalAssets();
  const loadPhysicalLand=assetReader.loadPhysicalLand;
  const waterContexts=new Map();
  let requestedWaterKey=null;
  let physicalSelection=null;
  // The active document, not the serialized sourceMode field, selects
  // optional project-owned Hydro/physical-water catalogs.
  let activeSource='unbound',projectSourceEpoch=0;
  function setProjectSource(source){
    if(!['builtin','project','new'].includes(source))throw new TypeError('Unknown active map source');
    hydroService?.cancel();
    activeSource=source==='builtin'?'builtin':'project';
    projectSourceEpoch++;
    requestedWaterKey=null;physicalSelection=null;builtinTimelineView=null;
  }
  function physicalSelectionFor(date) {
    const catalog=buildMeta.physicalWaterObjects;
    const rows=resolvePhysicalWaterObjects(catalog,date)
      .sort((a,b)=>timelineObjectKey(a.objectRef).localeCompare(timelineObjectKey(b.objectRef)));
    if(rows.some(row=>row.assets.land.sha256!==rows[0].assets.land.sha256))throw new Error('Selected water objects require one coherent physical land derivative.');
    return {catalog,date,rows,key:physicalWaterContextKey(rows)};
  }
  function selectedPhysicalWater() {
    if(activeSource!=='builtin')
      return {catalog:null,date:null,rows:[],key:'inactive-project-water'};
    const catalog=buildMeta.physicalWaterObjects,date=dependencies.projectState.state.timelineCursor;
    if(!physicalSelection||physicalSelection.catalog!==catalog||physicalSelection.date!==date){
      physicalSelection=physicalSelectionFor(date);
    }
    return physicalSelection;
  }
  function ensurePhysicalContext({rows:selected,key}) {
    if(waterContexts.has(key))return waterContexts.get(key);
    const landAsset=selected[0].assets.land;
    const entry={status:'loading',value:null,promise:null,activation:null,presentation:null,presentationKey:null};
    waterContexts.set(key,entry);
    const loader=storedPhysicalAssets(),decode=buffer=>JSON.parse(new TextDecoder().decode(buffer));
    entry.promise=Promise.all([
      loadPhysicalLandGeometry(landAsset,{
        loadGeometry:spec=>loader.loadAsset(spec,'background',key+'-land','육지 배경',decode).then(result=>result.value),
        loadPatch:spec=>loader.loadAsset(spec,'background',key+'-land-replacement','지역 육지 변경',decode).then(result=>result.value),
      }).then(value=>({value})),
      ...selected.map(row=>loader.loadAsset(row.assets.asset,'background',JSON.stringify(row.geometryRef)+'-water','수역 형상',decode)),
    ]).then(([land,...waters])=>{
      if(land.value.type!=='MultiPolygon'||waters.some(water=>!['Polygon','MultiPolygon'].includes(water.value.type)))throw new Error('Invalid physical-water geometry.');
      entry.value=Object.freeze({geometry:land.value,revision:landAsset.sha256,
        waters:selected.map((row,index)=>({row,water:waters[index].value,waterRevision:row.assets.asset.sha256}))});
      entry.status='ready';return entry.value;
    }).catch(error=>{entry.status='error';entry.error=error;throw error;});
    return entry;
  }
  async function preparePhysicalContext(month,{isCurrent=()=>true,activeProject=null}={}) {
    // Imported projects change their C++ cursor identically, but they must not
    // prepare default-world's external historical lake/land references.
    if(activeProject&&activeProject.source!=='builtin')return null;
    const assertCurrent=()=>{if(!isCurrent())throw Object.assign(new Error('Physical preparation superseded'),{name:'AbortError',cancelled:true});};
    assertCurrent();
    const selection=physicalSelectionFor(month),entry=waterContexts.get(selection.key);
    if(entry?.status==='error')waterContexts.delete(selection.key);
    const result=selection.rows.length?await ensurePhysicalContext(selection).promise:await loadPhysicalLand();
    assertCurrent();return result;
  }
  function activatePhysicalContext(entry,key) {
    const cache=dependencies.projectState.state.hydroFeatureCache;
    const epoch=projectSourceEpoch;
    if(entry.activation&&entry.activation.cache===cache&&entry.activation.epoch===epoch)return;
    const activation={cache,epoch};entry.activation=activation;
    const isCurrent=()=>activeSource==='builtin'&&projectSourceEpoch===epoch
      &&requestedWaterKey===key&&selectedPhysicalWater().key===key
      &&dependencies.projectState.state.hydroFeatureCache===cache;
    activation.promise=entry.promise.then(async()=>{
      for(const value of entry.value.waters){
        if(!isCurrent())break;
        await admitSelectedWater(value.row,value,isCurrent);
      }
      if(isCurrent())dependencies.domains.renderingDomain.invalidateProject('physical-water-ready');
    }).catch(error=>{
      if(isCurrent())
        dependencies.feedback.reportOperationError(error,'수역 형상을 준비하지 못했습니다. 시점을 바꿨다가 돌아오면 다시 불러옵니다.','PL-PHYSICAL-HISTORY-001',4200);
    });
  }
  const presentPhysicalWater=createPhysicalWaterPresentation();
  function currentPhysicalContext() {
    const {rows:selected,key}=selectedPhysicalWater();
    if(!selected.length){requestedWaterKey=null;return assetReader.physicalLand;}
    if(key!==requestedWaterKey){
      requestedWaterKey=key;
      if(waterContexts.get(key)?.status==='error')waterContexts.delete(key);
      if(waterContexts.has(key))waterContexts.get(key).activation=null;
      // An old version cannot remain selectable while its successor loads.
      for(const row of selected)dependencies.projectState.state.hydroFeatureCache?.delete(row.objectRef.id);
    }
    const entry=ensurePhysicalContext({rows:selected,key}),state=dependencies.projectState.state;
    activatePhysicalContext(entry,key);
    // Core catalog admission can be queued behind the current project
    // replacement. Immutable mask readiness cannot wait for that queue.
    if(entry.status!=='ready')return assetReader.physicalLand;
    const edits=projectResourceOverlay('hydro',state.hydroEdits||[]);
    const presentations=entry.value.waters.map(value=>{
      const id=value.row.objectRef.id,replacement=edits.sourceReplacement(id);
      const feature=state.hydroFeatureCache?.get(id);
      const descriptor=feature||{id,properties:{pandolab_id:id,category:value.row.identity.entityKind,layer_id:value.row.identity.layerId}};
      const visible=capabilities.builtinHydro||feature?dependencies.physicalServices.isHydroFeatureVisible(descriptor):true;
      return {...value,replacement,visible};
    });
    const presentationKey=JSON.stringify(presentations.map(value=>[value.row.objectRef,value.row.geometryRef,
      value.replacement?geometryReferenceFor(value.replacement.geometry):null,value.visible]));
    if(entry.presentationKey===presentationKey)return entry.presentation;
    let geometry=entry.value.geometry,revision=entry.value.revision;
    const waterFeatures=[];
    for(const value of presentations){
      const result=presentPhysicalWater({geometry,revision,water:value.water,waterRevision:value.waterRevision,waterObjectRef:value.row.objectRef},value.replacement,value.visible);
      geometry=result.geometry;revision=result.revision;
      if(result.water)waterFeatures.push({type:'Feature',geometry:result.water,
        properties:{objectKey:normalizeObjectRef({domain:'hydro',type:value.row.identity.entityKind,id:value.row.objectRef.id}).key}});
    }
    const water=composePhysicalWaterGeometry(waterFeatures.map(feature=>feature.geometry));
    entry.presentationKey=presentationKey;
    entry.presentation=Object.freeze({geometry,revision,water,waterFeatures,waterRevision:JSON.stringify([key,presentationKey])});
    return entry.presentation;
  }

  async function admitSelectedWater(row,value,isCurrent) {
    const state=dependencies.projectState.state;
    if(!capabilities.builtinHydro||activeSource!=='builtin')return;
    if(!(state.hydroFeatureCache instanceof Map))throw new TypeError("The canonical hydro resource cache is required.");
    const feature=prepareHydroFeature({type:'Feature',id:row.objectRef.id,geometry:value.water,
      properties:{pandolab_id:row.objectRef.id,category:row.identity.entityKind,layer_id:row.identity.layerId,
        name:row.identity.name,name_ko:row.identity.name,source:row.identity.source,source_id:row.identity.sourceId||row.objectRef.id,
        min_zoom:0,physical_water:true,geometryRef:row.geometryRef}});
    await admitHydroFeatures([feature],{isCurrent});
  }
  let builtinTimelineView=null;
  function isHydroObjectActive(feature) {
    if(feature.properties?.pandolab_domain==='hydro')return true;
    if(activeSource!=='builtin')return false;
    const state=dependencies.projectState.state,date=state.timelineCursor;
    if(!date)return false;
    const selection=selectedPhysicalWater(),entry=waterContexts.get(selection.key);
    const ready=entry?.status==='ready';
    if(!builtinTimelineView||builtinTimelineView.catalog!==selection.catalog
      ||builtinTimelineView.date!==date||builtinTimelineView.key!==selection.key
      ||builtinTimelineView.ready!==ready) {
      builtinTimelineView={catalog:selection.catalog,date,key:selection.key,ready,
        reference:physicalWaterReferenceView(selection.catalog,selection.rows,ready)};
    }
    return builtinTimelineView.reference.isActive(feature.properties?.pandolab_id||feature.id);
  }
  function connect(ports) {
    if (dependencies) throw new Error('physical-resources already connected');
    dependencies = ports;
  }

  function prepareHydroFeature(feature) {
    const bounds = (0, dependencies.geometryBounds.coordinateBounds)(feature?.geometry?.coordinates);
    feature.__awBounds = bounds.every(Number.isFinite) ? bounds : [-180, -90, 180, 90];
    try { feature.__awCentroid = dependencies.platform.d3.geo.centroid(feature); }
    catch (_) { feature.__awCentroid = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]; }
    feature.__awRadius = Math.min(180, Math.hypot(bounds[2] - bounds[0], bounds[3] - bounds[1]) / 2);
    return feature;
  }

  function hydroDetailEnabled(){
    const visibility=dependencies.projectState.state.layerVisibility;
    return activeSource==='builtin'&&capabilities.builtinHydro
      && (visibility.rivers!==false||visibility.lakes!==false);
  }

  async function loadHydroData(explicit = false) {
    if(!hydroDetailEnabled()){hydroService?.cancel();return false;}
    if(!capabilities.eagerBuiltinHydro&&!explicit)return false;
    return hydroService.load();
  }

  function builtinHydroSelectionReferences(features=null) {
    if(activeSource!=='builtin')return [];
    features??=(0,dependencies.hydroPresentation.allBuiltInHydroFeatures)();
    return [...new Map(features.map(feature=>{
      const id=String(feature.properties?.pandolab_id || feature.id);
      const category=dependencies.hydroPresentation.HYDRO_LAYER_META[feature.properties?.layer_id]?.category || feature.properties?.category;
      const sourceIds=String(feature.properties?.source_id || '').split(',').filter(Boolean);
      return [id,{domain:'hydroBuiltin',id,logicalId:id,type:(0,dependencies.hydroPresentation.hydroCategoryKey)(category),sourceIds}];
    })).values()];
  }

  async function admitHydroFeatures(features=[],{isCurrent=()=>true}={}) {
    if(activeSource!=='builtin')return false;
    if(typeof dependencies.domains.projectDomain?.admitSelectionCatalog!=='function')
      throw new TypeError('Hydro source identities require the canonical Core admission boundary.');
    const cache=dependencies.projectState.state.hydroFeatureCache;
    if(!(cache instanceof Map))throw new TypeError('The canonical hydro resource cache is required.');
    const current=()=>isCurrent()&&activeSource==='builtin'&&dependencies.projectState.state.hydroFeatureCache===cache;
    if(!current())return false;
    const additions=new Map(features.map(feature=>[String(feature.properties?.pandolab_id||feature.id),feature]));
    await dependencies.domains.projectDomain.admitSelectionCatalog('hydroBuiltin',()=>{
      if(!current())return builtinHydroSelectionReferences();
      const combined=[...cache].map(([id,feature])=>additions.get(id)||feature);
      for(const [id,feature]of additions)if(!cache.has(id))combined.push(feature);
      return builtinHydroSelectionReferences(combined);
    });
    if(!current())return false;
    for(const feature of features) {
      const id=String(feature.properties?.pandolab_id || feature.id),existing=cache.get(id);
      // Descriptor/FID indexes point at this aggregate. Hydrate that same
      // resource allocation rather than replacing it with a second full row.
      if(existing && existing!==feature)Object.assign(existing,feature);
      else cache.set(id,feature);
      dependencies.projectState.state.hydroFeatureCatalogRevision=(dependencies.projectState.state.hydroFeatureCatalogRevision||0)+1;
    }
    return true;
  }

  async function loadPhysicalData({includeHydro=true}={}){
    try{return await Promise.all([loadPhysicalLand(),includeHydro ? loadHydroData() : false]);}
    catch(error){dependencies.feedback.reportOperationError(error,'지도 배경 자료를 준비하지 못했습니다.','PL-PHYSICAL-LOAD-001',4200);return false;}
  }

  function initializeHydroService() {
    if(capabilities.builtinHydro)(hydroService = (0, dependencies.physicalServices.createHydroService)({
      fetchWithRetry: dependencies.physicalServices.fetchWithRetry,
      dataVersion: buildMeta?.projectCatalogs?.rivers?.version||dependencies.physicalConfig.HYDRO_DATA_VERSION,
      manifestUrl: () => {
        const manifestUrl = new URL(projectHydro?projectHydro.slice('assets/data/'.length):
          `hydro/v${dependencies.physicalConfig.HYDRO_DATA_VERSION}/manifest.json`, dependencies.physicalConfig.PHYSICAL_DATA_BASE_URL);
        manifestUrl.searchParams.set('v', dependencies.physicalConfig.DATA_REVISION);
        return manifestUrl;
      },
      getLoadState: () => dependencies.projectState.state.physicalLoadState.hydro,
      loadKey:()=>projectSourceEpoch,
      isLoadCurrent:key=>hydroDetailEnabled()&&key===projectSourceEpoch,
      onLoading: () => {
        dependencies.projectState.state.physicalLoadState.hydro = 'loading';
        dependencies.projectState.state.physicalLoadState.hydroManifest = 'loading';
        dependencies.projectState.state.physicalLoadState.hydroWorker = 'starting';
        dependencies.projectState.state.physicalLoadState.hydroView = 'idle';
        (0, dependencies.layerPresentation.invalidateObjectPresentation)();
        dependencies.domains.objectSearchController?.render();
      },
      onRetry: (_operation, attempt) => dependencies.operationFeedback.reliabilityDiagnostic.push({
        category: 'asset', operation: 'hydro-manifest', result: `retry-${attempt}`,
      }),
      acceptManifest: async (manifest, manifestUrl,context) => {
        const isCurrent=context?.isCurrent||(()=>activeSource==='builtin');
        if(!isCurrent())return false;
        dependencies.projectState.state.hydroManifest = manifest;
        dependencies.projectState.state.physicalLoadState.hydroManifest = 'ready';
        dependencies.projectState.state.physicalLoadState.hydroCache = 'idle';
        dependencies.projectState.state.physicalLoadState.hydroCachePercent = 0;
        const renderer=dependencies.rendering.mapRenderer;
        let generation,workerReady;
        do {
          if(!isCurrent())return false;
          generation=renderer.getProjectGeneration();
          workerReady=await renderer.setHydroManifest(manifest,manifestUrl);
          if(!isCurrent())return false;
        } while(generation!==renderer.getProjectGeneration());
        if (!workerReady) return false;
        await admitHydroFeatures();
        if(!isCurrent())return false;
        dependencies.projectState.state.physicalLoadState.hydroWorker = 'ready';
        dependencies.projectState.state.physicalLoadState.hydro = 'ready';
        (0, dependencies.layerPresentation.invalidateObjectPresentation)();
        dependencies.domains.objectSearchController?.render();
        dependencies.domains.renderingDomain?.invalidateOverlayGeometry('hydro', 'hydro-ready');
        return true;
      },
      onFailure: error => {
        if (dependencies.projectState.state.physicalLoadState.hydroManifest !== 'ready') dependencies.projectState.state.physicalLoadState.hydroManifest = 'error';
        dependencies.projectState.state.physicalLoadState.hydroWorker = 'error';
        dependencies.projectState.state.physicalLoadState.hydro = 'error';
        dependencies.operationFeedback.reliabilityDiagnostic.push({ category: 'asset', operation: 'hydro-init', result: 'failed', errorCode: 'PL-WATER-001' });
        (0, dependencies.layerPresentation.invalidateObjectPresentation)();
        dependencies.domains.objectSearchController?.render();
        console.warn('Hydro load failed', error);
        (0, dependencies.feedback.reportOperationError)(error, '강·호수 목록을 불러오지 못했습니다. 국가 지도는 계속 사용할 수 있습니다. 페이지를 새로고침하거나 잠시 후 다시 시도하세요.', 'PL-WATER-001', 0);
      },
    }));
  }

  return Object.freeze({
    connect,
    setProjectSource,
    initializeHydroService,
    loadPhysicalLand,
    preparePhysicalContext,
    get physicalLand() { return currentPhysicalContext(); },
    get physicalLandSourceRevision() { return buildMeta.physicalLand?.sha256 || null; },
    get physicalContextState() {
      const context=currentPhysicalContext(),selection=selectedPhysicalWater(),entry=waterContexts.get(selection.key);
      const ready=selection.rows.length?entry?.status==='ready':!!assetReader.physicalLand;
      return {ready,error:entry?.error||null,
        landRevision:ready?context.revision:null,waterRevision:ready&&context.water?context.waterRevision:null};
    },
    get loadHydroData() { return loadHydroData; },
    builtinHydroSelectionReferences,
    isHydroObjectActive,
    hydroDetailEnabled,
    admitHydroFeatures,
    get loadPhysicalData() { return loadPhysicalData; },
    get prepareHydroFeature() { return prepareHydroFeature; },
  });
}
