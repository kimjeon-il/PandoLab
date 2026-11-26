// Subscription and consumer lifetime are independent of the shared work's lifetime.
export function subscribeAbort(signal, callback) {
  if (!signal)return () => {};
  signal.addEventListener('abort', callback, {once:true});
  return () => signal.removeEventListener('abort', callback);
}

export function forwardAbort(signal, controller) {
  const abort = () => controller.abort(signal.reason);
  const detach = subscribeAbort(signal, abort);
  if (signal?.aborted)abort();
  return detach;
}

export function waitForConsumer(promise, signal) {
  if (!signal)return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled)return;
      settled = true;
      detach();
      callback(value);
    };
    const abort = () => finish(reject, signal.reason??new DOMException('Request cancelled','AbortError'));
    const detach = subscribeAbort(signal, abort);
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted)abort();
  });
}

// A retired request must not remove a newer request registered under its key.
export function trackPending(entries, key, promise) {
  const tracked = Promise.resolve(promise).finally(() => {
    if (entries.get(key)===tracked)entries.delete(key);
  });
  entries.set(key, tracked);
  return tracked;
}

// Share verified I/O independently of each consumer's decoding/validation.
// Retain a completed transfer until a deferred cache write settles.
export function acquireSharedRequest(entries, key, initialize) {
  let flight = entries.get(key);
  if (!flight) {
    flight = {controller:new AbortController(), users:0, keepAlive:null};
    initialize(flight);
    entries.set(key, flight);
  }
  flight.users++;
  let released = false;
  const remove = () => {
    if (!flight.users&&entries.get(key)===flight)entries.delete(key);
  };
  return {flight, release() {
    if (released)return;
    released = true;
    if (--flight.users)return;
    if (flight.keepAlive)flight.keepAlive.then(remove, remove);
    else {remove(); flight.controller.abort();}
  }};
}
