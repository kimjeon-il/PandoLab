import { waitForConsumer } from '../runtime/async-request.js';
import { createWorkerAdmissionQueue } from '../runtime/worker-admission-queue.js';
export { touchLruEntry as touchRenderCache, trimLruEntries as trimRenderCache } from '../runtime/lru-cache.js';
// These are standby-cache ceilings, not limits on the visible world.
// Unknown device hints keep the original defaults. Do not infer available
// heap from total device RAM or change the canonical geometry quality.
const MiB = 1024*1024;
export function renderCacheBudget(deviceMemory = globalThis.navigator?.deviceMemory) {
  const ram = Number(deviceMemory);
  const hasMemoryHint = Number.isFinite(ram) && ram > 0;
  const isLowMemory = hasMemoryHint && ram <= 2;
  const isMediumMemory = hasMemoryHint && ram <= 4;
  const factor = isLowMemory ? 0.375 : isMediumMemory ? 0.625 : 1;
  return Object.freeze({
    hydroBytes:Math.round(64*MiB*factor),
    historicalCpuBytes:Math.round(96*MiB*factor),
    physicalCpuBytes:Math.round(64*MiB*factor),
    residentMeshBytes:Math.round(128*MiB*factor),
    outlineBytes:Math.round(32*MiB*factor),
    labelAtlasBytes:Math.round(48*MiB*factor),
    totalRenderBytes:Math.round(320*MiB*factor),
    pendingBytes:Math.round(64*MiB*factor),
    persistenceBytes:Math.round(16*MiB*factor),
    neighborBytes:Math.round(12*MiB*factor),
    borderBatchBytes:Math.round(8*MiB*factor),
    concurrentLoads:hasMemoryHint&&ram<=2?2:4,
  });
}

// Account for distinct backing buffers, not each view of the same packet.
export function renderPacketBuffers(value) {
  const buffers = new Set(), visited = new Set();
  function visit(row) {
    if (!row||typeof row!=='object'||visited.has(row))return;
    visited.add(row);
    if (ArrayBuffer.isView(row))buffers.add(row.buffer);
    else if (row instanceof ArrayBuffer)buffers.add(row);
    else for (const child of Object.values(row))visit(child);
  }
  visit(value); return buffers;
}
export function renderBufferBytes(buffers, extraBytes = 0) {
  let total = extraBytes;
  for (const buffer of buffers)total += buffer.byteLength;
  return total;
}

export function renderFootprintBytes({buffers, extraBytes = 0}) {
  return renderBufferBytes(buffers, extraBytes);
}

// Decoded packet LRU with independent consumers of the same in-flight read.
// Last-consumer cancellation propagates through network and Worker restores.
export function createRenderPacketCache({byteBudget, entryLimit = 256, onEvict, residency = null, estimateExtraBytes = () => 0}) {
  const entries = new Map(), standby = new Map();
  let retained = new Set(), disposed = false, cancelled = 0, residentBytes = 0, pendingCount = 0, warmBytes = 0;
  const warm = new Map();
  const counters = {hits:0, misses:0, joinedPending:0, evicted:0, failed:0};
  function protectedEntry(key, entry) {return entry.pending||entry.users>0||retained.has(key);}
  function sync(key, entry) {
    standby.delete(key);
    if (entries.get(key)!==entry)return;
    if (!protectedEntry(key, entry)&&!warm.has(key))standby.set(key, entry);
    if (!entry.pending)residency?.set(entry, {buffers:entry.buffers, extraBytes:entry.extraBytes, lastUsed:entry.lastUsed+(warm.has(key)?5000:0),
      protected:protectedEntry(key, entry), evict:() => remove(key, entry)});
  }
  function remove(key, entry, {abort = false, notify = true} = {}) {
    if (entries.get(key)!==entry)return false;
    entries.delete(key); standby.delete(key); residency?.remove(entry);
    if (warm.delete(key))warmBytes-=entry.bytes;
    if (entry.pending) {pendingCount--; if (abort)entry.controller.abort();}
    else {residentBytes-=entry.bytes; if (notify)counters.evicted++;}
    if (notify)onEvict?.(key, entry);
    return true;
  }
  function trim() {
    // No scan or byte summation unless the standby budget is exceeded.
    while (residentBytes>byteBudget||entries.size>entryLimit) {
      const victim = standby.entries().next().value??[...warm].find(([key, entry]) => !protectedEntry(key, entry));
      if (!victim)break;
      remove(victim[0], victim[1]);
    }
  }
  function abortUnused(key, entry) {
    queueMicrotask(() => {
      if (entries.get(key)!==entry||!entry.pending||entry.users||entry.unscoped)return;
      cancelled++; remove(key, entry, {abort:true, notify:false});
    });
  }
  function consume(key, entry, signal) {
    entry.lastUsed = performance.now();
    if (!signal) {if (entry.pending)entry.unscoped = true; sync(key, entry); return entry.promise;}
    entry.users++; sync(key, entry);
    return waitForConsumer(entry.promise, signal).finally(() => {
      entry.users--; sync(key, entry);
      if (entry.pending&&!entry.users&&!entry.unscoped)abortUnused(key, entry);
      else if (!entry.pending&&!entry.users)trim();
    });
  }
  function read(key, load, signal = null, {priority = 0} = {}) {
    if (disposed||signal?.aborted)return Promise.reject(signal?.reason??new DOMException('Render packet cache disposed','AbortError'));
    const existing = entries.get(key);
    if (existing) {
      if (existing.pending)counters.joinedPending++; else counters.hits++;
      if (priority>=0&&warm.delete(key))warmBytes-=existing.bytes;
      if (existing.pending&&priority>existing.priority) {existing.priority = priority; for (const notify of existing.priorityListeners)notify();}
      return consume(key, existing, signal);
    }
    const entry = {pending:true, bytes:0, promise:null, controller:new AbortController(), users:0, unscoped:false, lastUsed:performance.now(), buffers:null, priority, priorityListeners:new Set()};
    const readPriority = () => entry.priority;
    readPriority.subscribe = notify => {entry.priorityListeners.add(notify); return () => entry.priorityListeners.delete(notify);};
    entries.set(key, entry); pendingCount++; counters.misses++;
    entry.promise = Promise.resolve().then(() => {
      entry.controller.signal.throwIfAborted(); return load(entry.controller.signal, readPriority);
    }).then(value => {
      entry.controller.signal.throwIfAborted();
      if (entries.get(key)===entry) {
        entry.pending = false; pendingCount--; entry.buffers = renderPacketBuffers(value?.packet??value);
        entry.extraBytes=Math.max(0,Number(estimateExtraBytes(value,key))||0);
        entry.bytes = renderBufferBytes(entry.buffers,entry.extraBytes);
        residentBytes+=entry.bytes; sync(key, entry); trim();
      }
      return value;
    }).catch (error => {
      if (entries.get(key)===entry&&!entry.controller.signal.aborted&&error?.name!=='AbortError'&&!error?.cancelled)counters.failed++;
      remove(key, entry, {abort:true, notify:false}); entry.controller.abort(); throw error;
    });
    return consume(key, entry, signal);
  }
  function retain(keys) {
    const next = new Set(keys), changed = new Set();
    for (const key of retained)if (!next.has(key))changed.add(key);
    for (const key of next)if (!retained.has(key))changed.add(key);
    retained = next;
    for (const key of changed) {const entry = entries.get(key); if (entry) {entry.lastUsed = performance.now(); sync(key, entry);}}
    trim();
  }
  function holdWarm(key, limit) {
    const entry = entries.get(key); if (!entry||entry.pending||retained.has(key)||entry.bytes>limit)return false;
    if (!warm.has(key)) {warm.set(key, entry); warmBytes+=entry.bytes;}
    while (warmBytes>limit&&warm.size) {const [old, row] = warm.entries().next().value; warm.delete(old); warmBytes-=row.bytes; sync(old, row);}
    sync(key, entry); trim(); return warm.has(key);
  }
  function releaseWarm(keys = null) {
    const keep = keys?new Set(keys):null;
    for (const [key, entry] of [...warm])if (!keep||!keep.has(key)) {warm.delete(key); warmBytes-=entry.bytes; sync(key, entry);}
    trim();
  }
  function memoryEntries() {
    return [...entries].filter(([, entry]) => !entry.pending).map(([key, entry]) => ({key:entry, buffers:entry.buffers, extraBytes:entry.extraBytes, lastUsed:entry.lastUsed,
      protected:protectedEntry(key, entry), evict:() => remove(key, entry)}));
  }
  function stats() {return {entries:entries.size, residentBytes, pending:pendingCount, cancelled, warmBytes, warmEntries:warm.size, byteBudget, entryLimit, ...counters};}
  function dispose() {disposed = true; for (const [key, entry] of entries)remove(key, entry, {abort:true, notify:false}); retained.clear(); standby.clear();}
  return Object.freeze({read, retain, holdWarm, releaseWarm, memoryEntries, has:key => entries.has(key), stats, dispose});
}

// Incremental ledger: register immutable CPU backing buffers by identity,
// update only changed resources, and search standby entries only under
// pressure. A snapshot owner is refreshed explicitly, not every hover.
export function createRenderResidencyBudget(byteBudget, {groups = {}} = {}) {
  const rows = new Map(), refs = new Map(), standby = new Map(), standbyGroups = new Map(), owners = new Set(), dirtyOwners = new Set(), totals = new Map();
  let cpu = 0, extra = 0, protectedCpu = 0, protectedExtra = 0, protectedEntries = 0, evicted = 0, updates = 0, ownerRefreshes = 0;
  const reservations = new Map(), listeners = new Set(); let workingBytes = 0, peakWorkingBytes = 0, peakTotalBytes = 0, overflowCount = 0;
  function peak() {peakTotalBytes = Math.max(peakTotalBytes, cpu+extra+workingBytes);}
  function changed() {for (const listener of listeners)listener();}
  function groupDelta(row, sign) {
    for (const group of row.groups??[]) {
      const limit = groups[group]; if (!limit||limit.standbyOnly&&row.protected)continue;
      let total = totals.get(group); if (!total) {total = {bytes:0, count:0}; totals.set(group, total);}
      total.bytes+=sign*row.localBytes; total.count+=sign;
    }
  }
  function detach(key, row) {
    standby.delete(key); for (const group of row.groups??[])standbyGroups.get(group)?.delete(key);
    extra-=row.extraBytes; groupDelta(row, -1);
    if (row.protected) {protectedExtra-=row.extraBytes;protectedEntries--;}
    for (const buffer of row.buffers) {
      const entry = refs.get(buffer); if (!entry)continue;
      if (row.protected&&--entry.protectedCount===0)protectedCpu-=entry.bytes;
      if (--entry.count===0) {refs.delete(buffer); cpu-=entry.bytes;}
    }
  }
  function set(key, source) {
    const before = cpu+extra, old = rows.get(key);
    const buffers = source.buffers instanceof Set?source.buffers:new Set(source.buffers??[]);
    const row = {...source, buffers, extraBytes:source.extraBytes??0,
      localBytes:renderFootprintBytes({buffers, extraBytes:source.extraBytes})};
    if (old)detach(key, old);
    rows.set(key, row); extra+=row.extraBytes; groupDelta(row, 1);
    if (row.protected) {protectedExtra+=row.extraBytes;protectedEntries++;}
    for (const buffer of buffers) {
      let entry = refs.get(buffer);
      if (!entry) {entry = {count:0,protectedCount:0,bytes:buffer.byteLength}; refs.set(buffer, entry); cpu+=entry.bytes;}
      entry.count++;
      if (row.protected&&entry.protectedCount++===0)protectedCpu+=entry.bytes;
    }
    if (!row.protected&&typeof row.evict==='function') {
      standby.set(key, row);
      for (const group of row.groups??[]) {let members = standbyGroups.get(group); if (!members) {members = new Map(); standbyGroups.set(group, members);}members.set(key, row);}
    }
    updates++; peak();
    if (cpu+extra<before)changed();
  }
  function remove(key) {
    const row = rows.get(key); if (!row)return false;
    rows.delete(key); detach(key, row); updates++; changed(); return true;
  }
  function register(read) {
    const owner = {read, keys:new Map()}; owners.add(owner); dirtyOwners.add(owner);
    const invalidate = () => {if (owners.has(owner))dirtyOwners.add(owner);};
    invalidate.dispose = () => {
      owners.delete(owner); dirtyOwners.delete(owner);
      for (const key of owner.keys.values())remove(key); owner.keys.clear();
    };
    return invalidate;
  }
  function refreshOwners() {
    for (const owner of [...dirtyOwners]) {
      dirtyOwners.delete(owner); ownerRefreshes++;
      const next = new Map();
      owner.read().forEach((row, i) => {
        const id = row.key??i, key = owner.keys.get(id)??{};
        next.set(id, key);
        const evict = typeof row.evict==='function'?() => {if (owner.keys.get(id)===key)owner.keys.delete(id); row.evict();}:undefined;
        set(key, {...row, evict});
      });
      for (const [id, key] of owner.keys)if (!next.has(id))remove(key);
      owner.keys = next;
    }
  }
  function evictUntil(over, candidates) {
    if (!over()||!candidates?.size)return;
    // Sort once per actual pressure event, never once per eviction.
    const ordered = [...candidates].sort((a, b) => (a[1].lastUsed??0)-(b[1].lastUsed??0));
    for (const [key, row] of ordered) {
      if (!over())break;
      if (standby.get(key)!==row)continue;
      remove(key); evicted++; row.evict();
    }
  }
  function trim(headroom = 0) {
    refreshOwners();
    for (const [group, limit] of Object.entries(groups)) {
      const over = () => {const total = totals.get(group); return total&&(total.bytes>(limit.byteBudget??Infinity)||total.count>(limit.entryLimit??Infinity));};
      evictUntil(over, standbyGroups.get(group));
    }
    evictUntil(() => cpu+extra+workingBytes+headroom>byteBudget, standby);
    return stats();
  }
  // Reserve work before I/O/allocation; optional work may be declined.
  function reserve(bytes, {kind = 'work', optional = false, trimFirst = true} = {}) {
    const size = Math.max(0, Number(bytes)||0);
    if (trimFirst)trim(size);
    if (cpu+extra+workingBytes+size>byteBudget) {
      if (optional)return null;
      overflowCount++;
    }
    const token = {}; reservations.set(token, {size, kind}); workingBytes+=size;
    peakWorkingBytes = Math.max(peakWorkingBytes, workingBytes); peak();
    let released = false;
    return () => {
      if (released)return; released = true;
      const row = reservations.get(token); if (!row)return;
      reservations.delete(token); workingBytes-=row.size; changed();
    };
  }
  function withTemporary(bytes, kind, work) {
    const release = reserve(bytes, {kind, trimFirst:false});
    try {return work();}finally {release();}
  }
  function onChange(callback) {listeners.add(callback); return () => listeners.delete(callback);}
  function stats() {
    const byKind = {}; for (const row of reservations.values())byKind[row.kind] = (byKind[row.kind]??0)+row.size;
    return {residentBytes:cpu+extra, cpuBytes:cpu, deviceAndOtherBytes:extra, workingBytes, totalBytes:cpu+extra+workingBytes,
      protectedBytes:protectedCpu+protectedExtra, protectedCpuBytes:protectedCpu, protectedDeviceAndOtherBytes:protectedExtra,protectedEntries,
      unprotectedBytes:cpu+extra-protectedCpu-protectedExtra,
      peakWorkingBytes, peakTotalBytes, overflowCount, workingByKind:byKind, evicted, byteBudget, entries:rows.size, standby:standby.size, updates, ownerRefreshes};
  }
  function dispose() {owners.clear(); dirtyOwners.clear(); rows.clear(); refs.clear(); standby.clear(); standbyGroups.clear(); totals.clear(); reservations.clear(); listeners.clear(); cpu = extra = workingBytes = protectedCpu = protectedExtra = protectedEntries = 0;}
  return Object.freeze({register, set, remove, trim, reserve, withTemporary, onChange, stats, dispose,
    pressure:() => ({totalBytes:cpu+extra+workingBytes, protectedBytes:protectedCpu+protectedExtra, workingBytes, byteBudget})});
}

// Admit a bounded number of downloads + Worker inputs, not only Worker calls.
// A required oversize packet runs alone. Queued work never acquires bytes.
export function createRenderLoadGate({concurrency, byteBudget, residency = null, overflowAllowance = Infinity}) {
  let active = 0, foreground = 0, speculative = 0, bytes = 0, closed = false, peakBytes = 0, peakActive = 0, bypasses = 0, pressureSkips = 0;
  let pumpQueued = false, pumping = false, handoffs = 0;
  const idleListeners = new Set();
  const schedule = () => {if (closed||pumpQueued)return; pumpQueued = true; queueMicrotask(() => {pumpQueued = false; pump();});};
  const pending = createWorkerAdmissionQueue(schedule), queue = pending.rows;
  const off = residency?.onChange(schedule);
  function notifyIdle() {if (!active&&!queue.length&&!bytes)for (const listener of [...idleListeners])listener();}
  function pump() {
    if (closed||pumping)return;
    pumping = true;
    try {
      pending.sort();
      while (queue.length&&active<concurrency) {
        const head = queue[0];
        if (head.priority<0&&(foreground||speculative))break;
        let at = 0;
        if (bytes>0&&bytes+head.bytes>byteBudget) {
          if (head.bypassed>=2||head.priority<0)break;
          at = queue.findIndex((row, i) => i>0&&row.priority===head.priority&&bytes+row.bytes<=byteBudget);
          if (at<0)break; head.bypassed++; bypasses++;
        }
        const row = queue[at];
        if (row.signal?.aborted) {pending.take(at); row.reject(row.signal.reason); continue;}
        const pressure=residency?.pressure();
        const allowOverflow=row.priority>=10&&active===0&&bytes===0&&(!pressure||
          pressure.protectedBytes+pressure.workingBytes+row.bytes<=pressure.byteBudget+overflowAllowance);
        const release = residency?residency.reserve(row.bytes, {kind:row.kind, optional:!allowOverflow}):() => {};
        if (!release) {
          // Visible-margin work can wait for admitted loads to release their
          // reservations; speculative work still yields to the foreground.
          if (row.priority>=0&&(active>0||bytes>0))break;
          pending.take(at); pressureSkips++;
          row.reject(Object.assign(new Error('Render preparation memory pressure'), {name:'AbortError', memoryPressure:true, requestedBytes:row.bytes})); continue;
        }
        pending.take(at);
        const isSpeculative = row.priority<0;
        active++; if (isSpeculative)speculative++; else foreground++;
        bytes+=row.bytes; peakActive = Math.max(peakActive, active); peakBytes = Math.max(peakBytes, bytes);
        let slotReleased = false, reservationReleased = false;
        const releaseSlot = () => {
          if (slotReleased)return;
          slotReleased = true;
          active--; if (isSpeculative)speculative--; else foreground--;
        };
        const handoff = () => {
          if (slotReleased)return;
          handoffs++; releaseSlot();
          if (residency)schedule(); else pump();
          notifyIdle();
        };
        const releaseAdmission = () => {
          if (reservationReleased)return;
          reservationReleased = true; releaseSlot();
          bytes-=row.bytes; release();
          if (residency)schedule(); else pump();
          notifyIdle();
        };
        Promise.resolve().then(() => {row.signal?.throwIfAborted(); return row.task({handoff});}).then(
          value => {releaseAdmission(); row.resolve(value);},
          error => {releaseAdmission(); row.reject(error);},
        );
      }
    }finally {pumping = false; notifyIdle();}
  }
  function run({bytes:estimate = 0, priority = 0, signal, kind = 'packet'}, task) {
    if (closed||signal?.aborted)return Promise.reject(signal?.reason??new DOMException('Render load gate closed','AbortError'));
    return pending.enqueue({bytes:Math.max(1, Number(estimate)||1), priority, signal, kind, bypassed:0}, task, residency?schedule:pump);
  }
  function onIdle(callback) {idleListeners.add(callback); if (!active&&!queue.length&&!bytes)schedule(); return () => idleListeners.delete(callback);}
  function dispose() {
    closed = true; off?.(); idleListeners.clear();
    pending.rejectAll(new DOMException('Render load gate closed','AbortError'));
  }
  return Object.freeze({run, onIdle, dispose, stats:() => ({active, foreground, speculative, queued:queue.length, reservedBytes:bytes, peakBytes, peakActive, bypasses, pressureSkips, handoffs, byteBudget, concurrency})});
}
