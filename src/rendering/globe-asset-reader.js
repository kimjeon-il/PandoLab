import { createStoredAssetLoader } from '../data/stored-asset-loader.js';
import { estimateGlobeTransferBytes, estimateGlobeWorkingBytes } from './globe-work-scheduler.js';

// Verified packet I/O and deferred-write accounting share a single owner.
export function createGlobeAssetReader({dataRevision, cacheBudget, residency, loadGate, workerGate, packetTasks, metrics, lifetime, resolveUrl}) {
  let persistenceBytes = 0, persistencePeakBytes = 0, persistenceSkipped = 0;
  function reserveDeferredWrite(bytes) {
    // Cache writes may retain the verified source and a Response copy.
    const size = bytes*2;
    if (persistenceBytes+size>cacheBudget.persistenceBytes) {persistenceSkipped++; return null;}
    const release = residency.reserve(size, {kind:'disk-cache-write', optional:true, trimFirst:false});
    if (!release) {persistenceSkipped++; return null;}
    persistenceBytes+=size; persistencePeakBytes = Math.max(persistencePeakBytes, persistenceBytes);
    let ended = false; return () => {if (ended)return; ended = true; persistenceBytes-=size; release();};
  }
  const loader = createStoredAssetLoader({dataRevision, cachePolicy:'immutable', deferCacheWrite:true, reserveDeferredWrite, resolveUrl});
  async function load(row, kind, {phase = 'startup', label = 'Three.js 지도 자산', signal = lifetime.signal, priority = phase==='startup'?10:0, ...parameters} = {}) {
    return loadGate.run({bytes:estimateGlobeTransferBytes(row), priority, signal, kind:'download-'+kind}, async({releaseAdmission}) => {
      const result = await loader.loadStoredAsset(row, phase, row.sha256, label, bytes => bytes, signal);
      try {
        return await workerGate.run({bytes:estimateGlobeWorkingBytes(row, kind), priority, signal, kind:'worker-'+kind}, () => {
          releaseAdmission();
          return metrics.track('three.decode-packet', () => packetTasks.decode(kind, result.value, row, {signal, priority, ...parameters}));
        });
      } finally {releaseAdmission();}
    });
  }
  async function loadTerritorialStroke(row, signal, priority, descriptor) {
    if (!descriptor.sources)return load(row,'stroke', {signal, priority});
    const transferBytes = descriptor.sources.reduce((sum, item) =>
      sum+Math.max(0, Number(item.spec.compressedBytes)||Number(item.spec.decodedBytes)||0)*3, 64*1024);
    return loadGate.run({bytes:transferBytes, priority, signal, kind:'download-border-batch'}, async({releaseAdmission}) => {
      // Fetch small partitions together, then hand their aggregate bytes to
      // the separately admitted Worker stage.
      const settled = await Promise.allSettled(descriptor.sources.map(async item => {
        signal.throwIfAborted();
        const result = await loader.loadStoredAsset(item.spec,'startup', item.spec.sha256,'역사 국경선', bytes => bytes, signal);
        signal.throwIfAborted();
        return {bytes:result.value, spec:item.spec};
      }));
      signal.throwIfAborted();
      const failed = settled.find(row => row.status==='rejected');
      if (failed)throw failed.reason;
      const inputs = settled.map(row => row.value);
      try {
        return await workerGate.run({bytes:estimateGlobeWorkingBytes(descriptor.spec,'stroke'), priority, signal, kind:'worker-border-batch'}, () => {
          releaseAdmission();
          return metrics.track('three.combine-borders', () => packetTasks.combineStoredStrokes(inputs, {signal, priority}));
        });
      } finally {releaseAdmission();}
    });
  }
  return Object.freeze({load, loadTerritorialStroke, stats:() => ({
    bytes:persistenceBytes, peakBytes:persistencePeakBytes, skipped:persistenceSkipped,
  })});
}
