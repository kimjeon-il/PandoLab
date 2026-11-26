import { createWorkerRpcClient } from './worker-rpc.js';

// A stateless worker lane owns its RPC lifetime. Cancellation retires only
// that lane; scheduling and job metrics remain with the caller.
export function createStatelessWorkerLane(createWorker, defaultTimeoutMs) {
  let rpc = null;
  return {
    get active() {return rpc!==null;},
    acquire() {return rpc??=createWorkerRpcClient({createWorker, defaultTimeoutMs});},
    retire(owner, reason) {
      if (rpc===owner)rpc = null;
      owner?.stop(reason);
    },
    dispose(reason) {const owner = rpc; rpc = null; owner?.stop(reason);},
  };
}
