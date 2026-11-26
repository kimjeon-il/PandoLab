/** Owns open tickets, active document identity and reversible Core replacement. */
export function createProjectReplacement({
  commandOwner, documentModel, currentProject, enqueueCommand, assertActive, isDisposed, readGeneration,
  bumpGeneration, readmitBuiltinSelectionCatalogs, discardTemporalBuiltin, readPresentationCatalog,
  publishCommand, replaceSnapshot, restoreReplacement, notify, invalidateProject,
  onReplacementState, onReplacementCommitted, onReplacementError,
}) {
  let activeProject = null;
  let openRequest = 0, opening = false, openQueue = Promise.resolve();
  let replacing = false;
  const currentActiveProject = () => activeProject?Object.freeze({...activeProject, generation:readGeneration()}):null;
  const activeProjectScope = () => JSON.stringify([
    activeProject?.projectId||null, activeProject?.documentId||null, readGeneration()]);

  const replaceAccepted = async (prepared, reason, {isCurrent = () => true, presentation = 'default', onPresented} = {}) => {
    assertActive();
    const requireCurrent = () => {if (!isCurrent())throw Object.assign(new Error('Project opening was superseded.'), {code:'PL-CORE-STALE', name:'AbortError', cancelled:true});};
    requireCurrent();
    let checkpoint;
    const previousActiveProject = activeProject;
    let replacementStarted = false;
    let failure;
    let replacementResult;
    try {
      checkpoint = { replacementId: await commandOwner.captureReplacement() };
      replacementStarted = true;
      await onReplacementState(true, reason);
      const nextGeneration = await bumpGeneration(`project-${reason}`, presentation === 'temporal' ? {presentation, isCurrent, onPresented} : null);
      if (prepared.kind==='temporal-candidate') {
        requireCurrent();
        if (prepared.expectedGeneration!==nextGeneration-1
          ||!Number.isSafeInteger(prepared.candidateId)||prepared.candidateId<=0
          ||prepared.expectedEpoch!==commandOwner.state()?.epoch)
          throw Object.assign(new Error('The Core temporal candidate is not current.'),
            {code:'PL-CORE-STALE'});
        // Core adoption is non-interruptible; its acknowledgement, followed
        // by the existing read-model publisher, is the sole commit boundary.
        await commandOwner.temporalCandidateAdopt({
          candidateId:prepared.candidateId, sourceId:prepared.sourceId,
          targetMonth:prepared.targetMonth, sourceFingerprint:prepared.sourceFingerprint,
          worldSha256:prepared.worldSha256, replacementId:checkpoint.replacementId,
          expectedEpoch:prepared.expectedEpoch,
        });
      } else {
        if (!Number.isSafeInteger(prepared.baselineId)||prepared.baselineId<=0)throw new TypeError('A previously admitted Core builtin source handle is required.');
        await commandOwner.loadBaseline(prepared.baselineId, prepared.setup);
      }
      await readmitBuiltinSelectionCatalogs({replacingProject:true});
      if (readPresentationCatalog) {
        if (typeof readPresentationCatalog !== 'function' || typeof commandOwner?.presentationCatalogLoad !== 'function'
          || typeof publishCommand !== 'function')
          throw new TypeError('Project replacement requires the C++ presentation catalog owner.');
        const outcome = await commandOwner.presentationCatalogLoad(readPresentationCatalog());
        await publishCommand(outcome, { expectedGeneration: nextGeneration, reason: 'presentation-catalog' });
      }
      const result = await replaceSnapshot(documentModel.snapshot(), {
        reason, generation: nextGeneration, skipRenderReset: true,
      });
      if (result === false) throw new Error('Project replacement was rejected.');
      requireCurrent();
      const accepted = documentModel.snapshot();
      activeProject = Object.freeze({
        projectId:accepted.mapProjectIdentity?.projectId||null,
        documentId:typeof accepted.documentId==='string'?accepted.documentId:null,
        source:'builtin',
      });
      notify(`project-${reason}`, null, invalidateProject);
      onReplacementCommitted(reason);
      replacementResult = result;
    } catch (error) {
      failure = error;
      activeProject = previousActiveProject;
      if (replacementStarted && checkpoint !== undefined) {
        // Generations stay monotonic so failed replacement workers remain stale.
        try {
          const rollbackGeneration = await bumpGeneration('project-rollback', presentation==='temporal'?{presentation}:null);
          await commandOwner.rollbackReplacement(checkpoint.replacementId);
          if (restoreReplacement)await restoreReplacement(documentModel.snapshot(), rollbackGeneration, previousActiveProject);
        }
        catch (restoreError) {
          activeProject = null;
          error.restoreError = restoreError;
        }
      }
      if (replacementStarted) onReplacementError(error, reason);
    } finally {
      let cleanupError;
      try { if (checkpoint)await commandOwner.releaseReplacement(checkpoint.replacementId); }
      catch (error) { cleanupError = error; }
      replacing = false;
      try { if (replacementStarted)await onReplacementState(false, reason); }
      catch (error) { if (cleanupError)cleanupError.stateError = error; else cleanupError = error; }
      if (cleanupError) { if (failure)failure.cleanupError = cleanupError; else failure = cleanupError; }
    }
    if (failure)throw failure;
    return replacementResult;
  };
  const replace = async (serializedProject, reason, options) => {
    assertActive();
    if (replacing)throw new Error('Project replacement is already running.');
    replacing = true;
    try {
      const coreProject = currentProject(serializedProject);
      const operation = enqueueCommand(() => replaceAccepted(coreProject, reason, options));
      return await operation;
    } catch (error) { replacing = false; throw error; }
  };
  const open = async (read, {source = 'builtin', presentation = 'default', isCurrent:requestCurrent = () => true, onPresented} = {}) => {
    assertActive();
    if (source!=='builtin'||typeof read!=='function')throw new TypeError('Built-in project opening requires its asynchronous source reader.');
    const ticket = ++openRequest, isCurrent = () => !isDisposed()&&ticket===openRequest&&requestCurrent();
    opening = true;
    try {
      const operation = openQueue.then(async() => {
        if (!isCurrent())return false;
        let prepared;
        try {
          const value = await read();
          if (!value||typeof value!=='object'||Array.isArray(value)
            ||(value.kind!=='temporal-candidate'&&(!Number.isSafeInteger(value.baselineId)||value.baselineId<=0)))
            throw new TypeError('Builtin reader requires an admitted C++ source candidate or baseline.');
          prepared = value;
          if (!isCurrent())return false;
          await replace(prepared,'builtin', {isCurrent, presentation, onPresented});
          return isCurrent();
        } finally {
          // Candidate cleanup is independent of successful adoption. It also
          // covers superseded reads that never entered the transaction.
          if (prepared?.kind==='temporal-candidate')await discardTemporalBuiltin(prepared);
        }
      });
      openQueue = operation.catch (() => {});
      return await operation;
    } catch (error) {
      if (!isCurrent()&&!error.restoreError)return false;
      throw error;
    } finally {if (isCurrent())opening = false;}
  };
  return Object.freeze({
    activeProject:currentActiveProject, activeProjectScope, open,
    isReplacing:() => replacing, isOpening:() => opening, getOpenRevision:() => openRequest,
    invalidateOpenRequests:() => {openRequest++;},
  });
}
