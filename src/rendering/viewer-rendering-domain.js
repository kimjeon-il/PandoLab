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
    }, error => {
      if (pendingPlaceViewport!==task||disposed)return;
      pendingPlaceViewport = null;
      if (!renderer.getRuntimeState().mapReady)renderer.failMapPreparation(error);
      else renderer.reportAncillaryError(error,'날짜 전환 후 지명 데이터를 불러오지 못했습니다.','PL-THREE-PLACE-001');
    });
  }
  function render() {
    queued = false;
    if (disposed||!renderer.loaded||renderer.getRuntimeState().webglContextLost)return;
    try {
      const frame = prepareView({frameId:++frameId});
      if (contentDirty) {contentDirty = false; preparePlacesForPublication();}
      if (selectionDirty) {selectionDirty = false; renderer.setSelection(selectionDomain.snapshot());}
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
    invalidateLabels:reason => {
      renderer.invalidateLabelContent({countries:reason!=='document-month-labels'&&reason!=='builtin-places-ready', places:reason!=='formal-country-name-display'});
      if (reason==='document-month-labels'&&renderer.labelZoomVisibility().places)preparePlacesForPublication();
      return invalidate(reason);
    },
    invalidateQuality:reason => invalidate(reason),
    invalidateOverlayStyle:reason => invalidate(reason, renderer.invalidatePresentationStyle?.()===true),
    beginInteraction() {labelResources.beginPlaceInteraction();},
    endInteraction(reason) {preparePlacesForPublication(); return invalidate(reason);},
    resetProjectGeneration(generation, presentation) {renderer.resetProjectRenderState({generation, ...presentation}); return invalidate('project-generation', true);},
    getStats:() => ({...stats, lastFrameId:frameId}), getDistributionRenderRows:options.getDistributionRenderRows,
    dispose() {disposed = true; labelResources.disposePlaces();},
  };
  return Object.freeze(methods);
}
