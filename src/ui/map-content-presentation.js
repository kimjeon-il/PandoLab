import {temporalContains,temporalMonthEnd} from "../document/temporal.js";
import {resolveMapStrokeStyle} from "../map/map-interaction-style.js";
import {distributionValueRange,distributionValueAlpha} from "../document/distribution-model.js";
import {createTerritorialFillResolver} from "../rendering/territorial-fill-style.js";
import {connectBoundarySegments} from "../geometry/boundary-lines.js";

/** Canonical map content and scene presentation; product outputs supply registered surfaces. */
export function createMapContentPresentation({countries={},territorial={},generic={},distribution={},
 territorialBoundary={},base={},prepareMapDisplay=null,onMapDisplayReady=()=>{},
 reportDiagnostic=()=>{},isDisposed=()=>false,isSmooth=()=>document.documentElement.dataset.smoothLines!=='false'}={}) {
  const renderCountries = () => {
    const state = countries.getState?.() || {};
    // GPU scene assembly belongs to preparation, before the GPU draw: changing
    // it here would invalidate the identity of the just-rendered visual frame.
    {
      const pending = state.layerVisibility?.objects && state.pendingCountryRenderIds?.size
        ? [...state.pendingCountryRenderIds].map(countries.getEntity).filter(Boolean)
        : [];
      const pendingPolygons = [];
      const pendingStrokes = [];
      const theme = pending.length ? countries.mapPalette() : null;
      const resolveFill = pending.length ? createTerritorialFillResolver({ state, entityRepository: territorial.entityRepository,
        neutralColor: theme.defaultLand,
        mapSubstrate: { color: theme.defaultLand, fillAlpha: theme.baseLandAlpha } }) : null;
      for (const feature of pending) {
        const id = String(feature.id || '');
        const geometryRevision = countries.selectionGeometryRevision?.(`country:${id}`, 'pending-country', feature);
        pendingPolygons.push({ key: `pending-country-fill:${id}`, geometryRevision, geometry: feature.geometry, order: -300,
          role: 'territorial-fill', ownerId: id, territoryDepth: 0,
          style: resolveFill(feature) });
        pendingStrokes.push({ key: `pending-country-outline:${id}`, geometryRevision, geometry: countries.countryOutlineFeature?.(feature).geometry, order: -290, style: Object.freeze({ ...theme.strokes.country, alpha: theme.borderAlpha }) });
      }
      countries.replaceSceneDomain?.('country-overlays', {
        polygons: pendingPolygons,
        strokes: pendingStrokes,
      });
    }
  };
  const renderTerritorialUnits = () => {
    const t = territorial;
    const state = t.getState?.() || {};
    const theme = countries.mapPalette?.() || {};
    const resolveFill = createTerritorialFillResolver({ state, entityRepository: t.entityRepository,
      neutralColor: theme.defaultLand });
    t.syncBuiltinPalette?.();
    const visibleIds = new Set((t.visibleMapObjectCandidates?.(['territorial']) || []).map(record => String(record.id)));
    const displayedUnits = t.displayEntities().filter(entity => entity.properties.entityKind === 'regional');
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
    const strokes = [];
    for (const feature of data) {
      const group = 'objects';
      const unitStyle = resolveFill(feature);
      const objectKey = t.normalizeObjectRef?.({ domain: 'territorial', type: 'entity', id: feature.id })?.key
        || `territorial:entity:${feature.id}`;
      const geometryRevision = t.selectionGeometryRevision?.(objectKey, 'gpu-scene', feature);
      polygons.push({ key: `${objectKey}:fill`, objectKey, geometryRevision, geometry: feature.geometry,
        role: 'regional-overlay',
        order: t.sceneOrder?.(group, 'fill', objectKey), blendMode: unitStyle.blendMode,
        style: { color: unitStyle.color, fillAlpha: unitStyle.fillAlpha, blendMode: unitStyle.blendMode } });

    }
    t.replaceSceneDomain?.('territorial-units', { polygons, strokes });
    const boundaryFeatures = displayedUnits.filter(feature => {
      const group = 'objects';
      return state.layerVisibility?.[group] !== false && t.isLayerItemVisible?.(group, feature.id);
    });
    renderTerritorialInternalBoundaries(boundaryFeatures);
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
      const geometryRevision = g.selectionGeometryRevision?.(objectKey, 'gpu-scene', feature);
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
      const geometryRevision = d.selectionGeometryRevision?.(`distribution-entry:${row.id}`, 'gpu-scene', feature);
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
  let territorialBoundaryEpoch = 0;
  let territorialBoundaryCache = { countries: null, units: null, revision: -1, inputSignature: '', segments: [], rebuildCount: 0 };
  let territorialBoundaryBatchCache = { signature: '', revision: '', groups: [], data: [] };
  const renderTerritorialInternalBoundaries = (visibleFeatures = []) => {
    const t = territorialBoundary;
    const state = t.getState?.() || {};
    const displayed = territorial.displayEntities();
    const countries = displayed.filter(entity => entity.properties.entityKind === 'general' && !entity.properties.parentId);
    const units = displayed.filter(entity => entity.properties.entityKind === 'regional');
    const revision = t.getTerritorialGeometryRevision?.() ?? 0;
    if (!units.some(feature => ['Polygon', 'MultiPolygon'].includes(feature?.geometry?.type))) {
      pendingTerritorialBoundary = null;
      const hadBoundaries = territorialBoundaryCache.segments.length || territorialBoundaryBatchCache.groups.length;
      territorialBoundaryCache = { countries: null, units: null, revision: -1, inputSignature: '', segments: [], rebuildCount: territorialBoundaryCache.rebuildCount };
      territorialBoundaryBatchCache = { signature: '', revision: '', groups: [], data: [] };
      if (hadBoundaries) t.replaceSceneDomain?.('territorial-boundaries', { strokes: [] });
      return true;
    }
    const inputSignature = JSON.stringify([
      t.getCountryLandRevision?.() ?? 0,
      revision,
      countries.map(feature => [String(feature?.id || ''), t.geometryToken?.(feature?.geometry)]),
      units.map(feature => [String(feature?.id || ''), t.geometryToken?.(feature?.geometry), String(feature?.properties?.entityKind || ''), String(feature?.properties?.parentId || '')]),
    ]);
    // A candidate belongs to one request lifetime, even if its input repeats
    // after undo or a project reset. Only the render path promotes its result.
    if (pendingTerritorialBoundary?.inputSignature !== inputSignature) pendingTerritorialBoundary = null;
    if (territorialBoundaryCache.revision !== revision || territorialBoundaryCache.inputSignature !== inputSignature) {
      if (pendingTerritorialBoundary?.status === 'ready') {
        territorialBoundaryCache = { countries, units, revision, inputSignature,
          segments: pendingTerritorialBoundary.segments, rebuildCount: territorialBoundaryCache.rebuildCount + 1 };
        pendingTerritorialBoundary = null;
      } else if (prepareMapDisplay && !pendingTerritorialBoundary) {
        const candidate = { inputSignature, epoch: territorialBoundaryEpoch, status: 'preparing', segments: null };
        pendingTerritorialBoundary = candidate;
        // Catch synchronous preparation failures as well as Worker rejection.
        (async () => {
          const response = await prepareMapDisplay({ kind: 'boundaries' },
          { jobKey: 'edit-display:boundaries' });
          if (isDisposed() || pendingTerritorialBoundary !== candidate || candidate.epoch !== territorialBoundaryEpoch) return;
          if (!Array.isArray(response?.result?.segments)) throw new TypeError('Territorial boundary result requires segments');
          candidate.segments = response.result.segments;
          candidate.status = 'ready';
          onMapDisplayReady();
        })().catch(error => {
          if (isDisposed() || pendingTerritorialBoundary !== candidate || candidate.epoch !== territorialBoundaryEpoch) return;
          if (error?.name === 'AbortError' || error?.cancelled === true) {
            pendingTerritorialBoundary = null;
            return;
          }
          candidate.status = 'failed';
          reportDiagnostic({ operation: 'territorial-boundary-prepare', result: 'recovered', stage: 'topology',
            technicalMessage: String(error?.message || error), stack: error?.stack || '' });
        });
      }
    } else pendingTerritorialBoundary = null;
    const visibleIds = new Set(visibleFeatures.map(feature => String(feature.id)));
    const styleByType = new Map([
      ['subunit', { presentationGroup: 'objects' }],
      ['subunit-internal', { presentationGroup: 'objects' }],
      ['region', { presentationGroup: 'objects' }],
    ]);
    const visibleSignature = [...visibleIds].sort().map(id => {
      const feature = visibleFeatures.find(item => String(item.id) === id);
      return `${id}:${t.territorialEntityColor?.(feature)}:${JSON.stringify(t.layerStyle?.(state.layerPresentation, 'objects', `territorial:entity:${id}`))}`;
    }).join('|');
    const styleSignature = [...styleByType].map(([type, definition]) => {
      const style = t.layerStyle?.(state.layerPresentation, definition.presentationGroup) || {};
      return `${type}:${style.boundaryVisible}:${style.blendMode}`;
    }).join('|');
    const boundaryColor = t.mapPalette?.().border || '#ffffff';
    // Aggregate buffers cannot selectively hide their old segments. A visibility
    // change makes that archive ineligible as a GPU upload fallback (M3), even
    // while an otherwise valid new topology is still being prepared.
    const continuityOwnerIds = [...visibleIds].sort().filter(id => {
      const style = t.layerStyle?.(state.layerPresentation, 'objects', `territorial:entity:${id}`) || {};
      return style.boundaryVisible !== false;
    });
    const signature = `${territorialBoundaryCache.rebuildCount};${visibleSignature};${styleSignature};${boundaryColor}`;
    if (territorialBoundaryBatchCache.signature !== signature) {
      const groups = new Map([...styleByType].map(([styleType, definition]) => [styleType, { key: styleType, styleType, segments: [] }]));
      for (const segment of territorialBoundaryCache.segments) {
        const owner = (segment.unitOwners || []).find(item => visibleIds.has(String(item.id)));
        if (!owner) continue;
        const feature = visibleFeatures.find(item => String(item.id) === String(owner.id));
        const styleType = segment.styleType || feature?.properties?.entityKind || 'subunit';
        const definition = styleByType.get(styleType) || styleByType.get('subunit');
        const group = groups.get(styleType) || groups.get('subunit');
        if (!group) continue;
        const style = t.layerStyle?.(state.layerPresentation, definition.presentationGroup, `territorial:entity:${feature.id}`) || {};
        if (!style.boundaryVisible) continue;
        group.segments.push({ a: segment.a, b: segment.b, color: boundaryColor, blendMode: style.blendMode });
      }
      const preparedGroups = [...groups.values()].filter(group => group.segments.length);
      const fallbackGroups = new Map();
      for (const group of preparedGroups) for (const segment of group.segments) {
        const key = `${group.styleType}:${segment.color}:${segment.blendMode}`;
        if (!fallbackGroups.has(key)) fallbackGroups.set(key, { key, styleType: group.styleType, color: segment.color, blendMode: segment.blendMode, coordinates: [] });
        fallbackGroups.get(key).coordinates.push([segment.a, segment.b]);
      }
      const data = [...fallbackGroups.values()].map(group => ({ ...group, geometry: { type: 'MultiLineString', coordinates: connectBoundarySegments(group.coordinates) } }));
      territorialBoundaryBatchCache = { signature, revision: `${territorialBoundaryCache.rebuildCount}:${signature}`, groups: preparedGroups, data };
    }
    const data = territorialBoundaryBatchCache.data;
    // These are scene strokes. A projected SVG copy caused a second visual
    // owner with different cache and transition timing.
    t.replaceSceneDomain?.('territorial-boundaries', { strokes: data.map((group, index) => {
      const definition = styleByType.get(group.styleType) || styleByType.get('subunit') || { presentationGroup: 'objects' };
      return { key: `territorial-internal:${group.key}`, continuityOwnerIds, geometryRevision: territorialBoundaryBatchCache.revision, geometry: group.geometry, order: t.sceneOrder?.(definition.presentationGroup, 'territorial-boundary', '', index), style: resolveMapStrokeStyle({ color: group.color, layerStyle: { boundaryWidth: 1, blendMode: group.blendMode } }, group.styleType) };
    }) });
    return true;
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
      lodPolicy: 'exact', protected: true, role: 'graticule', order: 0,
      style: { color: light ? '#aaaaaa' : '#688091', alpha: light ? 0.34 : 0.20, width: 0.55, cap: 'butt', join: 'round' },
    }] });
    return true;
  };
  const resetTerritorialBoundaryCache = () => {
    territorialBoundaryEpoch++;
    pendingTerritorialBoundary = null;
    territorialBoundaryCache = {
      countries: null,
      units: null,
      revision: -1,
      inputSignature: '',
      segments: [],
      rebuildCount: 0,
    };
    territorialBoundaryBatchCache = { signature: '', revision: '', groups: [], data: [] };
  };
  const getTerritorialBoundaryStats = () => Object.freeze({
    rebuildCount: territorialBoundaryCache.rebuildCount,
    revision: territorialBoundaryBatchCache.revision || '',
    inputSignature: territorialBoundaryCache.inputSignature || '',
    batchSignature: territorialBoundaryBatchCache.signature || '',
    segmentCount: territorialBoundaryCache.segments.length,
    groupCount: territorialBoundaryBatchCache.groups.length,
    pendingInputSignature: pendingTerritorialBoundary?.inputSignature || '',
    pendingStatus: pendingTerritorialBoundary?.status || 'idle',
  });
  return Object.freeze({renderCountries,renderTerritorialUnits,
 renderGenericFeatures,renderDistributions,renderBase,
 buildDistributionRenderRows,resetTerritorialBoundaryCache,getTerritorialBoundaryStats});
}
