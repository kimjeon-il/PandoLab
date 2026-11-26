
import { worldViewChange } from './world-view-change.js';
const text = value => String(value ?? '').trim();

/** Owns hierarchy indexes over common Store read projections. */
export function createTerritorialEntityRepository({
  entityStore,
  getEntities = entityStore?.snapshot,
} = {}) {
  if (typeof getEntities !== 'function') throw new TypeError('영역 엔티티 Repository에는 공통 엔티티 공급자가 필요합니다.');
  let cached = null;
  function snapshot() {
    const values = getEntities();
    if (!Array.isArray(values)) throw new TypeError('영역 엔티티 공급자는 배열을 반환해야 합니다.');
    if (cached?.values === values) return cached;
    const changes = cached&&worldViewChange(cached.values, values);
    if (changes) {
      // The receipt guarantees identity/order stability. Update only affected
      // indexes; this private map is never exposed to snapshot consumers.
      for (const i of changes) {
        const before = cached.values[i], after = values[i], id = text(after.id);
        const oldParent = text(before.properties?.parentId), newParent = text(after.properties?.parentId);
        cached.byId.set(id, after);
        if (oldParent) {
          const siblings = cached.childrenByParent.get(oldParent), position = siblings?.indexOf(before)??-1;
          if (position>=0) {if (oldParent===newParent)siblings[position] = after; else siblings.splice(position, 1);}
          if (!siblings?.length)cached.childrenByParent.delete(oldParent);
        }
        if (newParent&&newParent!==oldParent) {
          const siblings = cached.childrenByParent.get(newParent)||[];
          // Preserve the catalog order for administrative queries.
          siblings.push(after); siblings.sort((a, b) => cached.offsets.get(text(a.id))-cached.offsets.get(text(b.id)));
          cached.childrenByParent.set(newParent, siblings);
        }
      }
      cached.values = values; cached.lists.clear(); return cached;
    }
    const byId = new Map(), childrenByParent = new Map(), offsets = new Map();
    for (const entity of values) {
      const id = text(entity?.id);
      if (!id) throw new Error('영역 엔티티 ID가 비어 있습니다.');
      if (byId.has(id)) throw new Error(`영역 엔티티 ID가 중복되었습니다: ${id}`);
      offsets.set(id, byId.size); byId.set(id, entity);
      const parentId = text(entity.properties?.parentId);
      if (parentId) {
        const children = childrenByParent.get(parentId) || [];
        children.push(entity); childrenByParent.set(parentId, children);
      }
    }
    cached = { values, byId, childrenByParent, offsets, lists: new Map() };
    return cached;
  }

  const entityFrom = (state, id) => state.byId.get(text(id)) || null;
  const parentFrom = (state, id) => {
    const entity = entityFrom(state, id);
    const parentId = text(entity?.properties?.parentId);
    if (!parentId) return null;
    const parent = entityFrom(state, parentId);
    if (!parent) throw new Error(`${text(entity?.id) || text(id)}의 상위 영역 엔티티 ${parentId}이 존재하지 않습니다.`);
    return parent;
  };

  function get(id) {
    return entityFrom(snapshot(), id);
  }

  function list({
    kind = '',
    parentId = null,
    rootId = null,
  } = {}) {
    const state = snapshot();
    const cacheKey = JSON.stringify([kind, parentId, rootId]);
    if (state.lists.has(cacheKey)) return state.lists.get(cacheKey);
    let values = state.values;
    if (kind) {
      const kinds = new Set(Array.isArray(kind) ? kind : [kind]);
      values = values.filter(entity => kinds.has(entity.properties?.entityKind));
    }
    if (parentId !== null) {
      const key = text(parentId);
      values = values.filter(entity => text(entity.properties?.parentId) === key);
    }
    if (rootId !== null) {
      const key = text(rootId);
      values = values.filter(entity => text(root(entity.id)?.id) === key);
    }
    state.lists.set(cacheKey, values);
    return values;
  }

  function children(id, { kind = '' } = {}) {
    const state = snapshot();
    const values = [...(state.childrenByParent.get(text(id)) || [])];
    return kind ? values.filter(entity => entity.properties?.entityKind === kind) : values;
  }

  function parent(id) {
    return parentFrom(snapshot(), id);
  }

  function siblings(id, { kind = '' } = {}) {
    const state = snapshot();
    const entity = entityFrom(state, id);
    if (!entity) return [];
    const parentId = text(entity.properties?.parentId);
    const entityKind = entity.properties?.entityKind;
    const values = parentId
      ? [...(state.childrenByParent.get(parentId) || [])]
      : state.values.filter(candidate => !text(candidate.properties?.parentId));
    return values.filter(candidate => {
      if (text(candidate.id) === text(entity.id)) return false;
      if (kind && candidate.properties?.entityKind !== kind) return false;
      if (!kind && candidate.properties?.entityKind !== entityKind) return false;
      return true;
    });
  }

  function ancestors(id) {
    const state = snapshot();
    const result = [];
    const seen = new Set([text(id)]);
    let cursor = parentFrom(state, id);
    while (cursor) {
      const key = text(cursor.id);
      if (seen.has(key)) throw new Error(`영역 엔티티 상위 관계가 순환합니다: ${key}`);
      seen.add(key);
      result.push(cursor);
      cursor = parentFrom(state, key);
    }
    return result;
  }

  function descendants(id, { kind = '' } = {}) {
    const state = snapshot();
    const result = [];
    const seen = new Set([text(id)]);
    const pending = [...(state.childrenByParent.get(text(id)) || [])];
    while (pending.length) {
      const entity = pending.shift();
      const key = text(entity?.id);
      if (!key) continue;
      if (seen.has(key)) throw new Error(`영역 엔티티 상위 관계가 순환합니다: ${key}`);
      seen.add(key);
      if (!kind || entity.properties?.entityKind === kind) result.push(entity);
      pending.push(...(state.childrenByParent.get(key) || []));
    }
    return result;
  }

  function root(id) {
    const state = snapshot();
    const entity = entityFrom(state, id);
    if (!entity) return null;
    const seen = new Set([text(entity.id)]);
    let cursor = entity;
    while (true) {
      const next = parentFrom(state, cursor.id);
      if (!next) return cursor;
      const key = text(next.id);
      if (seen.has(key)) throw new Error(`영역 엔티티 상위 관계가 순환합니다: ${key}`);
      seen.add(key);
      cursor = next;
    }
  }

  return Object.freeze({
    get,
    has: id => !!get(id),
    list,
    children,
    parent,
    siblings,
    ancestors,
    descendants,
    root,
  });
}
