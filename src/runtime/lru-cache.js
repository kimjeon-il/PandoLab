// Insertion order is recency order. Callers own values, protection and disposal.
export function setLruEntry(entries, key, entry) {
  entries.delete(key);
  entries.set(key, entry);
  return entry;
}
export function touchLruEntry(entries, key) {
  const entry = entries.get(key);
  if (entry!==undefined)setLruEntry(entries, key, entry);
  return entry;
}
export function trimLruEntries(entries, protectedKeys, byteBudget, bytesOf, discard,
  {entryLimit = Infinity, residentBytes} = {}) {
  let bytes = residentBytes;
  if (bytes===undefined) {
    bytes = 0;
    for (const entry of entries.values())bytes+=bytesOf(entry);
  }
  for (const [key, entry] of entries) {
    if (bytes<=byteBudget&&entries.size<=entryLimit)break;
    if (protectedKeys?.has(key))continue;
    bytes-=bytesOf(entry); entries.delete(key); discard?.(key, entry);
  }
  return bytes;
}
export function trimLruCount(entries, limit) {
  while (entries.size>limit&&entries.size)entries.delete(entries.keys().next().value);
}
