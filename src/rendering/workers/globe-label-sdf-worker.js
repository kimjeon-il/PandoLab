import '../../runtime/workers/worker-rpc-host.js';
import {distanceMask} from '../globe-label-sdf.js';

const rpc=self.PandoLabWorkerRpc;
rpc.install({handlers:{
 'globe.label-sdf':({rows},context)=>{
  const results=[],transfer=[];
  for(const {key,width,height,mask,outlineRange} of rows){
   context.throwIfCancelled();
   if(!Number.isInteger(width)||!Number.isInteger(height)||width<=0||height<=0||
     !(mask instanceof Uint8Array)||mask.length!==width*height||width*height>2048**2)
    throw Error('Invalid label mask');
   const pixels=distanceMask(mask,width,height,outlineRange);
   results.push({key,width,height,pixels});transfer.push(pixels.buffer);
  }
  context.throwIfCancelled();return rpc.transferResult(results,transfer);
 }
}});
