import { createWorkerRpcClient } from '../runtime/worker-rpc.js';
import { workerAssetUrl } from '../runtime/worker-asset-url.js';
import { parseBuiltinIndex, serializeBuiltinProject } from './builtin-asset-operations.js';

export function createBuiltinAssetTasks({createWorker = () => new Worker(workerAssetUrl(new URL('./workers/builtin-asset-worker.js', import.meta.url)), {type:'module'}),
  useWorker = typeof globalThis.Worker==='function'&&!!globalThis.PANDOLAB_BUILD_META?.workerAssets?.['assets/js/workers/builtin-asset-worker.js']} = {}) {
  let rpc = null, active = 0;
  async function run(operation, payload, transfer, local) {
    if (!useWorker)return local();
    const owner = rpc??=createWorkerRpcClient({createWorker});
    active++;
    try {return (await owner.request(operation, payload, {transfer})).result;}
    finally {
      if (--active===0&&rpc===owner) {rpc = null; owner.stop('builtin-assets-idle');}
    }
  }
  return Object.freeze({
    parseIndex:buffer => run('builtin.parse-index', buffer, [], () => parseBuiltinIndex(buffer)),
    serializeProject:project => run('builtin.serialize-project', project, [], () => serializeBuiltinProject(project)),
  });
}
