import { createPreparedBoundaryStore, attachBoundarySegmentReferences } from '../geometry/boundary-source-store.js';
import { topologyNodeKey } from '../geometry/boundary-topology-core.js';
import { mergeSharedBoundaryContributions } from '../geometry/boundary-topology.js';
import { computeCountrySharedContacts } from '../geometry/country-contact-core.js';

const sharedSegmentKey = segment => [topologyNodeKey(segment.start), topologyNodeKey(segment.end)].sort().join('|');
const contactKey = ids => JSON.stringify([...ids].sort());

/** Prepared features and contact adjacency survive Worker patch messages. */
export function createCountrySharedBoundaryState() {
  const preparedStore = createPreparedBoundaryStore();
  const contacts = new Map(), contactsByOwner = new Map(), edges = new Map();
  let contactComputationCount = 0, lastAffectedOwners = new Set();
  const touchedEdges = new Set();
  const changedEdges = () => [...touchedEdges].map(key => [key, edges.get(key)?.value??null]);
  // Each key normally has one country-pair contributor. Keep that path
  // Map-free; promote/demote only when coincident multi-owner borders require it.
  function updateEdge(key) {
    const record = edges.get(key);
    const contributions = record.contributions;
    if (!contributions?.size) { edges.delete(key); return; }
    if (contributions.size === 1) {
      // A once-shared edge has become single-owner again. Release its Map.
      const [contact, value] = contributions.entries().next().value;
      record.value = value;
      record.contact = contact;
      record.contributions = null;
      return;
    }
    record.value = mergeSharedBoundaryContributions([...contributions.values()]);
  }
  function removeContact(key) {
    const contact = contacts.get(key);
    if (!contact) return;
    for (const id of contact.ids) {
      const adjacent = contactsByOwner.get(id);
      adjacent.delete(key);
      if (!adjacent.size) contactsByOwner.delete(id);
    }
    for (const segment of contact.segments) {
      const edgeKey = sharedSegmentKey(segment);
      touchedEdges.add(edgeKey);
      const record = edges.get(edgeKey);
      if (!record) continue;
      if (!record.contributions) {
        // Most world edges have exactly one contact: no per-edge Map needed.
        if (record.contact === key) edges.delete(edgeKey);
        continue;
      }
      record.contributions.delete(key);
      updateEdge(edgeKey);
    }
    contacts.delete(key);
  }
  function addContact(ids, segments) {
    if (!segments.length) return;
    const key = contactKey(ids);
    contacts.set(key, { ids, segments });
    for (const id of ids) {
      if (!contactsByOwner.has(id)) contactsByOwner.set(id, new Set());
      contactsByOwner.get(id).add(key);
    }
    for (const segment of segments) {
      const edgeKey = sharedSegmentKey(segment);
      touchedEdges.add(edgeKey);
      const existing = edges.get(edgeKey);
      if (!existing) {
        edges.set(edgeKey, { contact: key, value: segment });
        continue;
      }
      if (!existing.contributions) {
        if (existing.contact === key) {
          existing.value = segment;
          continue;
        }
        // Only actual multiple-contact collisions pay for a contribution Map.
        existing.contributions = new Map([[existing.contact, existing.value]]);
        existing.contact = null;
      }
      existing.contributions.set(key, segment);
      updateEdge(edgeKey);
    }
  }
  function reconcile(changed, profile, verifyContactParity = false) {
    const trace = typeof profile === 'function' ? profile : null;
    let started = trace ? performance.now() : 0;
    const obsolete = new Set([...changed].flatMap(id => [...(contactsByOwner.get(id) || [])]));
    const affected = new Set(changed);
    for (const key of obsolete)for (const id of contacts.get(key)?.ids||[])affected.add(id);
    for (const key of obsolete) removeContact(key);
    if (trace) trace('contact-remove', performance.now() - started, {changedIds: changed.size, removedPairs: obsolete.size});
    started = trace ? performance.now() : 0;
    const visited = new Set(), pairs = [], owners = [];
    for (const id of changed) {
      const left = preparedStore.get(id);
      if (!left?.segments.length) continue;
      for (const right of preparedStore.nearby(left.bounds)) {
        if (left.id === right.id) continue;
        const ids = [left.id, right.id].sort(), key = contactKey(ids);
        if (visited.has(key)) continue;
        visited.add(key);
        affected.add(left.id); affected.add(right.id);
        pairs.push([left, right]);
        owners.push(ids);
      }
    }
    if (trace) trace('contact-neighbor-search', performance.now() - started,
      {changedIds: changed.size, candidatePairs: pairs.length});
    const computed = computeCountrySharedContacts(pairs, trace, {verifyParity: verifyContactParity});
    started = trace ? performance.now() : 0;
    computed.forEach((segments, index) => {
      contactComputationCount++;
      addContact(owners[index], segments);
    });
    lastAffectedOwners = affected;
    if (trace) trace('contact-merge', performance.now() - started,
      {candidatePairs: pairs.length, computedSegments: computed.reduce((sum, rows) => sum + rows.length, 0)});

  }
  function seed(segments, changed, profile, verifyContactParity) {
    contacts.clear(); contactsByOwner.clear(); edges.clear();
    const pairs = new Map();
    for (const source of segments) {
      const ownerIds = source.ownerIds.filter(id => preparedStore.get(id) && !changed.has(id));
      if (ownerIds.length < 2) continue;
      const segment = attachBoundarySegmentReferences({ ...source, ownerIds,
        ...(source.refs ? { refs: source.refs.filter(ref => ownerIds.includes(String(ref.featureId))) } : {}) }, preparedStore);
      for (let left = 0; left < ownerIds.length; left++) for (let right = left + 1; right < ownerIds.length; right++) {
        const ids = [ownerIds[left], ownerIds[right]].sort(), key = contactKey(ids);
        if (!pairs.has(key)) pairs.set(key, { ids, segments: [] });
        pairs.get(key).segments.push({ ...segment, ownerIds: ids,
          refs: segment.refs.filter(ref => ids.includes(String(ref.featureId))) });
      }
    }
    for (const pair of pairs.values()) addContact(pair.ids, pair.segments);
    reconcile(changed, profile, verifyContactParity);
  }
  function replace(features, { cachedSegments, changedIds, profile, verifyContactParity = false } = {}) {
    const started = typeof profile === 'function' ? performance.now() : 0;
    touchedEdges.clear();
    const changed = preparedStore.replace(features);
    if (typeof profile === 'function') profile('prepare-store-replace', performance.now() - started,
      {changedIds: changed.size, totalFeatures: features.length});
    if (cachedSegments) seed(cachedSegments,
      changedIds === undefined ? changed : new Set([...changedIds].map(String)), profile, verifyContactParity);
    else reconcile(changed, profile, verifyContactParity);
    return changed;
  }
  function patch(features = [], removedIds = [], {profile, verifyContactParity = false} = {}) {
    const started = typeof profile === 'function' ? performance.now() : 0;
    touchedEdges.clear();
    const changed = preparedStore.patch(features, removedIds);
    if (typeof profile === 'function') profile('prepare-store-patch', performance.now() - started,
      {changedIds: changed.size, suppliedFeatures: features.length, removedIds: removedIds.length});
    reconcile(changed, profile, verifyContactParity);
    return changed;
  }
  return { preparedStore, replace, patch, changedEdges, affectedOwners:() => new Set(lastAffectedOwners),
    segments: () => [...edges.values()].map(record => record.value),
    features: () => preparedStore.values().map(prepared => prepared.feature),
    stats: () => ({ ...preparedStore.stats(), contactComputationCount, contactCount: contacts.size }) };
}
