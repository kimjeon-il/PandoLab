import { timelineObjectKey } from './timeline-records.js';
import { invalid } from './core-read-contract.js';

export const worldEntityPayload=({objectRef,geometryRef,rendering,parentId,coverageMode,validFrom,validTo,rootId,ancestors,properties})=>
  ({objectRef,geometryRef,rendering,parentId,coverageMode,validFrom,validTo,rootId,ancestors,properties});

const temporalPropertyNames = new Set(['name', 'color', 'flag']);

function worldObjectKey(ref) {
  if (!ref || typeof ref.domain !== 'string' || typeof ref.id !== 'string')
    invalid('A world delta requires a valid object reference.');
  return timelineObjectKey(ref);
}

export function validateWorldDelta(world, delta, state) {
  if (!world || delta.baseEpoch !== world.sourceEpoch || delta.sourceEpoch !== state.epoch
    || delta.month !== state.timelineCursor || !Array.isArray(delta.upserts) || !Array.isArray(delta.removed)
    || !Number.isSafeInteger(delta.entityCount) || delta.entityCount < 0
    || delta.entityCount > world.entities.length + delta.upserts.length
    || (Object.hasOwn(delta, 'retainedOrder') && !Array.isArray(delta.retainedOrder)))
    invalid('A world delta requires its accepted base epoch and target cursor.');
}

function expandWorldUpsert(world, update) {
  if (!update || typeof update !== 'object') invalid('Invalid world delta upsert.');
  if (!Object.hasOwn(update, 'propertyPatch')) return update.entity;
  const patch = update.propertyPatch;
  if (Object.hasOwn(update, 'entity') || !patch || typeof patch !== 'object')
    invalid('Invalid property-only world patch.');

  const {objectRef, set, removed} = patch;
  worldObjectKey(objectRef);
  const prior = world.byId.getObject(objectRef);
  if (!prior || !set || typeof set !== 'object' || Array.isArray(set) || !Array.isArray(removed))
    invalid('Invalid property-only world patch.');

  const validRemoval = name => typeof name === 'string' && temporalPropertyNames.has(name)
    && Object.hasOwn(prior.properties, name) && !Object.hasOwn(set, name);
  if (new Set(removed).size !== removed.length || !removed.every(validRemoval)
    || Object.keys(set).some(name => !temporalPropertyNames.has(name)))
    invalid('Invalid property-only world patch.');

  const properties = {...prior.properties};
  for (const name of removed) delete properties[name];
  Object.assign(properties, set);
  return {...worldEntityPayload(prior), properties};
}

export function collectWorldChanges(world, delta) {
  let retainedCount = world.entities.length;
  const touched = new Set();
  const positions = new Map();

  for (const ref of delta.removed) {
    const id = worldObjectKey(ref);
    if (touched.has(id) || !world.byId.getObject(ref)) invalid('Invalid world delta removal.');
    touched.add(id);
    retainedCount--;
  }

  for (const update of delta.upserts) {
    const entity = expandWorldUpsert(world, update);
    const {index} = update;
    const id = worldObjectKey(entity?.objectRef);
    const validIndex = Number.isSafeInteger(index) && index >= 0 && index < delta.entityCount;
    if (touched.has(id) || !validIndex || positions.has(index)) invalid('Invalid world delta upsert.');
    touched.add(id);
    if (world.byId.getObject(entity.objectRef)) retainedCount--;
    positions.set(index, entity);
  }

  if (retainedCount + positions.size !== delta.entityCount) invalid('World delta entity count differs.');
  return {touched, positions, retainedCount};
}

export function stableWorldOrder(world, delta, positions) {
  if (delta.removed.length || Object.hasOwn(delta, 'retainedOrder')
    || delta.entityCount !== world.entities.length) return false;
  for (const [index, entity] of positions) {
    if (worldObjectKey(world.entities[index].objectRef) !== worldObjectKey(entity.objectRef)) return false;
  }
  return true;
}

export function assembleWorldRows(world, delta, {touched, positions, retainedCount}) {
  let retained = world.entities;
  if (Object.hasOwn(delta, 'retainedOrder')) {
    if (delta.retainedOrder.length !== retainedCount) invalid('Invalid retained world delta order count.');
    const ordered = new Set();
    retained = delta.retainedOrder.map(ref => {
      const id = worldObjectKey(ref);
      const row = world.byId.getObject(ref);
      if (!row || touched.has(id) || ordered.has(id)) invalid('Invalid retained world delta order identity.');
      ordered.add(id);
      return row;
    });
  }

  let cursor = 0;
  return Array.from({length: delta.entityCount}, (_, index) => {
    if (positions.has(index)) return positions.get(index);
    while (cursor < retained.length) {
      const row = retained[cursor++];
      if (!touched.has(worldObjectKey(row.objectRef))) return row;
    }
    invalid('Missing retained world delta row.');
  });
}
