import { sameStructuredValue } from '../runtime/structured-value.js';
import { timelineObjectKey } from './timeline-records.js';
import { projectTimelineIdentity } from './timeline-resolver.js';
import { rememberWorldViewChange } from './world-view-change.js';
import { createWorldLookup } from './world-view-lookup.js';
import { normalizeTemporalInterval, temporalMonthEnd } from './temporal.js';
import { createWorldBindingIndex, sourceBindingCertificate } from './world-binding-index.js';
import { refKey, invalid, freeze } from './core-read-contract.js';
import { worldEntityPayload, validateWorldDelta, collectWorldChanges, stableWorldOrder, assembleWorldRows } from './core-world-delta.js';

const sameDisplayValue = (left, right) => sameStructuredValue(left, right, Object.is);

/** Owns accepted world rows, binding certificates and stable presentation views. */
export function createCoreWorldProjection({readProject, readGeometries}) {
  let world = null;
  let worldSourceProject = null;
  let territorialViews = Object.freeze([]);
  let hydroViews = Object.freeze([]);
  // Cache indexes by immutable source collections, not the whole project
  // snapshot: a geometry-only delta does not invalidate object identities.
  const identityIndexes = new WeakMap(), bindingIndexes = new WeakMap(), projectionSources = new WeakMap(), resourceIndexes = new WeakMap();
  const worldBindingWindows = new WeakMap(), viewsByRow = new WeakMap(), worldLookups = new WeakMap(), viewOffsets = new WeakMap();
  function identityIndex(identities) {
    let index = identityIndexes.get(identities);
    if (!index) {index = new Map(identities.map(identity => [identity.id, identity])); identityIndexes.set(identities, index);}
    return index;
  }
  function resourceIndex(project) {
    const resources = project.geometryResources;
    if (!resources)return null;
    let index = resourceIndexes.get(resources);
    if (!index) {index = new Map(resources.map(row=>[refKey(row),row]));resourceIndexes.set(resources,index);}
    return index;
  }
  function sourceBindingCandidates(identity, ref) {
    const bindings = identity.properties?.metadata?.historicalTimeline?.geometryBindings;
    if (!Array.isArray(bindings))return [];
    let index = bindingIndexes.get(bindings);
    if (!index) {
      index = new Map();
      for (const binding of bindings) {
        if (!binding.geometryRef)continue;
        const key = refKey(binding.geometryRef);
        if (!index.has(key))index.set(key, []);
        index.get(key).push({binding, interval:null});
      }
      bindingIndexes.set(bindings, index);
    }
    return index.get(refKey(ref))||[];
  }
  function bindingInterval(row) {
    return row.interval??=normalizeTemporalInterval(row.binding.validFrom, row.binding.validTo);
  }
  function canReuseWorldAt(month) {
    if (worldSourceProject!==readProject())return false;
    if (month===world.month)return true;
    const window = worldBindingWindows.get(world.entities);
    return !!window&&window.allows(temporalMonthEnd(month));
  }
  function worldAgainst(responseWorld,expectedEpoch,sourceProject,sourceGeometries,detached = false) {
    if (!responseWorld || !Array.isArray(responseWorld.entities) || typeof responseWorld.month !== 'string')
      invalid('A source-pinned C++ world response is required.');
    if (detached ? Object.hasOwn(responseWorld,'sourceEpoch') : !Number.isSafeInteger(responseWorld.sourceEpoch) || !Number.isSafeInteger(expectedEpoch))
      invalid('A detached import world must be distinct from an epoch-pinned active read model.');
    if (!detached && responseWorld.sourceEpoch !== expectedEpoch) throw Object.assign(new Error('The C++ world belongs to another document operation epoch.'),
      { code: 'PL-CORE-STALE', name: 'AbortError', cancelled: true });
    const identities={territorial:identityIndex(sourceProject.territorialEntities),hydro:identityIndex(sourceProject.hydroEdits)};
    const referenceDate=temporalMonthEnd(responseWorld.month), resources=resourceIndex(sourceProject);
    const previousWorld = !detached ? world : null;
    const ranges=[];
    const lookup=createWorldLookup();
    const rows=responseWorld.entities.map(row=>{
      const key=timelineObjectKey(row.objectRef);
      if(lookup.has(key))invalid('Duplicate C++ world identity: '+row.objectRef.id);
      const projected=projectRow(row,identities,sourceGeometries,resources,referenceDate,previousWorld,range=>ranges.push(range));
      lookup.set(key,projected);return projected;
    });
    return makeWorld(responseWorld,rows,lookup,createWorldBindingIndex(ranges),detached);
  }
  function makeWorld(response,rows,lookup,window,detached=false){
    Object.freeze(rows);worldBindingWindows.set(rows,window);worldLookups.set(rows,lookup);
    return Object.freeze({month:response.month,...(detached?{}:{sourceEpoch:response.sourceEpoch}),entities:rows,
      byId:Object.freeze({get:id=>lookup.get(timelineObjectKey({domain:'territorial',id})),getObject:ref=>lookup.get(timelineObjectKey(ref))})});
  }
  function projectRow(row,identities,sourceGeometries,resources,referenceDate,previousWorld,recordBinding){
      const identity=identities[row.objectRef.domain]?.get(row.objectRef.id);
      const resource=resources?.get(refKey(row.geometryRef))||null;
      // Resource-backed rows do not pin coordinates in historical world views.
      // An undeclared missing geometry is still a rejected Core response.
      const geometry=resource?null:sourceGeometries.get(row.geometryRef);
      if (!identity || (!geometry&&!resource) || !Array.isArray(row.ancestors))
        invalid(`The C++ world contains an unknown/duplicate identity or geometry: ${row.objectRef.id}`);
      for (const field of ['parentId','coverageMode','validFrom','validTo','rootId'])
        if (!Object.hasOwn(row, field)) invalid(`Required C++ world field is missing: ${field}`);
      if (!row.properties || typeof row.properties !== 'object') invalid('C++ temporal property projection is required.');
      // Identity and geometry are from the unchanged, immutable source snapshot.
      // Reuse a resolved row when only the cursor changed, not its visible data.
      const candidates=sourceBindingCandidates(identity,row.geometryRef);
      const {selected:selectedBinding,range}=sourceBindingCertificate(candidates,referenceDate,bindingInterval);
      recordBinding(range);
      const sourceBinding=selectedBinding?.binding;
      const sourceVersion=sourceBinding?.sourceVersionId ?? String(identity.properties?.sourceGeometryVersion ?? '');
      const prior=previousWorld?.byId?.getObject?.(row.objectRef);
      const priorSource=projectionSources.get(prior);
      if(prior && prior.geometry===geometry && prior.geometryResource===resource && priorSource?.identity===identity
        && priorSource.version===sourceVersion&&priorSource.binding===sourceBinding
        && (prior===row||(
          ['parentId','coverageMode','validFrom','validTo','rootId'].every(field=>prior[field]===row[field])
          && sameDisplayValue(prior.geometryRef,row.geometryRef)
          && sameDisplayValue(prior.ancestors,row.ancestors)
          && sameDisplayValue(prior.rendering,row.rendering)
          && sameDisplayValue(prior.properties,row.properties)))) {
        return prior;
      }
      const temporalIdentity=projectTimelineIdentity(identity,row.properties,{immutableSource:true});
      const datedIdentity=sourceBinding
        ?freeze({...temporalIdentity,properties:{...temporalIdentity.properties,
          sourceGeometryVersion:sourceVersion}}):temporalIdentity;
      const effectiveIdentity=row.objectRef.domain==='hydro'
        ?freeze({...datedIdentity,properties:{...datedIdentity.properties,...row.rendering}}):datedIdentity;
      const projected = freeze({ ...structuredClone(worldEntityPayload(row)), id:row.objectRef.id, identity:effectiveIdentity, geometry, ...(resource?{geometryResource:resource}:{}) });
      projectionSources.set(projected,{identity,version:sourceVersion,binding:sourceBinding});
      return projected;
  }
  const projectWorld=(value,expectedEpoch) => worldAgainst(value,expectedEpoch,readProject(),readGeometries());
  function viewForRow(row){
    const isHydro=row.objectRef.domain==='hydro';
      let view=viewsByRow.get(row);
      if(!view){
        const prior=world?.byId.getObject(row.objectRef),priorView=prior&&viewsByRow.get(prior);
        if(priorView&&prior.geometry===row.geometry&&prior.geometryResource===row.geometryResource
          &&(prior.identity===row.identity||(prior.identity.id===row.identity.id&&sameDisplayValue(prior.identity.properties,row.identity.properties)))
          &&['parentId','coverageMode','validFrom','validTo'].every(field=>prior[field]===row[field]))view=priorView;
        else if(isHydro)view=freeze({...row.identity,geometry:row.geometry,...(row.geometryResource?{geometryRef:row.geometryResource}:{})});
        else view=freeze({...row.identity,geometry:row.geometry,...(row.geometryResource?{geometryRef:row.geometryResource}:{}),properties:{...row.identity.properties,
          parentId:row.parentId,coverageMode:row.coverageMode,validFrom:row.validFrom,validTo:row.validTo}});
        viewsByRow.set(row,view);
      }
    return view;
  }
  function viewsForWorld(nextWorld) {
    const territorial=[],hydro=[],territorialOffsets=new Map(),hydroOffsets=new Map();
    let sameTerritorial=true,sameHydro=true;
    for(const row of nextWorld.entities){
      const isHydro=row.objectRef.domain==='hydro';
      const target=isHydro?hydro:territorial,previous=isHydro?hydroViews:territorialViews;
      const view=viewForRow(row);
      if(view!==previous[target.length]){if(isHydro)sameHydro=false;else sameTerritorial=false;}
      (isHydro?hydroOffsets:territorialOffsets).set(row.id,target.length);
      target.push(view);
    }
    const nextTerritorial=sameTerritorial&&territorial.length===territorialViews.length?territorialViews:Object.freeze(territorial);
    const nextHydro=sameHydro&&hydro.length===hydroViews.length?hydroViews:Object.freeze(hydro);
    viewOffsets.set(nextTerritorial,territorialOffsets);viewOffsets.set(nextHydro,hydroOffsets);
    return {territorial:nextTerritorial,hydro:nextHydro};
  }
  function acceptWorld(value,expectedEpoch) {
    const nextWorld=projectWorld(value,expectedEpoch);
    const views=viewsForWorld(nextWorld);
    world=nextWorld;
    worldSourceProject=readProject();
    territorialViews=views.territorial;hydroViews=views.hydro;
    return nextWorld;
  }
  function acceptStableWorldDelta(delta,positions){
    const project=readProject(), geometries=readGeometries();
    const prior=world,oldWindow=worldBindingWindows.get(prior.entities),lookup=worldLookups.get(prior.entities);
    if(!oldWindow||!lookup||worldSourceProject!==project)return null;
    const referenceDate=temporalMonthEnd(delta.month), resources=resourceIndex(project);
    const limit=Math.max(16,Math.floor(prior.entities.length/2));
    if(positions.size>limit)return null;
    // Core rows may be unchanged while their source-version metadata crosses
    // a binding boundary. Reproject only those certified affected leaves.
    const expired=oldWindow.changed(referenceDate,limit);
    if(expired.length>limit)return null;
    const affected=new Map(positions);
    for(const index of expired)if(!affected.has(index))affected.set(index,prior.entities[index]);
    if(affected.size>limit)return null;
    const ranges=new Map();
    const identities={territorial:identityIndex(project.territorialEntities),hydro:identityIndex(project.hydroEdits)};
    let rows=prior.entities;
    const updates=[];
    const territorialChanges=[],hydroChanges=[];
    for(const [index,entity]of affected){
      const row=projectRow(entity,identities,geometries,resources,referenceDate,prior,range=>ranges.set(index,range));
      if(row===prior.entities[index])continue;
      if(rows===prior.entities)rows=rows.slice();
      rows[index]=row;updates.push([timelineObjectKey(row.objectRef),row]);
      const isHydro=row.objectRef.domain==='hydro',before=isHydro?hydroViews:territorialViews;
      const offset=viewOffsets.get(before)?.get(row.id);
      if(offset===undefined)return null;
      const view=viewForRow(row);
      if(view!==before[offset])(isHydro?hydroChanges:territorialChanges).push([offset,view]);
    }
    const patchViews=(before,changed)=>{
      if(!changed.length)return before;
      const next=before.slice();
      for(const [index,view]of changed)next[index]=view;
      Object.freeze(next);viewOffsets.set(next,viewOffsets.get(before));
      rememberWorldViewChange(before,next,changed.map(([index])=>index));
      return next;
    };
    // A new certificate cannot replace the one attached to a previous
    // immutable row array. Share the rows themselves, not the array key.
    if(rows===prior.entities&&ranges.size)rows=rows.slice();
    const next=makeWorld(delta,rows,updates.length?lookup.fork(updates):lookup,oldWindow.fork(ranges));
    territorialViews=patchViews(territorialViews,territorialChanges);
    hydroViews=patchViews(hydroViews,hydroChanges);
    world=next;worldSourceProject=project;return next;
  }
  function acceptWorldDelta(delta, state) {
    validateWorldDelta(world, delta, state);
    const hasChanges = delta.upserts.length || delta.removed.length || Object.hasOwn(delta, 'retainedOrder');
    const acceptRows = entities => acceptWorld({
      month: delta.month, sourceEpoch: delta.sourceEpoch, entities,
    }, state.epoch);

    if (!hasChanges) {
      if (delta.entityCount !== world.entities.length) invalid('World delta entity count differs.');
      if (canReuseWorldAt(delta.month)) {
        world = Object.freeze({...world, month: delta.month, sourceEpoch: state.epoch});
        return world;
      }
      return acceptStableWorldDelta(delta, new Map()) || acceptRows(world.entities);
    }

    const changes = collectWorldChanges(world, delta);
    if (stableWorldOrder(world, delta, changes.positions)) {
      const stable = acceptStableWorldDelta(delta, changes.positions);
      if (stable) return stable;
    }
    return acceptRows(assembleWorldRows(world, delta, changes));
  }

  function rebaseWorld(epoch) {
    if (!world) invalid('A current C++ world must be admitted before rebasing an unchanged timeline.');
    if(worldSourceProject===readProject()){
      world=Object.freeze({...world,sourceEpoch:epoch});
      return world;
    }
    const entities=world.entities;
    return acceptWorld({ month: world.month,sourceEpoch: epoch,entities },epoch);
  }

  function reset() {
    world=null; worldSourceProject=null;
    territorialViews=Object.freeze([]); hydroViews=Object.freeze([]);
  }
  function rebaseGeometrySource(previousProject) {
    // Do not retain an obsolete geometry archive through the current projection.
    worldSourceProject=worldSourceProject===previousProject?readProject():null;
  }
  return Object.freeze({
    getIdentity:(identities,id) => identityIndex(identities).get(id)||null,
    projectWorld, acceptWorld, acceptWorldDelta, rebaseWorld, reset, rebaseGeometrySource,
    world:() => world, territorialViews:() => territorialViews, hydroViews:() => hydroViews,
  });
}
