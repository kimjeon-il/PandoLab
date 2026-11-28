import {createWorkerRpcClient} from '../runtime/worker-rpc.js';
import {createVerifiedCoreWorker} from '../runtime/core-wasm-loader.js';
import {workerAssetUrl} from '../runtime/worker-asset-url.js';

function cancelled(message) {
  return Object.assign(new Error(message), {
    name:'AbortError', cancelled:true, category:'CANCELLED', code:'PL-OBJECT-SEARCH-CANCELLED',
  });
}

/** Owns the lazy search Worker and its single revision-bound index. */
export function createObjectSearchRuntime({assetUrl, meta, createWorker = null} = {}) {
  if (!createWorker && (typeof assetUrl !== 'function' || !meta))
    throw new TypeError('Object search Worker requires the current asset URL and build metadata.');

  const workerFactory = createWorker || (() => createVerifiedCoreWorker(
    workerAssetUrl(assetUrl('workers/object-search-worker.js'), meta),
    {type:'module', name:'pandolab-object-search'},
  ));
  let client = null, closed = false;
  let indexGeneration = 0, indexKey = null, indexOrder = null;
  let indexingKey = null, indexingPromise = null;

  function getClient() {
    if (closed) throw cancelled('Object search runtime is closed.');
    if (!client) client = createWorkerRpcClient({
      createWorker:workerFactory,
      defaultTimeoutMs:30_000,
      onCrash:() => {
        indexGeneration++;
        indexKey = null;
        indexOrder = null;
        indexingKey = null;
        indexingPromise = null;
      },
    });
    return client;
  }

  function prepare({key, catalog} = {}) {
    const revision = String(key || '');
    if (closed) return Promise.reject(cancelled('Object search runtime is closed.'));
    if (!revision || !catalog || !Array.isArray(catalog.keys))
      return Promise.reject(new TypeError('Invalid object search index request.'));
    if (indexKey === revision && indexOrder) return Promise.resolve(indexOrder);
    if (indexingKey === revision && indexingPromise) return indexingPromise;

    const generation = ++indexGeneration;
    indexKey = null;
    indexOrder = null;
    indexingKey = revision;
    const pending = getClient().request('object-search.index', {key:revision, catalog}, {timeoutMs:60_000})
      .then(response => {
        if (closed || generation !== indexGeneration) throw cancelled('Object search index was superseded.');
        const result = response.result;
        if (result?.key !== revision || !(result.order instanceof Uint32Array)
          || result.order.length !== catalog.keys.length)
          throw new TypeError('Invalid object search index response.');
        indexKey = revision;
        indexOrder = result.order;
        return indexOrder;
      }).finally(() => {
        if (indexingPromise === pending) {
          indexingKey = null;
          indexingPromise = null;
        }
      });
    indexingPromise = pending;
    return pending;
  }

  async function search({key, query, signal = null} = {}) {
    const revision = String(key || '');
    if (closed) throw cancelled('Object search runtime is closed.');
    if (!revision || indexKey !== revision)
      throw cancelled('Object search index is not current.');
    const response = await getClient().request('object-search.query', {key:revision, query:String(query || '')}, {
      signal, timeoutMs:15_000,
    });
    if (closed || indexKey !== revision || response.result?.key !== revision
      || !(response.result.indices instanceof Uint32Array))
      throw cancelled('Object search result is stale.');
    return response.result.indices;
  }

  function invalidate() {
    indexGeneration++;
    indexKey = null;
    indexOrder = null;
    indexingKey = null;
    indexingPromise = null;
    if (!client || closed) return Promise.resolve(false);
    return client.request('object-search.clear', null, {timeoutMs:5_000})
      .then(() => true, () => false);
  }

  function dispose() {
    if (closed) return;
    closed = true;
    indexGeneration++;
    indexKey = null;
    indexOrder = null;
    indexingKey = null;
    indexingPromise = null;
    client?.stop('object-search-disposed');
    client = null;
  }

  return Object.freeze({prepare, search, invalidate, dispose,
    stats:() => Object.freeze({closed, indexed:indexKey !== null, indexing:indexingKey !== null,
      worker:client?.stats() || null})});
}
