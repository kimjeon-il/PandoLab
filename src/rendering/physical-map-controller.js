import { timelineObjectKey } from '../document/timeline-records.js';
import { mapProjectResourcePath } from '../data/map-project-manifest.js';
import { resolvePhysicalWaterObjects, physicalWaterContextKey, physicalWaterReferenceView } from '../data/physical-water-model.js';

// Runtime coordinator: the data layer owns source reads and the C++ owner
// owns admitted identities; this rendering layer owns visual preparation.
export function createPhysicalResources({ buildMeta, capabilities = {builtinHydro:true, eagerBuiltinHydro:true} } = {}) {
  // The same Hydro reader currently serves both river and lake layers.
  const projectHydro = buildMeta?.mapProject?mapProjectResourcePath(buildMeta.mapProject,'rivers'):null;
  let dependencies;
  let hydroService;
  const hydroFeatureCache = new Map();
  let hydroManifest = null;
  let physicalLoadState = Object.freeze({hydro: 'idle', hydroCache: 'idle', hydroCachePercent: 0});
  let physicalSelection = null;
  // The active document, not the serialized sourceMode field, selects
  // optional project-owned Hydro/physical-water catalogs.
  let activeSource = 'unbound', projectSourceEpoch = 0;
  function setProjectSource(source) {
    if (!['builtin','project','new'].includes(source))throw new TypeError('Unknown active map source');
    hydroService?.cancel();
    activeSource = source==='builtin'?'builtin':'project';
    projectSourceEpoch++;
    physicalSelection = null; builtinTimelineView = null;
  }
  function physicalSelectionFor(date) {
    const catalog = buildMeta.physicalWaterObjects;
    const rows = resolvePhysicalWaterObjects(catalog, date)
      .sort((a, b) => timelineObjectKey(a.objectRef).localeCompare(timelineObjectKey(b.objectRef)));
    return {catalog, date, rows, key:physicalWaterContextKey(rows)};
  }
  function selectedPhysicalWater() {
    if (activeSource!=='builtin')
      return {catalog:null, date:null, rows:[], key:physicalWaterContextKey([])};
    const catalog = buildMeta.physicalWaterObjects, date = dependencies.projectState.state.timelineCursor;
    if (!physicalSelection||physicalSelection.catalog!==catalog||physicalSelection.date!==date) {
      physicalSelection = physicalSelectionFor(date);
    }
    return physicalSelection;
  }
  let builtinTimelineView = null;
  function hydroActivityView() {
    if (activeSource!=='builtin'||!dependencies.projectState.state.timelineCursor)return null;
    const selection = selectedPhysicalWater();
    if (!builtinTimelineView||builtinTimelineView.catalog!==selection.catalog
      ||builtinTimelineView.key!==selection.key) {
      builtinTimelineView = {catalog:selection.catalog, key:selection.key,
        reference:physicalWaterReferenceView(selection.catalog, selection.rows, true)};
    }
    return builtinTimelineView.reference;
  }
  function isHydroObjectActive(feature) {
    if (feature.properties?.pandolab_domain==='hydro')return true;
    return hydroActivityView()?.isActive(feature.properties?.pandolab_id||feature.id)??false;
  }
  function connect(ports) {
    if (dependencies) throw new Error('physical-resources already connected');
    dependencies = ports;
  }

  function hydroDetailEnabled() {
    const visibility = dependencies.projectState.state.layerVisibility;
    return activeSource==='builtin'&&capabilities.builtinHydro
      && (visibility.rivers!==false||visibility.lakes!==false);
  }

  async function loadHydroData(explicit = false) {
    if (!hydroDetailEnabled()) {hydroService?.cancel(); return false;}
    if (!capabilities.eagerBuiltinHydro&&!explicit)return false;
    return hydroService.load();
  }

  function allBuiltInHydroFeatures() {
    return [...hydroFeatureCache.values()];
  }

  function builtInHydroFeatureById(id) {
    const key = String(id);
    if (hydroFeatureCache.has(key)) return hydroFeatureCache.get(key);
    for (const feature of hydroFeatureCache.values()) {
      if (String(feature.properties?.pandolab_id || feature.id || '') === key) return feature;
    }
    return null;
  }

  function builtinHydroSelectionReferences(features = null) {
    if (activeSource!=='builtin')return [];
    features ??= allBuiltInHydroFeatures();
    return [...new Map(features.map(feature => {
      const id = String(feature.properties?.pandolab_id || feature.id);
      const category = dependencies.hydroPresentation.HYDRO_LAYER_META[feature.properties?.layer_id]?.category || feature.properties?.category;
      const sourceIds = String(feature.properties?.source_id || '').split(',').filter(Boolean);
      return [id, {domain:'hydroBuiltin', id, logicalId:id, type:(0, dependencies.hydroPresentation.hydroCategoryKey)(category), sourceIds}];
    })).values()];
  }

  async function admitHydroFeatures(features = [], {isCurrent = () => true} = {}) {
    if (activeSource!=='builtin')return false;
    if (typeof dependencies.domains.projectDomain?.admitSelectionCatalog!=='function')
      throw new TypeError('Hydro source identities require the canonical Core admission boundary.');
    const cache = hydroFeatureCache, epoch = projectSourceEpoch;
    const current = () => isCurrent() && activeSource === 'builtin' && projectSourceEpoch === epoch;
    if (!current())return false;
    const additions = new Map(features.map(feature => [String(feature.properties?.pandolab_id||feature.id), feature]));
    await dependencies.domains.projectDomain.admitSelectionCatalog('hydroBuiltin', () => {
      if (!current())return builtinHydroSelectionReferences();
      const combined = [...cache].map(([id, feature]) => additions.get(id)||feature);
      for (const [id, feature]of additions)if (!cache.has(id))combined.push(feature);
      return builtinHydroSelectionReferences(combined);
    });
    if (!current())return false;
    for (const feature of features) {
      const id = String(feature.properties?.pandolab_id || feature.id), existing = cache.get(id);
      // Descriptor/FID indexes point at this aggregate. Hydrate that same
      // resource allocation rather than replacing it with a second full row.
      if (existing && existing!==feature)Object.assign(existing, feature);
      else cache.set(id, feature);
    }
    return true;
  }

  function initializeHydroService() {
    if (capabilities.builtinHydro)(hydroService = (0, dependencies.physicalServices.createHydroService)({
      fetchWithRetry: dependencies.physicalServices.fetchWithRetry,
      dataVersion: buildMeta?.projectCatalogs?.rivers?.version||dependencies.physicalConfig.HYDRO_DATA_VERSION,
      manifestUrl: () => {
        const manifestUrl = new URL(projectHydro?projectHydro.slice('assets/data/'.length):
          `hydro/v${dependencies.physicalConfig.HYDRO_DATA_VERSION}/manifest.json`, dependencies.physicalConfig.PHYSICAL_DATA_BASE_URL);
        manifestUrl.searchParams.set('v', dependencies.physicalConfig.DATA_REVISION);
        return manifestUrl;
      },
      getLoadState: () => physicalLoadState.hydro,
      loadKey:()=>projectSourceEpoch,
      isLoadCurrent:key=>hydroDetailEnabled()&&key===projectSourceEpoch,
      onLoading: () => {
        physicalLoadState = Object.freeze({...physicalLoadState,
          hydro: 'loading', hydroManifest: 'loading', hydroWorker: 'starting', hydroView: 'idle'});
        (0, dependencies.layerPresentation.invalidateObjectPresentation)();
        dependencies.domains.objectSearchController?.render();
      },
      onRetry: (_operation, attempt) => dependencies.operationFeedback.reliabilityDiagnostic.push({
        category: 'asset', operation: 'hydro-manifest', result: `retry-${attempt}`,
      }),
      acceptManifest: async (manifest, _manifestUrl, context) => {
        const isCurrent = context?.isCurrent||(() => activeSource==='builtin');
        if (!isCurrent())return false;
        hydroManifest = manifest;
        physicalLoadState = Object.freeze({...physicalLoadState,
          hydroManifest: 'ready', hydroCache: 'idle', hydroCachePercent: 0});
        const renderer = dependencies.rendering.mapRenderer;
        await renderer.initialize();
        if (!isCurrent())return false;
        await admitHydroFeatures();
        if (!isCurrent())return false;
        physicalLoadState = Object.freeze({...physicalLoadState, hydroWorker: 'ready', hydro: 'ready'});
        (0, dependencies.layerPresentation.invalidateObjectPresentation)();
        dependencies.domains.objectSearchController?.render();
        dependencies.domains.renderingDomain?.invalidateProject('hydro-ready');
        return true;
      },
      onFailure: error => {
        physicalLoadState = Object.freeze({...physicalLoadState,
          hydroManifest: physicalLoadState.hydroManifest === 'ready' ? 'ready' : 'error',
          hydroWorker: 'error', hydro: 'error'});
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
    get physicalSourceIdentity() { return selectedPhysicalWater().key; },
    physicalSourceIdentityAtMonth:month => physicalSelectionFor(month).key,
    get loadHydroData() { return loadHydroData; },
    builtinHydroSelectionReferences,
    allBuiltInHydroFeatures,
    builtInHydroFeatureById,
    get hydroManifest() {return hydroManifest;},
    get physicalLoadState() {return physicalLoadState;},
    hydroActivityView,
    isHydroObjectActive,
    hydroDetailEnabled,
    admitHydroFeatures,
  });
}
