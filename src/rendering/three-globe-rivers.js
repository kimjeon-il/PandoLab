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
 const entries=new Map();
 let wanted=new Set(),residentBytes=0;
 function discard(id,entry){
  entries.delete(id);
  if(!entry.resource){entry.controller.abort();return;}
  entry.resource.dispose();
  residentBytes-=entry.bytes;
 }
 function trim(){
  for(const [id,entry] of entries){
   if(residentBytes<=byteBudget)return;
   if(!wanted.has(id))discard(id,entry);
  }
 }
 async function prepare(row,entry){
  try{
   const packet=await load(row,entry.controller.signal);
   if(entries.get(row.id)!==entry)return;
   entry.resource=attach(row,packet);
   entry.packet=packet;
   residentBytes+=entry.bytes;
   trim();invalidate();
  }catch(error){
   if(entries.get(row.id)!==entry)return;
   discard(row.id,entry);onError(error,row);
  }
 }
 function update(rows){
  const next=new Set(rows.map(row=>row.id));
  if(wanted.size===next.size&&[...next].every(id=>wanted.has(id)))return false;
  const previous=wanted;wanted=next;
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
     cached.resource?.setVisible(true);
     entries.delete(row.id);entries.set(row.id,cached);
    }
    continue;
   }
   const entry={row,controller:new AbortController(),bytes:row.spec.decodedBytes,resource:null,packet:null};
   entries.set(row.id,entry);prepare(row,entry);
  }
  trim();return true;
 }
 const activeEntries=()=>[...wanted].map(id=>entries.get(id)).filter(entry=>entry?.resource);
 function stats(){
  const active=activeEntries();
  return {requestedChunks:wanted.size,visibleChunks:active.length,activeSegments:active.reduce((sum,row)=>sum+row.packet.count,0),residentBytes};
 }
 function dispose(){
  for(const [id,entry] of entries)discard(id,entry);
  wanted.clear();
 }
 return Object.freeze({update,stats,activeEntries,dispose});
}
