export async function decodeStoredBuffer(storedBuffer, spec, phase, key, label, signal = null, report = () => {}) {
  signal?.throwIfAborted();
  const startedAt = performance.now();
  let buffer = storedBuffer;
  if (spec.encoding === 'gzip') {
    if (typeof DecompressionStream !== 'function') throw new Error(`이 브라우저는 ${label} 압축 해제를 지원하지 않습니다.`);
    report(phase, `${key}-decode`, `${label}: 압축을 해제하는 중입니다.`);
    let decoded = new Blob([storedBuffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    const limit=spec.maxDecodedBytes??(Number.isSafeInteger(spec.decodedBytes)&&spec.decodedBytes>0?spec.decodedBytes:undefined);
    if(limit!==undefined||signal){
      if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<1))throw Error('Invalid decoded asset limit');
      let bytes=0;
      decoded=decoded.pipeThrough(new TransformStream({transform(chunk,controller){
        bytes+=chunk.byteLength;
        if(limit!==undefined&&bytes>limit)throw Error(`${label} 압축 해제 크기가 허용된 한도를 초과합니다.`);
        controller.enqueue(chunk);
      }}),signal?{signal}:undefined);
    }
    buffer = await new Response(decoded).arrayBuffer();
  }
  signal?.throwIfAborted();
  return {
    buffer,
    decodedBytes: buffer.byteLength,
    decompressMs: performance.now() - startedAt,
  };
}

export function validateAssetLength(result, spec, label) {
  const expected = Number(spec.decodedBytes || 0);
  if (expected <= 0 || result.buffer.byteLength === expected) return;
  if (spec.encoding === 'identity') {
    const normalized = new TextDecoder().decode(result.buffer).replaceAll('\r\n', '\n');
    if (new TextEncoder().encode(normalized).byteLength === expected) return;
  }
  throw new Error(`${label} 압축 해제 크기가 올바르지 않습니다.`);
}
