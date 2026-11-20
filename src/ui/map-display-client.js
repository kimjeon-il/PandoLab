import {createWorkerRpcClient} from '../runtime/worker-rpc.js';
import {createVerifiedCoreWorker} from '../runtime/core-wasm-loader.js';
import {workerAssetUrl} from '../runtime/worker-asset-url.js';

/** Send only changes from the Worker snapshot already acknowledged by RPC. */
export function createMapDisplayClient({
  createWorker = () => createVerifiedCoreWorker(workerAssetUrl(new URL('../rendering/workers/map-display-worker.js', import.meta.url)), {type: 'module'}),
} = {}) {
  let requestVersion = 0;
  let acknowledged = null;
  const createTransport = () => createWorkerRpcClient({createWorker,
    isCurrent: ({entry,message}) => entry.projectRevision === requestVersion && entry.projectRevision === message.projectRevision,
    onCrash: () => { acknowledged = null; },
  });
  let rpc = createTransport();

  async function prepare(entities, {signal} = {}) {
    const version = ++requestVersion;
    const next = new Map(entities.map(row => [row.id, row]));
    const transport = rpc;
    const request = base => transport.request('map.display', {
      baseVersion: base?.version ?? null, version, entityIds: [...next.keys()],
      upserts: entities.filter(row => {
        const previous = base?.entities.get(row.id);
        return !previous || previous.geometryKey !== row.geometryKey
          || previous.properties.entityKind !== row.properties.entityKind || previous.properties.parentId !== row.properties.parentId;
      }),
      removedIds: base ? [...base.entities.keys()].filter(id => !next.has(id)) : [],
    }, {signal, projectRevision: version});
    try {
      const response = await request(acknowledged);
      // A committed job can be cancelled before delivery, leaving the worker
      // ahead of the acknowledged base. A fresh snapshot reconciles that race.
      const accepted = response.result?.needsSnapshot ? await request(null) : response;
      if (accepted.result?.version !== version || !Array.isArray(accepted.result.segments))
        throw new TypeError('Territorial boundary Worker returned an invalid snapshot.');
      acknowledged = {version, entities: next};
      return accepted;
    } catch (error) {
      if (error.code === 'PL-MAP-DISPLAY-INITIALIZATION' && transport === rpc) {
        // Failed ESM imports remain rejected for this Worker's lifetime.
        transport.stop('map-display-initialization-failed');
        rpc = createTransport();
        acknowledged = null;
      }
      throw error;
    }
  }

  return Object.freeze({prepare, dispose: () => rpc.stop('map-display-disposed')});
}
