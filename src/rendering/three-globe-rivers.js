function intersects([west,south,east,north],[left,bottom,right,top]){
 if(north<bottom||south>top)return false;
 if(east-west>=360||right-left>=360)return true;
 const shift=360*Math.round((west+east-left-right)/720);
 return left+shift<=east&&right+shift>=west;
}

export function selectGlobeRiverChunks(chunks,bounds,zoom){
 return chunks.filter(row=>zoom>=row.minZoom&&intersects(row.bounds,bounds));
}

/** Retain prepared line buffers for the accepted viewport and recent visits. */
export function createGlobeRiverDetail({byteBudget,load,attach,invalidate,onError}){
 const entries=new Map(),failed=new Map();
 let wanted=new Set(),published=new Set(),residentBytes=0;
 function discard(id,entry){
  if(entries.get(id)!==entry)return;
  entries.delete(id);
  if(!entry.resource){entry.controller.abort();return;}
  entry.resource.dispose();
  residentBytes-=entry.bytes;
 }
 function trim(){
  for(const [id,entry] of entries){
   if(residentBytes<=byteBudget)return;
   if(!wanted.has(id)&&!published.has(id))discard(id,entry);
  }
 }
 async function prepare(row,entry){
  try{
   const packet=await load(row,entry.controller.signal);
   if(entries.get(row.id)!==entry)return;
   entry.resource=attach(row,packet);
   entry.packet=packet;entry.bytes=entry.resource.residentBytes;entry.lastUsed=performance.now();
   residentBytes+=entry.bytes;
   trim();invalidate();
  }catch(error){
   if(entries.get(row.id)!==entry)return;
   discard(row.id,entry);failed.set(row.id,performance.now()+1500);onError(error,row);
  }
 }
 function update(rows){
  const next=new Set(rows.map(row=>row.id));
  const changed=wanted.size!==next.size||[...next].some(id=>!wanted.has(id));
  const retry=rows.some(row=>!entries.has(row.id)&&(failed.get(row.id)??0)<=performance.now());
  if(!changed&&!retry)return false;
  const previous=wanted;wanted=next;
  for(const id of failed.keys())if(!next.has(id))failed.delete(id);
  for(const id of previous){
   if(next.has(id))continue;
   const entry=entries.get(id);
   if(entry?.resource)entry.resource.setVisible(false);
   else if(entry)discard(id,entry);
  }
  for(const row of rows){
   const cached=entries.get(row.id);
   if(cached){
    if(!previous.has(row.id)){
     cached.resource?.setVisible(true);cached.lastUsed=performance.now();
     entries.delete(row.id);entries.set(row.id,cached);
    }
    continue;
   }
   if((failed.get(row.id)??0)>performance.now())continue;
   failed.delete(row.id);
   const entry={row,controller:new AbortController(),bytes:0,resource:null,packet:null};
   entries.set(row.id,entry);prepare(row,entry);
  }
  trim();return true;
 }
 const activeEntries=()=>[...wanted].map(id=>entries.get(id)).filter(entry=>entry?.resource);
 function commit(active){const next=new Set(active.map(entry=>entry.row.id)),changed=next.size!==published.size||[...next].some(id=>!published.has(id));published=next;const before=residentBytes;trim();return changed||before!==residentBytes;}
 function memoryEntries(){return [...entries].filter(([,entry])=>entry.resource).map(([id,entry])=>({key:entry,...entry.resource.footprint(),lastUsed:entry.lastUsed,protected:wanted.has(id)||published.has(id),evict:()=>discard(id,entry)}));}
 function stats(){
  const active=activeEntries();
  return {requestedChunks:wanted.size,visibleChunks:active.length,activeSegments:active.reduce((sum,row)=>sum+row.packet.count,0),residentBytes};
 }
 function dispose(){
  for(const [id,entry] of entries)discard(id,entry);
  wanted.clear();published.clear();failed.clear();
 }
 return Object.freeze({update,commit,stats,activeEntries,memoryEntries,dispose});
}
