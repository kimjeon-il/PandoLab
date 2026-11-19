import {requireProjectMonth} from "./project-setup.js";
import { createProductModePolicy } from "../app/product-mode-policy.js";

const cloneValue = value => {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch (_) { /* fall through */ }
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]));
};

/**
 * Owns the canonical project boundary without exposing the mutable object
 * returned by the host application.
 */
export function createProjectDomain({
  productMode,
  readOnly = productMode === 'viewer',
  replaceSnapshot = () => false,
  admitImportedProject = project => project,
  restoreReplacement = null,
  invalidateProject = () => {},
  reportDiagnostic = () => {},
  onProjectChanged = () => {},
  onProjectReset = () => {},
  onReplacementState = () => {},
  onReplacementCommitted = () => {},
  onReplacementError = () => {},
  commandOwner = null,
  documentModel = null,
  publishCommand = null,
  readBuiltinSelectionCatalogs,
  readPresentationCatalog = null,
} = {}) {
  if(productMode!=='viewer')throw new TypeError('Project domain requires viewer product mode.');
  createProductModePolicy(productMode,{readOnly});
  let generation = 0;
  let openRequest=0,opening=false,openQueue=Promise.resolve();
  let disposed = false;
  let replacing = false;
  let commandQueue = Promise.resolve();
  // One admitted C++ document is active irrespective of its input reader.
  // projectId identifies content; documentId and generation isolate a session.
  let activeProject=null;
  const currentActiveProject=()=>activeProject?Object.freeze({...activeProject,generation}):null;
  const activeProjectScope=()=>JSON.stringify([
    activeProject?.projectId||null,activeProject?.documentId||null,generation]);
  const timelineNavigation=()=>Object.freeze({
    ...currentActiveProject(),
    month:commandOwner?.state?.()?.timelineCursor||null,
    range:snapshot().projectSetup?.timelineRange||null,
    scope:activeProjectScope(),
  });
  function currentProject(project) {
    if (project && Object.hasOwn(project,'packageAssets')) throw Object.assign(new TypeError('Unsupported retired project attachments.'),{code:'PL-PROJECT-RETIRED-ASSETS'});
    return admitImportedProject(project);
  }

  const snapshot = () => {
    if (typeof documentModel?.snapshot!=='function') throw new TypeError('The accepted C++ document read model is required.');
    return documentModel.snapshot();
  };
  const emitChanged = (reason, detail = null) => {
    const event = Object.freeze({ generation, reason: String(reason || 'project-changed'), detail: cloneValue(detail) });
    onProjectChanged(event);
    return event;
  };
  const bumpGeneration = async (reason, detail = null) => {
    generation += 1;
    const event = { generation, reason: String(reason || 'project-reset') };
    if (detail && typeof detail === 'object') Object.assign(event, detail);
    await onProjectReset(Object.freeze(event));
    return generation;
  };
  const assertActive = () => {
    if (disposed) throw Object.assign(new Error('Project domain is disposed.'),
      { code: 'PL-CORE-CANCELLED', name: 'AbortError', cancelled: true });
  };

  const readmitBuiltinSelectionCatalogs = async ({replacingProject=false}={}) => {
    if(typeof readBuiltinSelectionCatalogs!=='function')throw new TypeError('The immutable platform builtin identity catalogs are required for document admission.');
    const catalogs=readBuiltinSelectionCatalogs();
    if(!Array.isArray(catalogs))throw new TypeError('Builtin selection catalogs must be explicit domain/ref records.');
    // A replacement may not inherit the previous project's transient water
    // and place references. Its own providers re-admit them after acceptance.
    for(const {domain,refs} of catalogs)
      await commandOwner.selectionCatalogLoad(domain,replacingProject?[]:refs);
  };

  // Startup promotion replaces data inside the current render generation. It
  // shares the application dispatch queue with commands and whole history;
  // only C++ admits the complete document or allocates a static feature source.
  const admit = (project,{ features,territorialSource,baselineId,preserveCursor = false,reason = 'project-admission',expectedGeneration = generation } = {}) => {
    const operation=commandQueue.then(async () => {
      assertActive();
      if (generation!==expectedGeneration || replacing)
        throw Object.assign(new Error('Document admission belongs to another project generation.'),{ code: 'PL-CORE-STALE' });
      if (typeof commandOwner?.load!=='function' || typeof commandOwner.initialize!=='function'
        || typeof documentModel?.snapshot!=='function' || typeof publishCommand!=='function')
        throw new TypeError('Document admission requires the canonical C++ owner and accepted read-model publisher.');
      const core = currentProject(project);
      const outcome=features===undefined && territorialSource===undefined && baselineId===undefined && !preserveCursor
        ? await commandOwner.load(JSON.stringify(core))
        : await commandOwner.initialize({ project: core,preserveCursor,...(features===undefined ? {} : { features }),
          ...(territorialSource===undefined ? {} : { territorialSource }),...(baselineId===undefined ? {} : { baselineId }) });
      await readmitBuiltinSelectionCatalogs();
      if(generation!==expectedGeneration || replacing)
        throw Object.assign(new Error('Document admission completed after project replacement.'),{ code: 'PL-CORE-STALE' });
      await publishCommand(outcome,{ expectedGeneration,reason });
      return documentModel.snapshot();
    });
    commandQueue=operation.catch(() => {});
    return operation;
  };

  const admitStorageBaseline = (baseline,{ expectedGeneration = generation } = {}) => {
    const operation=commandQueue.then(async () => {
      assertActive();
      if (generation!==expectedGeneration)
        throw Object.assign(new Error('Storage baseline admission crossed a project replacement.'),{ code: 'PL-CORE-STALE' });
      if (typeof commandOwner?.storageBaselineLoad!=='function' || typeof publishCommand!=='function')
        throw new TypeError('The canonical C++ storage baseline admission is required.');
      const result=await commandOwner.storageBaselineLoad(baseline);
      if(generation!==expectedGeneration)
        throw Object.assign(new Error('Storage baseline admission completed after project replacement.'),{ code: 'PL-CORE-STALE' });
      await publishCommand(result,{ expectedGeneration,reason: 'storage-baseline' });
      return result.state;
    });
    commandQueue=operation.catch(() => {});return operation;
  };
  // Detached native source and candidate creation share the Core
  // command queue but do not mutate the active document or generation.
  // No baseline admission occurs until the existing replacement transaction
  // has captured a reversible Core capsule.
  const prepareTemporalBuiltin = (facts,setup,{dataRevision,manifestSha256,transition=false,
    expectedGeneration = generation,isCurrent = () => true} = {}) => {
    const operation=commandQueue.then(async()=>{
      assertActive();
      const current=()=>!disposed&&!replacing&&generation===expectedGeneration&&isCurrent();
      const stale=()=>Object.assign(new Error('Temporal candidate belongs to an older project request.'),
        {code:'PL-CORE-STALE',name:'AbortError',cancelled:true});
      if(!current())throw stale();
      // A date change never rebuilds or re-identifies the accepted project.
      // Legacy transition requests must use the common C++ cursor instead.
      if(transition)throw Object.assign(
        new TypeError('Project date changes must reuse the accepted C++ timeline cursor.'),
        {code:'PL-TIMELINE-REPLACE-RETIRED'});
      if(typeof commandOwner?.temporalSourcePrepare!=='function'
        ||typeof commandOwner?.temporalCandidatePrepare!=='function')
        throw new TypeError('Core temporal source/candidate owner is required.');
      let source;
      const sourceEpoch=commandOwner.state()?.epoch;
      try {
        source=await commandOwner.temporalSourcePrepare(facts,{dataRevision,manifestSha256,isCurrent:current});
        if(!current())throw stale();
        // Only independent-document opening allocates another document identity.
        // Existing projects navigate dates by commandOwner.setTimelineCursor.
        const documentId=globalThis.crypto.randomUUID();
        const candidate=await commandOwner.temporalCandidatePrepare({
          sourceId:source.sourceId,targetMonth:facts.sourceMonth,
          sourceFingerprint:source.fingerprint,setup,documentId,
        },{isCurrent:current});
        if(!current())throw stale();
        if(candidate?.sourceId!==source.sourceId||candidate?.targetMonth!==facts.sourceMonth
          ||candidate?.sourceFingerprint!==facts.fingerprint
          ||!Number.isSafeInteger(candidate?.candidateId)||candidate.candidateId<1
          ||candidate.expectedEpoch!==commandOwner.state()?.epoch)
          throw Object.assign(new Error('Core temporal candidate receipt is not current.'),
            {code:'PL-CORE-RESPONSE'});
        return Object.freeze({kind:'temporal-candidate',setup,
          expectedGeneration,expectedEpoch:candidate.expectedEpoch,
          sourceId:source.sourceId,candidateId:candidate.candidateId,
          targetMonth:candidate.targetMonth,sourceFingerprint:candidate.sourceFingerprint,
          worldSha256:candidate.worldSha256});
      } catch(error) {
        if(source&&commandOwner.state()?.epoch===sourceEpoch)
          try {await commandOwner.temporalSourceRelease(source.sourceId);}
          catch(releaseError){try{reportDiagnostic({stage:'temporal-source-release',error:releaseError});}catch(_){}}
        throw error;
      }
    });
    commandQueue=operation.catch(()=>{});
    return operation;
  };
  const discardTemporalBuiltin = async prepared => {
    if(prepared?.kind!=='temporal-candidate'||disposed
      ||commandOwner?.state?.()?.epoch!==prepared.expectedEpoch)return false;
    try {await commandOwner.temporalCandidateDiscard(prepared.candidateId);}
    catch(error){try{reportDiagnostic({stage:'temporal-candidate-discard',error});}catch(_){}}
    try {await commandOwner.temporalSourceRelease(prepared.sourceId);}
    catch(error){try{reportDiagnostic({stage:'temporal-source-release',error});}catch(_){}}
    return true;
  };
  const notify = (reason, detail, invalidate) => {
    for (const [stage, action] of [
      ['event', () => emitChanged(reason, detail)],
      ['render', () => { if(invalidate)invalidate(reason); }],
    ]) {
      try { action(); } catch (error) {
        try { reportDiagnostic({ stage, reason, error }); } catch (_) { /* A diagnostic cannot undo a commit. */ }
      }
    }
  };
  const admitPresentationCatalog = catalog => {
    const expectedGeneration=generation;
    const operation=commandQueue.then(async () => {
      assertActive();
      if (generation!==expectedGeneration) throw Object.assign(new Error('Presentation admission crossed a project replacement.'),{ code: 'PL-CORE-STALE' });
      if (typeof commandOwner?.presentationCatalogLoad!=='function' || typeof publishCommand!=='function')
        throw new TypeError('Canonical C++ presentation catalog admission is required.');
      const outcome=await commandOwner.presentationCatalogLoad(catalog);
      await publishCommand(outcome,{ expectedGeneration,reason: 'presentation-catalog' });
      return outcome;
    });
    commandQueue=operation.catch(() => {});
    return operation;
  };
  const admitSelectionCatalog = (domain,refsProducerOrArray,{ expectedEpoch,expectedGeneration = generation } = {}) => {
    const operation=commandQueue.then(async () => {
      assertActive();
      if(generation!==expectedGeneration)throw Object.assign(new Error('Builtin selection admission crossed a project replacement.'),{ code: 'PL-CORE-STALE' });
      if(typeof commandOwner?.selectionCatalogLoad!=='function' || typeof publishCommand!=='function')
        throw new TypeError('Canonical C++ builtin identity admission is required.');
      const refs=typeof refsProducerOrArray==='function' ? refsProducerOrArray():refsProducerOrArray;
      const result=await commandOwner.selectionCatalogLoad(domain,refs,expectedEpoch);
      await publishCommand(result,{ expectedGeneration,reason: 'selection-catalog' });
      return result;
    });
    commandQueue=operation.catch(() => {});return operation;
  };
  const replaceAccepted = async (prepared, reason, {isCurrent=()=>true,presentation='default',onPresented}={}) => {
    assertActive();
    const requireCurrent=()=>{if(!isCurrent())throw Object.assign(new Error('Project opening was superseded.'),{code:'PL-CORE-STALE',name:'AbortError',cancelled:true});};
    requireCurrent();
    let checkpoint;
    const previousActiveProject=activeProject;
    let replacementStarted = false;
    let failure;
    let replacementResult;
    try {
      checkpoint = { replacementId: await commandOwner.captureReplacement() };
      replacementStarted = true;
      await onReplacementState(true, reason);
      const nextGeneration = await bumpGeneration(`project-${reason}`, presentation === 'temporal' ? {presentation,isCurrent,onPresented} : null);
      if(prepared.kind==='temporal-candidate') {
        requireCurrent();
        if(prepared.expectedGeneration!==nextGeneration-1
          ||!Number.isSafeInteger(prepared.candidateId)||prepared.candidateId<=0
          ||prepared.expectedEpoch!==commandOwner.state()?.epoch)
          throw Object.assign(new Error('The Core temporal candidate is not current.'),
            {code:'PL-CORE-STALE'});
        // Core adoption is non-interruptible; its acknowledgement, followed
        // by the existing read-model publisher, is the sole commit boundary.
        await commandOwner.temporalCandidateAdopt({
          candidateId:prepared.candidateId,sourceId:prepared.sourceId,
          targetMonth:prepared.targetMonth,sourceFingerprint:prepared.sourceFingerprint,
          worldSha256:prepared.worldSha256,replacementId:checkpoint.replacementId,
          expectedEpoch:prepared.expectedEpoch,
        });
      } else {
        if(!Number.isSafeInteger(prepared.baselineId)||prepared.baselineId<=0)throw new TypeError('A previously admitted Core builtin source handle is required.');
        await commandOwner.loadBaseline(prepared.baselineId,prepared.setup);
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
      const accepted=documentModel.snapshot();
      activeProject=Object.freeze({
        projectId:accepted.mapProjectIdentity?.projectId||null,
        documentId:typeof accepted.documentId==='string'?accepted.documentId:null,
        source:'builtin',
      });
      notify(`project-${reason}`, null, invalidateProject);
      onReplacementCommitted(reason);
      replacementResult=result;
    } catch (error) {
      failure=error;
      activeProject=previousActiveProject;
      if (replacementStarted && checkpoint !== undefined) {
        // Generations stay monotonic so failed replacement workers remain stale.
        try {
          const rollbackGeneration = await bumpGeneration('project-rollback',presentation==='temporal'?{presentation}:null);
          await commandOwner.rollbackReplacement(checkpoint.replacementId);
          if(restoreReplacement)await restoreReplacement(documentModel.snapshot(),rollbackGeneration,previousActiveProject);
        }
        catch (restoreError) {
          activeProject=null;
          error.restoreError = restoreError;
        }
      }
      if (replacementStarted) onReplacementError(error, reason);
    } finally {
      let cleanupError;
      try { if(checkpoint)await commandOwner.releaseReplacement(checkpoint.replacementId); }
      catch(error) { cleanupError=error; }
      replacing = false;
      try { if(replacementStarted)await onReplacementState(false,reason); }
      catch(error) { if(cleanupError)cleanupError.stateError=error;else cleanupError=error; }
      if(cleanupError) { if(failure)failure.cleanupError=cleanupError;else failure=cleanupError; }
    }
    if(failure)throw failure;
    return replacementResult;
  };
  const replace = async (serializedProject,reason,options) => {
    assertActive();
    if(replacing)throw new Error('Project replacement is already running.');
    replacing=true;
    try {
      const coreProject = currentProject(serializedProject);
      const operation=commandQueue.then(() => replaceAccepted(coreProject,reason,options));
      commandQueue=operation.catch(() => {});return await operation;
    } catch(error) { replacing=false;throw error; }
  };
  const open = async (read,{source='builtin',presentation='default',isCurrent:requestCurrent=()=>true,onPresented}={}) => {
    assertActive();
    if(source!=='builtin'||typeof read!=='function')throw new TypeError('Built-in project opening requires its asynchronous source reader.');
    const ticket=++openRequest,isCurrent=()=>!disposed&&ticket===openRequest&&requestCurrent();
    opening=true;
    try {
      const operation=openQueue.then(async()=>{
        if(!isCurrent())return false;
        let prepared;
        try {
          const value=await read();
          if(!value||typeof value!=='object'||Array.isArray(value)
            ||(value.kind!=='temporal-candidate'&&(!Number.isSafeInteger(value.baselineId)||value.baselineId<=0)))
            throw new TypeError('Builtin reader requires an admitted C++ source candidate or baseline.');
          prepared=value;
          if(!isCurrent())return false;
          await replace(prepared,'builtin',{isCurrent,presentation,onPresented});
          return isCurrent();
        } finally {
          // Candidate cleanup is independent of successful adoption. It also
          // covers superseded reads that never entered the transaction.
          if(prepared?.kind==='temporal-candidate')await discardTemporalBuiltin(prepared);
        }
      });
      openQueue=operation.catch(()=>{});
      return await operation;
    } catch(error) {
      if(!isCurrent()&&!error.restoreError)return false;
      throw error;
    } finally {if(isCurrent())opening=false;}
  };
  const resetRenderGeneration = reason => bumpGeneration(reason || 'render-reset');
  const dispose = () => {
    if(disposed)return;
    disposed = true;openRequest++;
  };

  const resolveWorld = async (month, options) => {
    assertActive();
    if (typeof commandOwner?.resolveWorld!=='function' || typeof documentModel?.projectWorld!=='function')
      throw new TypeError('Project timeline requires the same C++ document query and accepted read model.');
    const result=await commandOwner.resolveWorld(month,options);
    return documentModel.projectWorld(result,commandOwner.state().epoch);
  };

  return Object.freeze({
    snapshot,
    state: () => commandOwner.state(),
    activeProject:currentActiveProject,
    activeProjectScope,
    timelineNavigation,
    requireTimelineMonth:month=>requireProjectMonth(snapshot().projectSetup,month),
    resolveWorld,
    getGeneration: () => generation,
    isReplacing: () => replacing,
    admit,
    admitPresentationCatalog,
    admitSelectionCatalog,
    admitStorageBaseline,
    prepareTemporalBuiltin,
    discardTemporalBuiltin,
    open,
    getOpenRevision:()=>openRequest,
    isOpening:()=>opening,
    baselineCoverage:(baselineId,month)=>commandOwner.baselineCoverage(baselineId,month),
    resetRenderGeneration,
    dispose,
  });
}
