/* Verified shard and range reads for the hydro Worker. */
'use strict';
function createHydroShardStore({ fetchResponse, openCache, resolveUrl, gunzip, digest,
  sharedBundle = null, onWholeBundle = null }) {
  const memory = new Map();
  const rangeReads = new Map(), recoveries = new Map(), fullReads = new Map();
  const queue = [], activeByShard = new Map();
  const now = () => globalThis.performance?.now() ?? Date.now();
  const stats = {queueMs: 0, fetchMs: 0, gunzipMs: 0, rangeRequests: 0, recoveryRequests: 0, fullResponses: 0};
  let active = 0;
  const deadline = signal => signal
    ? globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(15000)])
    : globalThis.AbortSignal.timeout(15000);
  const inContainer = spec => Number.isSafeInteger(spec.offset) &&
    Number.isSafeInteger(spec.fileBytes) && spec.offset >= 0 &&
    spec.bytes > 0 && spec.offset + spec.bytes <= spec.fileBytes;
  const containerBytes = (spec, all, diagnostic) => {
    if (all.length !== spec.fileBytes) throw invalid('통합 수계 전체 길이가 일치하지 않습니다.',
      { ...diagnostic, stage: 'container-length', actualLength: all.length });
    return all.subarray(spec.offset, spec.offset + spec.bytes);
  };
  const cacheKey = spec => {
    const url = resolveUrl(spec.url);
    return inContainer(spec) ? url + (url.includes('?') ? '&' : '?') +
      '__hydro_segment=' + spec.id : url;
  };
  async function cachedBundlePart(spec, diagnostic) {
    if (!inContainer(spec) || !sharedBundle) return null;
    const all = await sharedBundle();
    if (!all) return null;
    return validate(spec, containerBytes(spec, all, diagnostic), diagnostic);
  }
  function pump() {
    while (active < 4) {
      const index = queue.findIndex(({shard}) => (activeByShard.get(shard) || 0) < 2);
      if (index === -1) return;
      const [job] = queue.splice(index, 1);
      stats.queueMs += now() - job.enqueuedAt;
      job.signal.removeEventListener('abort', job.cancel);
      active++;
      activeByShard.set(job.shard, (activeByShard.get(job.shard) || 0) + 1);
      Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
        active--;
        const count = activeByShard.get(job.shard) - 1;
        if (count) activeByShard.set(job.shard, count);
        else activeByShard.delete(job.shard);
        pump();
      });
    }
  }
  function scheduled(shard, signal, run) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const job = {shard, signal, run, resolve, reject, enqueuedAt: now(), cancel: () => {
        queue.splice(queue.indexOf(job), 1);
        reject(signal.reason);
      }};
      queue.push(job);
      signal.addEventListener('abort', job.cancel, {once: true});
      pump();
    });
  }
  function existing(flights, key) {
    const flight = flights.get(key);
    return flight?.controller.signal.aborted ? null : flight;
  }
  function share(flights, key, signal, run) {
    signal.throwIfAborted();
    let flight = existing(flights, key);
    if (!flight) {
      flight = {controller: new AbortController(), consumers: 0, settled: false};
      flight.task = Promise.resolve().then(() => run(flight.controller.signal)).finally(() => {
        flight.settled = true;
        if (flights.get(key) === flight) flights.delete(key);
      });
      flights.set(key, flight);
    }
    return subscribe(flight, signal);
  }
  function subscribe(flight, signal) {
    signal.throwIfAborted();
    flight.consumers++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        if (--flight.consumers === 0 && !flight.settled) flight.controller.abort(signal.reason);
        callback(value);
      };
      const cancel = () => finish(reject, signal.reason);
      signal.addEventListener('abort', cancel, {once: true});
      flight.task.then(value => finish(resolve, value), error => finish(reject, error));
    });
  }
  function fullKey(spec) {
    return inContainer(spec) ? resolveUrl(spec.url) : cacheKey(spec);
  }
  function readFull(spec, response, signal, controller) {
    const key = fullKey(spec);
    const full = existing(fullReads, key);
    if (full) {
      const result = subscribe(full, signal);
      response.body?.cancel().catch(() => {});
      return result;
    }
    return share(fullReads, key, signal, async sharedSignal => {
      stats.fullResponses++;
      const abort = () => controller.abort(sharedSignal.reason);
      sharedSignal.addEventListener('abort', abort, {once: true});
      try {
        sharedSignal.throwIfAborted();
        const raw = new Uint8Array(await response.arrayBuffer());
        sharedSignal.throwIfAborted();
        if (inContainer(spec)) await onWholeBundle?.(raw);
        else await validate(spec, raw, {shardId: spec.id, source: 'network-full'});
        return raw;
      } finally {
        sharedSignal.removeEventListener('abort', abort);
      }
    });
  }
  async function readResponse(spec, start, end, signal, {recovery = false} = {}) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const started = now();
    if (recovery) stats.recoveryRequests++;
    else stats.rangeRequests++;
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    try {
      const init = {signal: controller.signal};
      if (recovery) init.cache = 'no-store';
      if (!recovery || inContainer(spec)) init.headers = {Range: `bytes=${start}-${end - 1}`};
      const response = await fetchResponse(resolveUrl(spec.url), init, {signal: controller.signal, ...(recovery && {attempts: 1})});
      signal.throwIfAborted();
      const status = response.status, contentRange = response.headers.get('Content-Range');
      if (!response.ok) return {status, contentRange, ok: false};
      if (status === 200) {
        // The complete body can outlive this Range's original subscriber.
        signal.removeEventListener('abort', abort);
        const raw = await readFull(spec, response, signal, controller);
        return {status, contentRange, ok: true, raw};
      }
      const raw = new Uint8Array(await response.arrayBuffer());
      signal.throwIfAborted();
      return {status, contentRange, ok: true, raw};
    } finally {
      signal.removeEventListener('abort', abort);
      stats.fetchMs += now() - started;
    }
  }
  function invalid(message, diagnostic) {
    return Object.assign(new Error(message), { corrupt: true, diagnostic });
  }
  function remember(spec, bytes) {
    memory.delete(spec.id);
    memory.set(spec.id, bytes);
    if (memory.size > 2) memory.delete(memory.keys().next().value);
    return bytes;
  }
  async function validate(spec, bytes, diagnostic) {
    if (bytes.length !== spec.bytes) throw invalid('수계 파일 길이가 일치하지 않습니다.', { ...diagnostic, stage: 'length', actualLength: bytes.length });
    const hash = await digest(bytes);
    if (hash !== spec.sha256) throw invalid('수계 파일 해시가 일치하지 않습니다.', { ...diagnostic, stage: 'hash', actualLength: bytes.length });
    return bytes;
  }
  async function save(spec, bytes) {
    const cache = await openCache();
    if (cache) {
      try { await cache.put(cacheKey(spec), new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } })); }
      catch (_) { /* Verified data remains available without persistent storage. */ }
    }
    return remember(spec, bytes);
  }
  async function cached(spec) {
    if (memory.has(spec.id)) return { bytes: remember(spec, memory.get(spec.id)), source: 'memory' };
    const cache = await openCache();
    let response;
    try { response = await cache?.match(cacheKey(spec)); } catch (_) { return null; }
    if (!response) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    await validate(spec, bytes, { shardId: spec.id, source: 'cache' });
    return { bytes: remember(spec, bytes), source: 'cache' };
  }
  async function downloadRecoveryShard(spec, signal) {
    signal.throwIfAborted();
    const diagnostic = { shardId: spec.id, source: 'recovery', recovery: true };
    const shared = await cachedBundlePart(spec, diagnostic);
    if (shared) return save(spec, shared);
    const contained = inContainer(spec);
    const absoluteStart = contained ? spec.offset : 0;
    const absoluteEnd = contained ? spec.offset + spec.bytes : spec.bytes;
    const full = existing(fullReads, fullKey(spec));
    if (full) {
      const raw = await subscribe(full, signal);
      const bytes = contained ? containerBytes(spec, raw, diagnostic) : raw;
      await validate(spec, bytes, diagnostic);
      signal.throwIfAborted();
      return save(spec, bytes);
    }
    const {status, contentRange, raw} = await scheduled(spec.id, signal,
      () => readResponse(spec, absoluteStart, absoluteEnd, signal, {recovery: true}));
    diagnostic.status = status;
    diagnostic.contentRange = contentRange;
    signal.throwIfAborted();
    let bytes;
    if (contained && status === 206) {
      if (diagnostic.contentRange !== `bytes ${absoluteStart}-${absoluteEnd - 1}/${spec.fileBytes}` ||
          raw?.length !== spec.bytes)
        throw invalid('통합 수계 부분 다운로드 범위가 올바르지 않습니다.',
          { ...diagnostic, stage: 'content-range' });
      bytes = raw;
    } else if (status === 200) {
      bytes = contained ? containerBytes(spec, raw, diagnostic) : raw;
    } else {
      throw invalid('수계 전체 파일 응답이 올바르지 않습니다.', { ...diagnostic, stage: 'response' });
    }
    await validate(spec, bytes, diagnostic);
    signal.throwIfAborted();
    return save(spec, bytes);
  }
  async function recover(spec, error, signal) {
    signal.throwIfAborted();
    memory.delete(spec.id);
    const cache = await openCache();
    try { await cache?.delete(cacheKey(spec)); } catch (_) { /* Memory recovery still works. */ }
    try { return await downloadRecoveryShard(spec, signal); }
    catch (failure) {
      signal.throwIfAborted();
      failure.diagnostic = { ...error.diagnostic, ...failure.diagnostic, recovery: true, stage: failure.diagnostic?.stage || 'recovery-download' };
      throw failure;
    }
  }
  function decode(spec, rows, bytes, base, source, responseDiagnostic = {}) {
    return rows.map(row => {
      const diagnostic = { ...responseDiagnostic, shardId: spec.id, packId: row.id, start: row.offset, end: row.offset + row.length - 1, actualLength: bytes.length, source, stage: 'gzip', recovery: source === 'recovery' };
      const start = row.offset - base;
      if (start < 0 || start + row.length > bytes.length) throw invalid('수계 pack 범위가 올바르지 않습니다.', diagnostic);
      const started = now();
      try { return [row.id, gunzip(bytes.subarray(start, start + row.length))]; }
      catch (error) { throw invalid(error.message || 'invalid gzip data', diagnostic); }
      finally { stats.gunzipMs += now() - started; }
    });
  }
  async function loadRange(spec, start, end, signal) {
    signal.throwIfAborted();
    const hit = await cached(spec);
    signal.throwIfAborted();
    if (hit) return {...hit, base: 0};
    const contained = inContainer(spec);
    const bundleDiagnostic = {shardId: spec.id, source: 'shared-container'};
    const bundlePart = await cachedBundlePart(spec, bundleDiagnostic);
    signal.throwIfAborted();
    if (bundlePart) return {bytes: bundlePart, base: 0, source: 'shared-container'};
    return scheduled(spec.id, signal, async () => {
      // Earlier lanes might have populated the verified shard while this
      // one waited for capacity.
      if (memory.has(spec.id)) return {bytes: remember(spec, memory.get(spec.id)), base: 0, source: 'memory'};
      const shared = await cachedBundlePart(spec, bundleDiagnostic);
      if (shared) return {bytes: shared, base: 0, source: 'shared-container'};
      const absoluteStart = (contained ? spec.offset : 0) + start;
      const absoluteEnd = (contained ? spec.offset : 0) + end;
      const response = await readResponse(spec, absoluteStart, absoluteEnd, signal);
      const {status, contentRange, raw} = response;
      const diagnostic = {shardId: spec.id, start: absoluteStart, end: absoluteEnd - 1,
        source: 'network-range', status, contentRange, stage: 'range', actualLength: raw?.length};
      if (!response.ok) throw Object.assign(new Error(`수계 HTTP ${status}`), {diagnostic});
      if (status === 206) {
        if (contentRange !== `bytes ${absoluteStart}-${absoluteEnd - 1}/${contained ? spec.fileBytes : spec.bytes}`
          || raw.length !== end - start) throw invalid('수계 부분 응답 범위가 일치하지 않습니다.', diagnostic);
        return {bytes: raw, base: start, source: 'network-range', diagnostic};
      }
      if (status !== 200) throw invalid('수계 응답 상태가 올바르지 않습니다.', diagnostic);
      const bytes = contained ? containerBytes(spec, raw, diagnostic) : raw;
      if (contained) await validate(spec, bytes, diagnostic);
      signal.throwIfAborted();
      await save(spec, bytes);
      return {bytes, base: 0, source: 'network-full', diagnostic};
    });
  }
  return {
    stats: () => ({...stats}),
    async read(spec, rows, start, end, viewSignal = null) {
      const signal = deadline(viewSignal), key = cacheKey(spec);
      try {
        const result = await share(rangeReads, JSON.stringify([key,start,end]), signal,
          sharedSignal => loadRange(spec, start, end, sharedSignal));
        signal.throwIfAborted();
        return decode(spec, rows, result.bytes, result.base, result.source, result.diagnostic);
      } catch (error) {
        signal.throwIfAborted();
        if (!error.corrupt || error.retryable === false) throw error;
        const bytes = await share(recoveries, key, signal, sharedSignal => recover(spec, error, sharedSignal));
        signal.throwIfAborted();
        try { return decode(spec, rows, bytes, 0, 'recovery'); }
        catch (failure) {
          memory.delete(spec.id);
          const cache = await openCache();
          try { await cache?.delete(cacheKey(spec)); } catch (_) {}
          throw failure;
        }
      }
    },
  };
}
self.createHydroShardStore = createHydroShardStore;
