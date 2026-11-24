// Independent geometry jobs share a bounded priority queue. Cancelling a
// queued job releases its closure; an executing job cooperatively checks its
// own cancellation context before publishing results.
export function createGeometryWorkGate(limit = 2) {
  let active = 0;
  let sequence = 0;
  const waiting = [];
  const cancellationError = signal => signal.reason || new DOMException('Cancelled', 'AbortError');

  function pump() {
    while (active < limit && waiting.length) {
      waiting.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
      const entry = waiting.shift();
      entry.detach();
      if (entry.context.signal?.aborted) {
        entry.reject(cancellationError(entry.context.signal));
        continue;
      }
      active++;
      Promise.resolve()
        .then(() => {
          entry.context.throwIfCancelled();
          return entry.work();
        })
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  }

  function run(context, work) {
    context.throwIfCancelled();
    return new Promise((resolve, reject) => {
      const signal = context.signal;
      const entry = {context, work, resolve, reject, priority: context.priority || 0, sequence: ++sequence};
      const cancel = () => {
        const index = waiting.indexOf(entry);
        if (index < 0) return;
        waiting.splice(index, 1);
        entry.detach();
        reject(cancellationError(signal));
      };
      entry.detach = () => signal?.removeEventListener('abort', cancel);
      waiting.push(entry);
      signal?.addEventListener('abort', cancel, {once: true});
      pump();
    });
  }

  return {run};
}
