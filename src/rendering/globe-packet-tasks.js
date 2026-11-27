import { subscribeAbort } from '../runtime/async-request.js';
import { workerPriority } from '../runtime/worker-admission-queue.js';
import { createStatelessWorkerLane } from '../runtime/stateless-worker-lane.js';
import { workerAssetUrl } from '../runtime/worker-asset-url.js';
import { createGlobeWorkScheduler } from './globe-work-scheduler.js';

const SMALL_PACKET_BYTES = 256*1024;
const SMALL_BATCH_BYTES = 1024*1024;
const SMALL_BATCH_DECODED_BYTES = 4*1024*1024;
const SMALL_BATCH_ITEMS = 8;

// Coalesce nearby small packet completions without coupling their cancellation.
// Each caller keeps an independent promise; the shared Worker is retired only
// when every member of its current batch has been cancelled.
export function createGlobeDecodeBatcher(dispatch, {
  schedule = callback => setTimeout(callback,0), maxItemBytes = SMALL_PACKET_BYTES, maxBytes = SMALL_BATCH_BYTES,
  maxDecodedBytes = SMALL_BATCH_DECODED_BYTES, maxItems = SMALL_BATCH_ITEMS,
} = {}) {
  const queue = [], running = new Set();
  let closed = false, scheduled = false, order = 0, batches = 0, packets = 0, batchBytes = 0, cancelled = 0;
  const abortError = signal => signal?.reason??new DOMException('Globe packet decode cancelled','AbortError');
  function settle(row, kind, value) {
    if (row.settled)return;
    row.settled = true; row.signal?.removeEventListener('abort',row.onAbort);
    row[kind](value);
  }
  function scheduleFlush() {
    if (scheduled||closed)return;
    scheduled = true; schedule(flush);
  }
  function eligible(row) {
    const stored = Number(row.packet.bytes?.byteLength)||0, decoded = Number(row.packet.spec?.decodedBytes)||stored;
    return ['mesh','stroke'].includes(row.packet.kind)&&stored>0&&stored<=maxItemBytes&&decoded>0&&decoded<=maxDecodedBytes;
  }
  function flush() {
    scheduled = false;
    if (closed)return;
    const rows = queue.splice(0).filter(row => !row.cancelled&&!row.settled);
    rows.sort((a,b) => b.priority-a.priority||a.order-b.order);
    while (rows.length) {
      const first = rows.shift(), firstStored = Number(first.packet.bytes?.byteLength)||0;
      const firstDecoded = Number(first.packet.spec?.decodedBytes)||firstStored;
      const group = [first]; let storedBytes = firstStored, decodedBytes = firstDecoded;
      if (eligible(first)) {
        for (let i=0;i<rows.length&&group.length<maxItems;) {
          const row = rows[i], stored = Number(row.packet.bytes?.byteLength)||0;
          const decoded = Number(row.packet.spec?.decodedBytes)||stored;
          if (row.priority===first.priority&&eligible(row)&&storedBytes+stored<=maxBytes&&decodedBytes+decoded<=maxDecodedBytes) {
            group.push(...rows.splice(i,1)); storedBytes+=stored; decodedBytes+=decoded;
          }else i++;
        }
      }
      run(group,storedBytes);
    }
  }
  async function run(rows, storedBytes) {
    const controller = new AbortController(), batch = {rows,controller};
    rows.forEach(row => {row.batch = batch;});
    running.add(batch);
    if (rows.length>1) {batches++;packets+=rows.length;batchBytes+=storedBytes;}
    try {
      const results = await dispatch(rows.map(row => row.packet), {signal:controller.signal,priority:rows[0].priority});
      if (!Array.isArray(results)||results.length!==rows.length)throw Error('Globe decode batch returned an invalid result count');
      for (let i=0;i<rows.length;i++) {
        const row = rows[i], result = results[i];
        if (row.cancelled||row.settled)continue;
        if (result?.ok===false) {
          const cause = result.error;
          settle(row,'reject',cause instanceof Error?cause:Object.assign(new Error(cause?.message||'Globe packet decode failed'),{name:cause?.name||'Error'}));
        }else settle(row,'resolve',result?.value);
      }
    }catch(error) {
      for (const row of rows)if (!row.cancelled&&!row.settled)settle(row,'reject',error);
    }finally {
      running.delete(batch);
      for (const row of rows) {row.signal?.removeEventListener('abort',row.onAbort);row.batch = null;}
    }
  }
  function enqueue(packet,{signal = null,priority = 0} = {}) {
    if (closed||signal?.aborted)return Promise.reject(abortError(signal));
    return new Promise((resolve,reject) => {
      const row = {packet,signal,priority:Number(priority)||0,resolve,reject,settled:false,cancelled:false,order:order++,batch:null};
      row.onAbort = () => {
        row.cancelled = true; cancelled++; settle(row,'reject',abortError(signal));
        if (row.batch&&row.batch.rows.every(item => item.cancelled||item.settled))row.batch.controller.abort(abortError(signal));
      };
      signal?.addEventListener('abort',row.onAbort,{once:true});
      queue.push(row); scheduleFlush();
    });
  }
  function dispose() {
    if (closed)return;
    closed = true;
    const error = new DOMException('Globe packet decode batcher disposed','AbortError');
    for (const row of queue.splice(0))settle(row,'reject',error);
    for (const batch of running) {
      batch.controller.abort(error);
      for (const row of batch.rows)settle(row,'reject',error);
    }
  }
  return Object.freeze({enqueue,dispose,stats:() => ({queued:queue.length,running:running.size,batches,packets,batchBytes,cancelled})});
}

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
  const lanes = Array.from({length:count}, () => ({worker:createStatelessWorkerLane(createWorker, 120_000), busy:false}));
  let disposed = false, submitted = 0, completed = 0, cancelled = 0, peakRunning = 0, running = 0, spatialIndexedPackets = 0;
  let decodeBatches = 0, decodeBatchPackets = 0;
  function request(operation, body, transfer, {signal, priority = 0}) {
    signal?.throwIfAborted(); submitted++;
    return work.run({signal, priority, kind:'packet'}, async() => {
      if (disposed)throw new DOMException('Packet tasks disposed','AbortError');
      const lane = lanes.find(row => !row.busy);
      if (!lane)throw Error('Globe packet Worker lane unavailable');
      const owner = lane.worker.acquire();
      lane.busy = true; running++; peakRunning = Math.max(peakRunning, running);
      const abort = () => {cancelled++; lane.worker.retire(owner, 'globe-packet-superseded');};
      const detachAbort = subscribeAbort(signal, abort);
      try {
        signal?.throwIfAborted();
        const {result} = await owner.request(operation, body, {transfer, priority:workerPriority(priority)});
        signal?.throwIfAborted(); completed++; return result;
      }finally {detachAbort(); running--; lane.busy = false;}
    });
  }
  const decodeBatcher = createGlobeDecodeBatcher(async(packets,{signal,priority}) => {
    if (packets.length===1) {
      const packet = packets[0];
      const value = await request('globe.decode-packet',packet,[packet.bytes],{signal,priority});
      if (packet.kind==='mesh'||packet.kind==='stroke')spatialIndexedPackets++;
      return [{ok:true,value}];
    }
    const transfer = [...new Set(packets.map(row => row.bytes))];
    const results = await request('globe.decode-packet-batch',{packets},transfer,{signal,priority});
    decodeBatches++; decodeBatchPackets+=packets.length;
    spatialIndexedPackets+=results.filter(row => row.ok).length;
    return results;
  });
  function decode(kind, bytes, spec, {signal, priority = 0, ...parameters} = {}) {
    signal?.throwIfAborted();
    const packet = {kind,bytes,spec:{encoding:spec.encoding,decodedBytes:spec.decodedBytes,maxDecodedBytes:spec.maxDecodedBytes},...parameters};
    if ((kind==='mesh'||kind==='stroke')&&!Object.keys(parameters).length)
      return decodeBatcher.enqueue(packet,{signal,priority});
    return request('globe.decode-packet',packet,[bytes],{priority,signal}).then(value => {
      if ((kind==='mesh'||kind==='stroke')&&parameters.spatial!==false)spatialIndexedPackets++;
      return value;
    });
  }
  function combineStoredStrokes(inputs, {signal, priority = 10} = {}) {
    signal?.throwIfAborted();
    // Inputs are private verified stored-byte copies, not cached decoded
    // packets. Transfer their backing stores exactly once.
    const transfer = [...new Set(inputs.map(row => row.bytes))];
    const packets = inputs.map(({bytes, spec}) => ({bytes, spec:{encoding:spec.encoding, decodedBytes:spec.decodedBytes, maxDecodedBytes:spec.maxDecodedBytes}}));
    return request('globe.combine-stored-strokes', {packets}, transfer, {priority, signal});
  }
  function dispose() {disposed = true; decodeBatcher.dispose(); if (owned)work.dispose(); for (const lane of lanes) {lane.worker.dispose('globe-packet-disposed');}}
  return Object.freeze({decode, combineStoredStrokes, dispose, stats:() => ({submitted, completed, cancelled, workerLimit:count, workers:lanes.filter(row => row.worker.active).length, running, peakRunning, spatialIndexedPackets, decodeBatches, decodeBatchPackets, decodeBatcher:decodeBatcher.stats(), ...(owned?{scheduler:work.stats()}:{})})});
}
