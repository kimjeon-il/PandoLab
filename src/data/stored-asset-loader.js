import { fetchWithRetry, isRetryableHttpStatus, withRetry } from "../runtime/reliability-core.js";
import { createExternalRuntimeDataFetch } from './external-runtime-data.js';
import {maintainStoredContent,touchStoredContent} from './stored-content-cache.js';
import {decodeStoredBuffer,validateAssetLength} from './asset-decompression.js';

const immutableFlightsByStorage = new WeakMap();
const HASH = /^[a-f0-9]{64}$/;

function waitForConsumer(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, {once:true});
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// Shared stored-byte cache, integrity and decoding owner for packed world and catalog assets.
export function createStoredAssetLoader({dataRevision, resolveUrl, report = () => {}, fetchFn = globalThis.fetch, cacheStorage = globalThis.caches, cachePolicy = 'revision',deferCacheWrite = false,subtle=globalThis.crypto?.subtle}) {
 const flightScope = cacheStorage ?? fetchFn;
 if (cachePolicy === 'immutable' && !immutableFlightsByStorage.has(flightScope))
   immutableFlightsByStorage.set(flightScope, new Map());
 const storedFlights = immutableFlightsByStorage.get(flightScope);
 fetchFn = createExternalRuntimeDataFetch({meta:globalThis.PANDOLAB_BUILD_META,fetchFn});
 const DATA_CACHE_PREFIX = 'pandolab-data-';
 const DATA_CACHE_NAME = DATA_CACHE_PREFIX + dataRevision;
 const IMMUTABLE_WORLD_CACHE_NAME = 'pandolab-world-content-v1';
 if (cachePolicy !== 'revision' && cachePolicy !== 'immutable') throw new Error('Unsupported stored asset cache policy');
 const ACTIVE_CACHE_NAME = cachePolicy === 'immutable' ? IMMUTABLE_WORLD_CACHE_NAME : DATA_CACHE_NAME;
 const LEGACY_CORE_CACHE_PREFIX = 'pandolab-core-';
 let dataCachePromise = null;
 let oldCacheCleanupPromise = null;
 function storedKey(spec,url){
   if(cachePolicy!=='immutable'||!HASH.test(spec.sha256||''))return url;
   try{return new URL('/.pandolab-cache/content/'+spec.sha256,url).href;}
   catch{return url;}
 }
 async function findStored(cache,spec,url){
   if(!cache)return null;
   const key=storedKey(spec,url);
   const response=await cache.match(key).catch(()=>null);
   if(response)return {key,response};
   if(String(key)===String(url))return null;
   const legacy=await cache.match(url).catch(()=>null);
   return legacy?{key:url,response:legacy}:null;
 }
 async function hasStoredAsset(spec){
   const match=await findStored(await openDataCache(),spec,resolveAssetUrl(spec));
   if(!match)return false;
   // A cache hit here is only a planning hint. Actual reads always verify.
   try{match.response.body?.cancel().catch(()=>{});}catch{}
   return true;
 }
async function openDataCache() {
  if (!cacheStorage) return null;
  if (!dataCachePromise) dataCachePromise = cacheStorage.open(ACTIVE_CACHE_NAME).catch(() => null);
  return dataCachePromise;
}

async function cleanupOldCoreCaches() {
  if (!cacheStorage) return;
  if (!oldCacheCleanupPromise) {
    oldCacheCleanupPromise = cacheStorage.keys()
      .then(names => Promise.all(names
      .filter(name => (typeof dataRevision==='string' && name.startsWith(DATA_CACHE_PREFIX) && name !== DATA_CACHE_NAME)
        || name.startsWith(LEGACY_CORE_CACHE_PREFIX))
        .map(name => cacheStorage.delete(name))))
      .catch(() => []);
  }
  await oldCacheCleanupPromise;
}

async function cacheStoredBuffer(cache,url,storedBuffer,headers=null){
  if(!cache)return false;
  const immutable=cachePolicy==='immutable';
  const write=async()=>{
    const metadata=new Headers(headers||undefined);
    if(immutable){metadata.set('x-pandolab-stored-bytes',String(storedBuffer.byteLength));metadata.set('x-pandolab-stored-at',String(Date.now()));}
    await cache.put(url,new Response(storedBuffer,{headers:metadata}));
    if(immutable){touchStoredContent(cache,url);await maintainStoredContent(cache);}
    return true;
  };
  try{return await write();}
  catch(_){
    await cleanupOldCoreCaches();
    if(immutable)await maintainStoredContent(cache,{force:true});
    try{return await write();}catch{return false;}
  }
}

function countedStream(stream, onChunk, signal = null) {
  if (!stream || typeof TransformStream !== 'function') return stream;
  return stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      onChunk(chunk.byteLength);
      controller.enqueue(chunk);
    },
  }), signal ? { signal } : undefined);
}

async function consumeStoredResponse(response, spec, phase, key, label, source, touch = () => {}, signal = null) {
  const startedAt = performance.now();
  let storedBytes = 0;
  const expectedStored = Number(spec.compressedBytes || 0);
  if (response.body && typeof TransformStream === 'function') {
    const stream = countedStream(response.body, length => {
      storedBytes += length;
      if(expectedStored>0&&storedBytes>expectedStored)throw Error(`${label} 저장 크기가 올바르지 않습니다.`);
      touch();
      report(phase, key, `${label}: ${source === 'cache' ? '저장된 데이터를 읽는' : '다운로드하는'} 중입니다.`, storedBytes, expectedStored);
    }, signal);
    const storedBuffer = await new Response(stream).arrayBuffer();
    return {
      storedBuffer,
      source,
      transferredBytes: source === 'network' ? storedBytes : 0,
      storedBytes,
      readMs: performance.now() - startedAt,
    };
  }

  const storedBuffer = await response.arrayBuffer();
  storedBytes = storedBuffer.byteLength;
  return {
    storedBuffer,
    source,
    transferredBytes: source === 'network' ? storedBytes : 0,
    storedBytes,
    readMs: performance.now() - startedAt,
  };
}


function resolveAssetUrl(spec) { return resolveUrl(spec); }

function validateStoredSize(storedBuffer, spec, label) {
  const expectedBytes = Number(spec.compressedBytes || 0);
  if (expectedBytes > 0 && storedBuffer.byteLength !== expectedBytes) throw new Error(`${label} 저장 크기가 올바르지 않습니다.`);
}

async function validateStoredAsset(storedBuffer, spec, label) {
  validateStoredSize(storedBuffer, spec, label);
  const expectedHash = String(spec.sha256 || '').toLowerCase();
  if (!expectedHash) return;
  if (!subtle) throw new Error(`${label} 무결성을 확인할 수 없습니다.`);
  const digest = await subtle.digest('SHA-256', storedBuffer);
  const actualHash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (actualHash !== expectedHash) throw new Error(`${label} 무결성 검증에 실패했습니다.`);
}


async function downloadStoredAsset({url,spec,phase,key,label,signal,attempt}) {
  let responseHeaders;
  const read=await fetchWithRetry(url,{cache:attempt===1?'default':'reload',signal},{
    fetchFn,maxAttempts:1,timeoutMs:30000,
    consume:(response,{touch,signal:requestSignal})=>{
      if(!response.ok)throw Object.assign(new Error(`${label} 요청에 실패했습니다. (${response.status})`),{httpStatus:response.status});
      responseHeaders=response.headers;
      return consumeStoredResponse(response,spec,phase,key,label,'network',touch,requestSignal);
    },
  });
  signal?.throwIfAborted();
  await validateStoredAsset(read.storedBuffer,spec,label);
  return {read,responseHeaders};
}

function persistDownload(cache,cacheKey,read,responseHeaders,phase,key,label) {
  const started=performance.now();
  report(phase,`${key}-cache-write`,`${label}: 다운로드한 데이터를 저장하는 중입니다.`,0,1);
  return cacheStoredBuffer(cache,cacheKey,read.storedBuffer,responseHeaders).then(cached=>{
    const cacheWriteMs=performance.now()-started;
    report(phase,`${key}-cache-write`,`${label}: 저장을 마쳤습니다.`,1,1,true,{cached});
    return {cached,cacheWriteMs};
  });
}

async function readImmutableCache(cache,spec,url,phase,key,label,signal) {
  signal.throwIfAborted();
  const match=await findStored(cache,spec,url);
  if (!match) return null;
  try {
    signal.throwIfAborted();
    const read=await consumeStoredResponse(match.response,spec,phase,key,label,'cache',undefined,signal);
    await validateStoredAsset(read.storedBuffer,spec,label);
    signal.throwIfAborted();
    touchStoredContent(cache,match.key);
    return read;
  } catch (error) {
    if (signal.aborted || error?.name==='AbortError') throw error;
    await cache.delete(match.key).catch(()=>false);
    report(phase,`${key}-cache-repair`,`${label}: 손상된 저장 데이터를 지웠습니다.`,1,1,true,{source:'cache',recovered:true});
    return null;
  }
}

async function loadImmutable(spec,phase,key,label,validate,signal,representation,cachedOnly) {
  const url=resolveAssetUrl(spec),cacheKey=storedKey(spec,url);
  let flight=storedFlights.get(cacheKey);
  if (!flight) {
    const controller=new AbortController(),cache=openDataCache();
    flight={controller,cache,users:0,network:null,writing:null,transferClaimed:false,
      cached:cache.then(opened=>readImmutableCache(opened,spec,url,phase,key,label,controller.signal))};
    storedFlights.set(cacheKey,flight);
  }
  const release=()=>{
    if (flight.users===0 && storedFlights.get(cacheKey)===flight) storedFlights.delete(cacheKey);
  };
  flight.users++;
  try {
    let read=await waitForConsumer(flight.cached,signal);
    signal?.throwIfAborted();
    let attempt=0;
    if (!read) {
      if (cachedOnly) return null;
      flight.network??=withRetry(async({attempt:current,signal:flightSignal})=>{
        const {read,responseHeaders}=await downloadStoredAsset({url,spec,phase,key,label,signal:flightSignal,attempt:current});
        flightSignal.throwIfAborted();
        const cache=await flight.cache;
        flightSignal.throwIfAborted();
        flight.writing=persistDownload(cache,cacheKey,read,responseHeaders,phase,key,label);
        // A deferred caller may leave before the write settles.
        flight.writing.catch(()=>{});
        return {read,attempt:current};
      },{
        signal:flight.controller.signal,maxAttempts:3,baseDelay:500,maxDelay:1000,jitter:0,
        shouldRetry:error=>!Number.isFinite(error?.httpStatus)||isRetryableHttpStatus(error.httpStatus),
        onRetry:current=>report(phase,`${key}-retry`,`${label} 준비를 다시 시도합니다. (${current+1}/3)`,1,1,false,{attempt:current}),
      });
      ({read,attempt}=await waitForConsumer(flight.network,signal));
    }
    signal?.throwIfAborted();
    validateStoredSize(read.storedBuffer,spec,label);
    const decoding=(async()=>{
      // Raw buffers may be mutated or transferred by a consumer.
      const input=representation==='stored'||spec.encoding!=='gzip'?read.storedBuffer.slice(0):read.storedBuffer;
      const decoded=representation==='decoded'?await decodeStoredBuffer(input,spec,phase,key,label,signal,report):
        {buffer:input,decodedBytes:input.byteLength,decompressMs:0};
      if (representation==='decoded') validateAssetLength(decoded,spec,label);
      return {...decoded,value:await validate(decoded.buffer,label)};
    })();
    // A verified immutable packet may be published before disk-cache I/O
    // completes. Other consumers keep the original synchronous persistence
    // contract; the shared flight remains alive until its write settles.
    const writing=read.source==='cache'?Promise.resolve({cached:true,cacheWriteMs:0}):flight.writing;
    const [decoded,{cached,cacheWriteMs}]=await waitForConsumer(
      Promise.all([decoding,deferCacheWrite&&read.source!=='cache'
        ?{cached:null,cacheWriteMs:null}:writing]),signal);
    signal?.throwIfAborted();
    const cacheHit=read.source==='cache';
    const transferredBytes=flight.transferClaimed?0:read.transferredBytes;
    if (transferredBytes) flight.transferClaimed=true;
    report(phase,key,`${label}: ${cacheHit?'저장된 데이터를 확인했습니다.':'다운로드를 완료했습니다.'}`,
      read.storedBytes,read.storedBytes,true,{source:read.source,cached,...(cached===null?{cacheWritePending:true}:{}),attempt});
    return {...read,...decoded,get storedBuffer(){return read.storedBuffer.slice(0);},transferredBytes,
      cacheWriteMs,milliseconds:read.readMs+(cacheWriteMs??0)+decoded.decompressMs,cacheHit};
  } catch (error) {
    if (!cachedOnly || signal?.aborted || error?.name==='AbortError') throw error;
    return null;
  } finally {
    if (--flight.users===0) {
      if (flight.writing) flight.writing.then(release,release);
      else {
        release();
        flight.controller.abort();
      }
    }
  }
}

async function loadRepresentation(spec, phase, key, label, validate, signal, representation, cachedOnly=false) {
  signal?.throwIfAborted();
  if (cachePolicy==='immutable' && HASH.test(spec.sha256||''))
    return loadImmutable(spec,phase,key,label,validate,signal,representation,cachedOnly);
  const decode=buffer=>representation==='decoded' ? decodeStoredBuffer(buffer,spec,phase,key,label,signal,report):Promise.resolve({buffer,decodedBytes:buffer.byteLength,decompressMs:0});
  const url = resolveAssetUrl(spec);
  const cache = await openDataCache(),cacheKey=storedKey(spec,url);
  if (cache) {
    const match=await findStored(cache,spec,url);
    if (match) {
      const cached=match.response;
      try {
        signal?.throwIfAborted();
        const read = await consumeStoredResponse(cached, spec, phase, key, label, 'cache', () => {}, signal);
        await validateStoredAsset(read.storedBuffer, spec, label);
        const decoded = await decode(read.storedBuffer);
        const result = {
          ...read,
          ...decoded,
          cacheWriteMs: 0,
          milliseconds: read.readMs + decoded.decompressMs,
        };
        if(representation==='decoded')validateAssetLength(result, spec, label);
        const value = await validate(result.buffer, label);
        signal?.throwIfAborted();
        report(phase, key, `${label}: 저장된 데이터를 확인했습니다.`, Number(spec.compressedBytes || result.storedBytes), Number(spec.compressedBytes || result.storedBytes), true, { source: 'cache' });
        if(cachePolicy==='immutable')touchStoredContent(cache,match.key);
        return { ...result, value, cacheHit: true };
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        await cache.delete(match.key).catch(() => false);
        report(phase, `${key}-cache-repair`, `${label}: 손상된 저장 데이터를 지우고 다시 받습니다.`, 1, 1, true, { source: 'cache', recovered: true });
      }
    }
  }

  if(cachedOnly)return null;
  // Aborts and terminal HTTP errors propagate immediately.
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const {read,responseHeaders}=await downloadStoredAsset({url,spec,phase,key,label,signal,attempt});
      signal?.throwIfAborted();
      // Verified stored bytes can be persisted while independent decoding
      // proceeds. Settle both operations before retry/delete, even on failure.
      const writing=persistDownload(cache,cacheKey,read,responseHeaders,phase,key,label);
      // Format validation (including independent content digest) can also
      // run before persistent-cache I/O finishes. Await both on failure.
      const decoding=decode(read.storedBuffer).then(async decoded=>{
        if(representation==='decoded')validateAssetLength(decoded,spec,label);
        const value=await validate(decoded.buffer,label);
        signal?.throwIfAborted();return {decoded,value};
      });
      const [written,unpacked]=await Promise.allSettled([writing,decoding]);
      if(written.status==='rejected')throw written.reason;
      if(unpacked.status==='rejected')throw unpacked.reason;
      const {cached,cacheWriteMs}=written.value,{decoded,value}=unpacked.value;
      const result = {
        ...read,
        ...decoded,
        cacheWriteMs,
        milliseconds: read.readMs + cacheWriteMs + decoded.decompressMs,
      };
      signal?.throwIfAborted();
      report(phase, key, `${label}: 다운로드를 완료했습니다.`, Number(spec.compressedBytes || result.storedBytes), Number(spec.compressedBytes || result.storedBytes), true, { source: 'network', cached, attempt });
      return { ...result, value, cacheHit: false };
    } catch (error) {
      lastError = error;
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      if (Number.isFinite(error?.httpStatus) && !isRetryableHttpStatus(error.httpStatus)) throw error;
      if (cache) await cache.delete(cacheKey).catch(() => false);
      if (attempt < 3) {
        report(phase, `${key}-retry`, `${label} 준비를 다시 시도합니다. (${attempt + 1}/3)`, attempt, 3, false, { attempt });
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastError || new Error(`${label}을 준비하지 못했습니다.`);
}


const loadAsset=(spec,phase,key,label,validate,signal=null)=>loadRepresentation(spec,phase,key,label,validate,signal,'decoded');
const loadStoredAsset=(spec,phase,key,label,validateStoredBytes,signal=null)=>{
 if(typeof validateStoredBytes!=='function')throw new TypeError('A stored-byte format validator is required.');
 return loadRepresentation(spec,phase,key,label,validateStoredBytes,signal,'stored');
};
const loadCachedAsset=(spec,phase,key,label,validate,signal=null)=>loadRepresentation(spec,phase,key,label,validate,signal,'decoded',true);
const loadCachedStoredAsset=(spec,phase,key,label,validate,signal=null)=>loadRepresentation(spec,phase,key,label,validate,signal,'stored',true);
async function decodeStoredAsset(storedBuffer,spec,phase,key,label,validate,{persist=false}={}) {
 await validateStoredAsset(storedBuffer,spec,label);
 const result=await decodeStoredBuffer(storedBuffer,spec,phase,key,label,null,report);
 validateAssetLength(result,spec,label);
 const value=await validate(result.buffer,label);
 if(persist)await cacheStoredBuffer(await openDataCache(),storedKey(spec,resolveAssetUrl(spec)),storedBuffer);
 return {...result,value};
}
return Object.freeze({loadAsset,loadStoredAsset,loadCachedAsset,loadCachedStoredAsset,hasStoredAsset,decodeStoredAsset,cleanupOldCoreCaches});
}
