// Gate residence and asynchronous overlap are wall-clock diagnostics,
// not CPU execution time or a count of simultaneously executing CPU cores.
export function createGeometryWorkActivity(now = () => performance.now()) {
  let active = 0, last = now(), busyMs = 0, overlapMs = 0, peakActive = 0;
  function account() {
    const time = now(), elapsed = Math.max(0, time-last); last = time;
    if (active)busyMs+=elapsed;
    if (active>1)overlapMs+=elapsed;
  }
  return {get active() {return active;}, change(delta) {
    account(); active+=delta; peakActive = Math.max(peakActive, active);
  }, stats() {account(); return {active, busyMs, overlapMs, peakActive};}};
}

// Independent geometry jobs share a bounded priority queue. Cancelling a
// queued job releases its closure; executing work checks its own context.
export function createGeometryWorkGate(limit = 2, {now = () => performance.now(), sharedActivity = null} = {}) {
  const activity = createGeometryWorkActivity(now);
  let sequence = 0, peakWaiting = 0, cancelledQueued = 0;
  const waiting = [], kinds = new Map();
  const cancellationError = signal => signal.reason||new DOMException('Cancelled','AbortError');
  function rowFor(kind) {
    let row = kinds.get(kind);
    if (!row) {row = {started:0, finished:0, failed:0, queueMs:0, maxQueueMs:0, workMs:0}; kinds.set(kind, row);}
    return row;
  }
  function pump() {
    while (activity.active<limit&&waiting.length) {
      waiting.sort((a, b) => b.priority-a.priority||a.sequence-b.sequence);
      const entry = waiting.shift(); entry.detach();
      if (entry.context.signal?.aborted) {cancelledQueued++; entry.reject(cancellationError(entry.context.signal)); continue;}
      const started = now(), row = rowFor(entry.kind), wait = Math.max(0, started-entry.queuedAt);
      activity.change(1); sharedActivity?.change(1);
      row.started++; row.queueMs+=wait; row.maxQueueMs = Math.max(row.maxQueueMs, wait);
      const finish = (ok, value) => {
        row.workMs+=Math.max(0, now()-started);
        activity.change(-1); sharedActivity?.change(-1);
        if (ok) {row.finished++; entry.resolve(value);}else {row.failed++; entry.reject(value);}
        pump();
      };
      Promise.resolve().then(() => {
        entry.context.throwIfCancelled(); return entry.work();
      }).then(value => finish(true, value), cause => finish(false, cause));
    }
  }
  function run(context, work, kind = 'default') {
    context.throwIfCancelled();
    return new Promise((resolve, reject) => {
      const signal = context.signal;
      const entry = {context, work, resolve, reject, kind, queuedAt:now(), priority:context.priority||0, sequence:++sequence};
      const cancel = () => {
        const index = waiting.indexOf(entry); if (index<0)return;
        waiting.splice(index, 1); entry.detach(); cancelledQueued++; reject(cancellationError(signal));
      };
      entry.detach = () => signal?.removeEventListener('abort', cancel);
      waiting.push(entry); signal?.addEventListener('abort', cancel, {once:true}); pump();
      peakWaiting = Math.max(peakWaiting, waiting.length);
    });
  }
  function stats() {
    return {limit, ...activity.stats(), waiting:waiting.length, peakWaiting, cancelledQueued,
      kinds:Object.fromEntries([...kinds].map(([kind, row]) => [kind, {...row}]))};
  }
  return {run, stats};
}
