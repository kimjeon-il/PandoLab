// One renderer-independent owner for temporal map admission and accepted-frame waiters.
// GPU resources, pixel buffers and canonical document state remain with their existing owners.
export function createMapPresentationSession({
  getGeneration, getContextRevision, isDisposed, getReadiness,
  invalidateFrame, prepareContentKey, sameContentKey=(a,b)=>a===b, isImmutableContentKey=()=>false, isProjectBlocked,
  isRecoveryFrameAdmissible, onTemporalFailure = () => {},
  onTemporalRetired = () => {}, onTemporalAdmitted = () => {}, waitForCanonicalFrame,
  now=()=>performance.now(),
}) {
  const mapWaiters = new Set();
  let committedGeneration = -1;
  let temporalTicket = null;
  let viewSequence = 0;
  let checkedTicket=null,checkedContent=null,checkedExpected=null,checkedMatch=false;
  const abortError = reason => Object.assign(new Error(reason), { name: 'AbortError', cancelled: true });
  const temporalPending = () => !!temporalTicket && !temporalTicket.presented;

  // Preparing a dated LOD precedes presentation. Waiting for the displayed
  // frame here would deadlock a capped source that needs that LOD to paint.
  function matchesCountryContent(ticket,content){
    const expected=ticket.countryContent;
    if(expected===content)return true;
    // The controller supplies immutable content identities. Never rescan the
    // same frozen pair on every deferred frame approval.
    const cacheable=isImmutableContentKey(expected)&&isImmutableContentKey(content);
    if(cacheable&&checkedTicket===ticket&&checkedExpected===expected&&checkedContent===content)return checkedMatch;
    const match=sameContentKey(expected,content);
    if(cacheable){checkedTicket=ticket;checkedExpected=expected;checkedContent=content;checkedMatch=match;}
    return match;
  }
  function countrySourceAdmitted(content) {
    if (!temporalPending()) return true;
    return !temporalTicket.error && temporalTicket.sourceAdmitted !== false
      && temporalTicket.isCurrent() && temporalTicket.generation === getGeneration()
      && temporalTicket.context === getContextRevision()
      && (temporalTicket.kind !== 'view' || temporalTicket.countryContent !== null
        && matchesCountryContent(temporalTicket,content));
  }

  function rejectMapPresentationWaiters(error) {
    for (const waiter of mapWaiters) waiter.reject(error);
    mapWaiters.clear();
  }
  function retireTicketWaiters(ticket) {
    for(const waiter of mapWaiters)if(waiter.ticket===ticket){mapWaiters.delete(waiter);waiter.resolve(false);}
  }
  function settleMapPresentationWaiters() {
    if (temporalPending() || !getReadiness().mapReady) return false;
    const generation = getGeneration();
    committedGeneration = generation;
    for (const waiter of mapWaiters) {
      if (waiter.generation !== generation) continue;
      if(waiter.ticket&&waiter.ticket!==temporalTicket){mapWaiters.delete(waiter);waiter.resolve(false);continue;}
      mapWaiters.delete(waiter);
      waiter.resolve(true);
    }
    return true;
  }
  function waitForMapPresentation(generation,ticket=null) {
    if (isDisposed() || Number(generation) !== getGeneration())
      return Promise.reject(abortError('Project map presentation was superseded.'));
    if (temporalPending() && temporalTicket.error) return Promise.reject(temporalTicket.error);
    if (!temporalPending() && committedGeneration === getGeneration() && getReadiness().mapReady)
      return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      mapWaiters.add({ generation, ticket, resolve, reject });
      invalidateFrame('await-current-map-frame');
    });
  }
  function beginTemporalViewTransition(isCurrent = () => true, onPresented = () => {}) {
    if(temporalTicket)retireTicketWaiters(temporalTicket);
    checkedTicket=checkedContent=checkedExpected=null;
    const token = ++viewSequence;
    temporalTicket = {
      kind: 'view', countryContent: null, token, generation: getGeneration(),
      context: getContextRevision(), isCurrent: () => !isDisposed()
        && token === viewSequence && isCurrent(),
      onPresented, presented: false, sourceAdmitted: false,
      admissionRequested:false,preparations:null,preparationStartedAt:null,preparationFinishedAt:null,
      error: null, frameId: null,
    };
    return token;
  }
  function admitTemporalViewTransition(token,{country=null,physical=null}={}) {
    const ticket=temporalTicket;
    if(!temporalPending()||ticket.token!==token||!ticket.isCurrent())return false;
    if(ticket.admissionRequested)return true;
    ticket.admissionRequested=true;
    if(ticket.error)return true;
    const tasks=Object.entries({country,physical}).filter(([,task])=>task!=null);
    ticket.preparationStartedAt=now();
    ticket.preparations=Object.fromEntries(tasks.map(([name])=>[name,{status:'pending',elapsedMs:null}]));
    const live=()=>ticket===temporalTicket&&ticket.isCurrent()&&!ticket.presented&&!ticket.error
      &&ticket.generation===getGeneration();
    const accept=()=>{
      if(!live()||Object.values(ticket.preparations).some(row=>row.status!=='ready'))return;
      ticket.preparationFinishedAt=now();
      try{
        ticket.sourceAdmitted=true;
        onTemporalAdmitted(ticket);
        invalidateFrame('temporal-source-admitted');
      }catch(error){failTemporalPresentation(error);}
    };
    for(const [name,task] of tasks)Promise.resolve(task).then(value=>{
      if(!live()){
        if(ticket===temporalTicket&&!ticket.isCurrent())retireTicketWaiters(ticket);
        return;
      }
      const row=ticket.preparations[name];
      row.elapsedMs=Math.max(0,now()-ticket.preparationStartedAt);
      if(name==='country'&&value!==true){
        row.status='failed';failTemporalPresentation(Error('Country source preparation did not complete.'));return;
      }
      row.status='ready';accept();
    },error=>{
      if(!live()){
        if(ticket===temporalTicket&&!ticket.isCurrent())retireTicketWaiters(ticket);
        return;
      }
      const row=ticket.preparations[name];row.status='failed';row.elapsedMs=Math.max(0,now()-ticket.preparationStartedAt);
      failTemporalPresentation(error);
    });
    if(!tasks.length)accept();
    return true;
  }
  function temporalPreparationStats(){
    const ticket=temporalTicket;
    if(!ticket?.preparations)return null;
    return {token:ticket.token,sourceAdmitted:ticket.sourceAdmitted,
      tasks:Object.fromEntries(Object.entries(ticket.preparations).map(([name,row])=>[name,{...row}])),
      joinElapsedMs:ticket.preparationFinishedAt===null?null:Math.max(0,ticket.preparationFinishedAt-ticket.preparationStartedAt)};
  }
  async function prepareTemporalCountrySource(features) {
    const ticket = temporalTicket;
    if (!temporalPending() || ticket.kind !== 'view' || ticket.countryContent !== null) return true;
    const isCurrent = () => ticket === temporalTicket && ticket.isCurrent();
    // Content identity (not the project generation alone) admits a dated mesh.
    const content = await prepareContentKey(features, isCurrent);
    if (content === null || !isCurrent()) return false;
    ticket.countryContent = content;
    return true;
  }
  function finishTemporalViewTransition(token) {
    if (temporalTicket?.token !== token) return false;
    if (!temporalTicket.presented) {
      retireTicketWaiters(temporalTicket);
      temporalTicket = null;
      onTemporalRetired();
      invalidateFrame('temporal-source-rejected');
    }
    return true;
  }
  function canPresentVisualFrame(frame, result = null) {
    if (!frame || frame.projectGeneration !== getGeneration()
      || isProjectBlocked() || temporalTicket?.sourceAdmitted === false) return false;
    // A completed GPU submission must match the visual frame it certifies.
    // No-result checks are for preparatory reads or reuse of an admitted camera.
    if (result != null && (result.succeeded !== true || result.presentationReady === false
      || result.deferred || result.preserved
      || result.frameId !== frame.frameId
      || result.viewRevision !== frame.viewRevision
      || result.projectionRevision !== frame.projectionRevision)) return false;
    if (!isRecoveryFrameAdmissible(frame)) return false;
    if (!temporalPending()) return true;
    return !temporalTicket.error && temporalTicket.isCurrent()
      && temporalTicket.generation === getGeneration()
      && frame?.projectGeneration === getGeneration()
      && temporalTicket.context === getContextRevision()
      && temporalTicket.frameId != null && temporalTicket.frameId === frame?.frameId;
  }
  function failTemporalPresentation(error) {
    if (!temporalPending()||temporalTicket.error) return;
    temporalTicket.error = error;
    temporalTicket.sourceAdmitted=false;
    // The date change awaits the generation's certified visible frame. A
    // Worker error must reject that waiter immediately so the caller can
    // restore its prior C++ cursor instead of hanging behind a failed ticket.
    rejectMapPresentationWaiters(error);
    onTemporalFailure(error);
  }
  function waitForTemporalPresentation(token) {
    if(token!==undefined&&temporalTicket?.token!==token)return Promise.resolve(false);
    if (!temporalPending()) return Promise.resolve(true);
    if (temporalTicket.error) return Promise.reject(temporalTicket.error);
    if (!temporalTicket.isCurrent())return Promise.resolve(false);
    return temporalTicket.kind==='view'?waitForMapPresentation(getGeneration(),temporalTicket):waitForCanonicalFrame();
  }
  // A restored GPU context needs a new draw for the same live date ticket.
  function rebaseContext() {
    if (!temporalPending() || !temporalTicket.isCurrent()
      || temporalTicket.generation !== getGeneration()) return false;
    temporalTicket.context = getContextRevision();
    temporalTicket.frameId = null;
    return true;
  }
  function markTemporalFrame(frame) {
    if (temporalPending()) temporalTicket.frameId = frame.frameId;
  }
  function commitVisualFrame(frame,publish=null) {
    if (!canPresentVisualFrame(frame)) return false;
    // Publish renderer-owned camera/picking state before notifying clients.
    publish?.();
    if (temporalPending()) {
      const ticket = temporalTicket;
      ticket.presented = true;
      onTemporalRetired();
      ticket.onPresented();
    }
    if (frame?.projectGeneration === getGeneration()) settleMapPresentationWaiters();
    return true;
  }
  function resetForProject({ presentation = 'default', isCurrent = () => true, onPresented = () => {} } = {}) {
    checkedTicket=checkedContent=checkedExpected=null;
    rejectMapPresentationWaiters(abortError('Project replaced before its map was presented.'));
    committedGeneration = -1;
    temporalTicket = presentation === 'temporal'
      ? { kind: 'replacement', generation: getGeneration(), context: getContextRevision(),
        isCurrent, onPresented, presented: false, error: null, frameId: null }
      : null;
  }
  function dispose() {
    temporalTicket = null;
    checkedTicket=checkedContent=checkedExpected=null;
    rejectMapPresentationWaiters(abortError('Renderer disposed before map publication.'));
    committedGeneration = -1;
  }
  return Object.freeze({
    get ticket() { return temporalTicket; },
    get pendingMapWaiterCount() { return mapWaiters.size; },
    temporalPending, countrySourceAdmitted, beginTemporalViewTransition, admitTemporalViewTransition,temporalPreparationStats,
    prepareTemporalCountrySource, finishTemporalViewTransition,
    canPresentVisualFrame, failTemporalPresentation, waitForTemporalPresentation,
    waitForMapPresentation, rejectMapPresentationWaiters, settleMapPresentationWaiters,
    rebaseContext, markTemporalFrame, commitVisualFrame, resetForProject, dispose,
  });
}
