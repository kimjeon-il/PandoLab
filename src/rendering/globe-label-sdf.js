// SDF transform is independent of font loading and GPU resources. The
// original document font raster is transferred as a single-channel mask.
export function distanceMask(alpha,width,height,outlineRange=7){
  const distanceTo=(foreground)=>{
    const values=new Float32Array(width*height);
    for(let i=0;i<values.length;i++)values[i]=(alpha[i]>=128)===foreground?0:outlineRange+1;
    const pass=(direction)=>{
      for(let step=0;step<values.length;step++){
        const i=direction===1?step:values.length-1-step;
        const x=i%width, row=i-direction*width, side=i-direction;
        let distance=values[i];
        if(x-direction>=0&&x-direction<width)distance=Math.min(distance,values[side]+1);
        if(row<0||row>=values.length){values[i]=distance;continue;}
        distance=Math.min(distance,values[row]+1);
        if(x>0)distance=Math.min(distance,values[row-1]+Math.SQRT2);
        if(x<width-1)distance=Math.min(distance,values[row+1]+Math.SQRT2);
        values[i]=distance;
      }
    };
    pass(1);pass(-1);return values;
  };
  const inside=distanceTo(true),outside=distanceTo(false);
  return Uint8Array.from(inside,(distance,i)=>{
    const signed=outside[i]-distance;
    return Math.round(127.5+127.5*Math.max(-1,Math.min(1,signed/outlineRange)));
  });
}

