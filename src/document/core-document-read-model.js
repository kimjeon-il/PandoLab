import { timelineObjectKey } from "./timeline-records.js";
import { createCanonicalGeometryVersionStore as createGeometryVersionStore } from "../geometry/geometry-version-store.js";
import { projectTimelineIdentity } from "./timeline-resolver.js";
import {rememberWorldViewChange} from './world-view-change.js';
import {createWorldLookup} from './world-view-lookup.js';
import { normalizeTemporalInterval,temporalContains, temporalMonthEnd,compareTemporalKeys } from "./temporal.js";

const fields = Object.freeze({ territorial: 'territorialEntities', label: 'labels', hydro: 'hydroEdits',
  generic: 'genericFeatures', distributionLayer: 'distributionLayers', distributionEntry: 'distributionEntries' });
const refKey = ref => JSON.stringify([ref.id, ref.version]);
const headerFields=new Set(['format','schemaVersion','version','savedAt','baseDataset','landObjectModel','territorialModel',
  'distributionModel','projectSetup','documentId','physicalSourceInfo','sourceInfo']);
const invalid = message => { throw Object.assign(new Error(message), { code: 'PL-CORE-RESPONSE' }); };
const sameCoordinates = (left,right) => Array.isArray(left) && Array.isArray(right)
  ? left.length===right.length && left.every((value,index) => sameCoordinates(value,right[index]))
  : Object.is(left,right);
// Compare immutable display values without allocating a JSON string for every
// country on every month transition. Property insertion order is irrelevant.
function sameDisplayValue(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) return left.length === right.length
    && left.every((item, index) => sameDisplayValue(item, right[index]));
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && sameDisplayValue(left[key], right[key]));
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Immutable presentation/storage projection; only accepted C++ deltas publish. */
export function createCoreDocumentReadModel(initialProject) {
  const { geometries: initialGeometries, ...initialProperties } = initialProject;
  const initial = structuredClone(initialProperties);
  let geometries = createGeometryVersionStore(initialGeometries);
  // Storage and render lookup share the same immutable geometry allocations.
  // The lookup is rebuilt only when the C++ geometry archive delta changes.
  let project = freeze({ ...initial, geometries: geometries.snapshot() });
  let provenance = null;
  let world = null;
  let worldSourceProject = null;
  let territorialViews = Object.freeze([]);
  let hydroViews = Object.freeze([]);
  // Cache indexes by immutable source collections, not the whole project
  // snapshot: a geometry-only delta does not invalidate object identities.
  const identityIndexes=new WeakMap(),bindingIndexes=new WeakMap(),projectionSources=new WeakMap();
  const worldBindingWindows=new WeakMap(),viewsByRow=new WeakMap(),worldLookups=new WeakMap(),viewOffsets=new WeakMap();
  function identityIndex(identities){
    let index=identityIndexes.get(identities);
    if(!index){index=new Map(identities.map(identity=>[identity.id,identity]));identityIndexes.set(identities,index);}
    return index;
  }
  function sourceBindingCandidates(identity,ref){
    const bindings=identity.properties?.metadata?.historicalTimeline?.geometryBindings;
    if(!Array.isArray(bindings))return [];
    let index=bindingIndexes.get(bindings);
    if(!index){
      index=new Map();
      for(const binding of bindings){
        if(!binding.geometryRef)continue;
        const key=refKey(binding.geometryRef);
        if(!index.has(key))index.set(key,[]);
        index.get(key).push({binding,interval:null});
      }
      bindingIndexes.set(bindings,index);
    }
    return index.get(refKey(ref))||[];
  }
  function bindingInterval(row){
    return row.interval??=normalizeTemporalInterval(row.binding.validFrom,row.binding.validTo);
  }
  function sourceBindingAt(candidates,date){
    return candidates.find(row=>temporalContains(bindingInterval(row),date))??null;
  }
  // For a unique active source binding, the intersection of its date bounds
  // certifies reuse of the same presentation rows at a later cursor. Ambiguous
  // or inactive bindings remain explicit checks; no hash or month guess.
  function includeBinding(window,candidates,selected){
    if(!candidates.length)return;
    if(candidates.length!==1||!selected){window.checks.push({candidates,selected});return;}
    const {start,end}=bindingInterval(selected);
    if(start&&(!window.start||compareTemporalKeys(window.start.startKey,start.startKey)<0))window.start=start;
    if(end&&(!window.end||compareTemporalKeys(window.end.endKey,end.endKey)>0))window.end=end;
  }
  function canReuseWorldAt(month){
    if(worldSourceProject!==project)return false;
    if(month===world.month)return true;
    const window=worldBindingWindows.get(world.entities);
    if(!window)return false;
    const date=temporalMonthEnd(month);
    if(window.start&&compareTemporalKeys(date.endKey,window.start.startKey)<0
      ||window.end&&compareTemporalKeys(window.end.endKey,date.endKey)<0)return false;
    return window.checks.every(({candidates,selected})=>sourceBindingAt(candidates,date)===selected);
  }
  function acceptLoadedProject(value) {
    if (!value || !Array.isArray(value.geometries)) invalid('A complete accepted C++ storage snapshot is required after document load.');
    for (const field of Object.values(fields)) if (!Array.isArray(value[field]))
      invalid(`Required accepted C++ loaded domain is missing: ${field}`);
    // The geometry registry validates, copies and freezes each untrusted shape.
    // Cloning the entire archive first duplicated every coordinate allocation.
    const { geometries: geometryRows, ...properties } = value;
    const candidate=structuredClone(properties);
    const nextGeometries=createGeometryVersionStore(geometryRows,{reuse:geometries});
    const next=freeze({ ...candidate,geometries: nextGeometries.snapshot() });
    project=next;
    geometries=nextGeometries;
    provenance=null;
    world=null;
    worldSourceProject=null;
    territorialViews=Object.freeze([]);hydroViews=Object.freeze([]);
    return project;
  }
  function list(domain) {
    const field = fields[domain];
    if (!field) invalid(`Unsupported C++ document domain: ${String(domain)}`);
    if(domain==='hydro' && world)return hydroViews;
    return project[field];
  }
  function get(ref) {
    if (!ref || typeof ref.id !== 'string') invalid('An explicit C++ document object reference is required.');
    return identityIndex(list(ref.domain)).get(ref.id) || null;
  }
  function worldAgainst(responseWorld,expectedEpoch,sourceProject,sourceGeometries,detached = false) {
    if (!responseWorld || !Array.isArray(responseWorld.entities) || typeof responseWorld.month !== 'string')
      invalid('A source-pinned C++ world response is required.');
    if (detached ? Object.hasOwn(responseWorld,'sourceEpoch') : !Number.isSafeInteger(responseWorld.sourceEpoch) || !Number.isSafeInteger(expectedEpoch))
      invalid('A detached import world must be distinct from an epoch-pinned active read model.');
    if (!detached && responseWorld.sourceEpoch !== expectedEpoch) throw Object.assign(new Error('The C++ world belongs to another document operation epoch.'),
      { code: 'PL-CORE-STALE', name: 'AbortError', cancelled: true });
    const identities={territorial:identityIndex(sourceProject.territorialEntities),hydro:identityIndex(sourceProject.hydroEdits)};
    const referenceDate=temporalMonthEnd(responseWorld.month);
    const previousWorld = !detached ? world : null;
    const bindingWindow={start:null,end:null,checks:[]};
    const lookup=createWorldLookup();
    const rows=responseWorld.entities.map(row=>{
      const key=timelineObjectKey(row.objectRef);
      if(lookup.has(key))invalid('Duplicate C++ world identity: '+row.objectRef.id);
      const projected=projectRow(row,identities,sourceGeometries,referenceDate,previousWorld,bindingWindow);
      lookup.set(key,projected);return projected;
    });
    return makeWorld(responseWorld,rows,lookup,bindingWindow,detached);
  }
  function makeWorld(response,rows,lookup,window,detached=false){
    Object.freeze(rows);worldBindingWindows.set(rows,window);worldLookups.set(rows,lookup);
    return Object.freeze({month:response.month,...(detached?{}:{sourceEpoch:response.sourceEpoch}),entities:rows,
      byId:Object.freeze({get:id=>lookup.get(timelineObjectKey({domain:'territorial',id})),getObject:ref=>lookup.get(timelineObjectKey(ref))})});
  }
  function projectRow(row,identities,sourceGeometries,referenceDate,previousWorld,bindingWindow){
      const identity=identities[row.objectRef.domain]?.get(row.objectRef.id),geometry=sourceGeometries.get(row.geometryRef);
      if (!identity || !geometry || !Array.isArray(row.ancestors))
        invalid(`The C++ world contains an unknown/duplicate identity or geometry: ${row.objectRef.id}`);
      for (const field of ['parentId','coverageMode','validFrom','validTo','rootId'])
        if (!Object.hasOwn(row, field)) invalid(`Required C++ world field is missing: ${field}`);
      if (!row.properties || typeof row.properties !== 'object') invalid('C++ temporal property projection is required.');
      // Identity and geometry are from the unchanged, immutable source snapshot.
      // Reuse a resolved row when only the cursor changed, not its visible data.
      const candidates=sourceBindingCandidates(identity,row.geometryRef);
      const selectedBinding=sourceBindingAt(candidates,referenceDate);
      includeBinding(bindingWindow,candidates,selectedBinding);
      const sourceBinding=selectedBinding?.binding;
      const sourceVersion=sourceBinding?.sourceVersionId ?? String(identity.properties?.sourceGeometryVersion ?? '');
      const prior=previousWorld?.byId?.getObject?.(row.objectRef);
      const priorSource=projectionSources.get(prior);
      if(prior && prior.geometry===geometry && priorSource?.identity===identity
        && priorSource.version===sourceVersion&&priorSource.binding===sourceBinding
        && (prior===row||(
          ['parentId','coverageMode','validFrom','validTo','rootId'].every(field=>prior[field]===row[field])
          && sameDisplayValue(prior.geometryRef,row.geometryRef)
          && sameDisplayValue(prior.ancestors,row.ancestors)
          && sameDisplayValue(prior.rendering,row.rendering)
          && sameDisplayValue(prior.properties,row.properties)))) {
        return prior;
      }
      const temporalIdentity=projectTimelineIdentity(identity,row.properties);
      const datedIdentity=sourceBinding
        ?freeze({...temporalIdentity,properties:{...temporalIdentity.properties,
          sourceGeometryVersion:sourceVersion}}):temporalIdentity;
      const effectiveIdentity=row.objectRef.domain==='hydro'
        ?freeze({...datedIdentity,properties:{...datedIdentity.properties,...row.rendering}}):datedIdentity;
      const projected = freeze({ ...structuredClone(worldEntityPayload(row)), id:row.objectRef.id, identity:effectiveIdentity, geometry });
      projectionSources.set(projected,{identity,version:sourceVersion,binding:sourceBinding});
      return projected;
  }
  const projectWorld=(value,expectedEpoch) => worldAgainst(value,expectedEpoch,project,geometries);
  function viewForRow(row){
    const isHydro=row.objectRef.domain==='hydro';
      let view=viewsByRow.get(row);
      if(!view){
        const prior=world?.byId.getObject(row.objectRef),priorView=prior&&viewsByRow.get(prior);
        if(priorView&&prior.geometry===row.geometry
          &&(prior.identity===row.identity||(prior.identity.id===row.identity.id&&sameDisplayValue(prior.identity.properties,row.identity.properties)))
          &&['parentId','coverageMode','validFrom','validTo'].every(field=>prior[field]===row[field]))view=priorView;
        else if(isHydro)view=freeze({...row.identity,geometry:row.geometry});
        else view=freeze({...row.identity,geometry:row.geometry,properties:{...row.identity.properties,
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
    worldSourceProject=project;
    territorialViews=views.territorial;hydroViews=views.hydro;
    return nextWorld;
  }
  const worldEntityPayload=({objectRef,geometryRef,rendering,parentId,coverageMode,validFrom,validTo,rootId,ancestors,properties})=>
    ({objectRef,geometryRef,rendering,parentId,coverageMode,validFrom,validTo,rootId,ancestors,properties});
  function acceptStableWorldDelta(delta,positions){
    const prior=world,oldWindow=worldBindingWindows.get(prior.entities),lookup=worldLookups.get(prior.entities);
    if(!oldWindow||!lookup||!canReuseWorldAt(delta.month))return null;
    // Keep the prior date certificate conservatively. A changed binding may
    // shrink it; a later request outside it uses the complete validated path.
    // Do not let accumulated uncertain checks grow without bound.
    if(oldWindow.checks.length+positions.size>Math.max(16,prior.entities.length))return null;
    const window={...oldWindow,checks:oldWindow.checks.slice()};
    const identities={territorial:identityIndex(project.territorialEntities),hydro:identityIndex(project.hydroEdits)};
    const referenceDate=temporalMonthEnd(delta.month),rows=prior.entities.slice(),updates=[];
    const territorialChanges=[],hydroChanges=[];
    for(const [index,entity]of positions){
      const row=projectRow(entity,identities,geometries,referenceDate,prior,window);
      if(row===prior.entities[index])continue;
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
    const next=makeWorld(delta,rows,lookup.fork(updates),window);
    territorialViews=patchViews(territorialViews,territorialChanges);
    hydroViews=patchViews(hydroViews,hydroChanges);
    world=next;worldSourceProject=project;return next;
  }
  function acceptWorldDelta(delta,state) {
    if (!world || delta.baseEpoch!==world.sourceEpoch || delta.sourceEpoch!==state.epoch
      || delta.month!==state.timelineCursor || !Array.isArray(delta.upserts) || !Array.isArray(delta.removed)
      || !Number.isSafeInteger(delta.entityCount) || delta.entityCount<0
      || delta.entityCount>world.entities.length+delta.upserts.length
      || (Object.hasOwn(delta,'retainedOrder')&&!Array.isArray(delta.retainedOrder)))
      invalid('A world delta requires its accepted base epoch and target cursor.');
    const key=ref=>{
      if (!ref || typeof ref.domain!=='string' || typeof ref.id!=='string')
        invalid('A world delta requires a valid object reference.');
      return timelineObjectKey(ref);
    };
    if(!delta.upserts.length&&!delta.removed.length&&!Object.hasOwn(delta,'retainedOrder')){
      if(delta.entityCount!==world.entities.length)invalid('World delta entity count differs.');
      if(canReuseWorldAt(delta.month)){
        world=Object.freeze({...world,month:delta.month,sourceEpoch:state.epoch});
        return world;
      }
      return acceptWorld({month:delta.month,sourceEpoch:delta.sourceEpoch,entities:world.entities},state.epoch);
    }
    let retainedCount=world.entities.length;
    const touched=new Set(), positions=new Map();
    for(const ref of delta.removed){
      const id=key(ref);
      if(touched.has(id)||!world.byId.getObject(ref))invalid('Invalid world delta removal.');
      touched.add(id);retainedCount--;
    }
    for(const update of delta.upserts){
      if(!update||typeof update!=='object')invalid('Invalid world delta upsert.');
      const {index,propertyPatch}=update;
      let entity=update.entity;
      if(Object.hasOwn(update,'propertyPatch')){
        if(Object.hasOwn(update,'entity')||!propertyPatch||typeof propertyPatch!=='object')invalid('Invalid property-only world patch.');
        const {objectRef,set,removed}=propertyPatch;
        key(objectRef);
        const prior=world.byId.getObject(objectRef);
        if(!prior||!set||typeof set!=='object'||Array.isArray(set)||!Array.isArray(removed)
          ||new Set(removed).size!==removed.length||removed.some(name=>typeof name!=='string'||!Object.hasOwn(prior.properties,name)||Object.hasOwn(set,name))
          ||Object.keys(set).some(name=>!['name','color','flag'].includes(name))
          ||removed.some(name=>!['name','color','flag'].includes(name)))
          invalid('Invalid property-only world patch.');
        const properties={...prior.properties};
        for(const name of removed)delete properties[name];
        Object.assign(properties,set);
        entity={...worldEntityPayload(prior),properties};
      }
      const id=key(entity?.objectRef);
      if(touched.has(id)||!Number.isSafeInteger(index)||index<0||index>=delta.entityCount||positions.has(index))
        invalid('Invalid world delta upsert.');
      touched.add(id);if(world.byId.getObject(entity.objectRef))retainedCount--;positions.set(index,entity);
    }
    if(retainedCount+positions.size!==delta.entityCount)invalid('World delta entity count differs.');
    if(!delta.removed.length&&!Object.hasOwn(delta,'retainedOrder')&&delta.entityCount===world.entities.length
      &&[...positions].every(([index,entity])=>key(world.entities[index].objectRef)===key(entity.objectRef))){
      const stable=acceptStableWorldDelta(delta,positions);
      if(stable)return stable;
    }
    let retained=world.entities;
    if(Object.hasOwn(delta,'retainedOrder')){
      if(delta.retainedOrder.length!==retainedCount)invalid('Invalid retained world delta order count.');
      const ordered=new Set();
      retained=delta.retainedOrder.map(ref=>{
        const id=key(ref),row=world.byId.getObject(ref);
        if(!row||touched.has(id)||ordered.has(id))invalid('Invalid retained world delta order identity.');
        ordered.add(id);return row;
      });
    }
    let cursor=0;
    const entities=Array.from({length:delta.entityCount},(_,index)=>{
      if(positions.has(index))return positions.get(index);
      while(cursor<retained.length){
        const row=retained[cursor++];
        if(!touched.has(key(row.objectRef)))return row;
      }
      invalid('Missing retained world delta row.');
    });
    return acceptWorld({month:delta.month,sourceEpoch:delta.sourceEpoch,entities},state.epoch);
  }
  function rebaseWorld(epoch) {
    if (!world) invalid('A current C++ world must be admitted before rebasing an unchanged timeline.');
    if(worldSourceProject===project){
      world=Object.freeze({...world,sourceEpoch:epoch});
      return world;
    }
    const entities=world.entities;
    return acceptWorld({ month: world.month,sourceEpoch: epoch,entities },epoch);
  }
  function applyGeometryAdmission(delta,verified){
    if(!Array.isArray(delta.admitted)||!Array.isArray(delta.removed))
      invalid('A Core geometry resource receipt is required.');
    if(!delta.admitted.length&&!delta.removed.length)return;
    const incoming=new Map((verified?.resources||[]).map(row=>[refKey(row),row]));
    const hashes=new Map((verified?.descriptors||[]).map(row=>[refKey(row),row.contentSha256]));
    const removed=new Set(delta.removed.map(refKey)),admitted=new Set();
    const rows=delta.admitted.map(ref=>{
      const key=refKey(ref),payload=incoming.get(key);
      if(!payload||admitted.has(key)||removed.has(key)||geometries.get(ref))
        invalid('Core geometry receipt does not match the submitted immutable resource.');
      admitted.add(key);
      return {id:ref.id,version:ref.version,geojson:JSON.parse(payload.source)};
    });
    for(const ref of delta.removed)if(!geometries.get(ref))invalid('Unknown evicted geometry resource.');
    const entries=project.geometries.filter(row=>!removed.has(refKey(row))).concat(rows);
    const next=createGeometryVersionStore(entries,{reuse:geometries,verifiedContentHashes:hashes});
    const sameSource=worldSourceProject===project;
    project=freeze({...project,geometries:next.snapshot()});geometries=next;
    // Do not pin the old archive through the current read model.
    // Only a geometry-only admission on the same accepted source may rebase
    // its certificate. A prior source edit still requires re-projection.
    worldSourceProject=sameSource?project:null;
  }
  function acceptTransition(result,operation,verifiedResources) {
    if(operation==='core.document-temporal-candidate-adopt') {
      const complete=Object.hasOwn(result||{},'project'),delta=result?.delta!=null;
      if(complete===delta)invalid('Core adoption requires exactly one complete project or temporal delta.');
      if(delta&&(!result.worldDelta||result.world))invalid('Core delta adoption requires its authoritative world delta.');
      if(complete)acceptLoadedProject(result.project);
    }
    if (['core.document-load','core.document-load-baseline','core.document-initialize',
      'core.document-replacement-rollback'].includes(operation))
      acceptLoadedProject(result.project);
    if(operation==='core.document-geometry-admit'||operation==='core.document-timeline-cursor'){
      if(!result?.geometryDelta)invalid('Core resource transition requires a geometry receipt.');
      applyGeometryAdmission(result.geometryDelta,verifiedResources);
    }
    if (result?.delta) apply(result.delta,verifiedResources);
    if(operation==='core.document-timeline-cursor'||(operation==='core.document-temporal-candidate-adopt'&&result.delta!=null)) {
      if(!result?.worldDelta)invalid('A temporal transition requires a Core world delta.');
      acceptWorldDelta(result.worldDelta,result.state);
    }
    else if (result?.world) acceptWorld(result.world,result.state.epoch);
    else if (result?.state && world && result.state.epoch!==world.sourceEpoch) {
      if (result.delta && result.delta.timelineRecords!==null)
        invalid('A changed C++ timeline requires its authoritative resolved world acknowledgement.');
      rebaseWorld(result.state.epoch);
    }
    return project;
  }
  function candidateForDelta(delta,verifiedResources) {
    for (const field of ['objects','geometries','removedGeometryRefs'])
      if (!Array.isArray(delta[field])) invalid(`Required C++ delta collection is missing: ${field}`);
    for (const field of ['timelineRecords','presentation','provenance','header'])
      if (!Object.hasOwn(delta, field)) invalid(`Required C++ delta field is missing: ${field}`);
    if (!delta.orders || typeof delta.orders !== 'object') invalid('Authoritative C++ domain orders are required.');
    const candidate = { ...project };
    const grouped = new Map();
    for (const row of delta.objects) {
      const field = fields[row.ref.domain];
      if (!field || typeof row.ref.id !== 'string') invalid('Unsupported C++ object delta identity.');
      if (!grouped.has(field)) grouped.set(field, []);
      grouped.get(field).push(row);
    }
    for (const [field, rows] of grouped) {
      const changed = new Set(rows.map(row => row.ref.id));
      if (changed.size !== rows.length) invalid('Duplicate C++ object delta identity.');
      const values = project[field].filter(value => !changed.has(value.id));
      for (const row of rows.filter(row => row.value !== null).sort((a, b) => a.index - b.index)) {
        if (!Number.isInteger(row.index) || row.index < 0 || row.index > values.length || row.value.id !== row.ref.id)
          invalid('Authoritative C++ object delta vector index/value is required.');
        values.splice(row.index, 0, freeze(structuredClone(row.value)));
      }
      candidate[field] = Object.freeze(values);
    }
    for (const [domain, field] of Object.entries(fields)) {
      const order = delta.orders[domain], values = candidate[field];
      if (!Array.isArray(order) || order.length !== values.length || new Set(order).size !== order.length)
        invalid(`Invalid authoritative C++ domain order: ${domain}`);
      const byId = new Map(values.map(value => [value.id, value]));
      if (order.some(id => typeof id !== 'string' || !byId.has(id))) invalid(`Unknown C++ domain order identity: ${domain}`);
      if (order.some((id, index) => values[index].id !== id)) candidate[field] = Object.freeze(order.map(id => byId.get(id)));
    }
    let nextGeometries = geometries;
    if (delta.geometries.length || delta.removedGeometryRefs.length) {
      const removed = new Set(delta.removedGeometryRefs.map(refKey));
      const admitted=new Set();
      for (const entry of delta.geometries) {
        const key=refKey(entry);
        if (admitted.has(key)) invalid('Duplicate C++ geometry delta version.');
        admitted.add(key);
        const existing=geometries.get({ id: entry.id,version: entry.version });
        if (existing && (existing.type!==entry.geojson?.type
          || !sameCoordinates(existing.coordinates,entry.geojson.coordinates)))
          invalid('A C++ geometry delta cannot replace the coordinates of an existing immutable version.');
      }
      // Canonical archive admission can expose an already-stored reference.
      // Upsert its identical version while retaining the geometry allocation.
      const entries = project.geometries.filter(row => !removed.has(refKey(row)) && !admitted.has(refKey(row))).concat(delta.geometries);
      const verifiedContentHashes=verifiedResources&&new Map(verifiedResources.map(row=>[refKey(row),row.contentSha256]));
      nextGeometries = createGeometryVersionStore(entries, { reuse: geometries, verifiedContentHashes });
      candidate.geometries = nextGeometries.snapshot();
    }
    if (delta.timelineRecords !== null) candidate.timelineRecords = freeze(structuredClone(delta.timelineRecords));
    if (delta.presentation !== null) Object.assign(candidate, freeze(structuredClone(delta.presentation)));
    if (delta.header!==null) {
      const { set,removedKeys }=delta.header;
      if (!set || typeof set!=='object' || Array.isArray(set) || !Array.isArray(removedKeys)
        || new Set(removedKeys).size!==removedKeys.length || [...Object.keys(set),...removedKeys].some(key => !headerFields.has(key))
        || removedKeys.some(key => Object.hasOwn(set,key))) invalid('A disjoint authoritative C++ root-field patch is required.');
      for (const key of removedKeys) delete candidate[key];
      Object.assign(candidate,freeze(structuredClone(set)));
    }
    const nextProvenance = delta.provenance === null ? provenance : freeze(structuredClone(delta.provenance));
    return { project: freeze(candidate),geometries: nextGeometries,provenance: nextProvenance };
  }
  function apply(delta,verifiedResources) {
    const next=candidateForDelta(delta,verifiedResources);
    project=next.project;
    geometries=next.geometries;
    provenance=next.provenance;
    return project;
  }
  return Object.freeze({ snapshot: () => project, get, list, geometry: ref => geometries.get(ref), provenance: () => provenance,
    acceptLoadedProject,apply,projectWorld,acceptWorld,acceptTransition,world: () => world,territorialViews: () => territorialViews });
}
