// Best-effort persistent byte cache maintenance. The cache is an acceleration
// layer; the canonical source and integrity checks remain authoritative.
const states = new WeakMap();
const MAX_BYTES = 512*1024*1024, MAX_ENTRIES = 4096, MAX_AGE_MS = 120*86400000;
const keyOf = value => String(value?.url??value);
function stateFor(cache) {
  let state = states.get(cache);
  if (!state) {state = {touches:new Map(), writes:0, task:null, last:0}; states.set(cache, state);}
  return state;
}
export function touchStoredContent(cache, key) {
  if (!cache)return;
  const state = stateFor(cache), id = keyOf(key);
  state.touches.delete(id); state.touches.set(id, Date.now());
  while (state.touches.size>MAX_ENTRIES)state.touches.delete(state.touches.keys().next().value);
}
export function maintainStoredContent(cache, {force = false} = {}) {
  if (!cache||typeof cache.keys!=='function')return Promise.resolve();
  const state = stateFor(cache);
  if (state.task)return state.task;
  if (!force&&++state.writes<64&&Date.now()-state.last<300000)return Promise.resolve();
  state.writes = 0; state.last = Date.now();
  state.task = (async() => {
    const now = Date.now(), rows = []; let bytes = 0;
    for (const key of await cache.keys()) {
      const response = await cache.match(key).catch (() => null); if (!response)continue;
      const id = keyOf(key), size = Number(response.headers.get('x-pandolab-stored-bytes')||response.headers.get('content-length')||0),
        stored = Number(response.headers.get('x-pandolab-stored-at')||0), last = state.touches.get(id)||stored;
      try {response.body?.cancel().catch (() => {});}catch{}
      const cost = Number.isSafeInteger(size)&&size>0?size:0;
      bytes+=cost; rows.push({key, id, cost, last});
    }
    rows.sort((a, b) => a.last-b.last);
    let count = rows.length;
    const target = force?MAX_BYTES*.75:MAX_BYTES, targetEntries = force?Math.floor(MAX_ENTRIES*.75):MAX_ENTRIES;
    for (const row of rows) {
      const expired = row.last>0&&now-row.last>MAX_AGE_MS;
      if (!expired&&count<=targetEntries&&bytes<=target)continue;
      if (now-(state.touches.get(row.id)||0)<60000)continue; // in-use reads/writes
      if (await cache.delete(row.key).catch (() => false)) {state.touches.delete(row.id); bytes-=row.cost; count--;}
    }
  })().catch (() => {}).finally(() => {state.task = null;});
  return state.task;
}
