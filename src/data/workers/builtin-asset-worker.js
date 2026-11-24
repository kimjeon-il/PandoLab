import '../../runtime/workers/worker-rpc-host.js';
import {parseBuiltinIndex,serializeBuiltinProject} from '../builtin-asset-operations.js';
self.PandoLabWorkerRpc.install({handlers:{
 'builtin.parse-index':(buffer,context)=>{context.throwIfCancelled();return parseBuiltinIndex(buffer);},
 'builtin.serialize-project':async(project,context)=>{
  context.throwIfCancelled();
  const result=await serializeBuiltinProject(project);
  context.throwIfCancelled();
  return self.PandoLabWorkerRpc.transferResult(result,[result.bytes.buffer]);
 },
}});
