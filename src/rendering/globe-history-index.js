// The Viewer keeps compact immutable history metadata, not a decoded world
// list for every date. Checkpoints bound reconstruction work; exact slot
// comparisons resolve any fingerprint collision.
const CHECKPOINT_STRIDE=32,DECODED_LIMIT=8;
export function globeHistorySlotKey(slots){
 let a=2166136261,b=0x9e3779b9;
 for(const slot of slots){
  a=Math.imul(a^slot,16777619)>>>0;
  b=(Math.imul(b^slot,2246822519)+3266489917)>>>0;
 }
 return slots.length.toString(36)+':'+a.toString(36)+':'+b.toString(36);
}
const equal=(a,b)=>a.length===b.length&&a.every((value,index)=>value===b[index]);

// Mode 0 is a full list. Mode 1 removes values and inserts ordered
// (position,value) pairs. If order changes or the delta is larger, retain
// the original order verbatim in a full list.
export function encodeGlobeHistoryList(previous,next,checkpoint=false){
 const full=[0,...next];
 if(checkpoint)return full;
 const oldSet=new Set(previous),nextSet=new Set(next);
 if(oldSet.size!==previous.length||nextSet.size!==next.length)return full;
 const remaining=previous.filter(value=>nextSet.has(value));
 if(!equal(remaining,next.filter(value=>oldSet.has(value))))return full;
 const removed=previous.filter(value=>!nextSet.has(value)),added=[];
 next.forEach((value,index)=>{if(!oldSet.has(value))added.push(index,value);});
 const delta=[1,removed.length,...removed,...added];
 return delta.length<full.length?delta:full;
}
export function decodeGlobeHistoryList(previous,encoded){
 if(!Array.isArray(encoded)||!encoded.length)throw Error('Invalid globe history list');
 if(encoded[0]===0){
  const result=encoded.slice(1);
  if(result.some(value=>!Number.isSafeInteger(value)||value<0))throw Error('Invalid globe history value');
  return result;
 }
 const count=encoded[1],end=2+count;
 if(encoded[0]!==1||!Number.isSafeInteger(count)||count<0||end>encoded.length||(encoded.length-end)%2)
  throw Error('Invalid globe history delta');
 const removed=new Set(encoded.slice(2,end)),remaining=previous.filter(value=>!removed.has(value));
 if(removed.size!==count||previous.length-remaining.length!==count)throw Error('Invalid globe history removal');
 const result=new Array(remaining.length+(encoded.length-end)/2);
 let at=end,source=0;
 for(let i=0;i<result.length;i++){
  if(at<encoded.length&&encoded[at]===i){
   const value=encoded[at+1];
   if(!Number.isSafeInteger(value)||value<0)throw Error('Invalid globe history insertion');
   result[i]=value;at+=2;
  }else{
   if(source>=remaining.length)throw Error('Invalid globe history insertion position');
   result[i]=remaining[source++];
  }
 }
 if(at!==encoded.length||source!==remaining.length)throw Error('Invalid globe history delta length');
 return result;
}
export function encodeGlobeHistoricalViews(views,{stride=CHECKPOINT_STRIDE}={}){
 if(!Number.isSafeInteger(stride)||stride<1)throw Error('Invalid globe history checkpoint stride');
 let previous=[[],[],[]];
 const rows=views.map((view,index)=>{
  const lists=[view.slots,view.hiddenBorders,view.borders];
  const row=[globeHistorySlotKey(view.slots),...lists.map((list,axis)=>
   encodeGlobeHistoryList(previous[axis],list,index%stride===0))];
  previous=lists;return row;
 });
 return {version:1,stride,rows};
}
// Signed calendar months have no year zero. Keep the order exactly as
// produced by Core and use numeric keys for neighbour lookup.
export function globeHistoryMonthKey(month){
 const match=/^([+-]?\d+)-(\d{2})$/.exec(String(month));
 if(!match)throw Error('Invalid globe history month');
 const year=Number(match[1]),m=Number(match[2]);
 if(!Number.isSafeInteger(year)||year===0||m<1||m>12)throw Error('Invalid globe history month');
 return (year>0?year-1:year)*12+m-1;
}
export function createGlobeHistoryIndex(history,baseCount,{decodedLimit=DECODED_LIMIT,timeline=[],physicalIdentities=[]}={}){
 if(history?.version!==1||!Array.isArray(history.rows)||!Number.isSafeInteger(history.stride)||history.stride<1)
  throw Error('Invalid globe historical view catalog');
 const {rows,stride}=history,byKey=new Map(),decoded=new Map();
 const base=Object.freeze({view:null,slots:Object.freeze(Array.from({length:baseCount},(_,slot)=>slot)),key:'base'});
 const baseKey=globeHistorySlotKey(base.slots);
 const moments=timeline.map(([month,view,physical],index)=>{
  const key=globeHistoryMonthKey(month),physicalIdentity=typeof physical==='string'?physical:physicalIdentities[physical];
  if(!Number.isInteger(view)||view< -1||view>=rows.length||typeof physicalIdentity!=='string'||
   index&&key<=globeHistoryMonthKey(timeline[index-1][0]))throw Error('Invalid globe history timeline');
  return {month,key,view,physicalIdentity};
 });
 rows.forEach((row,index)=>{
  if(!Array.isArray(row)||row.length!==4||typeof row[0]!=='string')throw Error('Invalid globe historical view row');
  let bucket=byKey.get(row[0]);
  if(!bucket){bucket=[];byKey.set(row[0],bucket);}
  bucket.push(index);
 });
 function get(index){
  let cached=decoded.get(index);
  if(cached){decoded.delete(index);decoded.set(index,cached);return cached;}
  let first=index-index%stride,lists=[[],[],[]];
  for(let prior=index-1;prior>=first;prior--){
   const candidate=decoded.get(prior);
   if(candidate){lists=[candidate.slots,candidate.view.hiddenBorders,candidate.view.borders];first=prior+1;break;}
  }
  for(let i=first;i<=index;i++){
   const row=rows[i];
   if(i%stride===0&&row.slice(1).some(list=>list?.[0]!==0))throw Error('Missing globe history checkpoint');
   lists=lists.map((list,axis)=>decodeGlobeHistoryList(list,row[axis+1]));
  }
  if(globeHistorySlotKey(lists[0])!==rows[index][0])throw Error('Globe history slot identity mismatch');
  const view=Object.freeze({id:index,slots:Object.freeze(lists[0]),hiddenBorders:Object.freeze(lists[1]),borders:Object.freeze(lists[2])});
  cached=Object.freeze({view,slots:view.slots,key:'history:'+index});
  decoded.set(index,cached);
  while(decoded.size>Math.max(1,decodedLimit))decoded.delete(decoded.keys().next().value);
  return cached;
 }
 function find(slots){
  const key=globeHistorySlotKey(slots);
  if(key===baseKey&&equal(slots,base.slots))return base;
  for(const index of byKey.get(key)??[]){
   const row=get(index);
   if(equal(row.slots,slots))return row;
  }
  return null;
 }
 function neighbors(month,direction=0){
  if(!moments.length)return [];
  const key=globeHistoryMonthKey(month);
  let lo=0,hi=moments.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(moments[mid].key<=key)lo=mid+1;else hi=mid;}
  const current=Math.max(0,lo-1),before=moments[current-1],after=moments[current+1];
  return (direction<0?[before,after]:[after,before]).filter(Boolean).map(row=>({
   month:row.month,physicalIdentity:row.physicalIdentity,territories:row.view===-1?base:get(row.view),
  }));
 }
 return Object.freeze({base,find,neighbors,stats:()=>({views:rows.length,decodedViews:decoded.size,checkpointStride:stride,timelineMoments:moments.length})});
}
