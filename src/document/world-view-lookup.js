// Bounded immutable lookup partitions: sparse changes clone only affected
// buckets, never the entire object index or a chain of earlier snapshots.
const count=64;
function bucket(key){
 let hash=2166136261;
 for(let i=0;i<key.length;i++)hash=Math.imul(hash^key.charCodeAt(i),16777619);
 return (hash>>>0)%count;
}
export function createWorldLookup(){
 const slots=Array.from({length:count},()=>new Map());
 return {
  get:key=>slots[bucket(key)].get(key),
  has:key=>slots[bucket(key)].has(key),
  set(key,value){slots[bucket(key)].set(key,value);},
  fork(updates){
   const next=slots.slice(),touched=new Set();
   for(const [key,value]of updates){
    const index=bucket(key);
    if(!touched.has(index)){next[index]=new Map(next[index]);touched.add(index);}
    next[index].set(key,value);
   }
   return lookupFor(next);
  },
 };
}
function lookupFor(slots){
 return {
  get:key=>slots[bucket(key)].get(key),
  has:key=>slots[bucket(key)].has(key),
  fork(updates){
   const next=slots.slice(),touched=new Set();
   for(const [key,value]of updates){
    const index=bucket(key);
    if(!touched.has(index)){next[index]=new Map(next[index]);touched.add(index);}
    next[index].set(key,value);
   }
   return lookupFor(next);
  },
 };
}
