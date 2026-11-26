import { subscribeAbort } from './async-request.js';

export const workerPriority = value => Number(typeof value==='function'?value():value)||0;

// Higher priorities run first; equally ranked jobs keep submission order.
export function sortWorkerJobs(queue, sequenceOf = row => row.sequence) {
  queue.sort((a, b) => workerPriority(b.priority)-workerPriority(a.priority)||sequenceOf(a)-sequenceOf(b));
}

/** One cancellable queue for admission gates. Owners decide when/what to admit. */
export function createWorkerAdmissionQueue(schedule) {
  const rows = [];
  let sequence = 0;
  function take(index = 0) {
    const [row] = rows.splice(index, 1);
    row?.detach();
    return row;
  }
  function enqueue({priority = 0, signal, ...fields}, task, start = schedule) {
    return new Promise((resolve, reject) => {
      const row = {...fields, get priority() {return workerPriority(priority);}, signal, task, resolve, reject, sequence:++sequence};
      const unsubscribe = priority?.subscribe?.(schedule);
      const abort = () => {
        const at = rows.indexOf(row);
        if (at<0)return;
        take(at);
        reject(signal.reason);
        schedule();
      };
      const detachAbort = subscribeAbort(signal, abort);
      row.detach = () => {detachAbort(); unsubscribe?.();};
      rows.push(row);
      if (signal?.aborted)abort(); else start();
    });
  }
  function rejectAll(error) {
    for (const row of rows.splice(0)) {row.detach(); row.reject(error);}
  }
  return Object.freeze({rows, enqueue, take, sort:() => sortWorkerJobs(rows), rejectAll});
}
