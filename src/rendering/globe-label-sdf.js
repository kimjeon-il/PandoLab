// Seed the two-pass chamfer transform with the raster coverage at the glyph edge.
// Scratch arrays are shared within a bounded batch.
export function createGlobeDistanceWorkspace() {
  let inside = new Float32Array(0), outside = new Float32Array(0);
  function distanceTo(alpha, width, height, range, foreground, values) {
    const count = width*height;
    for (let i = 0; i<count; i++) {
      const coverage = alpha[i];
      if (coverage===0)values[i] = foreground?range+1:0;
      else if (coverage===255)values[i] = foreground?0:range+1;
      else {
        const edge = coverage/255-0.5;
        values[i] = Math.max(0, foreground?-edge:edge);
      }
    }
    // Row loops avoid the modulo and row-boundary computation per pixel.
    for (const direction of [1, -1]) {
      const startY = direction===1?0:height-1, endY = direction===1?height:-1;
      const startX = direction===1?0:width-1, endX = direction===1?width:-1;
      for (let y = startY; y!==endY; y+=direction) {
        const base = y*width, hasRow = y-direction>=0&&y-direction<height;
        for (let x = startX; x!==endX; x+=direction) {
          const i = base+x, row = i-direction*width;
          let distance = values[i];
          if (x-direction>=0&&x-direction<width)distance = Math.min(distance, values[i-direction]+1);
          if (hasRow) {
            distance = Math.min(distance, values[row]+1);
            if (x>0)distance = Math.min(distance, values[row-1]+Math.SQRT2);
            if (x<width-1)distance = Math.min(distance, values[row+1]+Math.SQRT2);
          }
          values[i] = distance;
        }
      }
    }
  }
  function transform(alpha, width, height, outlineRange = 7) {
    const count = width*height;
    if (!Number.isSafeInteger(count)||count<=0||alpha.length!==count||outlineRange<=0)throw Error('Invalid SDF input');
    if (inside.length<count) {inside = new Float32Array(count); outside = new Float32Array(count);}
    distanceTo(alpha, width, height, outlineRange, true, inside);
    distanceTo(alpha, width, height, outlineRange, false, outside);
    const output = new Uint8Array(count);
    for (let i = 0; i<count; i++)output[i] = Math.round(127.5+127.5*Math.max(-1, Math.min(1, (outside[i]-inside[i])/outlineRange)));
    return output;
  }
  return {transform};
}
export function distanceMask(alpha, width, height, outlineRange = 7) {
  return createGlobeDistanceWorkspace().transform(alpha, width, height, outlineRange);
}
