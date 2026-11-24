// Preserve consecutive primitive order, cap ranges and effective paint.
// Never reorder translucent or multiply-blended primitives across runs.
const MAX_BATCH_VERTICES=65536,MAX_BATCH_INDICES=393216;
const isRiver=row=>row.ref?.domain==='hydro'&&row.ref.type==='river';
function samePaint(a,b){
 return a.loadingRole===b.loadingRole&&!!a.multiply===!!b.multiply
  &&isRiver(a)===isRiver(b)&&(a.width||1)===(b.width||1)
  &&!!a.packet.values===!!b.packet.values
  &&(a.color===b.color||a.color&&b.color&&a.color.length===b.color.length&&a.color.every((v,i)=>v===b.color[i]));
}
const vertices=packet=>packet.values?packet.values.length/5:packet.positions.length/2;
function mergePackets(packets,vertexCount,indexCount){
 const line=!!packets[0].values,components=line?5:2;
 const values=new Float32Array(vertexCount*components),indices=new Uint32Array(indexCount),ranges=[];
 let vertex=0,index=0;
 for(const packet of packets){
  const input=line?packet.values:packet.positions;
  values.set(input,vertex*components);
  for(let i=0;i<packet.indices.length;i++)indices[index+i]=packet.indices[i]+vertex;
  for(const range of packet.ranges||[{cap:3,offset:0,count:packet.indices.length}]){
   if(!range.count)continue;
   const offset=index+range.offset,prior=ranges.at(-1);
   if(prior&&prior.cap===range.cap&&prior.offset+prior.count===offset)prior.count+=range.count;
   else ranges.push({cap:range.cap,offset,count:range.count});
  }
  vertex+=vertices(packet);index+=packet.indices.length;
 }
 return line?{values,indices,ranges}:{positions:values,indices,ranges};
}
export function createPolarDrawBatcher({byteBudget=8*1024*1024}={}){
 // Weak input tokens do not retain retired packet arrays. The merged output
 // cache has an actual typed-array byte cap rather than a weak-key chain.
 let identities=new WeakMap(),sequence=0,bytes=0,evictions=0;
 const merged=new Map();
 const token=packet=>{let id=identities.get(packet);if(!id){id=++sequence;identities.set(packet,id);}return id;};
 function remember(key,entry){
  if(merged.has(key)){bytes-=merged.get(key).bytes;merged.delete(key);}
  if(entry.bytes>byteBudget)return;
  merged.set(key,entry);bytes+=entry.bytes;
  while(bytes>byteBudget||merged.size>128){
   const oldest=merged.keys().next().value;bytes-=merged.get(oldest).bytes;merged.delete(oldest);evictions++;
  }
 }
 function batch(rows){
  const output=[];
  for(let i=0;i<rows.length;){
   const first=rows[i];let end=i+1,v=vertices(first.packet),n=first.packet.indices.length;
   while(end<rows.length&&samePaint(first,rows[end])){
    const packet=rows[end].packet,nextV=v+vertices(packet),nextN=n+packet.indices.length;
    if(nextV>MAX_BATCH_VERTICES||nextN>MAX_BATCH_INDICES)break;
    v=nextV;n=nextN;end++;
   }
   if(end===i+1)output.push(first);
   else{
    const packets=rows.slice(i,end).map(row=>row.packet),key=token(first.packet),inputs=packets.map(token),prior=merged.get(key);
    const packet=prior&&prior.inputs.length===inputs.length&&prior.inputs.every((value,j)=>value===inputs[j])
      ?prior.packet:mergePackets(packets,v,n);
    remember(key,{inputs,packet,bytes:(packet.values||packet.positions).byteLength+packet.indices.byteLength});
    output.push({...first,packet});
   }
   i=end;
  }
  return {rows:output,packets:new Set(output.map(row=>row.packet))};
 }
 return {batch,stats:()=>({bytes,byteBudget,entries:merged.size,evictions}),
  clear(){merged.clear();identities=new WeakMap();bytes=0;}};
}
