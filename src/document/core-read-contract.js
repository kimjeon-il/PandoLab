export const fields = Object.freeze({ territorial: 'territorialEntities', label: 'labels', hydro: 'hydroEdits',
  generic: 'genericFeatures', distributionLayer: 'distributionLayers', distributionEntry: 'distributionEntries' });
export const refKey = ref => JSON.stringify([ref.id, ref.version]);
export const invalid = message => { throw Object.assign(new Error(message), { code: 'PL-CORE-RESPONSE' }); };
export function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

