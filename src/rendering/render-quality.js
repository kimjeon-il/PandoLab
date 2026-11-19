/** RenderQuality: extracted application responsibility.
 * Dependencies are explicitly wired once by the composition modules.
 * Mutable bindings stay local; exported accessors retain live identity.
 */
export function createRenderQuality() {
  let dependencies;
  let renderQualityController;
  let currentRenderQuality;
  let renderQualityApplyQueued;
  function connect(ports) {
    if (dependencies) throw new Error('render-quality already connected');
    dependencies = ports;
  }

  function applyAdaptiveRenderQuality({ refreshScene = false, reason = 'adaptive-render-quality' } = {}) {
    currentRenderQuality = renderQualityController.profile();
    dependencies.rendering.gpuMapRenderer.setRenderQuality(currentRenderQuality);
    if (refreshScene) dependencies.domains.renderingDomain?.invalidateQuality?.(reason);
    return currentRenderQuality;
  }

  function queueAdaptiveRenderQualityRefresh(reason = 'adaptive-render-quality') {
    if (renderQualityApplyQueued) return;
    renderQualityApplyQueued = true;
    dependencies.projectState.mapWorkScheduler.scheduleIdle('adaptive-render-quality', () => {
      renderQualityApplyQueued = false;
      applyAdaptiveRenderQuality({ refreshScene: true, reason });
    }, 80);
  }

  function syncResolvedInteractionStyle({ redraw = false } = {}) {
    (0, dependencies.selectionServices.setSelectionInteractionStyle)(dependencies.preferences.resolvedInteractionStyle);
    dependencies.rendering.gpuMapRenderer.setInteractionStyle?.(dependencies.preferences.resolvedInteractionStyle);
    if (redraw) {
      dependencies.domains.renderingDomain?.invalidateSelectionStyle?.('selection-style');
    }
    return dependencies.preferences.resolvedInteractionStyle;
  }

  function applyMapAppearanceChange({ reason = 'user-preferences', rerender = true } = {}) {
    syncResolvedInteractionStyle({ redraw: rerender });
    dependencies.rendering.gpuMapRenderer.invalidateCountryPalette({ base: true, emphasis: true }, reason);
    dependencies.rendering.gpuMapRenderer.invalidatePhysicalStyle(reason);
    if (rerender) dependencies.domains.renderingDomain.invalidateBaseScene(reason);
  }

  function initializeRenderQualityController() {
    (renderQualityController = (0, dependencies.mapFactories.createAdaptiveRenderQualityController)({
      deviceMemory: navigator.deviceMemory,
      hardwareConcurrency: navigator.hardwareConcurrency,
      saveData: navigator.connection?.saveData === true,
      devicePixelRatio: window.devicePixelRatio || 1,
    }));

    (currentRenderQuality = renderQualityController.profile());

    (renderQualityApplyQueued = false);
  }

  return Object.freeze({
    connect,
    initializeRenderQualityController,
    applyMapAppearanceChange,
    get applyAdaptiveRenderQuality() { return applyAdaptiveRenderQuality; },
    get currentRenderQuality() { return currentRenderQuality; },
    get queueAdaptiveRenderQualityRefresh() { return queueAdaptiveRenderQualityRefresh; },
    get renderQualityController() { return renderQualityController; },
    get syncResolvedInteractionStyle() { return syncResolvedInteractionStyle; },
  });
}
