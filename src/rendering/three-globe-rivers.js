import { touchLruEntry } from '../runtime/lru-cache.js';
/** Retain prepared line buffers for the accepted viewport and recent visits. */
const RETRY_DELAY = 1500, MAX_RETRIES = 3;
export function createGlobeRiverDetail({byteBudget, load, attach, invalidate, onError,
  deferGpuAttach=false,now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout}) {
  const entries = new Map(), failed = new Map();
  let wanted = new Set(), published = new Set(), residentBytes = 0, retryTimer = null, disposed = false;
  function cancelRetryTimer() {
    if (retryTimer!==null) {clearTimer(retryTimer); retryTimer = null;}
  }
  function nextRetryAt() {
    let next = Infinity;
    for (const [id, failure] of failed) {
      if (wanted.has(id)&&!entries.has(id))next = Math.min(next, failure.retryAt);
    }
    return next;
  }
  const retryDue = () => !disposed&&nextRetryAt()<=now();
  function scheduleRetry() {
    cancelRetryTimer();
    const next = nextRetryAt();
    if (disposed||!Number.isFinite(next))return;
    retryTimer = setTimer(() => {
      retryTimer = null;
      // The next eligible render recomputes its current viewport plan.
      // Do not start an obsolete request directly from a timer.
      if (retryDue())invalidate();
      else scheduleRetry();
    }, Math.max(0, Math.ceil(next-now())));
  }
  function discard(id, entry) {
    if (entries.get(id)!==entry)return;
    entries.delete(id);
    if (!entry.resource) {entry.controller.abort(); return;}
    entry.resource.dispose();
    residentBytes-=entry.bytes;
  }
  function trim() {
    const before = residentBytes;
    if (before>byteBudget)for (const [id, entry] of entries) {
      if (residentBytes<=byteBudget)break;
      if (!wanted.has(id)&&!published.has(id))discard(id, entry);
    }
    return before!==residentBytes;
  }
  function attachPrepared(entry) {
    if (entry.resource||!entry.packet)return Boolean(entry.resource);
    const row=entry.row;
    entry.resource=attach(row,entry.packet);
    if (!entry.resource)return false;
    entry.bytes=entry.resource.residentBytes;entry.lastUsed=performance.now();
      residentBytes+=entry.bytes;
      entry.resource.setResidency({protected:wanted.has(row.id)||published.has(row.id), evict:() => discard(row.id, entry),
        onBytesChanged:bytes => {
          if (entries.get(row.id)!==entry)return;
          residentBytes+=bytes-entry.bytes; entry.bytes = bytes;
        }});
    return true;
  }
  async function prepare(row,entry) {
    try {
      const packet=await load(row,entry.controller.signal);
      if (entries.get(row.id)!==entry)return;
      entry.packet=packet;
      if (!deferGpuAttach)attachPrepared(entry);
      failed.delete(row.id);trim();scheduleRetry();invalidate();
    }catch (error) {
      if (entries.get(row.id)!==entry)return;
      discard(row.id, entry);
      const attempts = (failed.get(row.id)?.attempts??0)+1;
      const retryAt = attempts<=MAX_RETRIES?now()+RETRY_DELAY*2**(attempts-1):Infinity;
      failed.set(row.id, {attempts, retryAt});
      scheduleRetry();
      if (!Number.isFinite(retryAt))onError(error, row);
    }
  }
  function update(rows) {
    if (disposed)return false;
    const next = new Set(rows.map(row => row.id));
    const changed = wanted.size!==next.size||[...next].some(id => !wanted.has(id));
    const retry = rows.some(row => !entries.has(row.id)&&(failed.get(row.id)?.retryAt??0)<=now());
    if (!changed&&!retry)return false;
    const previous = wanted; wanted = next;
    for (const id of failed.keys())if (!next.has(id))failed.delete(id);
    for (const id of previous) {
      if (next.has(id))continue;
      const entry = entries.get(id);
      if (entry?.resource) {entry.resource.setVisible(false); entry.resource.setProtected(published.has(id));}
      else if (entry)discard(id, entry);
    }
    for (const row of rows) {
      const cached = entries.get(row.id);
      if (cached) {
        if (!previous.has(row.id)) {
          cached.resource?.setVisible(true); cached.resource?.setProtected(true); cached.lastUsed = performance.now();
          touchLruEntry(entries, row.id);
        }
        continue;
      }
      if ((failed.get(row.id)?.retryAt??0)>now())continue;
      const entry = {row, controller:new AbortController(), bytes:0, resource:null, packet:null};
      entries.set(row.id, entry); prepare(row, entry);
    }
    trim(); scheduleRetry(); return true;
  }
  const activeEntries = () => [...wanted].map(id=>entries.get(id)).filter(entry=>entry?.resource&&(!deferGpuAttach||entry.resource.drawReady?.()!==false));
  function prepareGpuUploads() {
    let ready=true;
    for (const id of wanted) {
      const entry=entries.get(id);
      if (!entry?.packet)continue;
      if (!attachPrepared(entry)) {ready=false;continue;}
      const available=entry.resource.warmGpu?.()??true;
      entry.resource.setVisible(available);
      if (!available)ready=false;
    }
    return ready;
  }
  function commit(active) {
    const next = new Set(active.map(entry => entry.row.id)), changed = next.size!==published.size||[...next].some(id => !published.has(id));
    if (changed) {
      for (const id of published)if (!next.has(id))entries.get(id)?.resource?.setProtected(wanted.has(id));
      for (const id of next)if (!published.has(id))entries.get(id)?.resource?.setProtected(true);
      published = next;
    }
    return trim()||changed;
  }
  function stats() {
    const active = activeEntries();
    return {requestedChunks:wanted.size, visibleChunks:active.length, activeSegments:active.reduce((sum, row) => sum+row.packet.count, 0), residentBytes,
      retryWaiting:[...failed].filter(([id, row]) => !entries.has(id)&&Number.isFinite(row.retryAt)).length,
      retryExhausted:[...failed.values()].filter(row => !Number.isFinite(row.retryAt)).length};
  }
  function dispose() {
    disposed = true; cancelRetryTimer();
    for (const [id, entry] of entries)discard(id, entry);
    wanted.clear(); published.clear(); failed.clear();
  }
  return Object.freeze({update,retryDue,commit,trim,stats,activeEntries,prepareGpuUploads,dispose});
}
