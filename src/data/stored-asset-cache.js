import { maintainStoredContent, touchStoredContent } from './stored-content-cache.js';

const HASH = /^[a-f0-9]{64}$/;
const openCaches = new WeakMap();

function cacheHandles(storage) {
  let handles = openCaches.get(storage);
  if (!handles) {handles = new Map(); openCaches.set(storage, handles);}
  return handles;
}

function openStoredCache(storage, name) {
  const handles = cacheHandles(storage);
  let pending = handles.get(name);
  if (!pending) {
    pending = storage.open(name).catch(() => {
      if (handles.get(name)===pending)handles.delete(name);
      return null;
    });
    handles.set(name, pending);
  }
  return pending;
}

async function deleteStoredCache(storage, name) {
  const removed = await storage.delete(name);
  if (removed)cacheHandles(storage).delete(name);
  return removed;
}

export const hasImmutableAssetHash = value => HASH.test(value || '');

export function createStoredAssetCache({dataRevision, cacheStorage = globalThis.caches, cachePolicy = 'revision'} = {}) {
  const dataCachePrefix = 'pandolab-data-';
  const dataCacheName = dataCachePrefix + dataRevision;
  const immutableWorldCacheName = 'pandolab-world-content-v1';
  const legacyCoreCachePrefix = 'pandolab-core-';
  if (cachePolicy !== 'revision' && cachePolicy !== 'immutable')
    throw new Error('Unsupported stored asset cache policy');
  const activeCacheName = cachePolicy === 'immutable' ? immutableWorldCacheName : dataCacheName;
  let oldCacheCleanupPromise = null;

  function storedKey(spec, url) {
    if (cachePolicy !== 'immutable' || !hasImmutableAssetHash(spec.sha256)) return url;
    try {return new URL('/.pandolab-cache/content/' + spec.sha256, url).href;}
    catch {return url;}
  }

  async function findStored(cache, spec, url) {
    if (!cache) return null;
    const key = storedKey(spec, url);
    const response = await cache.match(key).catch(() => null);
    return response ? {key, response} : null;
  }

  async function openDataCache() {
    if (!cacheStorage) return null;
    return openStoredCache(cacheStorage, activeCacheName);
  }

  async function cleanupOldCoreCaches() {
    if (!cacheStorage) return;
    if (!oldCacheCleanupPromise) {
      oldCacheCleanupPromise = cacheStorage.keys()
        .then(names => Promise.all(names
          .filter(name => (typeof dataRevision === 'string' && name.startsWith(dataCachePrefix) && name !== dataCacheName)
            || name.startsWith(legacyCoreCachePrefix))
          .map(name => deleteStoredCache(cacheStorage, name))))
        .catch(() => []);
    }
    await oldCacheCleanupPromise;
  }

  async function cacheStoredBuffer(cache, url, storedBuffer, headers = null) {
    if (!cache) return false;
    const immutable = cachePolicy === 'immutable';
    const write = async () => {
      const metadata = new Headers(headers || undefined);
      if (immutable) {
        metadata.set('x-pandolab-stored-bytes', String(storedBuffer.byteLength));
        metadata.set('x-pandolab-stored-at', String(Date.now()));
      }
      await cache.put(url, new Response(storedBuffer, {headers: metadata}));
      if (immutable) {
        touchStoredContent(cache, url);
        await maintainStoredContent(cache);
      }
      return true;
    };
    try {return await write();}
    catch (_) {
      await cleanupOldCoreCaches();
      if (immutable) await maintainStoredContent(cache, {force: true});
      try {return await write();} catch {return false;}
    }
  }

  function touch(cache, key) {
    if (cachePolicy === 'immutable') touchStoredContent(cache, key);
  }

  return Object.freeze({storedKey, findStored, openDataCache, cleanupOldCoreCaches, cacheStoredBuffer, touch});
}
