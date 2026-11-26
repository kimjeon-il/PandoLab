import { bufferedPlaceBounds,coordinateInGeographicBounds,selectPlaceLabelCandidates } from "./label-layout.js";
import {isWithinDisplayZoom,placeDisplayMinZoom} from "../map/map-display-zoom.js";

import { createPlaceRuntime } from "../data/place-runtime.js";
import {createVerifiedCoreWorker} from "../runtime/core-wasm-loader.js";
import {projectResourceOverlay} from "../document/project-resource-overlay.js";
import { isBuiltinPlaceId } from "../document/place-contract.js";
import { mapPlaceLabelRowsAtMonth } from "../data/place-name-policy.js";
import { temporalMonthEnd } from "../document/temporal.js";

const PLACE_SEARCH_LANGUAGES = Object.freeze({ ko: true, en: true, native: true });

/** TerritorialLabels: extracted application responsibility.
 * Dependencies are explicitly wired once by the composition modules.
 * Mutable bindings stay local; exported accessors retain live identity.
 */
export function createTerritorialLabels({ capabilities = {builtinPlaces:true,eagerBuiltinPlaces:true},
  placeCatalog=null,placeLifetimesCatalog=null } = {}) {
  let dependencies;
  let builtinPlaces,activeSource='unbound',placeWindow=null;

  function setProjectSource(source) {
    if(!['builtin','project','new'].includes(source))throw new TypeError('Unknown map source');
    activeSource=source==='builtin'?'builtin':'project';

    placeWindow=null;
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
    if(!view.geographicBounds)return null;
    const reuse=placeWindow?.threshold===view.zoom&&placeWindow.width===state.size.width&&placeWindow.height===state.size.height;
    placeWindow={ projection: state.projection, threshold: view.zoom, mapDate: placeMapDate(), presentation: {month:state.timelineCursor,languages:PLACE_SEARCH_LANGUAGES}, width: state.size.width, height: state.size.height,
      bounds:bufferedPlaceBounds(view.geographicBounds,reuse?placeWindow.bounds:null) };
    return placeWindow;
  }

  function preparePlaces({ force = false } = {}) {
    if(activeSource!=='builtin')return Promise.resolve(false);
    if (!capabilities.builtinPlaces || (!capabilities.eagerBuiltinPlaces && !force && builtinPlaces.snapshot().revision === 0)) return Promise.resolve(false);
    if (!force && (dependencies.projectState.state.layerVisibility.labels === false ||
      !dependencies.rendering.mapRenderer.labelZoomVisibility().places)) {
      builtinPlaces.cancelViewport(); return builtinPlaces.settle(null);
    }
    const view=placeView();
    if(!view)return Promise.resolve(false);
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

  function placeLabelCandidates({zoom,geographicBounds}) {
    const candidates=[];
    const selectedIds = new Set(dependencies.domains.selectionDomain.snapshot().selection.items.filter(ref => ref.domain === 'label').map(ref => String(ref.id)));
    const loadedReferences=activeSource==='builtin'?[...new Map([...builtinPlaces.snapshot().records,
      ...[...selectedIds].map(id=>builtinPlaces.resolve(id)).filter(Boolean)]
      .map(label=>[label.id,label])).values()]:[];
    const resources=projectResourceOverlay('label',dependencies.projectState.state.labels,loadedReferences,
      {isReferenceActive:builtinPlaces.isActive});
    const labelSources = resources.records;
    const showNativeNames = dependencies.preferences.userPreferences.labels.place.showNativeNames === true;
    if (dependencies.projectState.state.layerVisibility.labels && dependencies.rendering.mapRenderer.labelZoomVisibility().places) for (const label of labelSources) {
      const selected = selectedIds.has(String(label.id));
      const settings = (0, dependencies.labelPresentation.automaticLabelSettings)(label.kind, dependencies.projectState.state.labelSettings[(0, dependencies.labelPresentation.labelKey)('label', label.id)] || {});
      // Validated places carry their continuous population/spatial rank from the
      // pinned viewport manifest. Never replace it with a feature-code priority.
      const builtinDisplay = isBuiltinPlaceId(label.id) ? label : null;
      const minZoom = placeDisplayMinZoom(builtinDisplay ? Number(builtinDisplay.minZoom)
        : Math.max(settings.minZoom, Number(label.minZoom || 0)));
      if (!isWithinDisplayZoom(zoom,minZoom,settings.maxZoom)) continue;
      const coordinate = settings.pinned && settings.manualPosition ? settings.manualPosition : label.coordinates;
      const viewportVisible=coordinateInGeographicBounds(coordinate,placeWindow?.bounds??geographicBounds);
      if(!Array.isArray(coordinate)||!Number.isFinite(coordinate[0])||!Number.isFinite(coordinate[1])||Math.abs(coordinate[1])>90)continue;
      const priority = builtinDisplay ? Number(builtinDisplay.priority) : (settings.priority ?? (label.kind === 'capital' ? dependencies.labelPresentation.LABEL_PRIORITIES.capital : label.kind === 'city' ? dependencies.labelPresentation.LABEL_PRIORITIES.majorCity : label.kind === 'region' ? dependencies.labelPresentation.LABEL_PRIORITIES.administrative : dependencies.labelPresentation.LABEL_PRIORITIES.place));
      const rows = builtinDisplay
        ? mapPlaceLabelRowsAtMonth(label, dependencies.projectState.state.timelineCursor, { showNativeNames })
        : [{ language: 'ko', text: label.name }];
      if (!rows.length) continue;
      candidates.push({
        key: (0, dependencies.labelPresentation.labelKey)('label', label.id), source: label, rows,coordinate,
        priority, minZoom, maxZoom: settings.maxZoom,
        pinned: settings.pinned, collisionGroup: settings.collisionGroup,
        selected, viewportVisible,
      });
    }
    return {rows:selectPlaceLabelCandidates(candidates,dependencies.renderScene.currentRenderQuality.labelCandidateLimit),count:candidates.length};
  }

  function initializePlaceRuntime() {
    const placeManifestRef='../'+(placeCatalog||'assets/data/places/manifest.json').slice('assets/'.length);
    const placeLifetimeRef='../'+(placeLifetimesCatalog||'assets/data/places/urban-lifetimes-v1.json').slice('assets/'.length);
    builtinPlaces = createPlaceRuntime({
      getPresentation:()=>({month:dependencies.projectState.state.timelineCursor,languages:PLACE_SEARCH_LANGUAGES}),
      admitReferences:refs=>dependencies.domains.projectDomain.admitSelectionCatalog('placeBuiltin',refs),
      manifestUrl: dependencies.platform.runtimeAssetUrl(placeManifestRef).href,
      urbanLifetimesUrl: dependencies.platform.runtimeAssetUrl(placeLifetimeRef).href,
      createWorker: () => createVerifiedCoreWorker(dependencies.platform.runtimeAssetUrl('workers/place-worker.js'), { type: 'module', name: 'pandolab-places' }),
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
    placeLabelCandidates,
    disposePlaces() {


      builtinPlaces?.dispose();
    },
    labelById,
    searchPlaces:query=>activeSource==='builtin'?builtinPlaces.search(query):Promise.resolve({records:[],truncated:false}),
    get builtinPlaces() { return builtinPlaces; },
    builtinPlaceSelectionReferences:()=>activeSource==='builtin'?builtinPlaces.selectionReferences():[],
    initializePlaceRuntime,
  });
}
