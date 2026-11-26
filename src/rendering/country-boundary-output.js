// A shared edge belongs to exactly one owner-set partition. Revisions change
// only when the exact rendered coordinates or owner membership changes.
// A partition is independent of paint and can serve all dated source slots.
const samePoint = (a, b) => a[0]===b[0]&&a[1]===b[1];
const ownersOf = segment => [...new Set(segment.ownerIds.map(String))].sort();
const partitionKey = segment => JSON.stringify(ownersOf(segment));
const equalEdge = (a, b) => a===b||!!a&&!!b&&partitionKey(a)===partitionKey(b)&&(
  samePoint(a.start, b.start)&&samePoint(a.end, b.end)||samePoint(a.start, b.end)&&samePoint(a.end, b.start));
export function createCountryBoundaryOutput(edgeKey) {
  const edges = new Map(), groups = new Map();
  function patch(changes, revision) {
    const dirty = new Set();
    for (const [key, next]of changes) {
      const before = edges.get(key);
      if (equalEdge(before, next))continue;
      if (before) {
        const id = partitionKey(before), group = groups.get(id);
        group.edges.delete(key); dirty.add(id); edges.delete(key);
      }
      if (next) {
        const id = partitionKey(next);
        let group = groups.get(id);
        if (!group) {group = {id, ownerIds:ownersOf(next), edges:new Map(), revision:null}; groups.set(id, group);}
        group.edges.set(key, next); edges.set(key, next); dirty.add(id);
      }
    }
    for (const id of dirty) {
      const group = groups.get(id);
      if (!group.edges.size)groups.delete(id);
      else group.revision = revision;
    }
    return dirty.size;
  }
  function replace(segments, revision) {
    const next = new Map(segments.map(segment => [edgeKey(segment), segment]));
    const changes = new Map(next);
    for (const key of edges.keys())if (!next.has(key))changes.set(key, null);
    return patch(changes, revision);
  }
  function select(visibleOwners, knownPartitions) {
    const visible = new Set(visibleOwners), known = new Map(knownPartitions), manifest = [], changed = [];
    for (const group of groups.values()) {
      if (!group.ownerIds.some(id => visible.has(id)))continue;
      const descriptor = {id:group.id, ownerIds:group.ownerIds, revision:group.revision};
      manifest.push(descriptor);
      if (known.get(group.id)!==group.revision)changed.push({...descriptor, segments:[...group.edges.values()]});
    }
    manifest.sort((a, b) => a.id.localeCompare(b.id));
    return {manifest, changed};
  }
  return {replace, patch, select};
}
