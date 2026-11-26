/** Route renderer gestures and geographic hits into existing Core selection. */
export function createMapInputPresentation({renderer, initialized, ports}) {
  let disposed = false, lastPointer = null, hoverAfterMove = false, lastPickRevision = -1;
  const listeners = [];
  const report = error => ports.feedback.reportOperationError(error,'지도 입력을 적용하지 못했습니다.','PL-MAP-INPUT-001', 4200);
  const beginMovement = () => {ports.projectState.state.mapMoving = true; ports.objectPicking.closeObjectChooser(); ports.renderQuality.renderQualityController.beginInteraction('map-move'); ports.projectState.mapWorkScheduler.setInteractionActive(true); ports.pointerInteraction.cancelCountryHoverPick({clear:true}).catch (report);};
  const finishMovement = () => {ports.projectState.state.mapMoving = false; ports.renderQuality.renderQualityController.endInteraction('map-move'); ports.renderQuality.applyAdaptiveRenderQuality({refreshScene:false, reason:'map-move-end'}); ports.projectState.mapWorkScheduler.setInteractionActive(false); hoverAfterMove = !!lastPointer;};
  const pick = point => {
    if (renderer.canPickFrame?.()===false) {hoverAfterMove = true; return;}
    lastPickRevision = renderer.getPickingRevision();
    const coordinate = renderer.projection.screenToGeo(point);
    if (coordinate)ports.pointerInteraction.queueCountryHoverPick(point, coordinate);
    else ports.pointerInteraction.cancelCountryHoverPick({clear:true}).catch (report);
  };
  function listen(type, callback) {listeners.push(renderer.subscribeInput(type, callback));}
  function bindMapEvents() {initialized.then(() => {
    if (disposed)return;
    const container = renderer.inputElement();
    const blockReplacementInput = event => {
      if (!ports.projectState.state.projectReplacing)return;
      if (event.type==='keydown'&&!/^(Arrow|Page|Home|End)|^[+\-=]$/.test(event.key))return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    for (const type of ['pointerdown','mousedown','touchstart','wheel','dblclick','keydown']) {
      container.addEventListener(type, blockReplacementInput, {capture:true, passive:false});
      listeners.push(() => container.removeEventListener(type, blockReplacementInput, true));
    }
    listen('movestart', beginMovement); listen('moveend', finishMovement);
    listen('click', event => {
      if (renderer.isFramePreserved()||renderer.canPickFrame?.()===false||ports.projectState.state.projectReplacing||ports.pointerInteraction.mapClickBlocked())return;
      ports.objectPicking.handleObjectSelectionAt(event.point, {sourceEvent:event.originalEvent}).catch (report);
    });
    listen('mousemove', event => {if (ports.surfaces.isMobile()||ports.projectState.state.projectReplacing)return;
      lastPointer = event.point;
      if (renderer.isFramePreserved()||ports.projectState.state.mapMoving)return;
      hoverAfterMove = false;
      pick(lastPointer);
    });
    listen('render', () => {
      if ((!hoverAfterMove&&lastPickRevision===renderer.getPickingRevision())||renderer.isFramePreserved()||ports.projectState.state.mapMoving||ports.projectState.state.projectReplacing)return;
      hoverAfterMove = false;
      if (lastPointer)pick(lastPointer);
    });
    listen('mouseout', () => {lastPointer = null; hoverAfterMove = false; ports.pointerInteraction.cancelCountryHoverPick({clear:true}).catch (report);});
  }).catch (report);}
  return Object.freeze({bindMapEvents, beginMovement, finishMovement, dispose() {disposed = true; listeners.forEach(remove => remove()); ports.pointerInteraction.cancelCountryHoverPick({clear:true}).catch (report);}});
}
