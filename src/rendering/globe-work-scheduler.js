import { createWorkerAdmissionQueue } from '../runtime/worker-admission-queue.js';
// Shared CPU admission for packet restoration and label SDF. Queued priority
// is live: a speculative read may become a required read without restarting.
// Device hints are ceilings, not a promise of available CPU or memory.
export function createGlobeWorkScheduler({maxConcurrent = 2, residency = null, now = () => performance.now()} = {}) {
  const limit = Math.max(1, Math.min(3, Math.floor(maxConcurrent)||1));
  let target = limit, closed = false, scheduled = false, serviceMs = 0, waitMs = 0, completed = 0, failed = 0, peak = 0, adjustments = 0;
  const active = new Set();
  const schedule = () => {if (closed||scheduled)return; scheduled = true; queueMicrotask(() => {scheduled = false; pump();});};
  const pending = createWorkerAdmissionQueue(schedule), queue = pending.rows;
  function adjust() {
    const pressure = residency?.pressure();
    // Estimate pressure including all active reservations, not just JS heap.
    const pressured = !!pressure&&pressure.totalBytes>pressure.byteBudget*.9;
    let next = target;
    if (pressured)next = 1;
    else if (pressure&&pressure.totalBytes<pressure.byteBudget*.7&&target<limit&&queue.length&&waitMs>8)next = target+1;
    if (next!==target) {target = next; adjustments++;}
  }
  function pump() {
    if (closed)return; adjust();
    pending.sort();
    while (queue.length&&active.size<target) {
      const row = queue[0], priority = row.priority;
      if (priority<0&&active.size)break;
      pending.take();
      if (row.signal?.aborted) {row.reject(row.signal.reason); continue;}
      const started = now(); waitMs = completed?waitMs*.8+(started-row.queuedAt)*.2:started-row.queuedAt;
      active.add(row); peak = Math.max(peak, active.size);
      Promise.resolve().then(() => {row.signal?.throwIfAborted(); return row.task();}).then(value => {completed++; row.resolve(value);}, error => {failed++; row.reject(error);}).finally(() => {
        const elapsed = now()-started; serviceMs = serviceMs?serviceMs*.8+elapsed*.2:elapsed;
        active.delete(row); schedule();
      });
    }
  }
  const off = residency?.onChange(schedule);
  function run({priority = 0, signal, kind = 'packet'}, task) {
    if (closed||signal?.aborted)return Promise.reject(signal?.reason??new DOMException('Globe work scheduler closed','AbortError'));
    return pending.enqueue({priority, signal, kind, queuedAt:now()}, task);
  }
  function dispose() {
    closed = true; off?.();
    pending.rejectAll(new DOMException('Globe work scheduler closed','AbortError'));
  }
  function stats() {return {workerLimit:limit, concurrency:target, queued:queue.length, running:active.size, peakRunning:peak, completed, failed, adjustments, meanServiceMs:serviceMs, meanQueueMs:waitMs,
    byKind:[...active].reduce((out, row) => (out[row.kind] = (out[row.kind]??0)+1, out), {})};}
  return {run, dispose, stats};
}

export function estimateGlobeTransferBytes(spec) {
  const stored = Math.max(0, Number(spec.compressedBytes)||0);
  const decoded = Math.max(0, Number(spec.decodedBytes)||0);
  return Math.ceil((stored||decoded)*3+64*1024);
}

export function estimateGlobeWorkingBytes(spec, kind = 'mesh') {
  if (Number.isFinite(spec.estimatedBytes))return Math.max(1, spec.estimatedBytes);
  const stored = Math.max(0, Number(spec.compressedBytes)||0), decoded = Math.max(1, Number(spec.decodedBytes)||0);
  // Allow decoded source, restored arrays, radix scratch, sparse tree, RPC
  // output and compressed transport copies to overlap during preparation.
  return Math.ceil(stored*3+decoded*(kind==='catalog'||kind==='hydro'?5:7)+64*1024);
}
