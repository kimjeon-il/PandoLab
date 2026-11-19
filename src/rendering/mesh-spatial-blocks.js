// Worker-side index reordering only: vertex values and primitive winding stay exact.
export function prepareMeshSpatialBlocks(mesh) {
  const started=performance.now();
  let partitionComparisons=0;
  function selectMedian(order, middle, compare) {
    let left=0,right=order.length-1;
    while(left<right){
      const center=(left+right)>>>1;
      let a=order[left],b=order[center];const c=order[right];
      if(compare(a,b)>0)[a,b]=[b,a];
      if(compare(b,c)>0)b=compare(a,c)>0?a:c;
      const pivot=b;let low=left,high=right;
      while(low<=high){
        while(compare(order[low],pivot)<0)low++;
        while(compare(order[high],pivot)>0)high--;
        if(low<=high){const value=order[low];order[low++]=order[high];order[high--]=value;}
      }
      if(middle<=high)right=high;else if(middle>=low)left=low;else break;
    }
  }
  const vectors = new Float64Array(mesh.positions.length / 2 * 3);
  for (let i = 0; i < mesh.positions.length / 2; i++) {
    const lon = mesh.positions[i * 2] * Math.PI / 180e6, lat = mesh.positions[i * 2 + 1] * Math.PI / 180e6;
    vectors[i * 3] = Math.cos(lat) * Math.cos(lon); vectors[i * 3 + 1] = Math.cos(lat) * Math.sin(lon); vectors[i * 3 + 2] = Math.sin(lat);
  }
  const build = (indices, ranges, stride, limit) => {
    const centroids = new Float64Array(indices.length / stride * 3);
    for (let p = 0; p < indices.length / stride; p++) for (let k = 0; k < stride; k++) for (let axis = 0; axis < 3; axis++) centroids[p * 3 + axis] += vectors[indices[p * stride + k] * 3 + axis] / stride;
    const output = new Uint32Array(indices.length), nodes = [], roots = [];
    function partition(order, first) {
      const id = nodes.length, box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], geo = [Infinity, Infinity, -Infinity, -Infinity];
      for (const p of order) for (let k = 0; k < stride; k++) {
        const vertex = indices[p * stride + k];
        for (let axis = 0; axis < 3; axis++) { const v = vectors[vertex * 3 + axis]; box[axis] = Math.min(box[axis], v); box[axis + 3] = Math.max(box[axis + 3], v); }
        const x = mesh.positions[vertex * 2] / 1e6, y = mesh.positions[vertex * 2 + 1] / 1e6;
        geo[0] = Math.min(geo[0], x); geo[1] = Math.min(geo[1], y); geo[2] = Math.max(geo[2], x); geo[3] = Math.max(geo[3], y);
      }
      const node = { first, count: order.length * stride, left: -1, right: -1, box, geo }; nodes.push(node);
      if (order.length > limit) {
        let axis = 0; for (let a = 1; a < 3; a++) if (box[a + 3] - box[a] > box[axis + 3] - box[axis]) axis = a;
        const middle = Math.floor(order.length / 2);
        selectMedian(order,middle,(a,b)=>{partitionComparisons++;return centroids[a*3+axis]-centroids[b*3+axis]||a-b;});
        node.left = partition(order.subarray(0, middle), first); node.right = partition(order.subarray(middle), first + middle * stride);
      } else {
        let target = first;
        for (const p of order) for (let k = 0; k < stride; k++) output[target++] = indices[p * stride + k];
      }
      return id;
    }
    for (let country = 0; country < ranges.length / 2; country++) {
      const first = ranges[country * 2], count = ranges[country * 2 + 1];
      if (!count) { roots.push(-1); continue; }
      const order = new Uint32Array(count / stride);
      for (let i = 0; i < order.length; i++) order[i] = first / stride + i;
      roots.push(partition(order, first));
    }
    // Allocate each typed tree buffer once. Array#flatMap materializes millions
    // of boxed numbers in large world meshes before converting them again.
    const rangesArray = new Uint32Array(nodes.length * 2);
    const childrenArray = new Int32Array(nodes.length * 2);
    const boundsArray = new Float64Array(nodes.length * 6);
    const geographicBoundsArray = new Float64Array(nodes.length * 4);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      rangesArray[i * 2] = node.first;
      rangesArray[i * 2 + 1] = node.count;
      childrenArray[i * 2] = node.left;
      childrenArray[i * 2 + 1] = node.right;
      boundsArray.set(node.box, i * 6);
      geographicBoundsArray.set(node.geo, i * 4);
    }
    return { indices: output, tree: { roots: Int32Array.from(roots), ranges: rangesArray,
      children: childrenArray, bounds: boundsArray, geographicBounds: geographicBoundsArray } };
  };
  const triangles = build(mesh.triangleIndices, mesh.countryTriangleRanges, 3, 2048);
  const boundaries = build(mesh.lineIndices, mesh.countryBoundaryRanges, 2, 4096);
  mesh.triangleIndices = triangles.indices; mesh.lineIndices = boundaries.indices;
  mesh.spatialBlocks = { version: 1, triangle: triangles.tree, boundary: boundaries.tree };
  mesh.spatialPreparation={partitionComparisons,milliseconds:performance.now()-started};
  return mesh;
}
