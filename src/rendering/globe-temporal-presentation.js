import { worldViewChange } from '../document/world-view-change.js';
import { parseTemporal } from '../document/temporal.js';

const idOf = row => String(row.id);
const props = row => row?.properties??{};
const colorInputs = row => {
  const p = props(row);
  return [p.entityKind, p.parentId, p.style?.color, p.metadata?.sourceFeatureId, p.sourceEntityId];
};
const sameColorInputs = (a, b) => {if (!a||!b)return false; const right = colorInputs(b); return colorInputs(a).every((value, i) => Object.is(value, right[i]));};
const monthKey = (value, boundary = 'start') => {
  const point = value?.startKey?value:parseTemporal(value);
  if (!point)return null;
  const [year, month] = boundary==='end'?point.endKey:point.startKey;
  return year*12+month;
};
const lowerBound = (rows, key) => {
  let lo = 0, hi = rows.length;
  while (lo<hi) {const mid = (lo+hi)>>1; if (rows[mid][0]<key)lo = mid+1; else hi = mid;}
  return lo;
};

// Source receipts identify the exact accepted rows. If a receipt is absent,
// compare immutable row identities once, not resolved colors, labels or
// geometry coordinates. Ancestor changes include their color dependants.
export function createGlobeTemporalPresentation() {
  let source = null, month = null, eventsDirty = true, events = [];
  const rowsById = new Map(), children = new Map(), boundaries = new Map(), uncertain = new Set(), nativeDated = new Set();
  function unlink(row) {
    const id = idOf(row), parent = props(row).parentId;
    if (parent) {const set = children.get(String(parent)); set?.delete(id); if (!set?.size)children.delete(String(parent));}
    boundaries.delete(id); uncertain.delete(id); nativeDated.delete(id); rowsById.delete(id);
  }
  function link(row) {
    const id = idOf(row), p = props(row), parent = p.parentId;
    rowsById.set(id, row);
    if (parent) {const key = String(parent); let set = children.get(key); if (!set) {set = new Set(); children.set(key, set);}set.add(id);}
    if (p.entityKind!=='general')return;
    const keys = new Set();
    const add = (value, boundary, offset = 0) => {
      if (value==null||value==='')return;
      try {const key = monthKey(value, boundary); if (key!==null)keys.add(key+offset);}
      catch{uncertain.add(id);}
    };
    add(p.start??p.validFrom,'start');
    // Month-end visibility may change in the last month or the following one.
    add(p.end??p.validTo,'end'); add(p.end??p.validTo,'end', 1);
    const names = Array.isArray(p.metadata?.nativeNames)?p.metadata.nativeNames:[p.metadata?.nativeName];
    for (const entry of names) {
      if (!entry||typeof entry!=='object')continue;
      for (const [value, isEnd] of [[entry.validFrom||entry.from, false], [entry.validTo||entry.to, true]]) {
        if (!value)continue;
        nativeDated.add(id);
        // Native labels currently use the existing YYYY-MM string policy.
        // Unusual/extended dates retain a conservative invalidation path.
        if (!/^\d{4}-\d{2}(?:-\d{2})?$/.test(String(value))){uncertain.add(id);continue;}
        add(String(value).slice(0, 7),'start', isEnd?1:0);
      }
    }
    if (keys.size)boundaries.set(id, keys);
  }
  function descendants(ids, target) {
    const stack = [...ids], seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id))continue;
      seen.add(id); target.add(id);
      for (const child of children.get(id)??[])stack.push(child);
    }
  }
  function advance(next, nextMonth) {
    const changed = new Set(), colorRoots = new Set(), dirty = new Set(), first = source===null;
    let examined = 0;
    const receipt = source===null?null:worldViewChange(source, next);
    const beforeRows = new Map(), afterRows = new Map();
    if (receipt!==null) {
      for (const i of receipt) {
        examined++; const before = source[i], after = next[i];
        if (before===after)continue;
        beforeRows.set(idOf(before), before); afterRows.set(idOf(after), after);
      }
    }else {
      const after = new Map(next.map(row => [idOf(row), row]));
      for (const [id, row] of rowsById) {examined++; if (after.get(id)!==row)beforeRows.set(id, row);}
      for (const [id, row] of after) {examined++; if (rowsById.get(id)!==row)afterRows.set(id, row);}
    }
    for (const id of new Set([...beforeRows.keys(), ...afterRows.keys()])) {
      changed.add(id); dirty.add(id);
      if (!sameColorInputs(beforeRows.get(id), afterRows.get(id)))colorRoots.add(id);
    }
    descendants(colorRoots, dirty);
    for (const row of beforeRows.values())unlink(row);
    for (const row of afterRows.values())link(row);
    descendants(colorRoots, dirty);
    if (changed.size)eventsDirty = true;
    const nextKey = monthKey(nextMonth);
    if (month!==null&&month!==nextMonth) {
      if (eventsDirty) {
        events = [...boundaries].flatMap(([id, keys]) => [...keys].map(key => [key, id])).sort((a, b) => a[0]-b[0]); eventsDirty = false;
      }
      const oldKey = monthKey(month), lo = Math.min(oldKey, nextKey), hi = Math.max(oldKey, nextKey);
      for (let i = lowerBound(events, lo+1); i<events.length&&events[i][0]<=hi; i++)dirty.add(events[i][1]);
      for (const id of uncertain)dirty.add(id);
      if (!/^\d{4}-\d{2}$/.test(String(month))||!/^\d{4}-\d{2}$/.test(String(nextMonth)))for(const id of nativeDated)dirty.add(id);
    }
    source = next; month = nextMonth;
    return {dirtyIds:dirty, changedIds:changed, first, examined, receipt:receipt!==null};
  }
  function reset() {source = null; month = null; events = []; eventsDirty = true; rowsById.clear(); children.clear(); boundaries.clear(); uncertain.clear(); nativeDated.clear();}
  return {advance, reset, get:id => rowsById.get(String(id))};
}
