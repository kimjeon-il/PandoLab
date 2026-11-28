import { createStoredAssetLoader } from '../data/stored-asset-loader.js';
import { estimateGlobeWorkingBytes } from './globe-work-scheduler.js';

// Verified packet I/O and deferred-write accounting share a single owner.
export function createGlobeAssetReader({dataRevision, cacheBudget, residency, loadGate, packetTasks, metrics, lifetime, resolveUrl}) {
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
    return loadGate.run({bytes:estimateGlobeWorkingBytes(row, kind), priority, signal, kind:'load-'+kind}, async({handoff}) => {
      const result = await loader.loadStoredAsset(row, phase, row.sha256, label, bytes => bytes, signal);
      handoff();
      return metrics.track('three.decode-packet', () => packetTasks.decode(kind, result.value, row, {signal, priority, ...parameters}));
    });
  }
  async function loadTerritorialStroke(row, signal, priority, descriptor, label = '역사 국경선') {
    if (!descriptor.sources)return load(row,'stroke', {signal, priority});
    return loadGate.run({bytes:estimateGlobeWorkingBytes(descriptor.spec,'stroke'), priority, signal, kind:'load-stroke-batch'}, async({handoff}) => {
      // Fetch small partitions together, then hand their aggregate bytes to
      // the separately admitted Worker stage.
      const settled = await Promise.allSettled(descriptor.sources.map(async item => {
        signal.throwIfAborted();
        const result = await loader.loadStoredAsset(item.spec,'startup', item.spec.sha256,label, bytes => bytes, signal);
        signal.throwIfAborted();
        return {bytes:result.value, spec:item.spec};
      }));
      signal.throwIfAborted();
      const failed = settled.find(row => row.status==='rejected');
      if (failed)throw failed.reason;
      const inputs = settled.map(row => row.value);
      handoff();
      return metrics.track(descriptor.aggregateErrorScale?'three.aggregate-river-strokes':'three.combine-strokes', () =>
        descriptor.aggregateErrorScale
          ?packetTasks.aggregateStoredStrokes(inputs,{signal,priority,lod:descriptor.lod,errorScale:descriptor.aggregateErrorScale,
            maxRun:descriptor.aggregateMaxRun,protectedBounds:descriptor.aggregateBounds,
            gridDivisions:descriptor.aggregateGridDivisions??0,preserveOwners:descriptor.aggregatePreserveOwners??true})
          :packetTasks.combineStoredStrokes(inputs,{signal,priority}));
    });
  }
  return Object.freeze({load, loadTerritorialStroke, stats:() => ({
    bytes:persistenceBytes, peakBytes:persistencePeakBytes, skipped:persistenceSkipped,
  })});
}
