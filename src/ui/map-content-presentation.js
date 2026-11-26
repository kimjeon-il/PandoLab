import {temporalContains,temporalMonthEnd} from "../document/temporal.js";
import {distributionValueRange} from "../document/distribution-model.js";

/** Current distribution objects for the Viewer spatial query. */
export function createDistributionRenderRows(distribution) {
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
  return buildDistributionRenderRows;
}
