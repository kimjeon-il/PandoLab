/** Display-only normalization; canonical physical geometry remains immutable. */
export const PHYSICAL_LAND_DISPLAY_ALGORITHM='physical-display-union-v1';
export async function dissolvePhysicalLand(geometry, {union, checkpoint=async()=>{}} = {}) {
  if(geometry?.type!=='MultiPolygon'||!Array.isArray(geometry.coordinates)||typeof union!=='function')
    throw new TypeError('Physical display requires the selected canonical MultiPolygon and its polygon kernel.');
  const polygons=geometry.coordinates,parent=polygons.map((_,index)=>index),points=new Map();
  const find=index=>{let root=index;while(parent[root]!==root)root=parent[root];while(parent[index]!==index){const next=parent[index];parent[index]=root;index=next;}return root;};
  // Join only exact source contacts, never bounding-box proximity or snapping.
  // Disconnected islands/polar/dateline components need no boolean operation.
  for(let index=0;index<polygons.length;index++){
    if(index%64===0)await checkpoint();
    for(const ring of polygons[index])for(const point of ring){
      const key=point[0]+','+point[1],previous=points.get(key);
      if(previous===undefined)points.set(key,index);
      else {const a=find(index),b=find(previous);if(a!==b)parent[a]=b;}
    }
  }
  const groups=new Map();
  polygons.forEach((polygon,index)=>{const key=find(index);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(polygon);});
  points.clear();
  const coordinates=[];
  for(const group of groups.values()){
    if(group.length===1){coordinates.push(group[0]);continue;}
    await checkpoint();
    // Connected sets fit the kernel's bounded sweep; unioning the entire world
    // at once unnecessarily combines unrelated continents and exceeds its queue.
    const merged=union(group);
    if(!Array.isArray(merged)||!merged.length)throw new Error('Physical display union lost a connected land component.');
    coordinates.push(...merged);
  }
  await checkpoint();
  return {type:'MultiPolygon',coordinates};
}
