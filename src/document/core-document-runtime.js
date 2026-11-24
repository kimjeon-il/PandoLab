const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

/** ABI dispatch only; every mutation, validation and history entry is C++ owned. */
export function createDocumentSessionRuntime({ loadModule, validateFlagDataUrl, currentMonth = () => new Date().toISOString().slice(0,7) }) {
  if (typeof loadModule !== 'function' || typeof validateFlagDataUrl !== 'function' || typeof currentMonth !== 'function')
    throw new TypeError('The complete document module and current platform flag policy are required.');
  let sessionPromise = null;
  let queue = Promise.resolve();
  let disposed = false;
  function session() {
    if (!sessionPromise) sessionPromise = Promise.resolve().then(loadModule).then(module => {
      if (typeof module.DocumentSession !== 'function') fail('PL-CORE-DOCUMENT-ABI', 'The required whole-document C++ session export is missing.');
      return new module.DocumentSession({ validateFlagDataUrl });
    }).catch(error => {
      // Release only a failed admission; command errors never discard a live session.
      sessionPromise = null;
      throw error;
    });
    return sessionPromise;
  }
  function call(method, args, context, projectResult = result => result) {
    const result = queue.then(async () => {
      if (disposed) fail('PL-CORE-DISPOSED', 'Document session is disposed.');
      context.throwIfCancelled();
      const core = await session();
      context.throwIfCancelled();
      if (typeof core[method] !== 'function') fail('PL-CORE-DOCUMENT-ABI', `DocumentSession.${method} is required.`);
      return projectResult(core[method](...(typeof args === 'function' ? args() : args)),core);
    });
    queue = result.catch(() => {});
    return result;
  }
  function resolvedWorld(core,state) {
    if (!Number.isSafeInteger(state?.epoch) || typeof state.timelineCursor !== 'string'
      || typeof core.resolveWorld !== 'function') fail('PL-CORE-DOCUMENT-ABI','An epoch-pinned current C++ world is required.');
    return core.resolveWorld(state.timelineCursor,state.epoch);
  }
  function loadedResult(state,core) {
    for (const method of ['documentSnapshot','selectionSnapshot'])
      if (typeof core[method] !== 'function') fail('PL-CORE-DOCUMENT-ABI',`DocumentSession.${method} is required.`);
    return { state,project: core.documentSnapshot(),selection: core.selectionSnapshot(),
      world: resolvedWorld(core,state) };
  }
  return Object.freeze({
    // Publish the accepted load projection in this same Worker operation. A
    // second RPC could observe an intervening command or another document load.
    load: (payload, context) => call('documentLoad', () => [payload.storageJson, currentMonth()], context,loadedResult),
    baselineCoverage:(payload,context)=>call('baselineCoverage',[payload.baselineId,payload.month],context),
    loadBaseline: (payload,context) => call('documentLoadBaseline',() => [payload.baselineId,payload.setup],context,loadedResult),
    initialize: (payload,context) => call('documentInitialize',() => [{ ...payload,currentMonth: currentMonth() }],context,loadedResult),
    captureReplacement: (payload,context) => call('captureReplacement',[payload.expectedEpoch],context),
    rollbackReplacement: (payload,context) => call('rollbackReplacement',[payload.replacementId,payload.expectedEpoch],context,loadedResult),
    releaseReplacement: (payload,context) => call('releaseReplacement',[payload.replacementId],context),
    storageBaselineLoad: (payload,context) => call('storageBaselineLoad',[payload.baseline,payload.expectedEpoch],context,state => ({ state })),
    // Only WASM owns source bytes and candidate lifetime. No JS history or
    // temporal resolver is introduced by these ordered Worker calls.
    temporalSourcePrepare:(payload,context)=>call('temporalSourcePrepare',[payload],context),
    temporalSourceStats:(payload,context)=>call('temporalSourceStats',[],context),
    temporalSourceRelease:(payload,context)=>call('temporalSourceRelease',[payload],context),
    temporalCandidatePrepare:(payload,context)=>call('temporalCandidatePrepare',[payload],context),
    temporalCandidateInspect:(payload,context)=>call('temporalCandidateInspect',[payload],context),
    temporalCandidateDiscard:(payload,context)=>call('temporalCandidateDiscard',[payload],context),
    temporalCandidateAdopt:(payload,context)=>call('temporalCandidateAdopt',[payload],context,(result,core)=>{
      if(!result?.state||!Object.hasOwn(result,'delta'))
        fail('PL-CORE-DOCUMENT-ABI','Core adoption must identify its complete or delta projection.');
      if(result.delta===null)return loadedResult(result.state,core);
      if(typeof result.delta!=='object'||!Array.isArray(result.delta.geometries))
        fail('PL-CORE-DOCUMENT-ABI','Core temporal adoption requires its authoritative delta.');
      return {...result,selection:core.selectionSnapshot(),
        world:resolvedWorld(core,result.state)};
    }),
    resolveWorld: (payload, context) => call('resolveWorld', [payload.month, payload.expectedEpoch], context),
    geometryRequirements:(payload,context)=>call('geometryRequirements',[payload.month,payload.expectedEpoch],context),
    admitGeometryResources:(payload,context)=>call('admitGeometryResources',[payload.resources,payload.expectedEpoch,payload.month],context,result=>{
      if(result?.state?.epoch!==payload.expectedEpoch||!Array.isArray(result?.geometryDelta?.admitted)||!Array.isArray(result?.geometryDelta?.removed))
        fail('PL-CORE-DOCUMENT-ABI','Core resource admission requires an epoch-pinned reference receipt.');
      return result;
    }),
    setTimelineCursor: (payload, context) => call('setTimelineCursor', [payload.month, payload.expectedEpoch], context,
      result => {
        const delta=result?.worldDelta;
        if (!result?.state || !delta || delta.baseEpoch!==payload.expectedEpoch || delta.sourceEpoch!==result.state.epoch
          || delta.month!==result.state.timelineCursor || !Number.isSafeInteger(delta.entityCount) || delta.entityCount<0
          || !Array.isArray(delta.upserts) || !Array.isArray(delta.removed)
          || !Array.isArray(result.geometryDelta?.admitted)||result.geometryDelta.admitted.length
          || !Array.isArray(result.geometryDelta?.removed))
          fail('PL-CORE-DOCUMENT-ABI', 'The C++ cursor transition must return its own epoch-pinned world delta.');
        return result;
      }).catch(error => {
        // The Core world resolver rejects invalid precision before the cursor
        // setter runs. Keep the distinct cursor RPC error contract while C++
        // remains authoritative for all calendar validation.
        if (error?.code === 'PL-TEMPORAL-001')
          throw Object.assign(new Error('INVALID_TIMELINE_CURSOR: ' + error.message),
            { code: 'INVALID_TIMELINE_CURSOR', cause: error });
        throw error;
      }),
    selectionCatalogLoad: (payload, context) => call('selectionCatalogLoad', [payload.domain,payload.refs,payload.expectedEpoch], context),
    presentationCatalogLoad: (payload,context) => call('presentationCatalogLoad',[payload.catalog,payload.expectedEpoch],context),
    selectionApply: (payload, context) => call('selectionApply', [payload], context),
    selectionSnapshot: (payload, context) => call('selectionSnapshot', [], context),
    state: (payload, context) => call('projectState', [], context),
    async dispose() { disposed = true; await queue; if (sessionPromise) (await sessionPromise).delete(); },
  });
}
