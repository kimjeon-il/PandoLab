import { presentViewerLoadStatus } from './viewer-load-status.js';
import { createProjectMonthClock } from '../document/project-month-clock.js';
import { territorialMembershipDelta } from '../document/territorial-entity-store.js';
import { installTimelineControls } from '../ui/timeline-controls.js';

/** Owns the Viewer date-control, C++ cursor transition, and temporal recovery flow. */
export function createViewerTimelineComposition({
  document, window, map, projectDomain, activeSession, owners, status, preferencePresentation,
  postPresentation, openBuiltinProject, search, syncStatus, report, getPresentedMonth, setPresentedMonth,
}) {
  const applyDocumentMonth = async(month, {
    isCurrent = () => true, waitForFrame = false, admitPresentation = null, geometryPreparation,
  } = {}) => {
    projectDomain.requireTimelineMonth(month);
    const before = map.features(), generation = projectDomain.getGeneration();
    const previousMonth = activeSession.commandOwner.state().timelineCursor;
    await map.renderer.measureWork('core.timeline-cursor',
      () => activeSession.commandOwner.setTimelineCursor(month, {isCurrent, geometryPreparation}));
    if (!isCurrent()||projectDomain.getGeneration()!==generation)return false;
    if (before!==map.features()&&territorialMembershipDelta(before, map.features()).changed)
      await map.objectCatalog.pruneLayerItemVisibility();
    if (!isCurrent()||projectDomain.getGeneration()!==generation)return false;
    await Promise.all([
      map.update({previousMonth}),
      waitForFrame&&map.viewState.layerVisibility.labels!==false?owners.territorialLabels.preparePlaces():null,
    ]);
    if (!isCurrent()||projectDomain.getGeneration()!==generation)return false;
    if (admitPresentation?.()===false)return false;
    if (waitForFrame)await map.renderer.waitForMapPresentation(generation);
    if (!isCurrent()||projectDomain.getGeneration()!==generation)return false;
    search();
    syncStatus();
    return true;
  };

  const changeProjectCursor = async(month, {isCurrent, commit}) => {
    projectDomain.requireTimelineMonth(month);
    const scope = projectDomain.activeProjectScope(), accepted = getPresentedMonth();
    const previous = accepted?.scope===scope?accepted.month:activeSession.commandOwner.state().timelineCursor;
    const current = () => isCurrent()&&scope===projectDomain.activeProjectScope()&&!projectDomain.isOpening();
    const previouslyReady = accepted?.scope===scope||status.dataset.ready==='true';
    let committed = false;
    const temporalTicket = map.renderer.beginTemporalViewTransition(current, () => {committed = commit();});
    status.dataset.loadingKind = 'temporal';
    status.dataset.ready = 'false';
    presentViewerLoadStatus(status,'다음 시점 준비 중…');
    try {
      let preparing = true, geometryPreparation;
      const preparationCurrent = () => preparing&&current();
      try {
        geometryPreparation = await map.prepareTimelineView(month, {
          isCurrent:preparationCurrent, activeProject:projectDomain.activeProject(),
        });
      } finally {preparing = false;}
      if (!current())return false;
      map.renderer.preserveTemporalFrame();
      if (!await applyDocumentMonth(month, {
        isCurrent:current, waitForFrame:true, geometryPreparation,
        admitPresentation:() => map.renderer.admitTemporalViewTransition(temporalTicket),
      }))return false;
      if (!current()||!committed)return false;
      status.dataset.ready = 'true';
      presentViewerLoadStatus(status,'지도 준비 완료.');
      postPresentation.schedule(current);
      return true;
    } catch (error) {
      if (current()) {
        if (previous&&(activeSession.commandOwner.state().timelineCursor!==previous||map.renderer.isFramePreserved())) {
          const restoreTicket = map.renderer.beginTemporalViewTransition(current);
          try {
            map.renderer.preserveTemporalFrame();
            map.renderer.retryMapPreparation();
            await map.preparePhysicalContext(previous, {
              isCurrent:current, activeProject:projectDomain.activeProject(),
            });
            if (!current())return false;
            const restored = await applyDocumentMonth(previous, {
              isCurrent:current, waitForFrame:true,
              admitPresentation:() => map.renderer.admitTemporalViewTransition(restoreTicket),
            });
            if (!restored)throw new Error('Previous dated map was not restored.');
          } catch (restoreError) {error.restoreError = restoreError;}
          finally {map.renderer.finishTemporalViewTransition(restoreTicket);}
        }
        status.dataset.ready = String(previouslyReady&&!error.restoreError);
      }
      throw error;
    } finally {map.renderer.finishTemporalViewTransition(temporalTicket);}
  };

  let clock;
  const disposeControls = installTimelineControls({
    document, window,
    getMonth:() => {
      const accepted = getPresentedMonth();
      return accepted&&(projectDomain.isOpening()||accepted.scope===projectDomain.activeProjectScope())
        ?accepted.month:activeSession?.commandOwner.state().timelineCursor||null;
    },
    getRange:() => projectDomain.timelineNavigation().range,
    isPending:() => clock?.isPending()===true,
    setMonth:async month => {
      if (projectDomain.isOpening())throw new Error('지도를 여는 중입니다.');
      return clock.selectMonth(month);
    },
  });
  clock = createProjectMonthClock({
    coalesceRequests:true, window, document,
    onPendingChange:() => window.dispatchEvent(new CustomEvent('pandolab:timeline-pending')),
    initialAutomatic:preferencePresentation.current.timeline.defaultWorldFollowCurrentMonth,
    canFollow:() => !projectDomain.isOpening()
      &&(!projectDomain.activeProject()||projectDomain.activeProject().source==='builtin'),
    onFollowChange:(automatic, {mode}) => {
      if (mode==='follow'||projectDomain.activeProject()?.source==='builtin') {
        const current = preferencePresentation.current;
        preferencePresentation.apply({...current,
          timeline:{...current.timeline, defaultWorldFollowCurrentMonth:automatic}},
          {rerender:false, reason:'default-world-follow'});
      }
    },
    applyMonth:async(month, {isCurrent, commit, mode}) => {
      const active = projectDomain.activeProject();
      if (mode==='startup'||(mode==='follow'&&active?.source!=='builtin')) {
        const opened = await openBuiltinProject(month, isCurrent);
        return opened&&commit();
      }
      if (!active)return false;
      return changeProjectCursor(month, {isCurrent, commit});
    },
    onCommitted:() => {
      setPresentedMonth({scope:projectDomain.activeProjectScope(),
        month:activeSession.commandOwner.state().timelineCursor});
      syncStatus();
      window.dispatchEvent(new CustomEvent('pandolab:project-changed'));
    },
    onError:report,
  });
  return Object.freeze({clock, disposeControls});
}
