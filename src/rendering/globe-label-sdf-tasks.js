import { createWorkerRpcClient } from '../runtime/worker-rpc.js';
import { workerAssetUrl } from '../runtime/worker-asset-url.js';

export function createGlobeLabelSdfTasks({
  createWorker = () => new Worker(workerAssetUrl(new URL('./workers/globe-label-sdf-worker.js', import.meta.url)), {type:'module'}),
  scheduler = null,
} = {}) {
  let rpc = null, disposed = false, active = null, submitted = 0, completed = 0, cancelled = 0;
  async function execute(rows, signal, priority, fontUrl, probes) {
    signal?.throwIfAborted();
    if (disposed||active)throw Error('Label SDF worker is unavailable');
    const owner = rpc??=createWorkerRpcClient({createWorker, defaultTimeoutMs:60_000});
    const job = {owner}; active = job; submitted++;
    const abort = () => {
      if (active!==job)return;
      cancelled++; active = null;
      if (rpc===owner)rpc = null;
      owner.stop('label-sdf-superseded');
    };
    signal?.addEventListener('abort', abort, {once:true});
    try {
      const {result} = await owner.request('globe.label-sdf', {rows, fontUrl, probes}, {transfer:rows.filter(row => row.mask).map(row => row.mask.buffer), priority});
      signal?.throwIfAborted(); completed++; return result;
    }finally {
      signal?.removeEventListener('abort', abort); if (active===job)active = null;
    }
  }
  function run(rows, signal, {priority = 10, fontUrl = null, probes = null} = {}) {
    const task = () => execute(rows, signal, priority, fontUrl, probes);
    return scheduler?scheduler.run({signal, priority, kind:'sdf'}, task):task();
  }
  function dispose() {disposed = true; active = null; rpc?.stop('label-sdf-disposed'); rpc = null;}
  return {run, dispose, stats:() => ({submitted, completed, cancelled, active:!!active})};
}
