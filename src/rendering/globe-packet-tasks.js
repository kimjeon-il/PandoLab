import { createWorkerRpcClient } from '../runtime/worker-rpc.js';
import { workerAssetUrl } from '../runtime/worker-asset-url.js';
import { createGlobeWorkScheduler } from './globe-work-scheduler.js';

/** A bounded pool of stateless packet Workers. Cancel only the worker
  * owned by the obsolete job. Network/input reservations remain global. */
export function globePacketWorkerCount({deviceMemory = globalThis.navigator?.deviceMemory, hardwareConcurrency = globalThis.navigator?.hardwareConcurrency} = {}) {
  const cores = Number(hardwareConcurrency)||4, ram = Number(deviceMemory)||4;
  return ram<=2||cores<=2?1:ram>=8&&cores>=8?3:2;
}
export function createGlobePacketTasks({
  createWorker = () => new Worker(workerAssetUrl(new URL('./workers/globe-packet-worker.js', import.meta.url)), {type:'module'}),
  maxWorkers = globePacketWorkerCount(), scheduler = null,
} = {}) {
  const count = Math.max(1, Math.min(3, Math.floor(maxWorkers)||1));
  const owned = !scheduler, work = scheduler??createGlobeWorkScheduler({maxConcurrent:count});
  const lanes = Array.from({length:count}, () => ({rpc:null, busy:false}));
  let disposed = false, submitted = 0, completed = 0, cancelled = 0, peakRunning = 0, running = 0;
  function request(operation, body, transfer, {signal, priority = 0}) {
    signal?.throwIfAborted(); submitted++;
    return work.run({signal, priority, kind:'packet'}, async() => {
      if (disposed)throw new DOMException('Packet tasks disposed','AbortError');
      const lane = lanes.find(row => !row.busy);
      if (!lane)throw Error('Globe packet Worker lane unavailable');
      const owner = lane.rpc??=createWorkerRpcClient({createWorker, defaultTimeoutMs:120_000});
      lane.busy = true; running++; peakRunning = Math.max(peakRunning, running);
      const abort = () => {cancelled++; if (lane.rpc===owner)lane.rpc = null; owner.stop('globe-packet-superseded');};
      signal?.addEventListener('abort', abort, {once:true});
      try {
        signal?.throwIfAborted();
        const {result} = await owner.request(operation, body, {transfer, priority:typeof priority==='function'?priority():priority});
        signal?.throwIfAborted(); completed++; return result;
      }finally {signal?.removeEventListener('abort', abort); running--; lane.busy = false;}
    });
  }
  function decode(kind, bytes, spec, {signal, priority = 0, ...parameters} = {}) {
    signal?.throwIfAborted();
    return request('globe.decode-packet', {kind, bytes, spec:{encoding:spec.encoding, decodedBytes:spec.decodedBytes, maxDecodedBytes:spec.maxDecodedBytes}, ...parameters}, [bytes], {priority, signal});
  }
  function combineStoredStrokes(inputs, {signal, priority = 10} = {}) {
    signal?.throwIfAborted();
    // Inputs are private verified stored-byte copies, not cached decoded
    // packets. Transfer their backing stores exactly once.
    const transfer = [...new Set(inputs.map(row => row.bytes))];
    const packets = inputs.map(({bytes, spec}) => ({bytes, spec:{encoding:spec.encoding, decodedBytes:spec.decodedBytes, maxDecodedBytes:spec.maxDecodedBytes}}));
    return request('globe.combine-stored-strokes', {packets}, transfer, {priority, signal});
  }
  function dispose() {disposed = true; if (owned)work.dispose(); for (const lane of lanes) {lane.rpc?.stop('globe-packet-disposed'); lane.rpc = null;}}
  return Object.freeze({decode, combineStoredStrokes, dispose, stats:() => ({...work.stats(), submitted, completed, cancelled, workerLimit:count, workers:lanes.filter(row => row.rpc).length, running, peakRunning})});
}
