import { connectMapOwner, createMapReadPorts, mergeMapPorts } from './map-owner-ports.js';
import { createMapInputPresentation } from '../map/map-input-presentation.js';
import { workerAssetUrl } from '../runtime/worker-asset-url.js';
import { createAtomicMapStateController } from './map-state-transition.js';
import { classifyTerritorialPropertyOnly, createTerritorialEntityStore } from '../document/territorial-entity-store.js';
import { worldViewChange } from '../document/world-view-change.js';
import { temporalContains, temporalMonthEnd } from '../document/temporal.js';
import { createDistributionRenderRows } from '../ui/map-content-presentation.js';
import { createThreeViewerRenderer } from '../rendering/three-viewer-renderer.js';
import { prepareGlobeTimelineSources } from '../rendering/globe-temporal-presentation.js';
import { createPhysicalSourceConfiguration, HYDRO_LAYER_META, HYDRO_CATEGORY_STYLES, PHYSICAL_DATASET } from '../data/physical-source-configuration.js';
import '../geometry/polygon-geometry.js';
import '../geometry/polygon-clipping-core.js';
import { MAP_OBJECT_CATEGORIES, MAP_OBJECT_TYPES } from '../document/map-object-categories.js';
import { DISTRIBUTION_MODES, DISTRIBUTION_RENDER_MODES, distributionEntriesForLayer } from '../document/distribution-model.js';
import { BASE_DATASET } from '../document/initial-document.js';
import { createMapObjectSpatialIndex } from '../map/map-object-spatial-index.js';
import { createObjectQuery } from '../document/object-query.js';
import { normalizeObjectRef } from '../document/object-ref-identity.js';
import { COLOR_DOMAINS, readDomainColor, countryDefaultColor, DEFAULT_GENERIC_FEATURE_COLOR } from '../ui/color-adapter.js';
import { createViewerRenderingDomain } from '../rendering/viewer-rendering-domain.js';
import { createAdaptiveRenderQualityController } from '../rendering/adaptive-render-quality.js';
import { OVERLAY_GROUPS } from '../ui/layer-presentation.js';
import { createMapLayoutMetricsSnapshot, DEFAULT_SAFE_INSETS } from '../map/map-layout-metrics.js';
import { createMapVisualFrame } from '../rendering/map-visual-frame.js';
import { resolveMapPalette } from '../ui/map-palette.js';
import { createTerritorialEntityRepository } from '../document/territorial-entity-repository.js';
import { normalizeLayerPresentation } from '../ui/layer-presentation.js';
import { createHydroService, HYDRO_DATA_VERSION } from '../data/physical-layer-service.js';
import { fetchWithRetry } from '../runtime/reliability-core.js';
import { automaticLabelSettings, labelKey, LABEL_PRIORITIES } from '../rendering/label-layout.js';
import { coordinateBounds } from '../geometry/coordinate-bounds.js';
import { createRingHitTester } from '../geometry/ring-hit-test.js';
import { createProjectSourceRuntime } from '../document/project-source-runtime.js';

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
/** Map presentation adapter for the Web Viewer. */
export function createViewerMap({ runtimeContext, owners, projectDomain, documentSession, getPreferences, onError, onPlacesSettled, onStatus, diagnostics, getInteractionStyle, onMapPreparationStatus = null, initialCamera, onWorldFitChange }) {
  const meta = runtimeContext.meta;
  const d3 = globalThis.d3;
  if (!d3) throw new Error('지도 투영 라이브러리를 불러오지 못했습니다.');
  let renderingDomain = null;
  let renderer = null;
  // The admitted empty document can already display the physical substrate.
  // Historical country data replaces it only after Core accepts that source.

  let updateGeneration = 0;
  const hitTester = createRingHitTester(globalThis.PandoLabPolygonGeometry.ensureClosedRing);
  let presentedEntities = null;
  let presentedHydroEdits = null;

  const {territorialSceneRuntime, projectSession, renderQuality, pointerTargets, cameraNavigation:navigation, countryIndex, spatialIndex, mapProjection, objectPresentation, hydroSettings:physicalSettings, objectCatalog, territorialLabels:labelOwner, physicalResources, mapHost, objectPicking} = owners;
  const $ = id => document.getElementById(id);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const palette = () => resolveMapPalette({state});
  const runtimeAssetUrl = path => {
    const url = runtimeContext.assetUrl(path);
    return /\/workers\/[\w-]+-worker\.js$/.test(url.pathname) ? workerAssetUrl(url, meta) : url;
  };
  const selectionPerformanceMetrics = {};
  // Session-owned values are read lazily so the existing initialization order is preserved.
  const ports = mergeMapPorts(createMapReadPorts(owners), {
    platform: {d3, $, clamp, deepClone: structuredClone, runtimeAssetUrl,
      get polygonClipping() {return globalThis.polygonClipping;}},
    preferences: {mapPalette: palette, get userPreferences() {return getPreferences();},
      get resolvedInteractionStyle() {return getInteractionStyle();}},
    projectSession,
    domains: {projectDomain, get selectionDomain() {return documentSession.selectionDomain;},
      get selectionUiController() {return documentSession.selectionUiController;},
      get renderingDomain() {return renderingDomain;},
      objectSearchController: {
        cancelSearch: () => onPlacesSettled('cancel'),
        render: () => onPlacesSettled('render'),
      }},
    rendering: {get mapRenderer() {return renderer;}, selectionPerformanceMetrics,
      invalidateChooserHighlight: () => renderingDomain.invalidateSelection('chooser-candidates')},
    feedback: {reportOperationError: onError, setActionStatus: onStatus},
    territorialModel: {get entityRepository() {return repository;}, DISTRIBUTION_MODES},
    colorModel: {COLOR_DOMAINS, readDomainColor, countryDefaultColor, DEFAULT_GENERIC_FEATURE_COLOR,
      defaultCountryColor: feature => countryDefaultColor(feature) || palette().defaultLand},
    objectDefinitions: {MAP_OBJECT_CATEGORIES, MAP_OBJECT_TYPES},
    hydroPresentation: {HYDRO_LAYER_META, HYDRO_CATEGORY_STYLES},
    distributionServices: {distributionEntriesForLayer},
    selectionServices: {normalizeObjectRef},
    objectLookup: {
      distributionLayerById: id => state.distributionLayers.find(layer => String(layer.id) === String(id)),
      get layerItemObjectRef() {return objectQuery.layerItemObjectRef;},
      get objectRefExists() {return objectQuery.objectRefExists;},
    },
    objectOperations: {
      get objectDisplayInfo() {return objectQuery.objectDisplayInfo;},
      get objectRefVisible() {return objectQuery.objectRefVisible;},
    },
    layerPresentation: {ASSET_REVISION: meta.assetRevision},
    physicalConfig: {
      ...createPhysicalSourceConfiguration({assetBaseUrl: runtimeContext.assetBaseUrl, mapProject: meta.mapProject}),
      DATA_REVISION: meta.dataRevision, HYDRO_DATA_VERSION, PHYSICAL_DATASET,
    },
    physicalData: {HYDRO_LAYER_META},
    physicalServices: {createHydroService, fetchWithRetry},
    operationFeedback: {reliabilityDiagnostic: diagnostics},
    applicationConstants: {DISTRIBUTION_RENDER_MODES},
    modelValidation: {normalizeLayerPresentation},
    mapFactories: {createAtomicMapStateController, createAdaptiveRenderQualityController},
    mapLayout: {createMapLayoutMetricsSnapshot, DEFAULT_SAFE_INSETS},
    renderFactories: {createMapVisualFrame},
    spatialFactories: {createMapObjectSpatialIndex},
    geometryBounds: {coordinateBounds},
    labelPresentation: {automaticLabelSettings, labelKey, LABEL_PRIORITIES},
    renderScene: {OVERLAY_GROUPS},
    landRelations: {pointInCountryFeature: (coord, feature) => hitTester.containsGeometry(coord, feature.geometry)},
  });
  const connectOwner = name => connectMapOwner(name, owners[name], ports);
  connectOwner('projectSession');
  projectSession.initializeMapWorkScheduler();
  const state = projectSession.state;
  const entityStore = createTerritorialEntityStore({documentModel:documentSession.documentModel, commandOwner:documentSession.commandOwner,
    onEntitiesReplaced:(entities, {rootGeometryChanged, propertyOnly = false}) => {
      // Property-only Core snapshots may have fresh Feature wrappers. Retain
      // proven identical spatial bounds; never retain them on a geometry,
      // membership or hierarchy change, or when no index was initialized.
      spatialIndex.noteTerritorialChange(entities, {propertyOnly});
      if (rootGeometryChanged) countryIndex.noteRootGeometryChange();
    }});
  projectSession.installDocumentProjection({documentModel:documentSession.documentModel, commandOwner:documentSession.commandOwner, entityStore});
  const repository = createTerritorialEntityRepository({entityStore});
  connectOwner('renderQuality');
  renderQuality.initializeRenderQualityController();

  connectOwner('objectPresentation');
  objectPresentation.initializeTerritorialScope();
  objectPresentation.initializeObjectPresentationModel();
  const objectQuery = createObjectQuery({
    projectState: ports.projectState, territorialModel: ports.territorialModel,
    territorialObjectModel: ports.territorialObjectModel, selectionServices: ports.selectionServices,
    hydroPresentation: ports.hydroPresentation, hydroModel: ports.hydroModel,
    labelPresentation: ports.labelPresentation, layerPresentation: ports.layerPresentation,
    objectPresentation: ports.objectPresentation, distributionServices: ports.distributionServices,
    objectLookup: ports.objectLookup, preferences: ports.preferences,
    navigation: ports.navigation, feedback: ports.feedback,
  });
  connectOwner('objectCatalog');
  const projectSourceRuntime = createProjectSourceRuntime({buildMeta: meta, projectDomain, baseDataset: BASE_DATASET});
  const releaseGeometryLoader = documentSession.commandOwner.setGeometryLoader(projectSourceRuntime.loadGeometryResources);
  connectOwner('hydroSettings');
  connectOwner('physicalResources');
  renderer = createThreeViewerRenderer({
    projectState: ports.projectState, layerPresentation: ports.layerPresentation,
    preferences: ports.preferences, colorModel: ports.colorModel, objectPresentation,
    highlightCandidates: objectPicking.highlightCandidates,
    countryLabelModel: labelOwner, objectRefVisible: objectQuery.objectRefVisible,
    hydroModel: ports.hydroModel, physicalResources,
    physicalServices: ports.physicalServices, domains: ports.domains, feedback: ports.feedback,
  }, {presentMapPreparation: createViewerMapPreparationPresenter($), onMapPreparationStatus,
    meta, initialCamera, onWorldFitChange,
    readSafeInsets: reason => (reason ? mapProjection.refreshMapLayoutMetrics(reason) : mapProjection.projectionLayoutMetrics()).safe});
  territorialSceneRuntime.connect({territorialScope: objectPresentation.territorialScope,
    entityRepository: repository, state, mapRenderer: renderer});
  let initialized;
  physicalResources.initializeHydroService();

  connectOwner('mapProjection');
  mapProjection.initializeMapLayoutMetricsSnapshot();
  mapProjection.installRenderer(renderer);

  connectOwner('mapHost');
  connectOwner('cameraNavigation');
  connectOwner('spatialIndex');
  spatialIndex.initializeGeometryBoundsCache();
  spatialIndex.initializeMapObjectSpatialIndex();
  spatialIndex.initializeViewportCullingMetrics();

  connectOwner('countryIndex');
  countryIndex.initializeCountryLandRevision();
  countryIndex.initializeCountryLabelAnchorWorker();
  countryIndex.initializeLabelFallbackQueue();

  connectOwner('territorialLabels');
  labelOwner.initializePlaceRuntime();
  const places = () => labelOwner.builtinPlaces;
  mapHost.attachMapOutput();
  initialized = mapHost.initializeMapHost();
  initialized.then(() => renderingDomain.invalidateProject('map-initialized'))
    .catch (error => onError(error,'지도 표시를 준비하지 못했습니다.','PL-MAP-INITIALIZE-001'));
  const selectionDomain = documentSession.selectionDomain;

  renderingDomain = createViewerRenderingDomain({
    mapRenderer:renderer, selectionDomain,
    labelResources:{
      preparePlaces:labelOwner.preparePlaces,
      beginPlaceInteraction:() => {
        labelOwner.builtinPlaces.beginInteraction();
        onPlacesSettled('cancel');
      },
      disposePlaces:labelOwner.disposePlaces,
    },
    getDistributionRenderRows:createDistributionRenderRows({
      getState:() => state, territorialEntityRepository:repository,
      geometryBounds:spatialIndex.geometryBounds, DISTRIBUTION_MODES, DISTRIBUTION_RENDER_MODES,
      isLayerItemVisible:objectCatalog.isLayerItemVisible,
      getCountryGeometryRevision:() => countryIndex.countryLandRevision,
    }),
    // Do not resize/clear visible GPU pixels during frame preparation.
    prepareView:mapHost.prepareVisualFrame,
  });
  renderQuality.applyAdaptiveRenderQuality();
  renderQuality.syncResolvedInteractionStyle();
  function buildScene() {objectCatalog.invalidateObjectPresentation(); renderingDomain.invalidateProject('document-presentation');}
  async function update({previousMonth} = {}) {
    const generation = ++updateGeneration;
    const entities = entityStore.snapshot();
    const previous = presentedEntities;
    const territorialFeatures = entities.filter(feature => feature.properties.entityKind==='general');
    await initialized; if (generation!==updateGeneration)return;
    // A dated source is admitted before publishing its frame.
    if (!await renderer.prepareTemporalCountrySource(territorialFeatures)||generation!==updateGeneration)return;
    if (!await renderer.setTerritorialFeatures(territorialFeatures, {sourceRows:entities})||generation!==updateGeneration)return;
    presentedEntities = entities;
    const hydroChanged = presentedHydroEdits!==state.hydroEdits;
    presentedHydroEdits = state.hydroEdits;
    // Distribution lifetimes can change on their own, even with identical national geometry.
    let distributionChanged = false;
    if (previousMonth&&previousMonth!==state.timelineCursor&&state.layerVisibility.distributions!==false) {
      const before = temporalMonthEnd(previousMonth), after = temporalMonthEnd(state.timelineCursor);
      distributionChanged = [state.distributionLayers, state.distributionEntries].some(rows => rows.some(row =>
        (row.validFrom||row.validTo)&&temporalContains(row, before)!==temporalContains(row, after)));
    }
    const propertiesOnly = previous&&classifyTerritorialPropertyOnly(previous, entities, worldViewChange(previous, entities));
    const regionalPaint = propertiesOnly?.paintChangedIds.some(id => repository.get(id)?.properties.entityKind==='regional');
    if (!previousMonth||distributionChanged||regionalPaint||previous!==entities&&!propertiesOnly)buildScene();
    else {
      if (previous!==entities)objectCatalog.invalidateObjectPresentation();
      if (hydroChanged)renderingDomain.invalidateSelection('dated-hydro');
      const zoom = renderer.labelZoomVisibility();
      if (zoom.country||zoom.places)renderingDomain.invalidateLabels('document-month-labels');
      else renderingDomain.invalidateView('temporal-source-admitted');
    }
  }
  connectOwner('objectPicking');
  objectPicking.bindChooser();

  connectOwner('pointerTargets');
  pointerTargets.initializeHoverPickFrame();
  const inputPresentation = createMapInputPresentation({renderer, initialized, ports: {
    projectState: ports.projectState, objectPicking: ports.objectPicking,
    renderQuality: ports.renderQuality, pointerInteraction: ports.pointerInteraction,
    surfaces: ports.surfaces, feedback: ports.feedback,
  }});
  inputPresentation.bindMapEvents();
  mapHost.startMapResizeObserver();
  const {preparePhysicalContext} = renderer;
  async function prepareTimelineView(month, options = {}) {
    return renderer.measureWork('three.timeline-prepare', () => prepareGlobeTimelineSources({
      isCurrent:options.isCurrent,
      preparePhysical:isCurrent => renderer.measureWork('three.timeline-physical', () => preparePhysicalContext(month, {...options, isCurrent})),
      prepareTerritories:isCurrent => renderer.measureWork('three.timeline-territorial', async() => {
        const next = {...options, isCurrent};
        const references = await projectSourceRuntime.readWorldGeometryReferences(month, next);
        return renderer.prepareDatedTerritories(month, references, next);
      }),
      prepareCore:isCurrent => renderer.measureWork('core.timeline-geometry', () => documentSession.commandOwner.prepareTimelineGeometry(month, {...options, isCurrent})),
    }));
  }
  return Object.freeze({
    async setSession(next, {view = null, prepareView = null, source = 'project'} = {}) {
      if (next!==documentSession)throw new Error('Map output requires its single document session.');
      objectPicking.closeObjectChooser();
      // The admitted reader origin is an in-memory session property, not an
      // interpretation of the backward-compatible projectSetup.sourceMode.
      physicalResources.setProjectSource(source);
      labelOwner.setProjectSource(source);
      projectSession.setViewingPresentation(view||{}, {reset:true});
      if (prepareView)await prepareView();
      // Validate the restored visibility against this admitted document before
      // its one canonical scene build; Core catalog/selection pruning follows
      // outside the replacement command transaction.
      projectSession.pruneViewingItems(objectCatalog.presentationCatalog());
      await update();
    },
    ready:initialized,
    cancelSearch:() => places().cancelSearch(), update, features:entityStore.snapshot, searchPlaces:query => labelOwner.searchPlaces(query), renderer,
    loadHydroData:physicalResources.loadHydroData,
    viewState:state, objectPresentation, searchActive:() => places().isSearchOpen(), preparePhysicalContext, prepareTimelineView,
    prepareBuiltinProject:async(month, options = {}) => {
      // Core candidate admission, initial territorial packets and physical
      // packets are independent after the builtin source index is available.
      const prepareGeometry = async({isCurrent}) => {
        const references = await projectSourceRuntime.readWorldGeometryReferences(month, {isCurrent});
        return renderer.prepareDatedTerritories(month, references, {isCurrent, includeAllObjects:true});
      };
      const [candidate, physical] = await Promise.allSettled([
        projectSourceRuntime.prepareProjectCandidate(month, {...options, prepareGeometry}),
        preparePhysicalContext(month, {...options, includeAllPhysical:true}),
      ]);
      if (candidate.status==='rejected'||physical.status==='rejected') {
        if (candidate.status==='fulfilled')await projectDomain.discardTemporalBuiltin(candidate.value);
        renderer.releasePreparedStartupResources();
        throw candidate.status==='rejected'?candidate.reason:physical.reason;
      }
      return candidate.value;
    },
    placeSelectionReferences:labelOwner.builtinPlaceSelectionReferences, hydroSelectionReferences:physicalResources.builtinHydroSelectionReferences,
    objectPicking, closeObjectChooser:objectPicking.closeObjectChooser, objectCatalog, objectQuery, refreshSelection:reason => renderingDomain.invalidateSelection(reason),
    capturePresentation:projectSession.captureViewingPresentation,
    physicalSettings:() => state.physicalSettings,
    entityRepository:repository,
    displayState:() => ({...documentSession.documentModel.snapshot(), ...state, projection:state.projection}),

    applyPresentation:projectSession.applyViewingPresentation,
    refreshAppearance(options) {
      if (options?.reason === 'native-name-visibility') return renderingDomain.invalidateLabels(options.reason);
      if (options?.reason === 'background-preference') return renderingDomain.invalidateProject(options.reason);
      if (options?.reason==='formal-country-name-display')renderingDomain.invalidateLabels(options.reason);
      else renderQuality.applyMapAppearanceChange(options);
      objectCatalog.invalidateObjectPresentation();
      onPlacesSettled('render');
    },

    navigation, mapProjection, projectSession, renderingDomain,
    dispose() {releaseGeometryLoader(); projectSourceRuntime.dispose(); entityStore.dispose(); inputPresentation.dispose(); pointerTargets.dispose(); countryIndex.resetCountryLabelAnchorRuntime(); mapHost.stopMapResizeObserver(); renderingDomain.dispose(); renderer.dispose();},
  });
}
