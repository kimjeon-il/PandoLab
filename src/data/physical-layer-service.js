export const HYDRO_DATA_VERSION = '0.14.2';

async function fetchManifest({ fetchWithRetry, url, operation, onRetry, signal }) {
  return fetchWithRetry(url, {signal}, {
    maxAttempts: 3,
    baseDelay: 400,
    maxDelay: 2400,
    timeoutMs: 15000,
    onRetry: ({ attempt }) => onRetry(operation, attempt),
    consume:response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
  });
}

export function createHydroService({
  fetchWithRetry,
  dataVersion,
  manifestUrl,
  getLoadState,
  onLoading,
  onRetry,
  acceptManifest,
  onFailure,
  // Generation-specific requests can replace a pending older project load.
  loadKey = () => null,
  isLoadCurrent = () => true,
}) {
  let pendingLoad = null, pendingKey = null, readyKey = null, controller = null, parsed = null;

  function cancel() {
    controller?.abort(); controller = null; pendingLoad = null; pendingKey = null;
  }
  function load() {
    const key = loadKey();
    if (!isLoadCurrent(key))return Promise.resolve(false);
    if (pendingLoad&&Object.is(pendingKey, key))return pendingLoad;
    if (getLoadState()==='ready'&&Object.is(readyKey, key))
      return Promise.resolve(true);
    cancel();
    controller = new AbortController();
    const {signal} = controller;
    const task = Promise.resolve().then(() => loadManifest(key, signal)).finally(() => {
      if (pendingLoad===task) {pendingLoad = null; pendingKey = null; controller = null;}
    });
    pendingKey = key; pendingLoad = task;
    return task;
  }

  async function loadManifest(key, signal) {
    const isCurrent = () => !signal.aborted&&isLoadCurrent(key);
    if (!isCurrent())return false;
    onLoading();
    try {
      const url = manifestUrl();
      const manifest = parsed&&Object.is(parsed.key, key)?parsed.manifest:
        await fetchManifest({fetchWithRetry, url, operation:'hydro-manifest', onRetry, signal});
      if (!isCurrent())return false;
      if (manifest.version!==dataVersion||manifest.schema!=='pandolab-water-shards-v5')
        throw new Error('수계 타일 버전이 맞지 않습니다.');
      parsed = {key, manifest};
      const accepted = await acceptManifest(manifest, url, {key, isCurrent});
      if (!isCurrent())return false;
      if (!accepted)throw new Error('수계 Worker 초기화에 실패했습니다.');
      readyKey = key;
      return true;
    } catch (error) {
      // A previous project's rejected network/Worker reply must never
      // alter the active project's load status or surface an obsolete error.
      if (isCurrent())onFailure(error);
      return false;
    }
  }

  return Object.freeze({load, cancel});
}
