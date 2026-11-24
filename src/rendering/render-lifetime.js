// Frame admission owns the renderer generation. Every async writer captures
// the same map, graphics context and generation certificate.
export function createRenderLifetime({
  getMap, getGeneration, getContextRevision = () => 0, isDisposed = () => false,
}) {
  function capture() {
    const map = getMap();
    const generation = getGeneration();
    const context = getContextRevision();
    const live = () => !isDisposed() && getMap() === map && getContextRevision() === context;

    return Object.freeze({
      map, generation, context, live,
      current: ({retainGeneration = false} = {}) => live() && (retainGeneration || getGeneration() === generation),
      sourceCurrent: (id, source) => live() && map?.getSource(id) === source,
    });
  }

  return Object.freeze({capture});
}

// Request cancellation is independent from acknowledgement of native writes
// that have already modified a source.
export function createLatestRenderRequests() {
  const entries = new Map();
  let closed = false;

  function cancel(key) {
    const previous = entries.get(key);
    if (!previous) return;
    entries.delete(key);
    previous.controller.abort();
  }

  function begin(key, fields = {}) {
    if (closed) throw new DOMException('Render requests disposed', 'AbortError');
    cancel(key);
    const controller = new AbortController();
    const entry = {...fields, controller, signal: controller.signal};
    entries.set(key, entry);
    return entry;
  }

  function current(key, entry) {
    return !closed && entries.get(key) === entry && !entry.signal.aborted;
  }

  function finish(key, entry) {
    if (!current(key, entry)) return false;
    entries.delete(key);
    return true;
  }

  function clear() {
    for (const key of entries.keys()) cancel(key);
  }

  return Object.freeze({
    begin, current, finish, cancel, clear,
    get: key => entries.get(key),
    has: key => entries.has(key),
    dispose() {
      closed = true;
      clear();
    },
  });
}
