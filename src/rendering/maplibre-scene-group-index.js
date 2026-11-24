// Index immutable domain contributions by group. Unchanged groups retain their
// array identity without walking any of their member rows.
export function partitionSceneRows(rows,keyFor){
 const groups=new Map();
 for(const row of rows){
  const key=keyFor(row);let group=groups.get(key);
  if(!group){group=[];groups.set(key,group);}
  group.push(row);
 }
 return groups;
}
export function createSceneGroupIndex(){
 let previous=new Map();
 function reconcile(contributions){
  const grouped=new Map();
  for(const contribution of contributions)for(const [id,rows]of contribution){
   let parts=grouped.get(id);
   if(!parts){parts=[];grouped.set(id,parts);}
   parts.push(rows);
  }
  const next=new Map(),result=new Map();
  for(const [id,parts]of grouped){
   const old=previous.get(id);
   const entry=old&&old.parts.length===parts.length&&old.parts.every((part,index)=>part===parts[index])
    ?old:{parts,rows:parts.length===1?parts[0]:parts.flat()};
   next.set(id,entry);result.set(id,entry.rows);
  }
  previous=next;return result;
 }
 return {reconcile,clear(){previous.clear();}};
}
