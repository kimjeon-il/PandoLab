import { createWorkerRpcClient } from "../runtime/worker-rpc.js";
import {createVerifiedCoreWorker} from '../runtime/core-wasm-loader.js';
import {workerAssetUrl} from "../runtime/worker-asset-url.js";
import { createProductModePolicy } from "../app/product-mode-policy.js";

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const stateResponses = new Set(['core.document-state']);

/** Ordered transport only. Document validation and history stay in C++ Project. */
export function createCoreDocumentClient({
  productMode = 'viewer',
  readOnly = productMode === 'viewer',
  createWorker = () => createVerifiedCoreWorker(workerAssetUrl(new URL(readOnly
    ? '../workers/core-viewer-session-worker.js' : '../workers/core-session-worker.js', import.meta.url)), { type: 'module' }),
  onTransition = () => {},
} = {}) {
  const policy = createProductModePolicy(productMode,{readOnly});
  let currentState = null;
  let disposed = false;
  let queue = Promise.resolve();
  let geometryLoader=null;
  let documentGeneration=0;
  const staleGeometryReceipt=Symbol('stale geometry preparation');
  const geometryReceipts=new WeakMap();
  const verifiedResourceAdmissions=new WeakMap();
  const replacesDocument=new Set(['core.document-load','core.document-load-baseline','core.document-initialize',
    'core.storage-baseline-load','core.document-temporal-candidate-adopt','core.document-replacement-rollback']);
  const subscribers = new Set();
  const detachedOps = new Set([
    'core.document-temporal-source-prepare','core.document-temporal-source-stats',
    'core.document-temporal-source-release','core.document-temporal-candidate-prepare',
    'core.document-temporal-candidate-inspect','core.document-temporal-candidate-discard',
  ]);
  const speculativeOps = new Map([
    ['core.document-temporal-source-prepare',{id:'sourceId',release:'core.document-temporal-source-release'}],
    ['core.document-temporal-candidate-prepare',{id:'candidateId',release:'core.document-temporal-candidate-discard'}],
  ]);
  const cancelled = (code,message) => Object.assign(new Error(message),
    { code,name:'AbortError',cancelled:true });
  // After a lost reply the document state is unknown. Only load or initialize
  // can open a new session, since all other operations require currentState.
  const rpc = createWorkerRpcClient({ createWorker, isCurrent: () => true,
    onCrash: () => { currentState = null; } });
  function ordered(operation, payload, options = {}, requiresDocument = true, atomic = false, injectEpoch = requiresDocument, geometryReceipt = null) {
    const result = queue.then(async () => {
      policy.assertOperation(operation);
      if (disposed) throw Object.assign(new Error('The C++ document owner was disposed.'),
        { code: 'PL-CORE-CANCELLED', name: 'AbortError', cancelled: true });
      if (options.isCurrent && !options.isCurrent()) fail('PL-CORE-STALE', 'The request belongs to another project generation.');
      if (requiresDocument && !currentState) fail('PL-CORE-NOT-LOADED', 'The complete C++ document has not been loaded.');
      const speculative=speculativeOps.get(operation);
      if ((atomic || speculative) && options.signal?.aborted)
        throw cancelled('PL-CORE-CANCELLED','Document operation was cancelled before dispatch.');
      if(geometryReceipt&&(geometryReceipt.epoch!==currentState?.epoch||geometryReceipt.generation!==documentGeneration))
        return staleGeometryReceipt;
      const request = injectEpoch ? { ...payload,
        expectedEpoch: Object.hasOwn(payload, 'expectedEpoch') ? payload.expectedEpoch : currentState?.epoch ?? 0 } : payload;
      // A synchronous C++ confirm cannot be interrupted. Once dispatched, its
      // acknowledgement must update the read model even if the caller aborts.
      // A native commit cannot be interrupted. Likewise, speculative work
      // must receive its acknowledgement so that cancelled handles can be
      // explicitly released rather than leaking after a lost Worker result.
      const { result } = await rpc.request(operation, request, atomic || speculative
        ? { timeoutMs: 0 } : { signal: options.signal });
      if (disposed) throw Object.assign(new Error('The C++ document owner was disposed.'),
        { code: 'PL-CORE-CANCELLED', name: 'AbortError', cancelled: true });
      if (speculative && (options.signal?.aborted || options.isCurrent?.() === false)) {
        // Must not queue this release through ordered(): we already hold that
        // transport queue. Release in the same Worker session, after the
        // original native operation has returned, before reporting stale work.
        const sourceId=result?.[speculative.id];
        if (Number.isSafeInteger(sourceId) && sourceId>0) {
          await rpc.request(speculative.release,
            { [speculative.id]:sourceId,expectedEpoch:request.expectedEpoch },
            { timeoutMs:0 });
        }
        throw cancelled(options.signal?.aborted?'PL-CORE-CANCELLED':'PL-CORE-STALE',
          'Detached temporal source/candidate was superseded and released.');
      }
      // Detached C++ handles and inspection never publish a document
      // transition. The accepted adopt response alone publishes Core state.
      if (detachedOps.has(operation))
        return result;
      if(replacesDocument.has(operation))documentGeneration++;
      const next = stateResponses.has(operation) ? result : result?.state;
      if (next) {
        if (!Number.isSafeInteger(next.epoch) || next.epoch < 0) fail('PL-CORE-RESPONSE', 'A current document operation epoch is required.');
        currentState = Object.freeze({ ...next,...(Array.isArray(next.dirtyTerritorialIds)
          ? { dirtyTerritorialIds: Object.freeze([...next.dirtyTerritorialIds]) }: {}) });
      }
      try {
        onTransition(result, operation, payload, verifiedResourceAdmissions.get(payload));
        // Accepted read projections publish synchronously in this queue. A
        // subscriber must not dispatch and await another queued Core request.
        for (const listener of subscribers) listener(result, operation, payload);
      }
      catch (error) {
        // C++ may already have committed. A failed read-model publication
        // requires an explicit document reload before another mutation.
        currentState = null;
        throw error;
      }
      return result;
    });
    queue = result.catch(() => {});
    return result;
  }
  async function ensureGeometryResources(month,options={}){
    const generation=documentGeneration;
    const query=await ordered('core.document-geometry-requirements',{month},options);
    if(!Array.isArray(query?.resources)||!Number.isSafeInteger(query.sourceEpoch))fail('PL-CORE-RESPONSE','Core geometry requirements must be epoch-pinned.');
    const isCurrent=()=>!disposed&&documentGeneration===generation&&currentState?.epoch===query.sourceEpoch
      &&options.isCurrent?.()!==false&&!options.signal?.aborted;
    if(query.resources.length){
      if(typeof geometryLoader!=='function')fail('GEOMETRY_UNLOADED','Required immutable geometry loader is unavailable.');
      const resources=await geometryLoader(query.resources,{...options,isCurrent});
      if(!isCurrent())throw cancelled('PL-CORE-STALE','Geometry admission crossed a document or date request.');
      const admission={resources,expectedEpoch:query.sourceEpoch};
      verifiedResourceAdmissions.set(admission,query.resources);
      await ordered('core.document-geometry-admit',admission,{...options,isCurrent},true,true);
    }
    if(!isCurrent())throw cancelled('PL-CORE-STALE','Geometry admission crossed a document or date request.');
    const receipt=Object.freeze({});
    geometryReceipts.set(receipt,{month,epoch:query.sourceEpoch,generation});
    return receipt;
  }
  async function prepareTimelineGeometry(month,options={}){
    for(;;){
      const epoch=currentState?.epoch,generation=documentGeneration;
      try{return await ensureGeometryResources(month,options);}
      catch(error){
        if((error?.code!=='PL-CORE-STALE'&&error?.name!=='AbortError')||disposed||options.signal?.aborted
          ||options.isCurrent?.()===false||(currentState?.epoch===epoch&&documentGeneration===generation)||!currentState)throw error;
      }
    }
  }
  return Object.freeze({
    productMode: policy.productMode,
    readOnly: policy.readOnly,
    subscribeTransitions(listener) {
      if (typeof listener !== 'function') throw new TypeError('A Core acknowledgement subscriber is required.');
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    load: (storageJson, options) => ordered('core.document-load', { storageJson }, options, false, true),
    baselineCoverage:(baselineId,month,options)=>ordered('core.document-baseline-coverage',{baselineId,month},options),
    loadBaseline: (baselineId,setup,options) => ordered('core.document-load-baseline',{ baselineId,setup },options,true,true),
    initialize: (payload,options) => ordered('core.document-initialize',payload,options,false,true,true),
    captureReplacement: options => ordered('core.document-replacement-capture',{},options,true,true),
    rollbackReplacement: (replacementId,options) => ordered('core.document-replacement-rollback',{ replacementId },options,true,true),
    releaseReplacement: (replacementId,options) => ordered('core.document-replacement-release',{ replacementId },options,true,true),
    setGeometryLoader(loader){
      if(typeof loader!=='function')throw new TypeError('An immutable geometry resource loader is required.');
      geometryLoader=loader;return ()=>{if(geometryLoader===loader)geometryLoader=null;};
    },
    geometryRequirements:(month='',options)=>ordered('core.document-geometry-requirements',{month},options),
    admitGeometryResources:(resources,options)=>ordered('core.document-geometry-admit',{resources},options,true,true),
    prepareTimelineGeometry,
    storageBaselineLoad: (baseline,options) => ordered('core.storage-baseline-load',{ baseline },options,true,true),
    temporalSourcePrepare:(source,{dataRevision,manifestSha256,...options}={})=>
      ordered('core.document-temporal-source-prepare',{source,dataRevision,manifestSha256},options),
    temporalSourceStats:options=>ordered('core.document-temporal-source-stats',{},options),
    temporalSourceRelease:(sourceId,options)=>ordered('core.document-temporal-source-release',{sourceId},options,true,true),
    temporalCandidatePrepare:({sourceId,targetMonth,sourceFingerprint,setup=null,documentId=''},options)=>
      ordered('core.document-temporal-candidate-prepare',
        {sourceId,targetMonth,sourceFingerprint,setup,documentId},options),
    temporalCandidateInspect:(candidateId,options)=>ordered('core.document-temporal-candidate-inspect',{candidateId},options),
    temporalCandidateDiscard:(candidateId,options)=>ordered('core.document-temporal-candidate-discard',{candidateId},options,true,true),
    temporalCandidateAdopt:({candidateId,sourceId,targetMonth,sourceFingerprint,worldSha256,replacementId,expectedEpoch},options)=>
      ordered('core.document-temporal-candidate-adopt',
        {candidateId,sourceId,targetMonth,sourceFingerprint,worldSha256,replacementId,expectedEpoch},options,true,true),
    setTimelineCursor: async(month, options={}) => {
      try {
        let receipt=geometryReceipts.get(options.geometryPreparation);
        for(;;){
          if(receipt?.month!==month)receipt=geometryReceipts.get(await prepareTimelineGeometry(month,options));
          const accepted=await ordered('core.document-timeline-cursor',{month},options,true,true,true,receipt);
          if(accepted!==staleGeometryReceipt)return accepted;
          receipt=null;
        }
      } catch(error) {
        // Geometry admission queries happen before cursor dispatch. Preserve
        // the cursor API's rejection contract for invalid calendar precision.
        if(error?.code==='PL-TEMPORAL-001')
          throw Object.assign(new Error('INVALID_TIMELINE_CURSOR: '+error.message),
            {code:'INVALID_TIMELINE_CURSOR',cause:error});
        throw error;
      }
    },
    resolveWorld: (month, options) => ordered('core.document-resolve-world', { month }, options),
    projectState: options => ordered('core.document-state', {}, options),
    selectionCatalogLoad: (domain,refs,expectedEpoch,options) => ordered('core.document-selection-catalog',
      { domain,refs,...(expectedEpoch===undefined ? {}:{ expectedEpoch }) },options,true,true),
    presentationCatalogLoad: (catalog,options) => ordered('core.document-presentation-catalog',{ catalog },options,true,true),
    selectionApply: (payload, options) => ordered('core.document-selection-apply', payload, options, true, true),
    selectionSnapshot: options => ordered('core.document-selection-snapshot', {}, options),
    state: () => currentState,
    dispose: () => { if(disposed)return;disposed=true;geometryLoader=null;currentState = null; subscribers.clear(); rpc.stop(); },
  });
}
