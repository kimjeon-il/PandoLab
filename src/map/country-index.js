import { resourceKey, resourceUpdate } from "../runtime/resource-dependency-policy.js";
import { geometryRevisionKey } from "../geometry/geometry-versions.js";
import {geometryReferenceFor} from '../geometry/geometry-version-store.js';
import {countryBoundaryOwner,matchesCountryGeometrySignature} from '../rendering/country-boundary-seed.js';
/** CountryIndex: extracted application responsibility.
 * Dependencies are explicitly wired once by the composition modules.
 * Mutable bindings stay local; exported accessors retain live identity.
 */
export function createCountryIndex({buildMeta=globalThis.PANDOLAB_BUILD_META}={}) {
  const seed=buildMeta?.countryBoundarySeed;
  const bakedAnchors=seed&&typeof seed.worldCatalogSha256==='string'&&seed.worldCatalogSha256&&seed.worldCatalogSha256===buildMeta.projectCatalogs?.world?.sha256
    &&typeof seed.territorialCatalogSha256==='string'&&seed.territorialCatalogSha256
    &&seed.territorialCatalogSha256===buildMeta.projectCatalogs?.territorial?.sha256?seed.labelAnchors||{}:{};
  let dependencies;
  let countryLandRevision;
  let pendingCountryLabelAnchors;
  let countryLabelAnchorVersions;
  let countryLabelAnchors;
  let countryLabelAnchorWorker;
  let countryLabelAnchorTimer;
  let countryLabelAnchorRequestId;
  let countryLabelAnchorFlight;
  let labelFallbackQueue;
  let anchorPublicationScheduled = false;
  const countryLabelAnchorDependencies = new Map();
  const anchorContentKeys = new WeakMap();
  function connect(ports) {
    if (dependencies) throw new Error('country-index already connected');
    dependencies = ports;
  }

  // External GIS ingress assigns an ID before its Feature enters the Store.
  function featureCountryId(feature, index) {
    return String(feature?.id || `country_${index}`);
  }

  function reindexCountries(fc) {
    const out = fc?.type === 'FeatureCollection' ? fc : { type: 'FeatureCollection', features: [] };
    dependencies.projectState.state.countryIndex.clear();
    out.features.forEach((feature, index) => {
      const id = feature.id;
      if (typeof id !== 'string' || !id) throw new TypeError('국가 인덱스에는 공통 엔티티 ID가 필요합니다.');
      dependencies.projectState.state.countryIndex.set(id, index);
    });
    (0, dependencies.spatialQuery.rebuildSpatialIndex)(out.features);
    (0, dependencies.objectDisplay.invalidateObjectPresentation)();
    return out;
  }

  function validLabelAnchor(value) {
    return Array.isArray(value) && value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]));
  }

  function largestCountryComponentFeature(feature) {
    const geometry = feature?.geometry;
    if (!geometry) return null;
    if (geometry.type === 'Polygon') return { type: 'Feature', properties: feature.properties || {}, geometry: (0, dependencies.platform.deepClone)(geometry) };
    if (geometry.type !== 'MultiPolygon') return null;
    let bestCoordinates = null;
    let bestArea = -Infinity;
    for (const coordinates of geometry.coordinates || []) {
      let area = 0;
      try { area = dependencies.platform.d3.geo.area({ type: 'Polygon', coordinates }); } catch (_) {}
      if (area > bestArea) { bestArea = area; bestCoordinates = coordinates; }
    }
    return bestCoordinates
      ? { type: 'Feature', properties: feature.properties || {}, geometry: { type: 'Polygon', coordinates: (0, dependencies.platform.deepClone)(bestCoordinates) } }
      : null;
  }

  function fallbackCountryLabelAnchor(feature) {
    const primary = largestCountryComponentFeature(feature) || feature;
    try {
      const centroid = dependencies.platform.d3.geo.centroid(primary);
      if (validLabelAnchor(centroid)) return centroid;
    } catch (_) {}
    const ring = primary?.geometry?.coordinates?.[0] || [];
    return (0, dependencies.mapView.ringRepresentativePoint)(ring);
  }

  function queueCountryLabelFallback(id) {
    if (validLabelAnchor(countryLabelAnchors.get(id))) return;
    labelFallbackQueue.set(id, { generation: dependencies.domains.projectDomain.getGeneration(), version: countryLabelAnchorVersions.get(id) });
    dependencies.projectState.mapWorkScheduler.scheduleIdle('country-label-fallback', drainCountryLabelFallback, 20);
  }

  function drainCountryLabelFallback() {
    if (dependencies.projectState.state.countryVisualPhase === 'pending' || dependencies.projectState.state.mapMoving || document.hidden || navigator.scheduling?.isInputPending?.()) {
      dependencies.projectState.mapWorkScheduler.scheduleIdle('country-label-fallback', drainCountryLabelFallback, 100); return;
    }
    const start = performance.now();
    let changed = false;
    for (const [id, task] of labelFallbackQueue) {
      labelFallbackQueue.delete(id);
      if (task.generation !== dependencies.domains.projectDomain.getGeneration() || task.version !== countryLabelAnchorVersions.get(id)) continue;
      const feature = (0, dependencies.countries.territorialLabelFeatureById)(id);
      if (feature && !validLabelAnchor(countryLabelAnchors.get(id))) { countryLabelAnchors.set(id, fallbackCountryLabelAnchor(feature)); changed = true; }
      if (performance.now() - start >= 4) break;
    }
    if (changed) dependencies.domains.renderingDomain?.invalidateLabels?.('country-label-fallback');
    if (labelFallbackQueue.size) dependencies.projectState.mapWorkScheduler.scheduleIdle('country-label-fallback', drainCountryLabelFallback, 20);
  }

  function ensureCountryLabelAnchorWorker() {
    if (countryLabelAnchorWorker) return countryLabelAnchorWorker;
    const worker = new Worker((0, dependencies.platform.runtimeAssetUrl)('workers/label-anchor-worker.js'), {
      name: 'pandolab-label-anchors',
    });
    worker.onmessage = event => {
      const message = event.data || {};
      const flight = countryLabelAnchorFlight;
      if (!flight || message.requestId !== flight.requestId) return;
      if (dependencies.domains.renderingDomain?.isPreparingTemporalFrame?.()) {
        dependencies.projectState.mapWorkScheduler.scheduleIdle('country-label-anchor-result', () => worker.onmessage({data:message}), 100);
        return;
      }
      countryLabelAnchorFlight = null;
      if (flight.generation !== dependencies.domains.projectDomain.getGeneration()) {
        dependencies.projectState.mapWorkScheduler.scheduleIdle('country-label-anchor-batch', flushCountryLabelAnchorQueue, 20);
        return;
      }
      dependencies.projectState.mapWorkScheduler.scheduleIdle('country-label-anchor-batch', flushCountryLabelAnchorQueue, 20);
      if (message.type === 'error') {
        console.warn('Country label anchor worker failed', message.message);
        for (const { id } of flight.items) {
          const feature = (0, dependencies.countries.territorialLabelFeatureById)(id);
          if (feature) queueCountryLabelFallback(id);
          pendingCountryLabelAnchors.delete(id);
        }
        dependencies.domains.renderingDomain?.invalidateLabels?.('country-label-anchor-fallback');
        return;
      }
      if (message.type !== 'anchors') return;
      for (const result of message.results || []) {
        const id = String(result.id || '');
        if (countryLabelAnchorVersions.get(id) !== Number(result.version || 0)) continue;
        const feature = (0, dependencies.countries.territorialLabelFeatureById)(id);
        if (feature && validLabelAnchor(result.anchor)) countryLabelAnchors.set(id, [Number(result.anchor[0]), Number(result.anchor[1])]);
        else if (feature) queueCountryLabelFallback(id);
        pendingCountryLabelAnchors.delete(id);
      }
      scheduleCountryLabelPublication();
    };
    worker.onerror = event => {
      console.warn('Country label anchor worker error', event.message || event);
      countryLabelAnchorFlight = null;
      countryLabelAnchorWorker?.terminate();
      countryLabelAnchorWorker = null;
      for (const id of [...pendingCountryLabelAnchors]) {
        const feature = (0, dependencies.countries.territorialLabelFeatureById)(id);
        if (feature) queueCountryLabelFallback(id);
        pendingCountryLabelAnchors.delete(id);
      }
      dependencies.domains.renderingDomain?.invalidateLabels?.('country-label-anchor-error');
    };
    countryLabelAnchorWorker = worker;
    return worker;
  }

  function scheduleCountryLabelPublication() {
    if (anchorPublicationScheduled) return;
    anchorPublicationScheduled = true;
    const publish = () => {
      if (dependencies.domains.renderingDomain?.isPreparingTemporalFrame?.()) {
        dependencies.projectState.mapWorkScheduler.scheduleIdle('country-label-anchor-publication', publish, 100);
        return;
      }
      anchorPublicationScheduled = false;
      dependencies.domains.renderingDomain?.invalidateLabels?.('country-label-anchor-ready');
    };
    // Four-point worker batches must not each reload every visible symbol tile.
    dependencies.projectState.mapWorkScheduler.scheduleIdle('country-label-anchor-publication', publish, 80);
  }

  function resetCountryLabelAnchorRuntime() {
    labelFallbackQueue.clear();
    dependencies.projectState.mapWorkScheduler.cancel('country-label-fallback');
    countryLabelAnchorFlight = null;
    dependencies.projectState.mapWorkScheduler.cancel('country-label-anchor-batch');
    dependencies.projectState.mapWorkScheduler.cancel('country-label-anchor-result');
    dependencies.projectState.mapWorkScheduler.cancel('country-label-anchor-publication');
    anchorPublicationScheduled = false;
    clearTimeout(countryLabelAnchorTimer);
    countryLabelAnchorTimer = 0;
    countryLabelAnchorWorker?.terminate();
    countryLabelAnchorWorker = null;
    pendingCountryLabelAnchors.clear();
    countryLabelAnchorVersions.clear();
    countryLabelAnchors.clear();
    countryLabelAnchorDependencies.clear();
    countryLabelAnchorRequestId += 1;
  }

  function flushCountryLabelAnchorQueue() {
    countryLabelAnchorTimer = 0;
    if (countryLabelAnchorFlight) return;
    if (document.hidden || dependencies.projectState.state.countryVisualPhase === 'pending'
        || dependencies.domains.renderingDomain?.isPreparingTemporalFrame?.()
        || dependencies.projectState.state.mapMoving || navigator.scheduling?.isInputPending?.()) {
      dependencies.projectState.mapWorkScheduler.scheduleIdle('country-label-anchor-batch', flushCountryLabelAnchorQueue, 100);
      return;
    }
    const batchStartedAt = performance.now();
    const items = [];
    for (const id of pendingCountryLabelAnchors) {
      const feature = (0, dependencies.countries.territorialLabelFeatureById)(id);
      if (!feature?.geometry) continue;
      items.push({
        id,
        version: countryLabelAnchorVersions.get(id) || 0,
        geometry: feature.geometry,
      });
      if (items.length >= 4 || performance.now() - batchStartedAt >= 4) break;
    }
    if (!items.length) return;
    try {
      countryLabelAnchorFlight = { requestId: ++countryLabelAnchorRequestId, generation: dependencies.domains.projectDomain.getGeneration(), items };
      ensureCountryLabelAnchorWorker().postMessage(countryLabelAnchorFlight);
    } catch (error) {
      console.warn('Country label anchor request failed', error);
      countryLabelAnchorFlight = null;
      countryLabelAnchorWorker = null;
      for (const item of items) {
        const feature = (0, dependencies.countries.territorialLabelFeatureById)(item.id);
        if (feature) queueCountryLabelFallback(item.id);
        pendingCountryLabelAnchors.delete(item.id);
      }
    }
  }

  function scheduleCountryLabelAnchors(ids = null, delay = 30) {
    const requested = ids ? new Set([...ids].map(String)) : null;
    const sources = (0, dependencies.countries.builtinTerritorialScene)();
    for (const id of countryLabelAnchorDependencies.keys()) {
      if (sources.labelById.has(id)) continue;
      countryLabelAnchorDependencies.delete(id);
      countryLabelAnchors.delete(id);
      pendingCountryLabelAnchors.delete(id);
      countryLabelAnchorVersions.delete(id);
    }
    let changed = false;
    const sourceKey='country-anchor:'+dependencies.domains.projectDomain.getGeneration();
    for (const feature of sources.labelById.values()) {
      const id = String(feature?.id || '');
      if (requested && !requested.has(id) && !requested.has(String(sources.labelRefs.get(id)?.id))) continue;
      const previous = countryLabelAnchorDependencies.get(id) || null;
      const ref=geometryReferenceFor(feature.geometry);
      let content=ref?anchorContentKeys.get(feature.geometry):geometryRevisionKey(feature.geometry);
      if(ref&&!content){content=JSON.stringify([ref.id,ref.version]);anchorContentKeys.set(feature.geometry,content);}
      const next = { source: sourceKey, content,
        preparation: resourceKey(['anchor-v1']), context: null, presentation: 'anchor' };
      const change = resourceUpdate(previous, next);
      countryLabelAnchorDependencies.set(id, next);
      if ((!previous || !change.prepare)
        && (validLabelAnchor(countryLabelAnchors.get(id)) || pendingCountryLabelAnchors.has(id))) continue;
      const baked=bakedAnchors[countryBoundaryOwner(id)];
      if(baked&&validLabelAnchor(baked.coordinates)&&matchesCountryGeometrySignature(feature,baked.signature)){
        countryLabelAnchors.set(id,[...baked.coordinates]);pendingCountryLabelAnchors.delete(id);
        countryLabelAnchorVersions.set(id,(countryLabelAnchorVersions.get(id)||0)+1);changed=true;continue;
      }
      countryLabelAnchors.delete(id);
      countryLabelAnchorVersions.set(id, (countryLabelAnchorVersions.get(id) || 0) + 1);
      pendingCountryLabelAnchors.add(id);
      changed = true;
    }
    if (!changed) return;
    (0, dependencies.objectDisplay.invalidateObjectPresentation)();
    clearTimeout(countryLabelAnchorTimer);
    countryLabelAnchorTimer = setTimeout(flushCountryLabelAnchorQueue, delay);
  }

  function initializeCountryLandRevision() {
    (countryLandRevision = 0);

    (pendingCountryLabelAnchors = new Set());

    (countryLabelAnchorVersions = new Map());

    (countryLabelAnchors = new Map());
  }

  function initializeCountryLabelAnchorWorker() {
    (countryLabelAnchorWorker = null);

    (countryLabelAnchorTimer = 0);

    (countryLabelAnchorRequestId = 0);

    (countryLabelAnchorFlight = null);
  }

  function initializeLabelFallbackQueue() {
    (labelFallbackQueue = new Map());
  }

  return Object.freeze({
    connect,
    initializeCountryLandRevision,
    initializeCountryLabelAnchorWorker,
    initializeLabelFallbackQueue,

    get countryLabelAnchors() { return countryLabelAnchors; },
    get countryLandRevision() { return countryLandRevision; },
    set countryLandRevision(value) { countryLandRevision = value; },
    get featureCountryId() { return featureCountryId; },
    get pendingCountryLabelAnchors() { return pendingCountryLabelAnchors; },
    get reindexCountries() { return reindexCountries; },
    get resetCountryLabelAnchorRuntime() { return resetCountryLabelAnchorRuntime; },
    get scheduleCountryLabelAnchors() { return scheduleCountryLabelAnchors; },
    get validLabelAnchor() { return validLabelAnchor; },
  });
}
// @worker-transport dedicated: country label indexing owns a single persistent geometry index channel
