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
export function createPolarDrawBatcher(){
 // Weak first-packet identity and at most one recent run per first packet
 // avoid pinning an ever-growing set of historical batch combinations.
 let merged=new WeakMap();
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
    const packets=rows.slice(i,end).map(row=>row.packet),prior=merged.get(first.packet);
    const packet=prior&&prior.inputs.length===packets.length&&prior.inputs.every((value,j)=>value===packets[j])
      ?prior.packet:mergePackets(packets,v,n);
    merged.set(first.packet,{inputs:packets,packet});
    output.push({...first,packet});
   }
   i=end;
  }
  return {rows:output,packets:new Set(output.map(row=>row.packet))};
 }
 return {batch,clear(){merged=new WeakMap();}};
}
