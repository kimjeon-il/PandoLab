/** CameraNavigation: extracted application responsibility.
 * Dependencies are explicitly wired once by the composition modules.
 * Mutable bindings stay local; exported accessors retain live identity.
 */
export function createCameraNavigation() {
  let dependencies;

  function connect(ports) {
    if (dependencies) throw new Error('camera-navigation already connected');
    dependencies = ports;
  }

  function panMapViewBy(dx, dy) {
    return dependencies.rendering.mapRenderer.panBy(dx, dy);
  }

  function fitMapToFeature(feature) {
    const safe = dependencies.mapView.projectionLayoutMetrics().safe;
    if (feature?.geometry||feature?.type==='FeatureCollection')dependencies.rendering.mapRenderer.fitGeometry(feature, safe);
    else if (feature?.__awBounds?.length===4&&feature.__awBounds.every(Number.isFinite)) {
      const [west, south, east, north] = feature.__awBounds;
      dependencies.rendering.mapRenderer.fitMapBounds([[west, south], [east, north]], safe);
    }else return;
    dependencies.domains.renderingDomain.invalidateView('focus-object');
  }

  function focusCoordinate(coord, zoom = null) {
    if (!(0, dependencies.countries.validLabelAnchor)(coord)) return;
    const view = dependencies.projectState.state.view;
    dependencies.rendering.mapRenderer.syncCameraFromState({
      globeRotation: [-Number(coord[0]), -Number(coord[1]), 0], zoom: zoom ?? view.zoom,
    });
    dependencies.domains.renderingDomain.invalidateView('focus-coordinate');
  }

  function selectObjectSearchItem(group, id, { mode = 'replace', range = false, orderedRefs = [] } = {}) {
    const key = String(id);
    if (group === 'hydro' && dependencies.physicalData.HYDRO_LAYER_META[key]) {
        if (!dependencies.projectState.state.hydroManifest) (0, dependencies.physicalData.loadHydroData)(true);
        else {
          const cacheState = dependencies.projectState.state.physicalLoadState.hydroCache;
          if (cacheState === 'error') {
            dependencies.rendering.mapRenderer.retryHydroCache?.();
            (0, dependencies.feedback.setActionStatus)('전 세계 강·호수 자료의 오프라인 저장을 다시 시도합니다.', 'working', 0);
          } else {
            const suffix = cacheState === 'ready' ? '오프라인에서도 바로 사용할 수 있습니다.' : `전 세계 강·호수 자료를 백그라운드에서 준비하고 있습니다. ${Math.round(dependencies.projectState.state.physicalLoadState.hydroCachePercent || 0)}%`;
            (0, dependencies.feedback.setActionStatus)(suffix, 'success', 3200);
          }
        }
        return false;
    }
    const ref = (0, dependencies.objectLookup.layerItemObjectRef)(group, key);
    if (!ref || !(0, dependencies.objectLookup.objectRefExists)(ref)) return false;
    return dependencies.domains.selectionUiController.applyIntent(ref, { mode: range ? 'range' : mode, orderedRefs, scope: 'layer-list' });
  }

  function resetView() {
    return dependencies.rendering.mapRenderer.fitWorld(dependencies.mapView.projectionLayoutMetrics().safe);
  }

  return Object.freeze({
    connect,

    panMapViewBy,
    dragMapBy:panMapViewBy,
    focusCoordinate,
    fitMapToFeature,
    resetView,
    selectObjectSearchItem,
  });
}
