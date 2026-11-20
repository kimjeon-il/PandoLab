/** PointerTargets: extracted application responsibility.
 * Dependencies are explicitly wired once by the composition modules.
 * Mutable bindings stay local; exported accessors retain live identity.
 */
export function createPointerTargets() {
  let dependencies;
  let hoverPickFrame;
  let pendingHoverPick;
  let lastHoverPickPoint;
  let lastHoverPickViewRevision;
  let lastPickingRevision;
  let lastMapHover;
  let hoverPickSequence = 0;
  let pendingHoverRequests = 0;
  function connect(ports) {
    if (dependencies) throw new Error('pointer-targets already connected');
    dependencies = ports;
  }

  const obsoleteHoverError = error => error.cancelled || error.name === 'AbortError'
    || ['STALE_REVISION','PL-CORE-STALE','PL-CORE-CANCELLED','PL-WORKER-RPC-STALE'].includes(error.code);

  async function applyCountryHover(hit, sequence, clear = false) {
    pendingHoverRequests += 1;
    try {
      const generation = dependencies.domains.projectDomain.getGeneration(), viewRevision = dependencies.mapLayout.viewRevision;
      const nextRef = hit?.ref || null;
      const isCurrent = () => sequence === hoverPickSequence && generation === dependencies.domains.projectDomain.getGeneration()
        && (clear || (viewRevision === dependencies.mapLayout.viewRevision && !dependencies.projectState.state.mapMoving
          && !dependencies.projectState.state.projectReplacing));
      const before = dependencies.domains.selectionDomain.snapshot();
      const key = nextRef?.key || null;
      if (!clear && pendingHoverRequests === 1 && (before.hover?.key || null) === key
        && (key === null || lastMapHover?.key === key && lastMapHover.revision === before.hoverRevision)) return true;
      const accepted = await dependencies.rendering.mapRenderer.measureWork('highlight.core-hover', () =>
        dependencies.domains.selectionDomain.setHover(nextRef, { ...(clear ? {} : { source: 'map' }), isCurrent }));
      if (!accepted || !Object.hasOwn(accepted,'hover')) throw new TypeError('An accepted Core hover snapshot is required.');
      if (sequence !== hoverPickSequence || generation !== dependencies.domains.projectDomain.getGeneration()
        || (!clear && (viewRevision !== dependencies.mapLayout.viewRevision || dependencies.projectState.state.mapMoving))) return false;
      if ((accepted.hover?.key || null) !== key || (dependencies.domains.selectionDomain.snapshot().hover?.key || null) !== key) return false;
      if (!clear) lastMapHover = {key,revision:accepted.hoverRevision};
      return true;
    } catch (error) {
      if (!obsoleteHoverError(error)) dependencies.feedback.reportOperationError(error,'지도 hover를 갱신하지 못했습니다.','PL-MAP-HOVER-001',4200);
      return false;
    } finally { pendingHoverRequests -= 1; }
  }

  async function cancelCountryHoverPick({ clear = false } = {}) {
    const sequence = ++hoverPickSequence;
    if (hoverPickFrame) cancelAnimationFrame(hoverPickFrame);
    hoverPickFrame = 0;
    pendingHoverPick = null;
    lastHoverPickPoint = null;
    lastHoverPickViewRevision = -1;
    lastPickingRevision = null;
    lastMapHover = null;
    try {
      // A pending enter can still acknowledge after cancellation. Queue its
      // clear even when no hover has been accepted yet.
      if (clear && (pendingHoverRequests || dependencies.domains.selectionDomain.snapshot().hover))
        return await applyCountryHover(null,sequence,true);
      return false;
    } catch (error) {
      if (!obsoleteHoverError(error)) dependencies.feedback.reportOperationError(error,'지도 hover를 취소하지 못했습니다.','PL-MAP-HOVER-001',4200);
      return false;
    }
  }

  function queueCountryHoverPick(screenPoint, coord) {
    if (!screenPoint || !coord || dependencies.projectState.state.mapMoving) return;
    const renderer = dependencies.rendering.mapRenderer;
    if (lastHoverPickPoint && lastHoverPickViewRevision === dependencies.mapLayout.viewRevision
      && lastPickingRevision === renderer.getPickingRevision()
      && Math.hypot(screenPoint[0] - lastHoverPickPoint[0], screenPoint[1] - lastHoverPickPoint[1]) < 3) return;
    pendingHoverPick = { screenPoint: [...screenPoint], coord: [...coord], sequence: ++hoverPickSequence };
    if (hoverPickFrame) return;
    hoverPickFrame = requestAnimationFrame(async () => {
      hoverPickFrame = 0;
      const pending = pendingHoverPick;
      pendingHoverPick = null;
      try {
        if (!pending || dependencies.projectState.state.mapMoving) return false;
        lastHoverPickPoint = pending.screenPoint;
        lastHoverPickViewRevision = dependencies.mapLayout.viewRevision;
        lastPickingRevision = renderer.getPickingRevision();
        const generation = dependencies.domains.projectDomain.getGeneration();
        const refs = await renderer.measureWork('highlight.pick', () => dependencies.objectPicking.selectableObjectsAt(
          pending.screenPoint, pending.coord, { includeLabels: false, includeHydro: false }));
        if (pending.sequence !== hoverPickSequence || dependencies.projectState.state.projectReplacing
          || generation !== dependencies.domains.projectDomain.getGeneration()
          || dependencies.projectState.state.mapMoving
          || lastHoverPickViewRevision !== dependencies.mapLayout.viewRevision) return false;
        return await applyCountryHover(refs[0] ? { ref: refs[0] } : null,pending.sequence);
      } catch (error) {
        if (!obsoleteHoverError(error)) dependencies.feedback.reportOperationError(error,'지도 hover 대상을 찾지 못했습니다.','PL-MAP-HOVER-001',4200);
        return false;
      }
    });
  }


  function mapClickBlocked(event = dependencies.platform.d3.event) {
    if (dependencies.projectState.state.projectReplacing) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      return true;
    }
    if (event?.defaultPrevented) {
      event.stopPropagation?.();
      return true;
    }
    const suppression = dependencies.projectState.state.suppressNextMapClick;
    if (!suppression) return false;
    const eventPoint = Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)
      ? [event.clientX, event.clientY]
      : null;
    if (suppression.point && eventPoint && Math.hypot(eventPoint[0] - suppression.point[0], eventPoint[1] - suppression.point[1]) > 18) {
      return false;
    }
    dependencies.projectState.state.suppressNextMapClick = null;
    clearTimeout(suppressNextMapClick._timer);
    event?.preventDefault?.();
    event?.stopPropagation?.();
    return true;
  }

  function suppressNextMapClick(point = null, timeout = 450) {
    dependencies.projectState.state.suppressNextMapClick = {
      point: Array.isArray(point) ? [Number(point[0]), Number(point[1])] : null,
    };
    clearTimeout(suppressNextMapClick._timer);
    suppressNextMapClick._timer = setTimeout(() => {
      dependencies.projectState.state.suppressNextMapClick = null;
    }, timeout);
  }

  function initializeHoverPickFrame() {
    hoverPickSequence += 1;
    if (hoverPickFrame) cancelAnimationFrame(hoverPickFrame);
    (hoverPickFrame = 0);

    (pendingHoverPick = null);

    (lastHoverPickPoint = null);

    (lastHoverPickViewRevision = -1);
    lastPickingRevision = null;
    lastMapHover = null;
  }

  return Object.freeze({
    connect,
    initializeHoverPickFrame,
    get cancelCountryHoverPick() { return cancelCountryHoverPick; },
    get lastHoverPickPoint() { return lastHoverPickPoint; },
    get lastHoverPickViewRevision() { return lastHoverPickViewRevision; },
    get mapClickBlocked() { return mapClickBlocked; },
    get queueCountryHoverPick() { return queueCountryHoverPick; },
    get suppressNextMapClick() { return suppressNextMapClick; },
  });
}
