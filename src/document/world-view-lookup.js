// Sparse changes copy only affected buckets, not the entire index or a
// chain of earlier snapshots. The initial builder alone exposes mutation.
const BUCKET_COUNT = 64;

function bucketIndex(key) {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  }
  return (hash >>> 0) % BUCKET_COUNT;
}

function lookupFor(buckets) {
  function fork(updates) {
    const nextBuckets = buckets.slice();
    const copiedBuckets = new Set();
    for (const [key, value] of updates) {
      const index = bucketIndex(key);
      if (!copiedBuckets.has(index)) {
        nextBuckets[index] = new Map(nextBuckets[index]);
        copiedBuckets.add(index);
      }
      nextBuckets[index].set(key, value);
    }
    return lookupFor(nextBuckets);
  }
  return {
    get: key => buckets[bucketIndex(key)].get(key),
    has: key => buckets[bucketIndex(key)].has(key),
    fork,
  };
}

export function createWorldLookup() {
  const buckets = Array.from({length: BUCKET_COUNT}, () => new Map());
  return {
    ...lookupFor(buckets),
    set(key, value) {
      buckets[bucketIndex(key)].set(key, value);
    },
  };
}
