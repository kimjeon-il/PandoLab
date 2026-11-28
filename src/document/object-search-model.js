const TYPE_LABELS = Object.freeze({objects:'객체', distributions:'분포', labels:'도시', genericFeatures:'기타 객체'});
const searchNameCollator = new Intl.Collator('ko', {numeric:true, sensitivity:'base'});

const compareKeys = (left, right) => left < right ? -1 : left > right ? 1 : 0;

/** Build the main-thread identity catalog without sorting or preparing search text. */
export function createObjectSearchCatalog({items, groups, itemRef}) {
  const rows = new Map();
  for (const group of groups) for (const source of items(group)) {
    const layerGroup = source.layerGroup || group;
    const ref = itemRef(layerGroup, source.id);
    const key = ref?.key || layerGroup + ':' + source.id;
    if (rows.has(key)) continue;
    const typeLabel = layerGroup === 'hydro'
      ? source.hydroCategory === 'lake' ? '호수' : '강'
      : layerGroup === 'genericFeatures'
        ? source.meta?.split(' · ')[0] || TYPE_LABELS[layerGroup]
        : TYPE_LABELS[layerGroup] || layerGroup;
    rows.set(key, {...source, kind:'object', key, ref, layerGroup, typeLabel});
  }
  return Object.freeze({items:Object.freeze([...rows.values()])});
}

/** Build the searchable order and normalized terms from compact columnar input. */
export function createObjectSearchIndex(catalog) {
  const {keys, ids, names, typeLabels, searchTexts} = catalog || {};
  const count = Array.isArray(keys) ? keys.length : -1;
  if (count < 0 || count > 0xffffffff
    || ![ids, names, typeLabels, searchTexts].every(rows => Array.isArray(rows) && rows.length === count))
    throw new RangeError('Invalid object search catalog columns');
  const entries = new Array(count);
  for (let index = 0; index < count; index++) {
    const key = String(keys[index] || '');
    if (!key) throw new TypeError('Invalid object search catalog key');
    const name = String(names[index] || '');
    const terms = [name, typeLabels[index] || '', searchTexts[index] || '', ids[index] || '']
      .join(' ').toLocaleLowerCase('ko');
    entries[index] = {index, key, name, terms};
  }
  entries.sort((left, right) => searchNameCollator.compare(left.name, right.name) || compareKeys(left.key, right.key));
  return Object.freeze({
    order:Uint32Array.from(entries, row => row.index),
    terms:Object.freeze(entries.map(row => row.terms)),
  });
}

/** Return sorted catalog positions; the Worker transfers this compact result. */
export function searchObjectSearchIndex(index, search = '') {
  const query = String(search ?? '').trim().toLocaleLowerCase('ko');
  if (!query) return new Uint32Array(0);
  const matches = [];
  for (let i = 0; i < index.terms.length; i++)
    if (index.terms[i].includes(query)) matches.push(i);
  return Uint32Array.from(matches);
}

/** Synchronous reference path retained for isolated callers without a Worker. */
export function createObjectSearchModel({items, groups, itemRef, compare}) {
  const catalog = createObjectSearchCatalog({items, groups, itemRef});
  const order = (a, b) => (compare
    ? compare({name:a.name, id:''}, {name:b.name, id:''})
    : searchNameCollator.compare(a.name, b.name)) || compareKeys(a.key, b.key);
  const orderedItems = Object.freeze([...catalog.items].sort(order));
  const terms = Object.freeze(orderedItems.map(item =>
    [item.name, item.typeLabel, item.searchText || '', item.id].join(' ').toLocaleLowerCase('ko')));
  return Object.freeze({items:orderedItems, terms});
}

export function visibleObjectSearchRows(model, search = '') {
  const query = search.trim().toLocaleLowerCase('ko');
  if (!query) return [];
  if (Array.isArray(model.terms) && model.terms.length === model.items.length)
    return model.items.filter((item, index) => model.terms[index].includes(query));
  return model.items.filter(item =>
    [item.name, item.typeLabel, item.searchText || '', item.id].join(' ').toLocaleLowerCase('ko').includes(query));
}
