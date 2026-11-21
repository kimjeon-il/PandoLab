import { createWorkerRpcClient } from "../runtime/worker-rpc.js";
import { createLatestWorkerJobScheduler, createWorkerCancellationError } from "../runtime/worker-job-scheduler.js";
import { isBuiltinPlaceId, normalizePlace, PLACE_LIMITS } from "../document/place-contract.js";
import { resourceKey, resourceUpdate } from "../runtime/resource-dependency-policy.js";
import { placeLabelRowsAtMonth } from "./place-name-policy.js";
import { indexPlaceUrbanLifetimes,placeUrbanLabelActiveAtMonth } from "./place-lifetime-policy.js";
import { createExternalRuntimeDataFetch } from './external-runtime-data.js';
const EMPTY = Object.freeze({ revision: 0, signature: 'empty', records: Object.freeze([]) });

/** Canonical owner of the builtin label snapshot and Worker lifecycle. */
export function createPlaceRuntime({ manifestUrl = new URL('../../data/places/manifest.json', import.meta.url).href, createWorker = null, rpc = null, onSnapshot = () => {}, onError = () => {}, onSettled = () => {}, getProtectedIds = () => [],getPresentation=()=>null,admitReferences,urbanLifetimes=null,loadUrbanLifetimes=null,urbanLifetimesUrl=new URL('../../data/places/urban-lifetimes-v1.json',import.meta.url).href } = {}) {
  if (typeof manifestUrl !== 'string' || !manifestUrl) throw new TypeError('Place manifest URL must be a nonempty string');
  if(typeof admitReferences!=='function')throw new TypeError('Place publication requires its accepted identity admission boundary.');
  let snapshot=EMPTY, revision=0, projectEpoch=0, moving=false, closed=false, desired=null, requestedDependencies=null, snapshotDependencies=null, referenceSequence=0;
  let admittedReferenceKey=null;
  let viewportTask=null,viewportContext=null;
  let lifetimeIndex=urbanLifetimes?indexPlaceUrbanLifetimes(urbanLifetimes):null;
  let lifetimeTask=null;
  const lifetimeUrl=urbanLifetimesUrl;
  async function ensureUrbanLifetimes(){
    if(lifetimeIndex)return lifetimeIndex;
    // Synthetic RPCs run without a mounted external library; tests injecting
    // urbanLifetimes/loadUrbanLifetimes still exercise the exact product rules.
    if(rpc&&!loadUrbanLifetimes)return null;
    if(!lifetimeTask)lifetimeTask=(async()=>{
      const value=loadUrbanLifetimes?await loadUrbanLifetimes():await(async()=>{
        const response=await createExternalRuntimeDataFetch({meta:globalThis.PANDOLAB_BUILD_META})(lifetimeUrl);
        if(!response.ok)throw new Error('Place-lifetime library HTTP '+response.status);
        const length=Number(response.headers.get('Content-Length')||0);
        if(length>256*1024)throw new RangeError('Place-lifetime policy exceeds byte budget');
        const body=await response.text();
        if(body.length>256*1024)throw new RangeError('Place-lifetime policy exceeds byte budget');
        return JSON.parse(body);
      })();
      lifetimeIndex=indexPlaceUrbanLifetimes(value);
      return lifetimeIndex;
    })().catch(error=>{lifetimeTask=null;throw error;});
    return lifetimeTask;
  }
  const retained=new Map();
  let publication=Promise.resolve();
  // A Worker can finish the next request while the previous C++ admission is
  // pending. Commit its identity catalog and resource snapshot as one ordered
  // publication, so a later search cannot overwrite a newly retained result.
  function publishAccepted(action) {
    const operation=publication.then(action);
    publication=operation.catch(()=>{});
    return operation;
  }
  // Worker startup includes module loading, Core instantiation and the pinned
  // manifest. Share that work across view changes and time actual queries separately.
  let workerReady=null;
  const createClient=()=>createWorkerRpcClient({createWorker,defaultTimeoutMs:15_000,
    onCrash:()=>{workerReady=null;}});
  let client=rpc||createClient();
  function prepareWorker(){
    if(rpc)return null;
    if(!workerReady){
      const startingClient=client;
      workerReady=startingClient.request('place.prepare',{manifestUrl},{timeoutMs:60_000}).catch(error=>{
        if(!closed&&client===startingClient){
          workerReady=null;
          // A module-load failure can be cached by this Worker for its lifetime.
          startingClient.stop();
          client=createClient();
        }
        throw error;
      });
    }
    return workerReady;
  }
  const scheduler=createLatestWorkerJobScheduler({
    async execute(entry){
      const signal=entry.metadata.controller.signal;
      signal.throwIfAborted();
      await prepareWorker();
      signal.throwIfAborted();
      const response=await client.request(entry.jobKey==='viewport'?'place.viewport':'place.search',
        {...entry.payload,manifestUrl},{signal});
      return response.result;
    },
    cancelRunning: entry => entry.metadata.controller.abort(),
    isCurrent: entry => !closed && (entry.jobKey !== 'viewport' || entry.targetRevision === revision),
  });
  function rememberInto(cache,record) {
    if (!record || !isBuiltinPlaceId(record.id)) return;
    cache.delete(record.id); cache.set(record.id,record);
    const protectedIds=new Set(getProtectedIds());
    while (cache.size > PLACE_LIMITS.retainedRecords) {
      const oldest=[...cache.keys()].find(id => !protectedIds.has(id));
      // Selection can be arbitrarily large; the primary is first in protectedIds.
      cache.delete(oldest || [...cache.keys()].find(id => id !== protectedIds.values().next().value));
    }
  }
  const remember=record=>rememberInto(retained,record);
  // External place names are resolved at the accepted project cursor.
  // Without certified ancient place evidence the source remains in the
  // library, but is not published as a selectable active project reference.
  const sourceActive=(record,presentation=getPresentation())=>{
    if(!record)return false;
    const month=presentation?.month;
    return !month||(placeUrbanLabelActiveAtMonth(record,month,lifetimeIndex)
      &&placeLabelRowsAtMonth(record,month,{ko:true,en:true,native:true}).length>0);
  };
  function references(records=snapshot.records,cache=retained,presentation=getPresentation()) {
    return [...new Map([...cache.values(),...records].filter(record=>sourceActive(record,presentation)).map(record=>[record.id,
      Object.freeze({domain:'placeBuiltin',type:record.kind,id:record.id})])).values()];
  }
  function viewportCurrent(current,view){
    if(closed||current!==revision)return false;
    const presentation=getPresentation();
    return !view.presentation||!presentation||resourceKey(view.presentation)===resourceKey(presentation);
  }
  function prepare(view){
    desired=view;if(closed)return Promise.resolve(false);
    const context=resourceKey([view?.mapDate??null,view?.presentation??null]);
    if(viewportTask&&viewportContext===context)return viewportTask;
    if(viewportTask)cancelViewport();
    desired=view;viewportContext=context;
    const task=prepareViewport(view);viewportTask=task;
    const finish=()=>{if(viewportTask!==task)return;viewportTask=null;viewportContext=null;
      if(!closed&&desired&&resourceKey(desired)!==resourceKey(view))void prepare(desired);
    };
    task.then(finish,finish);return task;
  }
  async function prepareViewport(view) {
    if (closed) return false;
    const requested={source:manifestUrl,content:'place-source',preparation:resourceKey(view),context:null,presentation:'viewport-query'};
    if (!resourceUpdate(requestedDependencies,requested).prepare) return false;
    requestedDependencies=requested;
    const current=++revision;
    try {
      await ensureUrbanLifetimes();
      if(!viewportCurrent(current,view))return false;
      const job=scheduler.enqueue({ jobKey: 'viewport', targetRevision: current, payload: { view }, metadata: { controller: new AbortController() } });
      const result=await job.promise;
      if (!viewportCurrent(current,view)) return false;
      if (!Array.isArray(result.records) || result.records.length > PLACE_LIMITS.candidates) throw new RangeError('Place snapshot candidate budget exceeded');
      // The worker returns spatial candidates; the accepted source snapshot
      // contains only identities eligible at the project's selected month.
      const records=Object.freeze(result.records.map(normalizePlace)
        .filter(record=>sourceActive(record,view.presentation)));
      const next={source:manifestUrl,content:resourceKey(records),preparation:'place-normalization-v1',context:null,
        presentation:resourceKey(result.signature || 'records')};
      return await publishAccepted(async()=>{
        if(!viewportCurrent(current,view))return false;
        const change=resourceUpdate(snapshotDependencies,next);
        const activeKey=JSON.stringify(references(records,retained,view.presentation));
        const referenceChanged=activeKey!==admittedReferenceKey;
        if(!change.present&&!referenceChanged)return false;
        if(change.input||referenceChanged)
          await admitReferences(()=>references(records,retained,view.presentation));
        if(!viewportCurrent(current,view)) {
          if(!closed)await admitReferences(()=>references());
          return false;
        }
        if(change.present){
          snapshot=Object.freeze({ ...result, revision: current, records:change.input?records:snapshot.records });
          snapshotDependencies=next;
          onSnapshot(snapshot);
        }
        admittedReferenceKey=activeKey;
        return true;
      });
    } catch (error) {
      if(current===revision)requestedDependencies=null;
      if(!closed && current===revision && !error.cancelled && error.name!=='AbortError' && error.code!=='PL-CORE-STALE')onError(error);
      return false;
    }
  }
  function cancelViewport() { desired=null;viewportTask=null;viewportContext=null;requestedDependencies=null; revision++; scheduler.cancelKey('viewport'); }
  function settle(view=desired) {
    const wasMoving=moving;
    moving=false;
    const task=view?prepare(view):Promise.resolve(false);
    if(wasMoving)onSettled();
    // A drag query may still be running. Its completion starts the coalesced
    // final viewport before this continuation runs.
    return task.then(result=>desired===view&&viewportTask&&viewportTask!==task?viewportTask:result);
  }
  function resetProject() {
    if(closed)return;
    projectEpoch++;revision++;moving=false;desired=null;
    viewportTask=null;viewportContext=null;
    scheduler.cancelAll('project-replaced');
    retained.clear();snapshot=EMPTY;admittedReferenceKey=null;
    requestedDependencies=null;snapshotDependencies=null;
  }
  return Object.freeze({
    prepare,
    cancelViewport,
    resetProject,
    beginInteraction() { moving=true; scheduler.cancelKey('search'); },
    settle,
    snapshot: () => snapshot,
    selectionReferences: () => references(),
    isActive: sourceActive,
    resolve: id => {
      const record=retained.get(String(id)) || snapshot.records.find(row=>row.id===String(id));
      return sourceActive(record)?record:null;
    },
    retain: remember,
    async search(query, { scope = 'display', mapDate = null, signal = null } = {}) {
      const requestEpoch=projectEpoch;
      if (!['display', 'reference'].includes(scope)) throw new TypeError('Unknown place search scope.');
      const reference = scope === 'reference';
      if (closed || (moving && !reference)) throw createWorkerCancellationError('지도 이동 중에는 도시 조회를 보류합니다.', 'interaction');
      signal?.throwIfAborted();
      await ensureUrbanLifetimes();
      if(requestEpoch!==projectEpoch)throw createWorkerCancellationError('Project source changed','project-replaced');
      signal?.throwIfAborted();
      const job=scheduler.enqueue({ jobKey: reference ? `reference:${++referenceSequence}` : 'search', signal,
        payload: { query, scope, mapDate, presentation:reference ? null : getPresentation() }, metadata: { controller: new AbortController() } });
      const result=await job.promise;
      if(requestEpoch!==projectEpoch)throw createWorkerCancellationError('Project source changed','project-replaced');
      if (result.records.length > PLACE_LIMITS.searchResults) throw new RangeError('Place search result budget exceeded');
      const records=result.records.map(normalizePlace);
      const displayed=reference?records:records.filter(record=>sourceActive(record));
      if (reference) {
        signal?.throwIfAborted();
        if (closed) throw createWorkerCancellationError();
        return { ...result, records };
      }
      return publishAccepted(async()=>{
        if(closed || moving || requestEpoch!==projectEpoch)
          throw createWorkerCancellationError('Project source changed or interaction resumed','project-replaced');
        const candidate=new Map(retained);
        displayed.forEach(record=>rememberInto(candidate,record));
        await admitReferences(()=>references(snapshot.records,candidate));
        if(closed || moving || requestEpoch!==projectEpoch) {
          if(!closed)await admitReferences(()=>references());
          throw createWorkerCancellationError('지도 이동 중에는 도시 조회를 보류합니다.','interaction');
        }
        retained.clear();for(const [id,record]of candidate)retained.set(id,record);
        return { ...result, records:displayed };
      });
    },
    cancelSearch: () => scheduler.cancelKey('search'),
    isSearchOpen: () => !closed && !moving,
    stats: () => ({ ...scheduler.stats(), snapshotRecords: snapshot.records.length, retainedRecords: retained.size, moving }),
    dispose() { if (closed) return; closed=true; revision++; scheduler.close(); client.stop(); retained.clear(); snapshot=EMPTY; admittedReferenceKey=null; },
  });
}
