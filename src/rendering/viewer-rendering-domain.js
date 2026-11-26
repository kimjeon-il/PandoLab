/** Schedule and publish the next drawn Viewer frame. */
export function createViewerRenderingDomain(options) {
  const {mapRenderer:renderer, selectionDomain, prepareView, labelResources} = options;
  let disposed = false, queued = false, frameId = 0, contentDirty = true, selectionDirty = true;
  let pendingPlaceViewport = null;
  const stats = {invalidations:0, visualFrameCommittedCount:0};
  function invalidate(reason = 'map-change', content = false) {
    if (disposed)return false;
    contentDirty||=content;
    selectionDirty||=content;
    stats.invalidations++; stats.lastReason = reason;
    if (!queued) {queued = true; requestAnimationFrame(render);}
    return true;
  }
  function preparePlacesForPublication() {
    const task = labelResources.preparePlaces();
    pendingPlaceViewport = task;
    task.then(() => {
      if (pendingPlaceViewport!==task||disposed)return;
      pendingPlaceViewport = null;
      if (renderer.labelZoomVisibility().places) {
        renderer.invalidateLabelContent({countries:false});
        invalidate('settled-place-viewport');
      }else if (renderer.isFramePreserved())invalidate('settled-place-viewport');
    }, error => {if (pendingPlaceViewport===task&&!disposed)renderer.failMapPreparation(error);});
  }
  function render() {
    queued = false;
    if (disposed||!renderer.loaded||renderer.getRuntimeState().webglContextLost)return;
    try {
      const frame = prepareView({frameId:++frameId});
      if (contentDirty) {contentDirty = false; preparePlacesForPublication();}
      if (selectionDirty) {selectionDirty = false; renderer.setSelection(selectionDomain.snapshot());}
      if (renderer.labelZoomVisibility().places&&renderer.isFramePreserved()&&pendingPlaceViewport!==null)return;
      const result = renderer.renderFrame(frame);
      if (result.deferred||!renderer.canPresentVisualFrame(frame, result)||!renderer.commitVisualFrame(frame))return;
      stats.visualFrameCommittedCount++;
      stats.lastCommittedVisualFrameId = frame.frameId;
    }catch (error) {renderer.failMapPreparation(error);}
  }
  const methods = {
    isPreparingTemporalFrame:() => renderer.getRuntimeState().temporalPresentationPending,
    invalidateView:reason => invalidate(reason, reason==='map-retry'),
    invalidateViewport:reason => {renderer.verifyLayout(); return invalidate(reason, true);},
    invalidateProject:reason => invalidate(reason, true),
    invalidateSelection:reason => {selectionDirty = true; return invalidate(reason);},
    invalidateLabels:reason => {renderer.invalidateLabelContent({countries:reason!=='document-month-labels'&&reason!=='builtin-places-ready', places:reason!=='formal-country-name-display'}); return invalidate(reason);},
    invalidateQuality:reason => invalidate(reason),
    invalidateOverlayStyle:reason => invalidate(reason, renderer.invalidatePresentationStyle?.()===true),
    beginInteraction() {labelResources.getState().mapMoving = true; labelResources.beginPlaceInteraction();},
    endInteraction(reason) {labelResources.getState().mapMoving = false; preparePlacesForPublication(); return invalidate(reason);},
    resetProjectGeneration(generation, presentation) {renderer.resetProjectRenderState({generation, ...presentation}); return invalidate('project-generation', true);},
    getStats:() => ({...stats, lastFrameId:frameId}), getDistributionRenderRows:options.getDistributionRenderRows,
    dispose() {disposed = true; labelResources.disposePlaces();},
  };
  return Object.freeze(methods);
}
