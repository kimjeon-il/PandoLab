import { createPreparedBoundaryStore, attachBoundarySegmentReferences, topologyNodeKey, mergeSharedBoundaryContributions } from "../geometry/boundary-topology.js";
import { computeCountrySharedContacts } from "../geometry/country-contact-core.js";
import { countryBoundaryOwner, countryBoundarySeedOptions } from "./country-boundary-seed.js";

// Every ordinary map style renders shared land borders, not per-object coastal outlines.
// This is a presentation policy: canonical polygon/coast geometry is unchanged.
export function visibleCountrySharedSegments(segments = [], isVisible = () => true) {
  return segments.filter(segment => segment.ownerIds.some(isVisible));
}

/** A seed is optional and can only accelerate the first complete snapshot. */
export function createCountryBoundaryPreparation({loadSeed, seedWaitMs = 5_000}) {
  let current = null, seedPromise;
  let boundarySeedFailure = null, boundarySeeded = false, boundaryChangedCount = 0;

  function readSeed() {
    return seedPromise ||= (async () => {
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Country boundary seed timed out');
          controller.abort(error);
          reject(error);
        }, seedWaitMs);
      });
      try {
        return await Promise.race([loadSeed(controller.signal), timeout]);
      } catch (error) {
        boundarySeedFailure = error?.message || String(error);
        return null;
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    })();
  }

  async function prepare(input, context) {
    context.throwIfCancelled();
    if (current?.key === input.key) return current;
    if (input.baseKey !== null && current?.key !== input.baseKey) return null;
    const upserts = input.upserts.map(({id, geometry}) => ({type: 'Feature', id: countryBoundaryOwner(id), geometry}));
    if (input.baseKey === null) {
      const seed = current ? null : await readSeed();
      context.throwIfCancelled();
      if (current?.key === input.key) return current;
      const options = countryBoundarySeedOptions(upserts, seed);
      boundarySeeded = !!options;
      boundaryChangedCount = options?.changedIds.size ?? upserts.length;
      let state = null, segments = options?.cachedSegments;
      if (!options || options.changedIds.size) {
        state = createCountrySharedBoundaryState();
        state.replace(upserts, options);
        segments = state.segments();
      }
      current = {key: input.key, state, segments, seedRows: state ? null : upserts};
    } else {
      const previous = current;
      // A failed state patch must force the next delivery to rebuild its base.
      current = null;
      const state = previous.state ?? createCountrySharedBoundaryState();
      const removed = input.remove.map(countryBoundaryOwner);
      if (previous.state) {
        boundaryChangedCount = state.patch(upserts, removed).size;
      } else {
        const rows = new Map(previous.seedRows.map(row => [row.id, row]));
        const changedIds = new Set(removed);
        for (const id of removed) rows.delete(id);
        for (const row of upserts) { rows.set(row.id, row); changedIds.add(row.id); }
        state.replace([...rows.values()], {cachedSegments: previous.segments, changedIds});
        boundaryChangedCount = changedIds.size;
      }
      current = {key: input.key, state, segments: state.segments()};
    }
    return current;
  }
  return {prepare, stats: () => ({boundarySeedFailure, boundarySeeded, boundaryChangedCount})};
}

const sharedSegmentKey = segment => [topologyNodeKey(segment.start), topologyNodeKey(segment.end)].sort().join('|');
const contactKey = ids => JSON.stringify([...ids].sort());

/** Prepared features and contact adjacency survive Worker patch messages. */
export function createCountrySharedBoundaryState() {
  const preparedStore = createPreparedBoundaryStore();
  const contacts = new Map(), contactsByOwner = new Map(), edges = new Map();
  let contactComputationCount = 0;
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
    const changed = preparedStore.patch(features, removedIds);
    if (typeof profile === 'function') profile('prepare-store-patch', performance.now() - started,
      {changedIds: changed.size, suppliedFeatures: features.length, removedIds: removedIds.length});
    reconcile(changed, profile, verifyContactParity);
    return changed;
  }
  return { preparedStore, replace, patch,
    segments: () => [...edges.values()].map(record => record.value),
    features: () => preparedStore.values().map(prepared => prepared.feature),
    stats: () => ({ ...preparedStore.stats(), contactComputationCount, contactCount: contacts.size }) };
}
