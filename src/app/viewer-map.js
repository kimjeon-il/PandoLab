import {connectMapOwner,createMapReadPorts,mergeCapabilityPorts} from "./map-owner-ports.js";
import {createMapLibreInputPresentation} from "../map/maplibre-input-presentation.js";
import {workerAssetUrl} from "../runtime/worker-asset-url.js";
import {createAtomicMapStateController} from "./map-state-transition.js";
import {classifyTerritorialPropertyOnly,createTerritorialEntityStore} from "../document/territorial-entity-store.js";
import {temporalContains,temporalMonthEnd} from "../document/temporal.js";
import {createMapRenderingResources} from "../rendering/map-renderer-composition.js";
import {createMapLibreViewerRenderer} from "../rendering/maplibre-viewer-renderer.js";
import {createPhysicalSourceConfiguration,HYDRO_LAYER_META,HYDRO_TOOL_CONFIG,PHYSICAL_DATASET} from "../data/physical-source-configuration.js";
import {createMapSurfaceHost} from "../ui/map-surface-host.js";
import {setInteractionStyle as setSelectionInteractionStyle} from "../rendering/selection-style.js";
import "../geometry/polygon-geometry.js";
import "../geometry/polygon-clipping-core.js";
import {MAP_OBJECT_CATEGORIES,MAP_OBJECT_TYPES} from "../document/map-object-categories.js";
import {DISTRIBUTION_MODES,DISTRIBUTION_RENDER_MODES,distributionEntriesForLayer} from "../document/distribution-model.js";
import {BASE_DATASET} from "../document/initial-document.js";
import {createMapObjectSpatialIndex} from "../map/map-object-spatial-index.js";
import { createObjectQuery } from "../document/object-query.js";
import { normalizeObjectRef } from "../document/object-ref-identity.js";
import { COLOR_DOMAINS,readDomainColor,countryDefaultColor,DEFAULT_GENERIC_FEATURE_COLOR } from "../ui/color-adapter.js";
import {createMapLibreRenderingDomain} from "../rendering/maplibre-rendering-domain.js";
import {createAdaptiveRenderQualityController} from "../rendering/adaptive-render-quality.js";
import {createMapDisplayClient} from "../ui/map-display-client.js";
import {OVERLAY_GROUPS} from "../ui/layer-presentation.js";
import {initializeMapReadOwners} from "./map-owner-composition.js";
import {builtinSubunitSourceId} from "../document/territorial-display-identity.js";
import {buildRenderableStrokeFeature} from "../geometry/geographic-boundary.js";
import { createMapLayoutMetricsSnapshot, DEFAULT_SAFE_INSETS } from "../map/map-layout-metrics.js";
import { MAP_HOST_KINDS } from "../ui/map-host.js";
import { createMapVisualFrame } from "../rendering/map-visual-frame.js";
import {resolveMapPalette} from "../ui/map-palette.js";
import { createTerritorialEntityRepository } from "../document/territorial-entity-repository.js";
import { normalizeLayerPresentation } from "../ui/layer-presentation.js";
import {createHydroService,HYDRO_DATA_VERSION} from "../data/physical-layer-service.js";
import { fetchWithRetry } from "../runtime/reliability-core.js";
import { automaticLabelSettings, labelKey, LABEL_PRIORITIES } from "../rendering/label-layout.js";
import { layerStyle } from "../ui/layer-presentation.js";
import { coordinateBounds } from "../geometry/coordinate-bounds.js";
import { createRingHitTester } from "../geometry/ring-hit-test.js";

// Viewer map presentation logic migrated from the former split module.

function createViewerMapPreparationPresenter(getElement) {
  if (typeof getElement !== 'function') throw new TypeError('Viewer map presentation requires an element resolver.');
  return (presentation, { retry }) => {
    const label = getElement('mapPreparationStatus');
    const retryButton = getElement('mapPreparationRetry');
    const notice = getElement('mapPreparationNotice');
    const text = presentation.label.replace('현재 화면 ', '').replace('준비 실패', '불러오기 실패');
    if (label) {
      if (label.textContent !== text) label.textContent = text;
      label.hidden = presentation.status === 'ready';
    }
    if (notice) notice.hidden = presentation.status !== 'error';
    if (retryButton) {
      retryButton.hidden = !presentation.retry;
      retryButton.onclick = retry;
    }
  };
}
// End viewer map presentation helpers

/** Presentation adapter shared by the Viewer and Windows reviewer. */
export function createViewerMap({ runtimeContext,owners,element, canvas, projectDomain, documentSession, getPreferences, onError, onPlacesSettled, onStatus,isSafeKoreanErrorMessage,isMobile,diagnostics,getInteractionStyle,onMapPreparationStatus=null,isInitialPresentation }) {
  const meta=runtimeContext.meta;
  const d3 = globalThis.d3;
  if (!d3) throw new Error('지도 투영 라이브러리를 불러오지 못했습니다.');
  let renderingDomain=null;
  // The admitted empty document can already display the physical substrate.
  // Historical country data replaces it only after Core accepts that source.
  let session = documentSession, disposed = false;

  let updateGeneration = 0;
  const hitTester=createRingHitTester(globalThis.PandoLabPolygonGeometry.ensureClosedRing);
  let presentedEntities=null;
  let presentedHydroEdits=null;
  let lastFrame=null;

  const {projectResourcePorts,projectSourceRuntime,territorialSceneRuntime,projectSession,renderQuality,pointerTargets,cameraNavigation:navigation,countryIndex,spatialIndex,mapProjection,objectPresentation,hydroSettings:physicalSettings,objectCatalog,territorialLabels:labelOwner,physicalResources,gpuScene,mapHost,objectPicking}=owners;
  const commonPorts=createMapReadPorts(owners);
  connectMapOwner('projectSession',projectSession,mergeCapabilityPorts(commonPorts,{applicationConstants:{DISTRIBUTION_RENDER_MODES},
    modelValidation:{normalizeLayerPresentation},physicalConfig:{PHYSICAL_DATASET},domains:{selectionDomain:documentSession.selectionDomain},
    mapFactories:{createAtomicMapStateController},}));
  projectSession.initializeMapWorkScheduler();
  const state=projectSession.state,mapWorkScheduler=projectSession.mapWorkScheduler;
  const entityStore=createTerritorialEntityStore({documentModel:documentSession.documentModel,commandOwner:documentSession.commandOwner,
    onEntitiesReplaced:(entities,{rootGeometryChanged,propertyOnly=false})=>{
      // Property-only Core snapshots may have fresh Feature wrappers. Retain
      // proven identical spatial bounds; never retain them on a geometry,
      // membership or hierarchy change, or when no index was initialized.
      if(!propertyOnly||!spatialIndex.retainTerritorialSpatialIndex(entities))
        spatialIndex.mapObjectGeometryRevisions.territorial++;
      if(rootGeometryChanged)countryIndex.countryLandRevision++;
    }});
  projectSession.installDocumentProjection({documentModel:documentSession.documentModel,commandOwner:documentSession.commandOwner,entityStore});
  state.countryVisualPhase='canonical';
  const repository=createTerritorialEntityRepository({entityStore});
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));

  connectMapOwner('renderQuality',renderQuality,mergeCapabilityPorts(commonPorts,{projectState:{mapWorkScheduler},mapFactories:{createAdaptiveRenderQualityController},
    rendering:{get gpuMapRenderer(){return renderer;}},
    preferences:{get resolvedInteractionStyle(){return getInteractionStyle();}},selectionServices:{setSelectionInteractionStyle},
    domains:{get renderingDomain(){return renderingDomain;}}}));
  renderQuality.initializeRenderQualityController();

  const palette = () => resolveMapPalette({state});
  const schedule = () => { if(!disposed&&session&&renderingDomain)renderingDomain.invalidateView('map-view'); };
  Object.defineProperty(state,'projectReplacing',{get:()=>projectDomain.isReplacing()});
  const hydroEditById=physicalSettings.hydroEditById,hydroById=physicalSettings.hydroFeatureById;

  const readPorts={platform:{get polygonClipping(){return globalThis.polygonClipping;}},preferences:{get userPreferences(){return getPreferences();}},projectSession,domains:{projectDomain,get selectionDomain(){return documentSession.selectionDomain;}},projectState:{state},territorialModel:{entityRepository:repository,DISTRIBUTION_MODES},
    colorModel:{COLOR_DOMAINS,readDomainColor,countryDefaultColor,DEFAULT_GENERIC_FEATURE_COLOR,defaultCountryColor:feature=>countryDefaultColor(feature)||palette().defaultLand},
    objectDefinitions:{MAP_OBJECT_CATEGORIES,MAP_OBJECT_TYPES},
    objectPresentation,hydroModel:{hydroFeatureById:hydroById},labelPresentation:commonPorts.labelPresentation,
    hydroPresentation:{HYDRO_LAYER_META,HYDRO_TOOL_CONFIG,hydroEditById,hydroCategoryKey:value=>objectPresentation.hydroCategoryKey(value),hydroDisplayColor:physicalSettings.hydroDisplayColor,
      hydroEditorName:objectPresentation.hydroEditorName,hydroFallbackName:value=>objectPresentation.hydroFallbackName(value),hydroCategoryLabel:value=>objectPresentation.hydroCategoryLabel(value),
},
    distributionPresentation:{distributionColor:layer=>objectPresentation.distributionColor(layer)},
    distributionServices:{distributionEntriesForLayer},
    selectionServices:{normalizeObjectRef},objectLookup:{distributionLayerById:id=>state.distributionLayers.find(layer=>String(layer.id)===String(id))},
    layerPresentation:{ASSET_REVISION:meta.assetRevision,isLayerItemVisible:objectCatalog.isLayerItemVisible,layerGroupNames:{distributions:'분포'}}};
  connectMapOwner('objectPresentation',objectPresentation,mergeCapabilityPorts(commonPorts,readPorts));initializeMapReadOwners(owners,'queries');
  Object.assign(readPorts.colorModel,{territorialEntityColor:objectPresentation.territorialEntityColor,genericFeatureColor:objectPresentation.genericFeatureColor});
  const objectQuery=createObjectQuery(readPorts);
  connectMapOwner('objectCatalog',objectCatalog,mergeCapabilityPorts(commonPorts,readPorts));
  const runtimeAssetUrl = path => {const url=runtimeContext.assetUrl(path);return /\/workers\/[\w-]+-worker\.js$/.test(url.pathname)?workerAssetUrl(url,meta):url;};
  const physicalConfig={...createPhysicalSourceConfiguration({assetBaseUrl:runtimeContext.assetBaseUrl,mapProject:meta.mapProject}),
    DATA_REVISION:meta.dataRevision,HYDRO_DATA_VERSION,PHYSICAL_DATASET};
  const territorialScope=objectPresentation.territorialScope;
  connectMapOwner('projectResourcePorts',projectResourcePorts,mergeCapabilityPorts(commonPorts,{territorialModel:{entityRepository:repository},territorialObjectModel:{territorialScope},
    objectDefinitions:{builtinSubunitSourceId},layerStyleServices:{layerStyle},runtimeConfiguration:{BASE_DATASET},domains:{projectDomain},
    rendering:{get gpuMapRenderer(){return renderer;}},layerPresentation:objectCatalog}));
  territorialSceneRuntime.initializePristineCountriesFallback();
  const releaseGeometryLoader=documentSession.commandOwner.setGeometryLoader(projectSourceRuntime.loadGeometryResources);
  connectMapOwner('hydroSettings',physicalSettings,mergeCapabilityPorts(commonPorts,{physicalResources,physicalConfig,preferences:{mapPalette:palette},platform:{$:id=>document.getElementById(id),clamp},
    hydroPresentation:readPorts.hydroPresentation,objectPresentation,layerPresentation:objectCatalog}));
  Object.assign(readPorts.hydroPresentation,{allBuiltInHydroFeatures:physicalSettings.allBuiltInHydroFeatures,
    hydroLayerVisible:physicalSettings.hydroLayerVisible,hydroLineParts:physicalSettings.hydroLineParts});
  connectMapOwner('physicalResources',physicalResources,mergeCapabilityPorts(commonPorts,{physicalConfig,physicalServices:{createHydroService,fetchWithRetry,},
    hydroPresentation:readPorts.hydroPresentation,platform:{d3},cutGeometry:{coordinateBounds},
    layerPresentation:objectCatalog,domains:{projectDomain,get renderingDomain(){return renderingDomain;},objectSearchController:{render:()=>onPlacesSettled('render')}},
    operationFeedback:{reliabilityDiagnostic:diagnostics},
    rendering:{get gpuMapRenderer(){return renderer;}},feedback:{reportOperationError:onError}}));
  const renderer=createMapLibreViewerRenderer({projectState:{state,mapWorkScheduler},physicalConfig,
    runtimeConfiguration:{APP_VERSION:meta.appVersion},layerPresentation:{ASSET_REVISION:meta.assetRevision,isLayerItemVisible:objectCatalog.isLayerItemVisible},
    preferences:{mapPalette:palette},colorModel:readPorts.colorModel,
    platform:{d3,deepClone:structuredClone,$:id=>document.getElementById(id),runtimeAssetUrl},
    countries:territorialSceneRuntime,builtinCountries:territorialSceneRuntime,countryLabelModel:labelOwner,
    territorialModel:{entityRepository:repository},containsGeometry:(coordinate,geometry)=>hitTester.containsGeometry(coordinate,geometry),objectRefVisible:objectQuery.objectRefVisible,hydroPresentation:readPorts.hydroPresentation,hydroModel:{hydroFeatureById:hydroById},
    physicalResources,physicalServices:{isHydroFeatureVisible:physicalSettings.isHydroFeatureVisible},surfaces:{isMobile},
    readinessUi:{isSafeKoreanErrorMessage},mapHostView:{queueMapResize:()=>mapHost.queueMapResize()},
    mapView:{get mapHost(){return mapHost.mapHost;}},domains:{get renderingDomain(){return renderingDomain;}},
    renderQuality,renderScene:{get currentRenderQuality(){return renderQuality.currentRenderQuality;}},
    feedback:{reportOperationError:onError,setActionStatus:onStatus}},{presentMapPreparation:createViewerMapPreparationPresenter(id=>document.getElementById(id)),onMapPreparationStatus});
  let initialView=state.view;
  Object.defineProperty(state,'view',{configurable:true,enumerable:true,get(){
    const camera=renderer.cameraSnapshot();
    if(!camera)return initialView;
    initialView=null;
    return Object.freeze({globeRotation:Object.freeze([-camera.center[0],-camera.center[1],0]),zoom:camera.zoom});
  },set(view){if(renderer.loaded)renderer.syncCameraFromState(view);else initialView=view;}});
  let initialized;
  physicalResources.initializeHydroService();

  connectMapOwner('mapProjection',mapProjection,mergeCapabilityPorts(commonPorts,{platform:{d3,clamp,$:id=>document.getElementById(id)},surfaces:{isMobile,},
    mapLayout:{createMapLayoutMetricsSnapshot,DEFAULT_SAFE_INSETS}}));
  initializeMapReadOwners(owners,'projection');
  mapProjection.installMapLibreRenderer(renderer);

  connectMapOwner('mapHost',mapHost,mergeCapabilityPorts(commonPorts,{platform:{d3,$:id=>document.getElementById(id),deepClone:structuredClone},mapView:mapProjection,projectionView:mapProjection,
    navigation,workspaceUi:owners.workspaceSurfaces,mapLayers:{},
    readiness:{reliabilityDiagnostic:diagnostics},preferences:{syncResolvedInteractionStyle:renderQuality.syncResolvedInteractionStyle},
    applicationConstants:{MAP_HOST_KINDS},
    runtimeConfiguration:{},rendering:{gpuMapRenderer:renderer},surfaces:{isMobile},
    mapLayout:{DEFAULT_SAFE_INSETS,},
    domains:{projectDomain,get renderingDomain(){return renderingDomain;}},renderQuality,renderFactories:{createMapVisualFrame,createMapSurfaceHost}}));

  connectMapOwner('cameraNavigation',navigation,mergeCapabilityPorts(commonPorts,{platform:{d3,clamp},surfaces:{isMobile},
    rendering:{gpuMapRenderer:renderer},objectLookup:objectQuery,physicalData:{HYDRO_LAYER_META:readPorts.hydroPresentation.HYDRO_LAYER_META},
    domains:{get selectionUiController(){return documentSession.selectionUiController;},renderingDomain:{beginInteraction:()=>inputPresentation.beginMovement(),endInteraction:()=>inputPresentation.finishMovement(),invalidateView:schedule}}}));

  connectMapOwner('spatialIndex',spatialIndex,mergeCapabilityPorts(commonPorts,{projectState:{mapWorkScheduler},territorialModel:{entityRepository:repository},cutGeometry:{coordinateBounds},
    mapView:mapProjection,spatialFactories:{createMapObjectSpatialIndex},domains:{get renderingDomain(){return renderingDomain;}},surfaces:{isMobile},rendering:{get selectionPerformanceMetrics(){return selectionPerformanceMetrics;}}}));
  initializeMapReadOwners(owners,'spatial');
  Object.assign(readPorts,{navigation,territorialObjectModel:{territorialScope},countries:{builtinTerritorialScene:territorialSceneRuntime.builtinTerritorialScene,validLabelAnchor:countryIndex.validLabelAnchor},surfaces:{isMobile},feedback:{setActionStatus:onStatus}});
  const countryPorts={projectState:{state,mapWorkScheduler},platform:{d3,deepClone:structuredClone,runtimeAssetUrl},
    countries:{builtinTerritorialScene:territorialSceneRuntime.builtinTerritorialScene,territorialLabelFeatureById:territorialSceneRuntime.territorialLabelFeatureById,
      PRISTINE_LABEL_ANCHORS:territorialSceneRuntime.PRISTINE_LABEL_ANCHORS},
    objectDisplay:{invalidateObjectPresentation:objectCatalog.invalidateObjectPresentation},mapView:{ringRepresentativePoint:mapProjection.ringRepresentativePoint},
    domains:{get projectDomain(){return projectDomain;},get renderingDomain(){return renderingDomain;}}};
  connectMapOwner('countryIndex',countryIndex,mergeCapabilityPorts(commonPorts,countryPorts));initializeMapReadOwners(owners,'anchors');
  const labelPorts={...countryPorts,rendering:{gpuMapRenderer:renderer},territorialModel:{entityRepository:repository},territorialObjectModel:{territorialScope},objectPresentation,
    countries:{...countryPorts.countries,scheduleCountryLabelAnchors:countryIndex.scheduleCountryLabelAnchors},
    mapView:mapProjection,mapHostView:{projectionViewSnapshot:mapHost.projectionViewSnapshot},
    layerPresentation:{...readPorts.layerPresentation,isLayerItemVisible:objectCatalog.isLayerItemVisible,isCountryVisibleById:objectCatalog.isCountryVisibleById},
    labelPresentation:{automaticLabelSettings,labelKey,LABEL_PRIORITIES,buildRenderableStrokeFeature,
      get pendingCountryLabelAnchors(){return countryIndex.pendingCountryLabelAnchors;},get countryLabelAnchors(){return countryIndex.countryLabelAnchors;}},
    preferences:{get userPreferences(){return getPreferences();}},surfaces:{isMobile},renderScene:{get currentRenderQuality(){return renderQuality.currentRenderQuality;}},
    spatialQuery:{geometryBounds:spatialIndex.geometryBounds,visibleMapObjectCandidates:spatialIndex.visibleMapObjectCandidates,viewportCullingMetrics:spatialIndex.viewportCullingMetrics},
    feedback:{reportOperationError:onError},domains:{get renderingDomain(){return renderingDomain;},get projectDomain(){return projectDomain;},
      get selectionDomain(){return documentSession.selectionDomain;},objectSearchController:{cancelSearch:()=>onPlacesSettled('cancel'),render:()=>onPlacesSettled('render')}}};
  connectMapOwner('territorialLabels',labelOwner,mergeCapabilityPorts(commonPorts,labelPorts));initializeMapReadOwners(owners,'labels');
  const places=()=>labelOwner.builtinPlaces;
  connectMapOwner('gpuScene',gpuScene,mergeCapabilityPorts(commonPorts,{rendering:{gpuMapRenderer:renderer}}));
  gpuScene.initializeGpuSceneDomains();
  mapHost.attachMapOutput({gpuCanvas:canvas});
  initialized=Promise.all([renderer.initialize(),mapHost.initializeMapHost()]);
  initialized.then(()=>renderingDomain.invalidateProject('map-initialized'))
    .catch(error=>onError(error,'지도 표시를 준비하지 못했습니다.','PL-MAP-INITIALIZE-001'));
  const selectionDomain=documentSession.selectionDomain;

  const mapDisplay=createMapDisplayClient({getEntities:territorialScope.displayEntities,getRevision:()=>spatialIndex.mapObjectGeometryRevisions.territorial});
  renderingDomain=createMapLibreRenderingDomain({gpuMapRenderer:renderer,projectDomain,selectionDomain:selectionDomain,
    mapHost:()=>mapHost.mapHost,
    prepareMapDisplay:mapDisplay.prepare,disposeMapDisplay:mapDisplay.dispose,
    ...createMapRenderingResources({session:{selectionDomain,objectSearchController:{cancelSearch:()=>onPlacesSettled('cancel')}},ports:mergeCapabilityPorts(commonPorts,readPorts,{
    domains:{projectDomain,selectionDomain,get renderingDomain(){return renderingDomain;}},
    objectPicking,gpuSceneServices:gpuScene,spatialRecords:spatialIndex,
    preferences:{mapPalette:palette,get resolvedInteractionStyle(){return getInteractionStyle();}},
    mapDisplayModel:{get distributionVisibilityRevision(){return objectPresentation.distributionVisibilityRevision;}},
  })}),

    prepareView:options=>{
      lastFrame=mapHost.prepareVisualFrame(options);
      // Do not resize/clear visible GPU pixels during frame preparation.
      return lastFrame;
    },
    renderers:{labelLayout:frame=>labelOwner.visibleLabelLayout(frame)},
    reportDiagnostic:entry=>diagnostics.push({category:'rendering-domain',...entry}),
  });
  renderQuality.applyAdaptiveRenderQuality();
  renderQuality.syncResolvedInteractionStyle();
  function buildScene(){if(!session)return;objectCatalog.invalidateObjectPresentation();renderingDomain.invalidateProject('document-presentation');}
  async function update({previousMonth}={}) {
    if(!session)return;
    const generation=++updateGeneration;
    const entities=entityStore.snapshot();
    const previous=presentedEntities;
    if(!previous||previous!==entities)state.countryIndex=new Map(entities.map(feature=>[String(feature.id),feature]));
    const territorialFeatures=territorialScope.displayEntities().filter(feature=>feature.properties.entityKind==='general');
    await initialized;if(generation!==updateGeneration)return;
    // A dated source is admitted before its matching MapLibre render event.
    if(!await renderer.prepareTemporalCountrySource(territorialFeatures)||generation!==updateGeneration)return;
    if(!await renderer.setTerritorialFeatures(territorialFeatures)||generation!==updateGeneration)return;
    presentedEntities=entities;
    const hydroChanged=presentedHydroEdits!==state.hydroEdits;
    presentedHydroEdits=state.hydroEdits;
    // Distribution lifetimes can change on their own, even with identical national geometry.
    let distributionChanged=false;
    if(previousMonth&&previousMonth!==state.timelineCursor&&state.layerVisibility.distributions!==false){
      const before=temporalMonthEnd(previousMonth),after=temporalMonthEnd(state.timelineCursor);
      distributionChanged=[state.distributionLayers,state.distributionEntries].some(rows=>rows.some(row=>
        (row.validFrom||row.validTo)&&temporalContains(row,before)!==temporalContains(row,after)));
    }
    const propertiesOnly=previous&&classifyTerritorialPropertyOnly(previous,entities);
    const regionalPaint=propertiesOnly?.paintChangedIds.some(id=>repository.get(id)?.properties.entityKind==='regional');
    if(!previousMonth||distributionChanged||regionalPaint||previous!==entities&&!propertiesOnly)buildScene();
    else {
      if(previous!==entities)objectCatalog.invalidateObjectPresentation();
      if(hydroChanged)renderingDomain.invalidateSelection('dated-hydro');
      const zoom=renderer.labelZoomVisibility();
      if(zoom.country||zoom.places)renderingDomain.invalidateLabels('document-month-labels');
      else renderingDomain.invalidateView('temporal-source-admitted');
    }
  }
  const selectionPerformanceMetrics={};

  connectMapOwner('objectPicking',objectPicking,mergeCapabilityPorts(commonPorts,{territorialObjectModel:{territorialScope},platform:{d3,$:id=>document.getElementById(id),clamp},
    selectionServices:{normalizeObjectRef},objectLookup:objectQuery,objectOperations:objectQuery,territorialModel:{entityRepository:repository},
    renderScene:{OVERLAY_GROUPS},mapView:mapProjection,
    landRelations:{pointInCountryFeature:(coord,feature)=>hitTester.containsGeometry(coord,feature.geometry)},
    hydroModel:{hydroFeatureById:hydroById},rendering:{gpuMapRenderer:renderer,selectionPerformanceMetrics},hydroPresentation:{hydroEditById},surfaces:{isMobile},

    pointerInteraction:{get hydroAtScreenPoint(){return pointerTargets.hydroAtScreenPoint;}},
    domains:{projectDomain,selectionDomain:selectionDomain,get selectionUiController(){return documentSession.selectionUiController;}},

    feedback:{reportOperationError:onError}}));
  objectPicking.bindChooser();

  connectMapOwner('pointerTargets',pointerTargets,mergeCapabilityPorts(commonPorts,{mapView:mapProjection,objectPicking,physicalResources,
    hydroPresentation:readPorts.hydroPresentation,
    domains:{projectDomain,selectionDomain:selectionDomain},
    layerPresentation:objectCatalog,landRelations:{pointInCountryFeature:(coord,feature)=>hitTester.containsGeometry(coord,feature.geometry)},
    platform:{d3,clamp},surfaces:{isMobile},rendering:{gpuMapRenderer:renderer},feedback:{reportOperationError:onError}}));
  pointerTargets.initializeHoverPickFrame();
  const inputPresentation=createMapLibreInputPresentation({renderer,initialized,
    ports:mergeCapabilityPorts(commonPorts,{
      platform:{$:id=>document.getElementById(id),d3},rendering:{gpuMapRenderer:renderer},
      domains:{renderingDomain,selectionDomain,projectDomain},navigation,mapView:mapProjection,
      objectPicking,surfaces:{isMobile},feedback:{reportOperationError:onError},
      pointerInteraction:{cancelCountryHoverPick:pointerTargets.cancelCountryHoverPick,mapNavigationEnabled:()=>!!session&&!state.projectReplacing,
        mapClickBlocked:pointerTargets.mapClickBlocked,queueCountryHoverPick:pointerTargets.queueCountryHoverPick,
        suppressNextMapClick:pointerTargets.suppressNextMapClick},
      interactionStateCommands:{setHoverHit:hit=>{state.hoverHit=hit;}}
    })});
  inputPresentation.bindSvg(d3.select(element));
  mapHost.startMapResizeObserver();
  return Object.freeze({
    async setSession(next,{view=null,prepareView=null,source='project'}={}){
      if(next!==documentSession)throw new Error('Map output requires its single document session.');
      // The admitted reader origin is an in-memory session property, not an
      // interpretation of the backward-compatible projectSetup.sourceMode.
      physicalResources.setProjectSource(source);
      labelOwner.setProjectSource(source);
      session=next;
      projectSession.setViewingPresentation(view||{},{reset:true});
      if(prepareView)await prepareView();
      // Validate the restored visibility against this admitted document before
      // its one canonical scene build; Core catalog/selection pruning follows
      // outside the replacement command transaction.
      projectSession.pruneViewingItems(objectCatalog.presentationCatalog());
      await update();
    },
    ready:initialized,
    cancelSearch:()=>places().cancelSearch(),update,features:entityStore.snapshot,searchPlaces:query=>labelOwner.searchPlaces(query),renderer,
    loadPhysicalResources:physicalResources.loadPhysicalData,loadPhysicalLandMask:physicalResources.loadPhysicalLandMask,viewState:state,objectPresentation,searchActive:()=>places().isSearchOpen(),
    prepareBuiltinProject:async(month,options)=>{
      // Parallel country/physical preparation must not orphan a native
      // candidate when only the physical half fails or is superseded.
      const [candidate,physical]=await Promise.allSettled([
        projectSourceRuntime.prepareProjectCandidate(month,options),
        physicalResources.preparePhysicalContext(month,options),
      ]);
      if(candidate.status==='fulfilled'&&physical.status==='rejected')
        await projectDomain.discardTemporalBuiltin(candidate.value);
      if(candidate.status==='rejected')throw candidate.reason;
      if(physical.status==='rejected')throw physical.reason;
      return candidate.value;
    },
    placeSelectionReferences:labelOwner.builtinPlaceSelectionReferences,hydroSelectionReferences:physicalResources.builtinHydroSelectionReferences,
    objectPicking,closeObjectChooser:objectPicking.closeObjectChooser,objectCatalog,objectQuery,refreshSelection:reason=>renderingDomain.invalidateSelection(reason),
    capturePresentation:projectSession.captureViewingPresentation,
    physicalSettings:()=>state.physicalSettings,
    entityRepository:repository,
    displayState:()=>({...session?.documentModel.snapshot(),...state,projection:state.projection}),

    applyPresentation:projectSession.applyViewingPresentation,
    distributionPresentation:{bumpVisibilityRevision:()=>{objectPresentation.distributionVisibilityRevision++;}},
    refreshAppearance(options){renderQuality.applyMapAppearanceChange(options);objectCatalog.invalidateObjectPresentation();onPlacesSettled('render');},

    navigation,mapProjection,projectSession,renderingDomain,
    dispose(){disposed=true;releaseGeometryLoader();projectSourceRuntime.dispose();entityStore.dispose();inputPresentation.dispose();pointerTargets.cancelCountryHoverPick();countryIndex.resetCountryLabelAnchorRuntime();mapHost.stopMapResizeObserver();renderingDomain.dispose();renderer.dispose();},
  });
}
