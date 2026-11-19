import { isMapVisualFrame } from "./map-visual-frame.js";
import { coordinateInGeographicBounds,selectPlaceLabelCandidates } from "./label-layout.js";

import { createPlaceRuntime } from "../data/place-runtime.js";
import {projectResourceOverlay} from "../document/project-resource-overlay.js";
import { isBuiltinPlaceId } from "../document/place-contract.js";
import { mapPlaceLabelRowsAtMonth } from "../data/place-name-policy.js";
import { temporalMonthEnd } from "../document/temporal.js";
import { territorialLabelFlag } from "./territorial-label-flags.js";
import { territorialNativeLabelRows } from "../ui/territorial-native-label.js";
import { effectiveTerritorialFlagUrl } from "../ui/country-flags.js";
import { territorialPaintRole, territorialSymbolVisibility } from "../ui/layer-presentation.js";

const PLACE_SEARCH_LANGUAGES = Object.freeze({ ko: true, en: true, native: true });

/** TerritorialLabels: extracted application responsibility.
 * Dependencies are explicitly wired once by the composition modules.
 * Mutable bindings stay local; exported accessors retain live identity.
 */
export function createTerritorialLabels({ capabilities = {builtinPlaces:true,eagerBuiltinPlaces:true},
  placeCatalog=null,placeLifetimesCatalog=null } = {}) {
  let dependencies;
  let countryOutlineCache;
  let labelLayoutMetrics;
  let builtinPlaces,activeSource='unbound';

  function setProjectSource(source) {
    if(!['builtin','project','new'].includes(source))throw new TypeError('Unknown map source');
    activeSource=source==='builtin'?'builtin':'project';

    builtinPlaces?.resetProject();
  }
  function connect(ports) {
    if (dependencies) throw new Error('territorial-labels already connected');
    dependencies = ports;
  }

  function placeMapDate() {
    const month = dependencies.projectState.state.timelineCursor;
    return typeof month === 'string' && /^\d{4}-\d{2}$/u.test(month)
      ? temporalMonthEnd(month).canonical : null;
  }

  function placeView() {
    const state = dependencies.projectState.state;
    const view = dependencies.mapHostView.projectionViewSnapshot();
    return { projection: state.projection, threshold: view.zoom, mapDate: placeMapDate(), presentation: {month:state.timelineCursor,languages:PLACE_SEARCH_LANGUAGES}, width: state.size.width, height: state.size.height,
      bounds:view.geographicBounds };
  }

  function preparePlaces({ force = false } = {}) {
    if(activeSource!=='builtin')return Promise.resolve(false);
    if (!capabilities.builtinPlaces || (!capabilities.eagerBuiltinPlaces && !force && builtinPlaces.snapshot().revision === 0)) return Promise.resolve(false);
    if (!force && (dependencies.projectState.state.layerVisibility.labels === false ||
      !dependencies.rendering.gpuMapRenderer.labelZoomVisibility().places)) {
      builtinPlaces.cancelViewport(); return builtinPlaces.settle(null);
    }
    const view=placeView();
    if(!view.bounds)return Promise.resolve(false);
    return dependencies.projectState.state.mapMoving?builtinPlaces.prepare(view):builtinPlaces.settle(view);
  }

  function labelById(id) {
    const resources=projectResourceOverlay('label',dependencies.projectState.state.labels);
    const user=resources.findById(id);
    if(user)return user;
    if(activeSource!=='builtin')return null;
    // An authored copy hides its source from selection, but does not delete it
    // from the immutable reference library or the pinned place worker store.
    if(resources.isSourceReplaced(id))return null;
    const builtin = builtinPlaces.resolve(id);
    if (builtin) builtinPlaces.retain(builtin);
    return builtin;
  }

  function countryOutlineFeature(feature) {
    const geometry = feature?.geometry;
    if (geometry && countryOutlineCache.has(geometry)) return countryOutlineCache.get(geometry);
    const outline = (0, dependencies.labelPresentation.buildRenderableStrokeFeature)(feature);
    if (geometry) countryOutlineCache.set(geometry, outline);
    return outline;
  }

  function territorialLabelScreenMetrics(feature, fontSize, projectedExtent, labelFeature, frame) {
    let width = Number(projectedExtent?.width);
    let height = Number(projectedExtent?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      const geometry = feature?.geometry;
      const bounds = geometry ? (0, dependencies.spatialQuery.geometryBounds)(geometry) : null;
      const points=[];
      if(bounds?.every(Number.isFinite)){
        const [west,south,east,north]=bounds;
        for(const lng of [west,(west+east)/2,east]){
          for(const lat of [south,(south+north)/2,north]){
            const point=frame.projectCoordinate([lng,lat]);
            if(point)points.push(point);
          }
        }
      }
      if(points.length){
        const xs=points.map(point=>point[0]),ys=points.map(point=>point[1]);
        width=Math.min(frame.size.width,Math.max(...xs)-Math.min(...xs));
        height=Math.min(frame.size.height,Math.max(...ys)-Math.min(...ys));
      }
    }
    const textWidth = Math.max(20, [...(0, dependencies.objectPresentation.territorialEntityName)(labelFeature)].length * fontSize * 1.02 + 8);
    return {
      width: Number.isFinite(width) ? width : 0,
      height: Number.isFinite(height) ? height : 0,
      area: Number.isFinite(width * height) ? width * height : 0,
      textWidth,
      textHeight: fontSize * 1.65 + 4,
    };
  }

  function shouldShowTerritorialLabel(feature, metrics) {
    const id = String(feature.id || '');
    if (!(0, dependencies.layerPresentation.isLayerItemVisible)('objectLabels', id) || dependencies.labelPresentation.pendingCountryLabelAnchors.has(id)) return false;
    if ((dependencies.projectState.state.selected?.domain === 'territorial' && (dependencies.territorialModel.entityRepository.get(dependencies.projectState.state.selected?.id)?.properties.entityKind === 'general' && !dependencies.territorialModel.entityRepository.get(dependencies.projectState.state.selected?.id)?.properties.parentId)) && dependencies.projectState.state.selected.id === id) return true;
    const widthFit = metrics.width >= Math.min(34, metrics.textWidth * ((0, dependencies.surfaces.isMobile)() ? 0.48 : 0.42));
    const heightFit = metrics.height >= metrics.textHeight * 0.52;
    const areaFit = metrics.area >= Math.max((0, dependencies.surfaces.isMobile)() ? 72 : 58, metrics.textWidth * metrics.textHeight * 0.32);
    return widthFit && heightFit && areaFit;
  }

  function visibleLabelLayout(frameContext) {
    if (!isMapVisualFrame(frameContext)) throw new TypeError('Label layout requires a MapVisualFrame.');
    dependencies.countries.scheduleCountryLabelAnchors?.();
    const candidates = [];
    const zoom = frameContext.viewState.zoom;
    const renderCountries = (0, dependencies.countries.builtinTerritorialScene)();
    const visibility = territorialSymbolVisibility(dependencies.projectState.state);
    const territorialRows = new Map();
    const flagOptions = {
      zoom, enabled: true,
      isVisible: feature => visibility.flag,
      flagUrl: feature => effectiveTerritorialFlagUrl(territorialPaintRole(feature) === 'country-fill'
        ? dependencies.territorialModel.entityRepository.get(feature.id) : feature,
        { assetRevision: dependencies.layerPresentation.ASSET_REVISION }),
    };
    for (const feature of renderCountries.labelById.values()) {
      if (dependencies.projectState.state.countryVisualPhase === 'pending') continue;
      const id = String(feature.id || '');
      const group = 'objects';
      const namesVisible = visibility.name;
      const rows = territorialNativeLabelRows(feature, dependencies.projectState.state.timelineCursor, {
        zoom, enabled: dependencies.preferences.userPreferences?.labels?.place?.showNativeNames === true,
      });
      territorialRows.set(id, rows);
      const labelRef = renderCountries.labelRefs.get(id);
      if (!(0, dependencies.layerPresentation.isLayerItemVisible)(group, labelRef?.id || id)) continue;
      if (!(0, dependencies.layerPresentation.isLayerItemVisible)('objectLabels', id) || dependencies.labelPresentation.pendingCountryLabelAnchors.has(id)) continue;
      const flag = namesVisible ? null : territorialLabelFlag(feature, flagOptions);
      if (!namesVisible && !flag) continue;
      const settings = (0, dependencies.labelPresentation.automaticLabelSettings)('country', dependencies.projectState.state.labelSettings[(0, dependencies.labelPresentation.labelKey)('territorial', labelRef.id)] || {});
      if (zoom < Number(settings.minZoom ?? -Infinity) || zoom > Number(settings.maxZoom ?? Infinity)) continue;
      const anchor = dependencies.labelPresentation.countryLabelAnchors.get(id);
      const coordinate = settings.pinned && settings.manualPosition ? settings.manualPosition : anchor;
      if (!Array.isArray(coordinate)) continue;
      const selected = dependencies.domains.selectionDomain.has(labelRef);
      const displayFeature = dependencies.territorialObjectModel.territorialScope.displayFeature(renderCountries.labelRefs.get(String(feature.id))?.id || feature.id);
      const baseMetrics = territorialLabelScreenMetrics(displayFeature, (0, dependencies.surfaces.isMobile)() ? 8 : 9, null, feature, frameContext);
      const fontSize = baseMetrics.area >= ((0, dependencies.surfaces.isMobile)() ? 3200 : 2200) ? ((0, dependencies.surfaces.isMobile)() ? 10 : 12) : (0, dependencies.surfaces.isMobile)() ? 8 : 9;
      const metrics = territorialLabelScreenMetrics(displayFeature, fontSize, baseMetrics, feature, frameContext);
      if (rows.length > 1) {
        metrics.textWidth = Math.max(metrics.textWidth, rows[1].text.length * fontSize);
        metrics.textHeight += fontSize * 1.2;
      }
      if (namesVisible && !selected && !shouldShowTerritorialLabel(feature, metrics)) continue;
      candidates.push({
        key: (0, dependencies.labelPresentation.labelKey)('territorial', labelRef.id), sourceType: 'territorial', source: feature,
        nameVisible: namesVisible,
        width: namesVisible ? metrics.textWidth : flag.width,
        height: namesVisible ? metrics.textHeight : flag.height,
        priority: settings.priority ?? dependencies.labelPresentation.LABEL_PRIORITIES.country, minZoom: settings.minZoom, maxZoom: settings.maxZoom,
        pinned: settings.pinned, collisionGroup: settings.collisionGroup,
        selected,
      });
    }
    const selectedIds = new Set(dependencies.domains.selectionDomain.snapshot().selection.items.filter(ref => ref.domain === 'label').map(ref => String(ref.id)));
    const loadedReferences=activeSource==='builtin'?[...new Map([...builtinPlaces.snapshot().records,
      ...[...selectedIds].map(id=>builtinPlaces.resolve(id)).filter(Boolean)]
      .map(label=>[label.id,label])).values()]:[];
    const resources=projectResourceOverlay('label',dependencies.projectState.state.labels,loadedReferences,
      {isReferenceActive:builtinPlaces.isActive});
    const labelSources = resources.records;
    const showNativeNames = dependencies.preferences.userPreferences.labels.place.showNativeNames === true;
    if (dependencies.projectState.state.layerVisibility.labels && dependencies.rendering.gpuMapRenderer.labelZoomVisibility().places) for (const label of labelSources) {
      const selected = selectedIds.has(String(label.id));
      const settings = (0, dependencies.labelPresentation.automaticLabelSettings)(label.kind, dependencies.projectState.state.labelSettings[(0, dependencies.labelPresentation.labelKey)('label', label.id)] || {});
      // Validated places carry their continuous population/spatial rank from the
      // pinned viewport manifest. Never replace it with a feature-code priority.
      const builtinDisplay = isBuiltinPlaceId(label.id) ? label : null;
      const minZoom = builtinDisplay ? Number(builtinDisplay.minZoom)
        : Math.max(settings.minZoom, Number(label.minZoom || 0));
      if (zoom < Number(minZoom ?? -Infinity) || zoom > Number(settings.maxZoom ?? Infinity)) continue;
      const coordinate = settings.pinned && settings.manualPosition ? settings.manualPosition : label.coordinates;
      const viewportVisible=coordinateInGeographicBounds(coordinate,frameContext.viewState.geographicBounds);
      if(!Array.isArray(coordinate)||!Number.isFinite(coordinate[0])||!Number.isFinite(coordinate[1])||Math.abs(coordinate[1])>90)continue;
      const priority = builtinDisplay ? Number(builtinDisplay.priority) : (settings.priority ?? (label.kind === 'capital' ? dependencies.labelPresentation.LABEL_PRIORITIES.capital : label.kind === 'city' ? dependencies.labelPresentation.LABEL_PRIORITIES.majorCity : label.kind === 'region' ? dependencies.labelPresentation.LABEL_PRIORITIES.administrative : dependencies.labelPresentation.LABEL_PRIORITIES.place));
      const names = builtinDisplay
        ? mapPlaceLabelRowsAtMonth(label, dependencies.projectState.state.timelineCursor, { zoom, showNativeNames })
        : { rows: [{ language: 'ko', text: label.name }], secondaryRows: [] };
      const { rows, secondaryRows } = names;
      if (!rows.length) continue;
      candidates.push({
        key: (0, dependencies.labelPresentation.labelKey)('label', label.id), sourceType: 'label', source: label, rows, secondaryRows,
        priority, minZoom, maxZoom: settings.maxZoom,
        pinned: settings.pinned, collisionGroup: settings.collisionGroup,
        selected, viewportVisible,
      });
    }
    const nextLabelLayoutMetrics = {
      qualityTier: dependencies.renderScene.currentRenderQuality.tier,
      qualityCandidateCount: candidates.length,
      qualityCulledCount: 0,
    };
    // Geographic country anchors remain installed across both hemispheres.
    // MapLibre projects, occludes and places them on every camera frame.
    const countries=candidates.filter(item=>item.sourceType==='territorial');
    const places=selectPlaceLabelCandidates(candidates.filter(item=>item.sourceType==='label'),dependencies.renderScene.currentRenderQuality.labelCandidateLimit);
    const placed=[...countries,...places].map(item=>({...item,rows:item.rows?[...item.rows,...(item.secondaryRows||[]).slice(0,1)]:item.rows}));
    const territorialFlags = new Map(countries.flatMap(item=>{const flag=territorialLabelFlag(item.source,flagOptions);return flag?[[String(item.source.id),flag]]:[];}));
    const placedTerritorialLabels = placed.filter(item => item.sourceType === 'territorial'
      && (item.nameVisible || territorialFlags.has(String(item.source.id))));
    const placedUserLabels = placed.filter(item => item.sourceType === 'label');
    labelLayoutMetrics = nextLabelLayoutMetrics;
    if (dependencies.spatialQuery.viewportCullingMetrics.lastByDomain.label) dependencies.spatialQuery.viewportCullingMetrics.lastByDomain.label.finalVisibleCount = placedUserLabels.length;
    return {
      territorialLabels: placedTerritorialLabels.map(item => item.source),
      territorialLabelNames: new Map(placedTerritorialLabels.map(item => [String(item.source.id), item.nameVisible])),
      territorialLabelRows: new Map(placedTerritorialLabels.map(item => [String(item.source.id), territorialRows.get(String(item.source.id)) || []])),
      territorialFlags,
      userLabels: placedUserLabels.map(item => item.source),
      userLabelRows: new Map(placedUserLabels.map(item => [String(item.source.id), item.rows])),
      territorialLabelPriorities:new Map(placedTerritorialLabels.map(item=>[String(item.source.id),item.priority])),
      userLabelPriorities:new Map(placedUserLabels.map(item=>[String(item.source.id),item.priority])),
      candidateCount: candidates.length,
    };
  }

  function initializeCountryOutlineCache() {
    (countryOutlineCache = new WeakMap());
  }

  function initializeLabelLayoutMetrics() {
    (labelLayoutMetrics = {});

    const placeManifestRef='../'+(placeCatalog||'assets/data/places/manifest.json').slice('assets/'.length);
    const placeLifetimeRef='../'+(placeLifetimesCatalog||'assets/data/places/urban-lifetimes-v1.json').slice('assets/'.length);
    builtinPlaces = createPlaceRuntime({
      getPresentation:()=>({month:dependencies.projectState.state.timelineCursor,languages:PLACE_SEARCH_LANGUAGES}),
      admitReferences:refs=>dependencies.domains.projectDomain.admitSelectionCatalog('placeBuiltin',refs),
      manifestUrl: dependencies.platform.runtimeAssetUrl(placeManifestRef).href,
      urbanLifetimesUrl: dependencies.platform.runtimeAssetUrl(placeLifetimeRef).href,
      createWorker: () => new Worker(dependencies.platform.runtimeAssetUrl('workers/place-worker.js'), { type: 'module', name: 'pandolab-places' }),
      getProtectedIds: () => {
        const selection = dependencies.domains.selectionDomain.snapshot().selection;
        const refs = selection.items.filter(ref => ref.domain === 'label');
        return [refs.find(ref => ref.key === selection.primaryKey)?.id, ...refs.map(ref => ref.id)].filter(Boolean);
      },
      onSettled: () => { dependencies.domains.objectSearchController.render(); },
      onSnapshot: () => dependencies.domains.renderingDomain.invalidateLabels('builtin-places-ready'),
      onError: error => dependencies.feedback.reportOperationError(error, '내장 도시를 불러오지 못했습니다.', 'PL-PLACE-LOAD-001'),
    });
  }

  return Object.freeze({
    connect,
    setProjectSource,
    preparePlaces,
    disposePlaces() {


      builtinPlaces?.dispose();
    },
    labelById,
    searchPlaces:query=>activeSource==='builtin'?builtinPlaces.search(query):Promise.resolve({records:[],truncated:false}),
    get builtinPlaces() { return builtinPlaces; },
    builtinPlaceSelectionReferences:()=>activeSource==='builtin'?builtinPlaces.selectionReferences():[],
    initializeCountryOutlineCache,
    initializeLabelLayoutMetrics,
    get countryOutlineCache() { return countryOutlineCache; },
    get countryOutlineFeature() { return countryOutlineFeature; },
    get labelLayoutMetrics() { return labelLayoutMetrics; },
    labelPlacementWorkerStats: () => null,
    get visibleLabelLayout() { return visibleLabelLayout; },
  });
}
