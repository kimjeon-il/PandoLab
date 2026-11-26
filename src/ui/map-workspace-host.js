import { createProductModePolicy } from '../app/product-mode-policy.js';

/** The Viewer host measures layout; its active renderer owns canvas and camera. */
export function createMapHost({productMode = 'viewer', readOnly = true, projection = 'globe'} = {}) {
  const policy = createProductModePolicy(productMode, {readOnly, projection});
  let dependencies, host = null, ready = false, observer = null, resolution = null, resizeFrame = 0, viewRevision = 0, lastSignature = '', lastFrame = null;
  const element = () => dependencies.platform.$('map');
  const renderer = () => dependencies.rendering.mapRenderer;
  function connect(ports) {if (dependencies)throw new Error('map-host already connected'); dependencies = ports;}
  function projectionViewSnapshot({withGeographicBounds = true} = {}) {
    const state = dependencies.projectState.state, layout = dependencies.mapView.projectionLayoutMetrics(), camera = renderer().cameraSnapshot();
    const rotation = camera?[-camera.center[0], -camera.center[1], 0]:state.view.globeRotation.slice(), zoom = camera?camera.zoom:state.view.zoom;
    return {projection:state.projection, size:{...state.size}, dpr:renderer().getRenderPixelRatio(), sourceDpr:window.devicePixelRatio||1,
      safeInset:layout.safe, translate:[state.size.width/2,state.size.height/2],rotation,
      globeRotation:rotation.slice(), zoom, camera,
      geographicBounds:withGeographicBounds&&renderer().loaded?renderer().projection.geographicBounds():null};
  }
  function syncViewRevision({withGeographicBounds = true} = {}) {
    const snapshot = projectionViewSnapshot({withGeographicBounds});
    // Bounds are derived from the same camera identity; they do not own view revision.
    const {geographicBounds:ignoredBounds, ...identity} = snapshot;
    const signature = JSON.stringify(identity);
    if (lastSignature!==signature) {lastSignature = signature; viewRevision++;}
    const view = {...snapshot, revision:viewRevision}; window.__PANDOLAB_VIEW_REVISION__ = viewRevision; window.__PANDOLAB_VIEW_STATE__ = view; return view;
  }
  function prepareVisualFrame({frameId, withBounds = false} = {}) {
    const viewState = syncViewRevision({withGeographicBounds:withBounds});
    lastFrame = dependencies.renderFactories.createMapVisualFrame({frameId, viewRevision, projectGeneration:dependencies.domains.projectDomain.getGeneration(),
      projectionRevision:0, viewState, layoutSnapshot:dependencies.mapLayout.mapLayoutMetricsSnapshot,
      projectCoordinate:renderer().projection.projectCoordinate, projectVisibleCoordinate:renderer().projection.projectVisibleCoordinate});
    return lastFrame;
  }
  function syncMapHostFromState() {renderer().syncCameraFromState(); return dependencies.domains.renderingDomain.invalidateView('host-camera');}
  function attachMapOutput() {
    renderer().attach(element());
    // Preserve the browser inspection API without a second surface lifecycle.
    host = Object.freeze({
      getKind:() => 'pando',
      isReady:() => ready,
      getProjectionKind:() => policy.projection,
      getViewState:projectionViewSnapshot,
      setViewState(view) {
        policy.assertProjection(view?.projection);
        if (view?.view)dependencies.projectState.state.view = structuredClone(view.view);
        syncMapHostFromState(); return true;
      },
      getViewportSize:() => ({...dependencies.projectState.state.size, dpr:renderer().getRenderPixelRatio()}),
      project:coordinate => renderer().projection.projectVisibleCoordinate(coordinate),
      unproject:point => renderer().projection.screenToGeo(point),
      requestRepaint:reason => dependencies.domains.renderingDomain.invalidateView(reason),
      resize:() => queueMapResize('host'),
      dragBy:(dx, dy) => renderer().panBy(dx, dy),
      getDebugState:() => ({kind:'pando', ready, projection:policy.projection, viewRevision, frameId:lastFrame?.frameId, renderer:renderer().kind}),
    });
  }
  async function initializeMapHost() {
    await renderer().initialize();
    ready = true; document.body.dataset.mapHost = renderer().kind; window.__PANDOLAB_MAP_HOST__ = host; return true;
  }
  function queueMapResize(reason = 'layout') {
    if (resizeFrame)return;
    resizeFrame = requestAnimationFrame(() => {resizeFrame = 0; const layout = dependencies.projectionView.refreshMapLayoutMetrics(reason);
      dependencies.projectState.state.size = {width:layout.width, height:layout.height}; renderer().verifyLayout(); dependencies.domains.renderingDomain.invalidateViewport('resize');});
  }
  function watchResolution() {resolution?.removeEventListener('change', watchResolution); resolution = window.matchMedia?.('(resolution: '+(window.devicePixelRatio||1)+'dppx)'); resolution?.addEventListener('change', watchResolution, {once:true}); queueMapResize('resolution');}
  const viewportResize = () => {dependencies.workspaceUi.refreshMapSheetMetrics(); queueMapResize('visual-viewport');};
  function startMapResizeObserver() {observer = new ResizeObserver(() => queueMapResize('resize-observer')); observer.observe(element()); window.visualViewport?.addEventListener('resize', viewportResize); watchResolution();}
  function stopMapResizeObserver() {observer?.disconnect(); resolution?.removeEventListener('change', watchResolution); window.visualViewport?.removeEventListener('resize', viewportResize); if (resizeFrame)cancelAnimationFrame(resizeFrame); ready = false;}
  return Object.freeze({connect, attachMapOutput, initializeMapHost, prepareVisualFrame, projectionViewSnapshot, syncViewRevision, syncMapHostFromState,
    queueMapResize, startMapResizeObserver, stopMapResizeObserver, get mapHost() {return host;}, get viewRevision() {return viewRevision;}});
}
