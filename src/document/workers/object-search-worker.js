import '../../runtime/workers/worker-rpc-host.js';
import {createObjectSearchIndex, searchObjectSearchIndex} from '../object-search-model.js';

let currentIndex = null;
let indexGeneration = 0;

self.PandoLabWorkerRpc.install({handlers:{
  'object-search.index':(payload, context) => {
    const generation = ++indexGeneration;
    const key = String(payload?.key || '');
    if (!key || !payload.catalog)
      throw new TypeError('Invalid object search index payload.');
    const built = createObjectSearchIndex(payload.catalog);
    context.throwIfCancelled();
    if (generation !== indexGeneration) {
      const error = new Error('Object search index was superseded.');
      error.category = 'STALE_RESULT';
      error.code = 'PL-OBJECT-SEARCH-STALE';
      throw error;
    }
    currentIndex = {key, terms:built.terms};
    return self.PandoLabWorkerRpc.transferResult({key, order:built.order}, [built.order.buffer]);
  },
  'object-search.query':(payload, context) => {
    context.throwIfCancelled();
    const key = String(payload?.key || '');
    if (!currentIndex || currentIndex.key !== key) {
      const error = new Error('Object search index is not current.');
      error.category = 'STALE_RESULT';
      error.code = 'PL-OBJECT-SEARCH-STALE';
      throw error;
    }
    const indices = searchObjectSearchIndex(currentIndex, payload.query);
    context.throwIfCancelled();
    return self.PandoLabWorkerRpc.transferResult({key, indices}, [indices.buffer]);
  },
  'object-search.clear':(_payload, context) => {
    context.throwIfCancelled();
    indexGeneration++;
    currentIndex = null;
    return null;
  },
}});
