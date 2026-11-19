import { resourceCapabilities } from "../runtime/resource-capabilities.js";

/** MapProjection: extracted application responsibility.
 * Dependencies are explicitly wired once by the composition modules.
 * Mutable bindings stay local; exported accessors retain live identity.
 */
export function createMapProjection({capabilities=resourceCapabilities('viewer')}={}) {
  let dependencies;
  let mapLayoutMetricsSnapshot;
  let mapLayoutMetricsRefreshCount;
  let graticule;
  let mapLibreRenderer=null;
  function connect(ports) {
    if (dependencies) throw new Error('map-projection already connected');
    dependencies = ports;
  }

  function ringRepresentativePoint(ring) {
    if (!ring?.length) return [0, 0];
    let x = 0, y = 0, n = Math.max(1, ring.length - 1);
    for (let i = 0; i < n; i += 1) { x += ring[i][0]; y += ring[i][1]; }
    return [x / n, y / n];
  }

  // A read adapter around the single MapLibre camera; no D3 globe fallback.
  const mapProject = coordinate => projectVisibleCoordinate(coordinate);
  mapProject.invert = point => screenToGeo(point);
  mapProject.translate = () => [
    dependencies.projectState.state.size.width / 2,
    dependencies.projectState.state.size.height / 2,
  ];
  function activeProjection() { return mapProject; }

  function readMapSafeInsets() {
    const workspace = document.querySelector('.workspace');
    if (!workspace) return dependencies.mapLayout.DEFAULT_SAFE_INSETS;
    const styles = getComputedStyle(workspace);
    const read = name => Math.max(0, Number.parseFloat(styles.getPropertyValue(name)) || 0);
    return {
      left: read('--projection-safe-left'),
      right: read('--projection-safe-right'),
      top: read('--projection-safe-top'),
      bottom: Math.max(26, read('--projection-safe-bottom')),
    };
  }

  function refreshMapLayoutMetrics(reason = 'layout') {
    const mapElement = (0, dependencies.platform.$)('map');
    const bounds = mapElement?.getBoundingClientRect?.();
    const width = Math.max(1, bounds?.width || mapElement?.clientWidth || dependencies.projectState.state.size.width || 900);
    const height = Math.max(1, bounds?.height || mapElement?.clientHeight || dependencies.projectState.state.size.height || 650);
    const safe = readMapSafeInsets();
    mapLayoutMetricsRefreshCount += 1;
    mapLayoutMetricsSnapshot = (0, dependencies.mapLayout.createMapLayoutMetricsSnapshot)({
      width,
      height,
      dpr: Math.max(1, Number(window.devicePixelRatio || 1)),
      safeInsets: safe,
      mobile: (0, dependencies.surfaces.isMobile)(),
      revision: mapLayoutMetricsRefreshCount,
      reason,
      projectBounds: dependencies.projectState.state.projectSetup?.initialMapBounds || null,
    });
    return mapLayoutMetricsSnapshot;
  }

  function projectionLayoutMetrics() {
    const bounds = dependencies.projectState.state.projectSetup?.initialMapBounds || null;
    const boundsKey = JSON.stringify(bounds);
    if (mapLayoutMetricsSnapshot && mapLayoutMetricsSnapshot.projectBoundsKey !== boundsKey) {
      // A project reference change updates the fit without discarding measured
      // viewport insets. Date queries do not change the fixed reference bounds.
      const previous = mapLayoutMetricsSnapshot;
      mapLayoutMetricsSnapshot = dependencies.mapLayout.createMapLayoutMetricsSnapshot({
        ...previous, safeInsets: previous.safe, projectBounds: bounds,
        revision: ++mapLayoutMetricsRefreshCount, reason: 'project-reference',
      });
    }
    if (!mapLayoutMetricsSnapshot) {
      mapLayoutMetricsSnapshot = (0, dependencies.mapLayout.createMapLayoutMetricsSnapshot)({
        width: dependencies.projectState.state.size.width,
        height: dependencies.projectState.state.size.height,
        dpr: Math.max(1, Number(window.devicePixelRatio || 1)),
        safeInsets: dependencies.mapLayout.DEFAULT_SAFE_INSETS,
        mobile: (0, dependencies.surfaces.isMobile)(),
        projectBounds: bounds,
      });
    }
    return mapLayoutMetricsSnapshot;
  }

  function currentMapSafeInsets() {
    return projectionLayoutMetrics().safe;
  }

  function projectVisibleCoordinate(coord, frameContext = null) {
    if (!coord) return null;
    if (typeof frameContext?.projectVisibleCoordinate === 'function') return frameContext.projectVisibleCoordinate(coord);
    return mapLibreRenderer?.loaded ? mapLibreRenderer.projection.projectVisibleCoordinate(coord) : null;
  }

  function isCoordVisible(coord) {
    return !!projectVisibleCoordinate(coord);
  }

  function screenToGeo(screenPoint) {
    return mapLibreRenderer?.loaded ? mapLibreRenderer.projection.screenToGeo(screenPoint) : null;
  }

  function initializeMapLayoutMetricsSnapshot() {
    (mapLayoutMetricsSnapshot = null);

    (mapLayoutMetricsRefreshCount = 0);
  }

  function initializeGraticule() {
    if(capabilities.graticule)
      graticule = dependencies.platform.d3.geo.graticule().minorExtent([[-180,-89.999999],[180,89.999999]]);
  }

  return Object.freeze({
    connect,
    installMapLibreRenderer(renderer){mapLibreRenderer=renderer;},
    initializeMapLayoutMetricsSnapshot,
    initializeGraticule,
    get activeProjection() { return activeProjection; },
    get currentMapSafeInsets() { return currentMapSafeInsets; },
    get graticule() { return graticule; },
    get isCoordVisible() { return isCoordVisible; },
    get mapLayoutMetricsRefreshCount() { return mapLayoutMetricsRefreshCount; },
    get mapLayoutMetricsSnapshot() { return mapLayoutMetricsSnapshot; },
    get projectVisibleCoordinate() { return projectVisibleCoordinate; },
    get projectionLayoutMetrics() { return projectionLayoutMetrics; },
    get refreshMapLayoutMetrics() { return refreshMapLayoutMetrics; },
    get ringRepresentativePoint() { return ringRepresentativePoint; },
    get screenToGeo() { return screenToGeo; },
  });
}
