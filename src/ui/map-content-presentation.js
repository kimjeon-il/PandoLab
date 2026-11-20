import {temporalContains,temporalMonthEnd} from "../document/temporal.js";
import {resolveMapStrokeStyle} from "../map/map-interaction-style.js";
import {distributionValueRange,distributionValueAlpha} from "../document/distribution-model.js";
import {createTerritorialFillResolver} from "../rendering/territorial-fill-style.js";
import {connectBoundarySegments} from "../geometry/boundary-lines.js";

/** Canonical map content and scene presentation; product outputs supply registered surfaces. */
export function createMapContentPresentation({mapPalette=()=>({}),territorial={},generic={},distribution={},
 territorialBoundary={},base={},prepareMapDisplay=null,onMapDisplayReady=()=>{},onMapDisplayFailed=()=>{},
 reportDiagnostic=()=>{},isDisposed=()=>false,isSmooth=()=>document.documentElement.dataset.smoothLines!=='false'}={}) {
  const renderTerritorialUnits = () => {
    const t = territorial;
    const state = t.getState?.() || {};
    const theme = mapPalette();
    const resolveFill = createTerritorialFillResolver({ state, entityRepository: t.entityRepository,
      neutralColor: theme.defaultLand });
    t.syncBuiltinPalette?.();
    const visibleIds = new Set((t.visibleMapObjectCandidates?.(['territorial']) || []).map(record => String(record.id)));
    const displayed = t.displayEntities();
    const displayedUnits = displayed.filter(entity => entity.properties.entityKind === 'regional');
    const data = displayedUnits.filter(feature => {
      const group = 'objects';
      const selected = t.selectionHas?.(t.normalizeObjectRef?.({
        domain: 'territorial', type: 'entity', id: feature.id,
      }));
      return state.layerVisibility?.[group] !== false && t.isLayerItemVisible?.(group, feature.id)
        && (selected || (visibleIds.has(String(feature.id)) && t.geometryMayIntersectViewport?.(feature.geometry)));
    });
    if (t.viewportCullingMetrics?.lastByDomain?.territorial) t.viewportCullingMetrics.lastByDomain.territorial.finalVisibleCount = data.length;
    const polygons = [];
    for (const feature of data) {
      const group = 'objects';
      const unitStyle = resolveFill(feature);
      const objectKey = t.normalizeObjectRef?.({ domain: 'territorial', type: 'entity', id: feature.id })?.key
        || `territorial:entity:${feature.id}`;
      const geometryRevision = t.selectionGeometryRevision?.(objectKey, 'territorial-overlay', feature);
      polygons.push({ key: `${objectKey}:fill`, objectKey, geometryRevision, geometry: feature.geometry,
        order: t.sceneOrder?.(group, 'fill', objectKey), blendMode: unitStyle.blendMode,
        style: { color: unitStyle.color, fillAlpha: unitStyle.fillAlpha, blendMode: unitStyle.blendMode } });

    }
    t.replaceSceneDomain?.('territorial-units', { polygons });
    const boundaryFeatures = displayedUnits.filter(feature => {
      const group = 'objects';
      return state.layerVisibility?.[group] !== false && t.isLayerItemVisible?.(group, feature.id);
    });
    renderTerritorialInternalBoundaries(displayed, boundaryFeatures);
    return true;
  };
  const renderGenericFeatures = () => {
    const g = generic;
    const state = g.getState?.() || {};
    const style = g.layerStyle?.(state.layerPresentation, 'genericFeatures') || {};
    const visibleIds = state.layerVisibility?.genericFeatures !== false
      ? new Set((g.visibleMapObjectCandidates?.(['generic']) || []).map(record => String(record.id)))
      : new Set();
    const data = state.layerVisibility?.genericFeatures !== false
      ? (state.genericFeatures || []).filter(feature => g.isLayerItemVisible?.('genericFeatures', feature.id))
        .filter(feature => feature.geometry && ((visibleIds.has(String(feature.id)) && g.geometryMayIntersectViewport?.(feature.geometry))
          || g.selectionHas?.(g.normalizeObjectRef?.({ domain: 'generic', type: 'feature', id: feature.id }))))
      : [];
    if (g.viewportCullingMetrics?.lastByDomain?.generic) g.viewportCullingMetrics.lastByDomain.generic.finalVisibleCount = data.length;
    const selectedRef = d => g.normalizeObjectRef?.({ domain: 'generic', type: 'feature', id: d.id });
    const polygons = [];
    const strokes = [];
    for (const feature of data) {
      const objectKey = selectedRef(feature)?.key || `generic:feature:${feature.id}`;
      const geometryRevision = g.selectionGeometryRevision?.(objectKey, 'generic-feature', feature);
      if (['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)) {
        polygons.push({ key: `${objectKey}:fill`, objectKey, geometryRevision, geometry: feature.geometry,
          order: g.sceneOrder?.('genericFeatures', 'fill'), blendMode: style.blendMode,
          style: { color: g.genericFeatureColor?.(feature), fillAlpha: 0.34, blendMode: style.blendMode } });
        if (style.boundaryVisible) strokes.push({
          key: `${objectKey}:boundary`, objectKey, geometryRevision,
          geometry: (g.buildRenderableStrokeFeature?.(feature) || feature).geometry,
          order: g.sceneOrder?.('genericFeatures', 'boundary'), blendMode: style.blendMode,
          style: resolveMapStrokeStyle({ color: g.genericFeatureColor?.(feature), layerStyle: style, antiAlias: isSmooth() }, 'generic'),
        });
      } else if (['LineString', 'MultiLineString'].includes(feature.geometry?.type) && style.boundaryVisible) strokes.push({
        key: `${objectKey}:line`, objectKey, geometryRevision, geometry: feature.geometry,
        order: g.sceneOrder?.('genericFeatures', 'line'), blendMode: style.blendMode,
        style: resolveMapStrokeStyle({ color: g.genericFeatureColor?.(feature), layerStyle: style, antiAlias: isSmooth() }, 'generic'),
      });
      else if(['Point','MultiPoint'].includes(feature.geometry?.type))strokes.push({key:`${objectKey}:point`,objectKey,geometryRevision,geometry:feature.geometry,
        order:g.sceneOrder?.('genericFeatures','line'),style:{color:g.genericFeatureColor(feature),alpha:1,width:style.boundaryWidth}});
    }
    g.replaceSceneDomain?.('generic-features', { polygons, strokes });
    return true;
  };
  let distributionRenderRowCache = { layers: null, entries: null, entities: null, countryGeometryRevision: -1, month:'', renderMode: '', selectedLayerId: '', visibilityRevision: -1, rows: Object.freeze([]), rebuildCount: 0, buildMs: 0 };
  const buildDistributionRenderRows = () => {
    const d = distribution;
    const state = d.getState?.() || {};
    const settings = state.distributionSettings || {};
    const renderMode = settings.renderMode;
    const month=state.timelineCursor;
    const at=month?temporalMonthEnd(month):null;
    const exists=value=>at===null||temporalContains(value,at);
    const modes = d.DISTRIBUTION_RENDER_MODES || {};
    const selectedLayerId = renderMode === modes.SINGLE ? String(settings.activeLayerId || '') : '';
    const visibilityRevision = d.getDistributionVisibilityRevision?.() ?? 0;
    const countryRevision = d.getCountryGeometryRevision?.() ?? 0;
    const cacheCurrent = distributionRenderRowCache.layers === state.distributionLayers
      && distributionRenderRowCache.entries === state.distributionEntries
      && distributionRenderRowCache.entities === state.territorialEntities
      && distributionRenderRowCache.countryGeometryRevision === countryRevision
      && distributionRenderRowCache.month===month
      && distributionRenderRowCache.renderMode === renderMode
      && distributionRenderRowCache.selectedLayerId === selectedLayerId
      && distributionRenderRowCache.visibilityRevision === visibilityRevision;
    if (cacheCurrent) return distributionRenderRowCache.rows;
    const started = globalThis.performance?.now?.() || Date.now();
    const visibleLayers = state.layerVisibility?.distributions === false ? [] :
      (state.distributionLayers || []).filter(layer => exists(layer)&&d.isLayerItemVisible?.('distributions', layer.id));
    const activeId = visibleLayers.some(layer => layer.id === selectedLayerId) ? selectedLayerId : visibleLayers[0]?.id;
    const displayedLayers = renderMode === modes.SINGLE
      ? visibleLayers.filter(layer => layer.id === activeId) : visibleLayers;
    const entriesByLayer = new Map(visibleLayers.map(layer => [layer.id, []]));
    for (const entry of state.distributionEntries || []) if(exists(entry))entriesByLayer.get(entry.layerId)?.push(entry);
    const ranges = new Map(visibleLayers.map(layer => [layer.id, distributionValueRange(layer, entriesByLayer.get(layer.id))]));
    const rows = displayedLayers.flatMap(layer => (entriesByLayer.get(layer.id) || []).map(entry => {
      const geometry = entry.mode === (d.DISTRIBUTION_MODES || {}).TERRITORIAL
        ? d.territorialEntityRepository.get(entry.territorialUnitId)?.geometry : entry.geometry;
      if (!layer || !geometry) return null;
      return Object.freeze({ id: entry.id, layer, entry, range: ranges.get(layer.id),
        geometry, bounds: d.geometryBounds?.(geometry), type: 'Feature' });
    })).filter(Boolean);
    distributionRenderRowCache = { layers: state.distributionLayers, entries: state.distributionEntries, entities: state.territorialEntities,
      countryGeometryRevision: countryRevision, month, renderMode, selectedLayerId, visibilityRevision,
      rows: Object.freeze(rows), rebuildCount: distributionRenderRowCache.rebuildCount + 1, buildMs: (globalThis.performance?.now?.() || Date.now()) - started };
    return distributionRenderRowCache.rows;
  };
  const visibleDistributionRenderRows = () => {
    const d = distribution;
    const rows = buildDistributionRenderRows();
    const candidates = new Set((d.visibleMapObjectCandidates?.(['distribution']) || []).map(record => String(record.id)));
    const started = globalThis.performance?.now?.() || Date.now();
    let verificationCount = 0;
    const visible = rows.filter(row => {
      const selected = d.selectionHas?.(d.normalizeObjectRef?.({ domain: 'distribution', type: 'distribution', id: row.layer.id }));
      if (selected) return true;
      if (!candidates.has(String(row.id))) return false;
      verificationCount += 1;
      return d.geometryMayIntersectViewport?.(row.geometry);
    });
    if (d.viewportCullingMetrics) {
      d.viewportCullingMetrics.finalVisibleCount = visible.length;
      if (d.viewportCullingMetrics.lastByDomain?.distribution) d.viewportCullingMetrics.lastByDomain.distribution.finalVisibleCount = visible.length;
      d.viewportCullingMetrics.projectedVerificationCount = (d.viewportCullingMetrics.projectedVerificationCount || 0) + verificationCount;
      d.viewportCullingMetrics.projectedVerificationMs = (d.viewportCullingMetrics.projectedVerificationMs || 0) + ((globalThis.performance?.now?.() || Date.now()) - started);
    }
    return visible;
  };
  const renderDistributions = () => {
    const d = distribution;
    const state = d.getState?.() || {};
    const data = visibleDistributionRenderRows();
    const boundaryVisible = state.distributionSettings?.boundaryVisible !== false;
    const isArea = row => ['Polygon', 'MultiPolygon'].includes(row.geometry?.type);
    const color = row => d.distributionColor?.(row.layer);
    const styleFor = () => d.layerStyle?.(state.layerPresentation, 'distributions') || {};
    const polygons = [], strokes = [];
    for (const row of data) {
      const group = 'distributions';
      const renderStyle = styleFor(row);
      const objectKey = d.normalizeObjectRef?.({ domain: 'distribution', type: 'distribution', id: row.layer.id })?.key || `distribution:distribution:${row.layer.id}`;
      const feature = d.featureFromGeometry?.(row.geometry);
      const geometryRevision = d.selectionGeometryRevision?.(`distribution-entry:${row.id}`, 'distribution', feature);
      const fillAlpha = distributionValueAlpha(row.entry.value, row.range);
      if (isArea(row)) {
        polygons.push({ key: `distribution-entry:${row.id}:fill`, objectKey, geometryRevision, geometry: row.geometry, order: d.sceneOrder?.(group, 'fill'), blendMode: renderStyle.blendMode, style: { color: color(row), fillAlpha, blendMode: renderStyle.blendMode } });
        if (boundaryVisible && renderStyle.boundaryVisible) strokes.push({ key: `distribution-entry:${row.id}:boundary`, objectKey, geometryRevision, geometry: (d.buildRenderableStrokeFeature?.(feature) || feature).geometry, order: d.sceneOrder?.(group, 'boundary'), blendMode: renderStyle.blendMode, style: resolveMapStrokeStyle({ color: color(row), layerStyle: renderStyle, antiAlias: isSmooth() }, 'distribution') });
      } else if (['LineString', 'MultiLineString'].includes(row.geometry?.type) && boundaryVisible) strokes.push({ key: `distribution-entry:${row.id}:line`, objectKey, geometryRevision, geometry: row.geometry, order: d.sceneOrder?.(group, 'line'), blendMode: renderStyle.blendMode, style: resolveMapStrokeStyle({ color: color(row), layerStyle: renderStyle, antiAlias: isSmooth() }, 'distribution') });
    }
    d.replaceSceneDomain?.('distributions', { polygons, strokes });
    return true;
  };
  let pendingTerritorialBoundary = null;
  let territorialBoundaryCache = { inputSignature: '', segments: [], rebuildCount: 0 };
  let territorialBoundaryBatchCache = { signature: '', groups: [] };
  const polygonal = feature => ['Polygon', 'MultiPolygon'].includes(feature.geometry?.type);

  const cancelTerritorialBoundaries = () => {
    const candidate = pendingTerritorialBoundary;
    pendingTerritorialBoundary = null;
    clearTimeout(candidate?.retryTimer);
    candidate?.controller.abort();
  };
  const prepareTerritorialBoundaries = candidate => {
    if (isDisposed() || pendingTerritorialBoundary !== candidate) return;
    candidate.status = 'preparing';
    // An explicit retry or a changed input owns a new request lifetime.
    (async () => {
      const response = await prepareMapDisplay(candidate.inputs, {signal: candidate.controller.signal});
      if (isDisposed() || pendingTerritorialBoundary !== candidate) return;
      if (!Array.isArray(response?.result?.segments)) throw new TypeError('Territorial boundary result requires segments');
      candidate.segments = response.result.segments;
      candidate.status = 'ready';
      onMapDisplayReady();
    })().catch(error => {
      if (isDisposed() || pendingTerritorialBoundary !== candidate) return;
      if (error?.name !== 'AbortError' && error?.cancelled !== true) {
        reportDiagnostic({ operation: 'territorial-boundary-prepare', result: candidate.retried ? 'failed' : 'retrying', stage: 'topology',
          technicalMessage: String(error?.message || error), stack: error?.cause?.stack || error?.stack || '' });
      }
      if (!candidate.retried) {
        candidate.retried = true;
        candidate.status = 'retry-wait';
        candidate.retryTimer = setTimeout(() => prepareTerritorialBoundaries(candidate), 250);
      } else {
        candidate.status = 'failed';
        candidate.error = error;
        onMapDisplayFailed(error);
      }
    });
  };

  const renderTerritorialInternalBoundaries = (displayed, visibleFeatures) => {
    const t = territorialBoundary;
    if (!prepareMapDisplay) return;
    const state = territorial.getState();
    const ownerStyles = new Map(visibleFeatures.filter(polygonal).map(feature => {
      const id = String(feature.id);
      const {boundaryVisible, blendMode} = t.layerStyle(state.layerPresentation, 'objects', `territorial:entity:${id}`);
      return [id, {boundaryVisible, blendMode}];
    }));
    if (![...ownerStyles.values()].some(style => style.boundaryVisible)) {
      cancelTerritorialBoundaries();
      if (territorialBoundaryBatchCache.signature) {
        territorialBoundaryBatchCache = { signature: '', groups: [] };
        t.replaceSceneDomain('territorial-boundaries', { strokes: [] });
      }
      return;
    }
    const inputs = displayed.filter(feature => {
      const {entityKind, parentId} = feature.properties;
      return polygonal(feature) && (entityKind === 'regional' || (entityKind === 'general' && !parentId));
    }).map(({id, geometry, properties: {entityKind, parentId}}) => ({
      type: 'Feature', id: String(id), geometry, geometryKey: t.geometryToken(geometry), properties: {entityKind, parentId},
    }));
    const inputSignature = JSON.stringify(inputs.map(row => [row.id, row.geometryKey, row.properties.entityKind, row.properties.parentId]));
    if (pendingTerritorialBoundary && pendingTerritorialBoundary.inputSignature !== inputSignature)
      cancelTerritorialBoundaries();
    if (territorialBoundaryCache.inputSignature !== inputSignature) {
      if (pendingTerritorialBoundary?.status === 'ready') {
        territorialBoundaryCache = { inputSignature, segments: pendingTerritorialBoundary.segments,
          rebuildCount: territorialBoundaryCache.rebuildCount + 1 };
        pendingTerritorialBoundary = null;
      } else if (!pendingTerritorialBoundary) {
        const candidate = { inputSignature, inputs, controller: new AbortController(), retried: false };
        pendingTerritorialBoundary = candidate;
        prepareTerritorialBoundaries(candidate);
      }
    }

    const signature = JSON.stringify([territorialBoundaryCache.rebuildCount, [...ownerStyles].sort()]);
    if (territorialBoundaryBatchCache.signature !== signature) {
      const groups = new Map();
      for (const {a, b, unitOwners, styleType} of territorialBoundaryCache.segments) {
        // The first visible owner retains precedence on shared segments.
        const owner = unitOwners.find(item => ownerStyles.has(String(item.id)));
        const style = owner && ownerStyles.get(String(owner.id));
        if (!style?.boundaryVisible) continue;
        const {blendMode} = style;
        const key = `${styleType}:${blendMode}`;
        if (!groups.has(key)) groups.set(key, {key, styleType, blendMode, coordinates: []});
        groups.get(key).coordinates.push([a, b]);
      }
      territorialBoundaryBatchCache = { signature, groups: [...groups.values()].map(({coordinates, ...group}) => ({
        ...group, geometry: {type: 'MultiLineString', coordinates: connectBoundarySegments(coordinates)},
      })) };
    }
    const color = mapPalette().border || '#ffffff';
    t.replaceSceneDomain('territorial-boundaries', { strokes: territorialBoundaryBatchCache.groups.map((group, index) => ({
      key: `territorial-internal:${group.key}`, geometryRevision: signature, geometry: group.geometry,
      order: t.sceneOrder?.('objects', 'territorial-boundary', '', index),
      style: resolveMapStrokeStyle({color, layerStyle: {boundaryWidth: 1, blendMode: group.blendMode}}, group.styleType),
    })) });
  };
  const renderBase = (viewState = null) => {
    const b = base;
    if(b.getState().resourceCapabilities?.graticule===false||b.getState().backgroundSettings?.graticule===false){b.replaceSceneDomain('base-graticule',{strokes:[]});return true;}
    const graticuleGeometry = b.graticule?.();
    if (!graticuleGeometry) return false;
    const light = b.isLightTheme?.() ?? true;
    b.replaceSceneDomain?.('base-graticule', { strokes: [{
      key: 'base:graticule', geometryRevision: `${viewState.projection}:graticule-v2`,
      geometry:graticuleGeometry,
      role: 'graticule', order: 0,
      style: { color: light ? '#aaaaaa' : '#688091', alpha: light ? 0.34 : 0.20, width: 0.55, cap: 'butt', join: 'round' },
    }] });
    return true;
  };
  const resetTerritorialBoundaryCache = () => {
    cancelTerritorialBoundaries();
    territorialBoundaryCache = { inputSignature: '', segments: [], rebuildCount: 0 };
    territorialBoundaryBatchCache = { signature: '', groups: [] };
    territorialBoundary.replaceSceneDomain?.('territorial-boundaries', {strokes: []});
  };
  const retryTerritorialBoundaries = () => {
    if (['failed', 'retry-wait'].includes(pendingTerritorialBoundary?.status)) cancelTerritorialBoundaries();
  };
  const getTerritorialBoundaryStats = () => Object.freeze({
    rebuildCount: territorialBoundaryCache.rebuildCount,
    revision: territorialBoundaryBatchCache.signature,
    inputSignature: territorialBoundaryCache.inputSignature,
    batchSignature: territorialBoundaryBatchCache.signature,
    segmentCount: territorialBoundaryCache.segments.length,
    groupCount: territorialBoundaryBatchCache.groups.length,
    pendingInputSignature: pendingTerritorialBoundary?.inputSignature || '',
    pendingStatus: pendingTerritorialBoundary?.status || 'idle',
  });
  return Object.freeze({renderTerritorialUnits, renderGenericFeatures, renderDistributions, renderBase,
    buildDistributionRenderRows, resetTerritorialBoundaryCache, retryTerritorialBoundaries, getTerritorialBoundaryStats,
    territorialBoundariesPending: () => pendingTerritorialBoundary !== null,
    territorialBoundaryFailure: () => pendingTerritorialBoundary?.error ?? null,
  });
}
