import { createStatelessWorkerLane } from '../runtime/stateless-worker-lane.js';
import { workerAssetUrl } from '../runtime/worker-asset-url.js';

export function createGlobeLabelSdfTasks({
  createWorker = () => new Worker(workerAssetUrl(new URL('./workers/globe-label-sdf-worker.js', import.meta.url)), {type:'module'}),
  scheduler = null,
} = {}) {
  const worker = createStatelessWorkerLane(createWorker, 60_000);
  let disposed = false, active = null, submitted = 0, completed = 0, cancelled = 0;
  async function execute(rows, signal, priority, fontUrl, probes) {
    signal?.throwIfAborted();
    if (disposed||active)throw Error('Label SDF worker is unavailable');
    const owner = worker.acquire();
    const job = {owner}; active = job; submitted++;
    const abort = () => {
      if (active!==job)return;
      cancelled++; active = null;
      worker.retire(owner, 'label-sdf-superseded');
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
  function dispose() {disposed = true; active = null; worker.dispose('label-sdf-disposed');}
  return {run, dispose, stats:() => ({submitted, completed, cancelled, active:!!active})};
}
