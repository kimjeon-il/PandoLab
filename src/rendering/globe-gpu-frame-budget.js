// Deterministic per-frame admission for WebGL object creation, buffer/texture
// uploads and dynamic compaction. Reservations are estimates; the actual
// renderer remains the final authority for driver allocations.
const MiB=1024*1024;
const bounded=(value,min,max)=>Math.max(min,Math.min(max,Math.floor(value)));
export function globeGpuFrameLimits(totalRenderBytes=320*MiB) {
  const factor=Math.max(.25,Math.min(1,Number(totalRenderBytes)/(320*MiB)||1));
  const createBytes=bounded(6*MiB*factor,1*MiB,12*MiB);
  const uploadBytes=bounded(8*MiB*factor,2*MiB,16*MiB);
  return Object.freeze({
    createBytes,createOperations:8,maxSingleCreateBytes:Math.min(32*MiB,Math.max(createBytes,Number(totalRenderBytes)*.12)),
    uploadBytes,uploadOperations:6,maxSingleUploadBytes:Math.min(32*MiB,Math.max(uploadBytes,Number(totalRenderBytes)*.12)),
    compactionBytes:bounded(2*MiB*factor,256*1024,4*MiB),
  });
}
export function createGlobeGpuFrameBudget({totalRenderBytes=320*MiB,limits=globeGpuFrameLimits(totalRenderBytes)}={}) {
  let frameId=null,creates=0,createBytes=0,uploads=0,uploadBytes=0,compactionBytes=0;
  const deferred={create:0,upload:0,compaction:0};
  function beginFrame(next) {
    if (Object.is(frameId,next))return false;
    frameId=next;creates=createBytes=uploads=uploadBytes=compactionBytes=0;
    deferred.create=deferred.upload=deferred.compaction=0;
    return true;
  }
  function admitCreate(bytes=0,operations=1) {
    const size=Math.max(0,Number(bytes)||0),count=Math.max(1,Math.floor(operations)||1);
    const fits=createBytes+size<=limits.createBytes&&creates+count<=limits.createOperations;
    const oversize=!creates&&createBytes===0&&count===1&&size<=limits.maxSingleCreateBytes;
    if (!fits&&!oversize) {deferred.create+=count;return false;}
    creates+=count;createBytes+=size;return true;
  }
  function admitUpload(bytes=0,operations=1) {
    const size=Math.max(0,Number(bytes)||0),count=Math.max(1,Math.floor(operations)||1);
    const fits=uploadBytes+size<=limits.uploadBytes&&uploads+count<=limits.uploadOperations;
    const oversize=!uploads&&uploadBytes===0&&count===1&&size<=limits.maxSingleUploadBytes;
    if (!fits&&!oversize) {deferred.upload+=count;return false;}
    uploads+=count;uploadBytes+=size;return true;
  }
  function admitCompaction(bytes=0,operations=1) {
    const size=Math.max(0,Number(bytes)||0);
    if (compactionBytes+size>limits.compactionBytes) {deferred.compaction+=1;return false;}
    if (!admitUpload(size,operations))return false;
    compactionBytes+=size;return true;
  }
  function remainingCompactionBytes() {
    if (uploads>=limits.uploadOperations)return 0;
    return Math.max(0,Math.min(limits.compactionBytes-compactionBytes,limits.uploadBytes-uploadBytes));
  }
  function defer(kind) {if (Object.hasOwn(deferred,kind))deferred[kind]++;}
  function stats() {
    return {frameId,limits:{...limits},creates,createBytes,uploads,uploadBytes,compactionBytes,
      deferred:{...deferred},remaining:{createBytes:Math.max(0,limits.createBytes-createBytes),
        uploadBytes:Math.max(0,limits.uploadBytes-uploadBytes),compactionBytes:Math.max(0,limits.compactionBytes-compactionBytes),
        createOperations:Math.max(0,limits.createOperations-creates),uploadOperations:Math.max(0,limits.uploadOperations-uploads)}};
  }
  return Object.freeze({beginFrame,admitCreate,admitUpload,admitCompaction,remainingCompactionBytes,defer,stats});
}
