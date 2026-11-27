import { createHash } from 'node:crypto';
import { normalizeTemporalInterval, parseTemporal } from "../../src/document/temporal.js";
import { normalizeCountryCollection } from "../../src/document/country-feature.js";
import {classifyBuiltinCountries} from '../gis/builtin-country-classification.mjs';
import { builtinSubunitSourceId } from "../../src/document/territorial-display-identity.js";
import { normalizeAffiliationMetadata } from "../../src/document/territorial-affiliation.js";
import {loadBuiltinDisplayPolicy} from "../gis/builtin-display-policy.mjs";
import { createTerritorialFeature, normalizeTerritorialIdentities, TERRITORIAL_IDENTITY_FIELDS } from "../../src/document/territorial-units.js";
import { createCanonicalGeometryVersionStore as createGeometryVersionStore } from "../../src/geometry/geometry-version-store.js";
import { normalizeTimelineRecords } from "../../src/document/timeline-records.js";
import { createProjectTemplateCompiler } from "../gis/project-template-compiler.js";
import { DISTRIBUTION_MODES } from "../../src/document/distribution-model.js";
import {territorialNameData,territorialLifetimeIntervals} from "../gis/territorial-library.js";
import { adjustHistoricalTerritories, historicalWorldClipper,createHistoricalTerritoryCache } from "../gis/historical-world-territories.mjs";
import {buildCurrentWorld} from '../data/territorial-current-world.mjs';

const compare = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
};
const date = ([year, month, day]) => `${year < 0 ? '-' : year > 9999 ? '+' : ''}${String(Math.abs(year)).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
function shiftDay(key, direction) {
  let [year, month, day] = key;
  if (direction > 0) {
    const end = parseTemporal(date([year, month, 1]).slice(0, -3)).endKey[2];
    if (++day > end) { day = 1; if (++month > 12) { month = 1; year = year === -1 ? 1 : year + 1; } }
  } else if (--day < 1) {
    if (--month < 1) { month = 12; year = year === 1 ? -1 : year - 1; }
    day = parseTemporal(date([year, month, 1]).slice(0, -3)).endKey[2];
  }
  return [year, month, day];
}
function bounds(interval) {
  const value = normalizeTemporalInterval(interval.validFrom, interval.validTo);
  return { start: value.start?.startKey ?? null, end: value.end?.endKey ?? null };
}
const lifetimeBounds=lifetime=>territorialLifetimeIntervals(lifetime).map(bounds);
function intersection(a, b) {
  const start = !a.start ? b.start : !b.start ? a.start : compare(a.start, b.start) > 0 ? a.start : b.start;
  const end = !a.end ? b.end : !b.end ? a.end : compare(a.end, b.end) < 0 ? a.end : b.end;
  return start && end && compare(start, end) > 0 ? null : { start, end };
}
function covers(interval, start) {
  if (start === null) return interval.start === null;
  return (!interval.start || compare(interval.start, start) <= 0) && (!interval.end || compare(interval.end, start) >= 0);
}
// Interval adjacency is shared; each caller supplies its own record-identity contract.
function appendAdjacentInterval(rows, row, sameValue) {
  const previous = rows.at(-1);
  if (previous && previous.validTo !== null && row.validFrom !== null
      && date(shiftDay(parseTemporal(previous.validTo).endKey, 1)) === row.validFrom && sameValue(previous, row)) {
    previous.validTo = row.validTo;
  } else rows.push(row);
}
function append(rows, row, sameValue) {
  appendAdjacentInterval(rows, row, (a, b) => a.objectRef.domain === b.objectRef.domain
    && a.objectRef.id === b.objectRef.id && sameValue(a, b));
}
const identity = feature => ({ type: 'Feature', id: feature.id, geometry: null,
  properties: Object.fromEntries(TERRITORIAL_IDENTITY_FIELDS.map(key => [key, structuredClone(feature.properties[key])])) });
const withoutGeometry = ({ geometry, ...value }) => structuredClone(value);

function applyNameBaseline(identity,entity) {
  const properties=identity.properties;
  if(Object.hasOwn(entity,'nameVersions')) {
    properties.name='';delete properties.metadata.nameDetails;
    properties.metadata.nameSource={baseName:'',nameExplicit:true};
  }else{
    const naming=territorialNameData(entity);
    properties.name=naming.name;properties.metadata.nameDetails=naming.names;
  }
}

export function compileBuiltinWorldNameBindings(entity,id,formalName) {
  const lifetimes=lifetimeBounds(entity.lifetime);
  const bindings=territorialNameData(entity).versions.flatMap((version,i)=>{
    const naming=territorialNameData({lifetime:{validFrom:null,validTo:null},nameVersions:[{...version,validFrom:null,validTo:null}]});
    return lifetimes.flatMap((lifetime,j)=>{
      const period=intersection(bounds(version),lifetime);
      if(!period)return [];
      return [{id:'historical-world:names:'+id+':'+i+(lifetimes.length>1?':'+j:''),objectRef:{domain:'territorial',id},
        validFrom:period.start&&date(period.start),validTo:period.end&&date(period.end),property:'name',
        value:{name:naming.name,nameExplicit:true,names:naming.names}}];
    });
  });
  return formalName ? applyBuiltinWorldFormalNames(bindings,id,formalName) : bindings;
}

// Historical flag editions compile to the existing C++ flag property binding.
// This is source metadata, not a new application field or a second flag layer.
export function compileBuiltinWorldFlagBindings(entity,id) {
 const history=entity.metadata?.flagHistory||[];
 if(!Array.isArray(history))throw new Error('Invalid flag history: '+entity.entityId);
 const lifetimes=lifetimeBounds(entity.lifetime);
 return history.flatMap((version,i)=>{
  if(!['default','embedded','none'].includes(version.policy))
   throw new Error('Unsupported dated flag policy: '+entity.entityId);
  if(version.policy==='embedded'&&!/^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/.test(version.flagDataUrl||''))
   throw new Error('Missing historical SVG flag: '+entity.entityId);
  return lifetimes.flatMap((lifetime,j)=>{
   const period=intersection(bounds(version),lifetime);
   if(!period)return [];
   return [{id:'historical-world:flags:'+id+':'+i+(lifetimes.length>1?':'+j:''),objectRef:{domain:'territorial',id},
    validFrom:period.start&&date(period.start),validTo:period.end&&date(period.end),
    property:'flag',value:{policy:version.policy,
     embeddedDataUrl:version.policy==='embedded'?version.flagDataUrl:'',
     defaultCountryId:'',defaultFlagDataUrl:null}}];
  });
 });
}

export function replaceBuiltinWorldCountryNames(country,entity,formalName) {
  const result=structuredClone(country);
  applyNameBaseline(result.identity,entity);
  result.timelineRecords.propertyBindings=[...result.timelineRecords.propertyBindings.filter(row=>row.property!=='name'),
    ...compileBuiltinWorldNameBindings(entity,result.entityId,formalName)];
  return result;
}

export function applyBuiltinAffiliation(target,metadata={}) {
  const keys=['affiliationType','affiliationTypeHistory'];
  const fields=normalizeAffiliationMetadata(Object.fromEntries(keys.filter(key=>Object.hasOwn(metadata,key))
    .map(key=>[key,metadata[key]])));
  for(const key of keys)delete target[key];
  Object.assign(target,fields);
}

export function readBuiltinWorldFormalNames(input) {
  if(input?.schema!=='pandolab-builtin-formal-names'||input.schemaVersion!==1||!Array.isArray(input.names)
    ||(input.deferred!==undefined&&!Array.isArray(input.deferred)))
    throw Error('Invalid builtin formal name source');
  const validId=id=>typeof id==='string'&&/^[a-z]+:[A-Za-z0-9_-]+$/.test(id);
  const nonempty=text=>typeof text==='string'&&text.trim().length>0;
  const validPrecision=value=>['month','date'].includes(parseTemporal(value,{nullable:false}).precision);
  // The reviewed registry predates per-record date evidence. Admit its exact content.
  const restoredRegistry=createHash('sha256').update(JSON.stringify(input)).digest('hex')
    === 'e37f069e5ff214118b2ffdbdfa4476e444c1de74ca801b88e818190ebaabb704';
  const formalNames=new Map();
  for(const row of input.names) {
    if(!validId(row?.entityId)
      ||typeof row.ko!=='string'||!row.ko||row.ko.trim()!==row.ko
      ||!validPrecision(row.validFrom)
      ||(row.validTo!=null&&!validPrecision(row.validTo)))
      throw Error('Invalid builtin formal name: '+row?.entityId);
    const evidence=row.dateEvidence;
    if(!['effective-date','documented-use'].includes(row.dateBasis)
      ||(!restoredRegistry&&(evidence?.date!==row.validFrom||!nonempty(evidence.statement)
      ||typeof evidence.sourceUrl!=='string'||!/^https?:\/\/\S+$/i.test(evidence.sourceUrl)
      ||!Array.isArray(row.sources)||!row.sources.includes(evidence.sourceUrl))))
      throw Error('Missing direct formal name date evidence: '+row.entityId);
    const names=formalNames.get(row.entityId)??[];
    const period=bounds(row);
    names.push({ko:row.ko,...period});
    formalNames.set(row.entityId,names);
  }
  for(const [entityId,names] of formalNames){
    names.sort((a,b)=>compare(a.start,b.start));
    for(let i=1;i<names.length;i++){
      const prior=names[i-1],current=names[i];
      if(compare(prior.start,current.start)===0)throw Error('Duplicate builtin formal name: '+entityId);
      if(prior.end&&compare(prior.end,current.start)>=0)throw Error('Overlapping builtin formal names: '+entityId);
      prior.end??=shiftDay(current.start,-1);
    }
  }
  // An explicitly deferred identity can replace a previously generated formal
  // interval with its underlying name binding during a scoped rebuild.
  for(const row of input.deferred??[]){
    if(!validId(row?.entityId)||!nonempty(row.reason))
      throw Error('Invalid deferred builtin formal name: '+row?.entityId);
    if(!formalNames.has(row.entityId))formalNames.set(row.entityId,[]);
  }
  return formalNames;
}

function applyBuiltinWorldFormalNames(bindings,entityId,names) {
  const matched=new Set();
  const result=bindings.flatMap(row=>{
    if(row.property!=='name'||!row.value.names?.ko?.common)return [row];
    const period=bounds(row);
    const parts=[];
    let nextStart=period.start;
    let consumed=false;
    for(const name of names){
      const within=intersection(period,name);
      if(!within)continue;
      const existing=row.value.names.ko.formal;
      if(existing&&existing!==name.ko)throw Error('Conflicting formal names for '+entityId);
      matched.add(name);
      if(existing===name.ko)continue;
      if(!nextStart||compare(nextStart,within.start)<0){
        parts.push({...row,id:parts.length?row.id+':from:'+date(nextStart):row.id,
          validFrom:nextStart&&date(nextStart),validTo:date(shiftDay(within.start,-1))});
      }
      parts.push({...row,id:row.id+':formal:'+date(within.start),
        validFrom:date(within.start),validTo:within.end&&date(within.end),
        value:{...row.value,names:{...row.value.names,ko:{...row.value.names.ko,formal:name.ko}}}});
      consumed=!within.end;
      nextStart=within.end&&shiftDay(within.end,1);
    }
    if(!parts.length)return [row];
    if(!consumed&&(!period.end||compare(nextStart,period.end)<=0)){
      parts.push({...row,id:row.id+':from:'+date(nextStart),validFrom:date(nextStart)});
    }
    return parts;
  });
  if(matched.size!==names.length)throw Error('Formal name publication requires an active short name: '+entityId);
  return result.length===bindings.length&&result.every((row,i)=>row===bindings[i])?bindings:result;
}

export function addBuiltinWorldFormalName(country,formalName) {
  const prior=country.timelineRecords.propertyBindings;
  // Recover the underlying name bindings before applying a revised source.
  // Existing formal names that came from the country source have no suffix.
  const original=[];
  let reapplying=false;
  for(const row of prior){
    const derived=row.property==='name'&&row.id.match(/^(historical-world:names:.+):(formal|from):[+-]?\d{4,}-\d{2}-\d{2}$/);
    if(!derived){original.push({...row});continue;}
    reapplying=true;
    const [,id,role]=derived;
    const value=structuredClone(row.value);
    if(role==='formal')delete value.names.ko.formal;
    appendAdjacentInterval(original,{...row,id,value},(a,b)=>a.id===b.id);
  }
  const propertyBindings=applyBuiltinWorldFormalNames(reapplying?original:prior,country.entityId,formalName);
  if(propertyBindings===prior)return country;
  return {...country,timelineRecords:{...country.timelineRecords,propertyBindings}};
}

/** Build an ordinary editable project; library inputs and raw intervals stay immutable. */
export function compileBuiltinWorldCatalog({ entities, view, currentWorld = null, policy, clipper = historicalWorldClipper, availableSourceIds = null,displayPolicy=loadBuiltinDisplayPolicy(),formalNames=new Map() }) {
  entities=entities.filter(entity=>['general','regional'].includes(entity.entityKind));
  if(view?.schemaVersion!==1 || !Array.isArray(view.selections) || Object.hasOwn(view,'referenceDate'))throw new Error('Invalid world view');
  if (!policy || policy.schemaVersion !== 1) throw new Error('Missing historical world policy');
  const selection=new Map(view.selections.map(row=>[row.entityId,row.geometryVersionId]));
  if(selection.size!==view.selections.length)throw new Error('Duplicate world selection');
  const bySource = new Map(entities.map(entity => [entity.entityId, entity]));
  if (bySource.size !== entities.length) throw new Error('Duplicate source entity');
  const currentIds = new Set(selection.keys());
  for (const id of currentIds) if (!bySource.has(id)) throw new Error(`Missing current source: ${id}`);
  currentWorld=buildCurrentWorld({entities,view,currentWorld});
  const classified = classifyBuiltinCountries(normalizeCountryCollection(currentWorld), { availableSourceIds,displayPolicy });
  const definitions = new Map(), sourceToProject = new Map(), sourceIdentities = [];
  for (const feature of [...classified.countries.features, ...classified.subunits]) {
    const sourceFeature = builtinSubunitSourceId(feature) || feature.id;
    const sourceFeatureIds = [sourceFeature, ...displayPolicy.territoryMerges.filter(row => row.controller === sourceFeature).map(row => row.sourceId)].sort();
    const sources = entities.filter(entity => currentIds.has(entity.entityId) && sourceFeatureIds.includes(entity.sourceInfo?.featureId));
    if (!sources.length) throw new Error(`Missing current identity: ${feature.id}`);
    for (const source of sources) sourceToProject.set(source.entityId, feature.id);
    const info = { projectEntityId: feature.id, sourceEntityIds: sources.map(source => source.entityId).sort(), sourceFeatureIds };
    sourceIdentities.push(info);
    const primary = sources.find(source => source.sourceInfo.featureId === sourceFeature);
    const lifetimes = lifetimeBounds(primary.lifetime);
    const version = primary.geometryVersions.find(row=>row.versionId===selection.get(primary.entityId));
    if(!version)throw new Error(`Missing selected geometry: ${primary.entityId}`);
    const normalized = identity(feature);
    applyNameBaseline(normalized,primary);
    if (builtinSubunitSourceId(feature)) applyBuiltinAffiliation(normalized.properties.metadata,primary.metadata);
    normalized.properties.metadata.historicalTimeline = { entityId: primary.entityId, sourceEntityIds: info.sourceEntityIds,
      lifetime: structuredClone(primary.lifetime), geometryVersions: primary.geometryVersions.map(withoutGeometry), geometryBindings: [] };
    const windows=primary.geometryVersions.flatMap(row=>lifetimes.map(lifetime=>{
      const interval=intersection(lifetime,bounds(row));
      return interval && {...interval,versionId:row.versionId,
        geometry:row.versionId===version.versionId?feature.geometry:row.geometry,
        parentId:feature.properties.parentId,coverageMode:feature.properties.coverageMode,
        currentSnapshot:row.versionId===version.versionId};
    }).filter(Boolean));
    definitions.set(feature.id,{identity:normalized,currentSnapshot:true,info,windows,nameSource:primary});
  }
  for (const entity of entities) {
    const lifetimes = lifetimeBounds(entity.lifetime);
    // Validate all input windows/geometry, including sources outside the snapshot.
    for (const version of entity.geometryVersions) {
      bounds(version);
      if (!version.geometry) throw new Error(`Missing source geometry: ${version.versionId}`);
    }
    if (currentIds.has(entity.entityId)) continue;
    const first = entity.geometryVersions[0];
    if (!first) throw new Error(`Missing source geometry: ${entity.entityId}`);
    const feature = createTerritorialFeature({ id: entity.entityId, entityKind: entity.entityKind,
      name: '', geometry: first.geometry,
      color: entity.metadata?.defaultColor || '',
      notes: entity.metadata?.notes || '', metadata: { ...Object.fromEntries(Object.entries(structuredClone(entity.metadata || {})).filter(([key])=>key!=='flagHistory')),
        ...(entity.entityKind === 'general' && !entity.parentEntityId && entity.metadata?.defaultFlagDataUrl
          ? { flagDataUrl: entity.metadata.defaultFlagDataUrl } : {}),
        historicalTimeline: { entityId: entity.entityId, lifetime: structuredClone(entity.lifetime),
          sourceInfo: structuredClone(entity.sourceInfo), geometryVersions: entity.geometryVersions.map(withoutGeometry), geometryBindings: [] } },
      sourceEntityId: entity.entityId });
    applyNameBaseline(feature,entity);
    const windows = entity.geometryVersions.flatMap(version => lifetimes.map(lifetime => {
      const interval = intersection(lifetime, bounds(version));
      return interval && { ...interval, geometry: version.geometry, versionId: version.versionId,
        parentId: sourceToProject.get(entity.parentEntityId) || entity.parentEntityId,
        coverageMode: entity.instantiation.coverageMode || 'explicit' };
    }).filter(Boolean));
    definitions.set(entity.entityId, { identity: identity(feature), currentSnapshot: false, windows,nameSource:entity });
    sourceIdentities.push({ projectEntityId: entity.entityId, sourceEntityIds: [entity.entityId], sourceFeatureIds: [] });
  }
  // Dated administrative ownership belongs to the compiled baseline. It must
  // resolve before parent gaps and peer-overlap classification, without
  // rewriting library source parents, coordinates or source validity.
  if (policy.parentRelations !== undefined && !Array.isArray(policy.parentRelations)) throw new Error('Invalid dated parent relations');
  const parentRelations = (policy.parentRelations || []).map(rule => {
    const entityId = sourceToProject.get(rule.entityId) || rule.entityId;
    const parentId = sourceToProject.get(rule.parentEntityId) || rule.parentEntityId;
    if (!definitions.has(entityId) || !definitions.has(parentId) || entityId === parentId
        || !rule.validFrom || !rule.validTo) throw new Error('Invalid dated parent relation');
    return {entityId, parentId, ...bounds(rule)};
  });
  for (let i = 0; i < parentRelations.length; i++) for (let j = i + 1; j < parentRelations.length; j++) {
    if (parentRelations[i].entityId === parentRelations[j].entityId && intersection(parentRelations[i], parentRelations[j]))
      throw new Error('Overlapping dated parent relations: ' + parentRelations[i].entityId);
  }
  const archive = createGeometryVersionStore(), byGeometry = new Map();
  const adjustments = [];
  const refByObject=new WeakMap();
  const geometryRef = geometry => {
    if(refByObject.has(geometry))return refByObject.get(geometry);
    const bytes = JSON.stringify(geometry), hash = createHash('sha256').update(bytes).digest('hex');
    if (!byGeometry.has(hash)) { const ref = { id: `historical-world:${hash}`, version: 1 }; archive.insert(ref, geometry); byGeometry.set(hash, ref); }
    const ref=byGeometry.get(hash);refByObject.set(geometry,ref);return ref;
  };
  const ordered = [...definitions].sort(([a], [b]) => a.localeCompare(b, 'en'));
  const events=new Map();
  for(const definition of definitions.values())for(const window of definition.windows){
    if(window.start)events.set(date(window.start),window.start);
    if(window.end){const next=shiftDay(window.end,1);events.set(date(next),next);}
  }
  for(const rule of [...policy.replacements,...(policy.parentRelations || [])]){const interval=bounds(rule);
    if(interval.start)events.set(date(interval.start),interval.start);
    if(interval.end){const next=shiftDay(interval.end,1);events.set(date(next),next);}
  }
  const cuts=[...events.values()].sort(compare);
  const rowsByEntity=new Map(),sourceBindings=new Map();
  const territoryCache=createHistoricalTerritoryCache(clipper);
  for (let index = 0; index <= cuts.length; index++) {
    const start = index === 0 ? null : cuts[index - 1], end = index === cuts.length ? null : shiftDay(cuts[index], -1);
    let candidates = [];
    for (const [id, definition] of ordered) {
      let active = definition.windows.filter(window=>covers(window,start));
      if (active.length > 1) throw new Error(`Overlapping geometry intervals: ${id}`);
      if (active.length) candidates.push({ ...active[0], entityId: id, currentSnapshot: active[0].currentSnapshot ?? definition.currentSnapshot,
        validFrom: start && date(start), validTo: end && date(end) });
    }
    for (const row of candidates) {
      const relation = parentRelations.find(rule => rule.entityId === row.entityId && covers(rule, start));
      if (relation) row.parentId = relation.parentId;
    }
    // A parent gap hides descendants transitively; cycles are a source error.
    const all = new Map(candidates.map(row => [row.entityId, row]));
    const activeParent = (row, seen = new Set()) => {
      if (seen.has(row.entityId)) throw new Error(`Cyclic parent: ${row.entityId}`);
      if (!row.parentId) return true;
      seen.add(row.entityId);
      const parent = all.get(row.parentId);
      return !!parent && activeParent(parent, seen);
    };
    candidates = candidates.filter(row => activeParent(row));
    const mappedPolicy = { ...policy, replacements: policy.replacements.map(rule => ({ ...rule,
      targetEntityId: sourceToProject.get(rule.targetEntityId) || rule.targetEntityId,
      priorityEntityId: sourceToProject.get(rule.priorityEntityId) || rule.priorityEntityId,
    })) };
    const adjusted = adjustHistoricalTerritories(candidates, mappedPolicy, clipper,territoryCache);
    candidates = adjusted.candidates;
    const surviving=new Map(candidates.map(row=>[row.entityId,row]));
    const hasParent=row=>!row.parentId || (surviving.has(row.parentId)&&hasParent(surviving.get(row.parentId)));
    candidates=candidates.filter(hasParent);
    adjustments.push(...adjusted.adjustments.map(row => ({ ...row, validFrom: start && date(start), validTo: end && date(end) })));
    for (const candidate of candidates) {
      const ref = geometryRef(candidate.geometry);
      let rows = rowsByEntity.get(candidate.entityId);
      if (!rows) rowsByEntity.set(candidate.entityId, rows = { availability: [], geometryBindings: [], parentRelations: [] });
      const base = { objectRef: {domain:"territorial",id:candidate.entityId}, validFrom: start && date(start), validTo: end && date(end) };
      append(rows.availability, { ...base }, () => true);
      append(rows.geometryBindings, { ...base, geometryRef: ref }, (a, b) => a.geometryRef.id === b.geometryRef.id);
      append(rows.parentRelations, { ...base, parentId: candidate.parentId, coverageMode: candidate.coverageMode }, (a, b) => a.parentId === b.parentId && a.coverageMode === b.coverageMode);
      if(!sourceBindings.has(candidate.entityId))sourceBindings.set(candidate.entityId,[]);
      append(sourceBindings.get(candidate.entityId),{...base,geometryRef:ref,sourceVersionId:candidate.versionId},
        (a,b)=>a.geometryRef.id===b.geometryRef.id&&a.sourceVersionId===b.sourceVersionId);

    }
  }
  const identities = normalizeTerritorialIdentities(ordered.filter(([id]) => rowsByEntity.has(id)).map(([, value]) => value.identity));
  const records = { schemaVersion: 3, lifetimes: [], geometryBindings: [], parentRelations: [], propertyBindings: [] };
  for (const [id] of ordered) {
    const rows = rowsByEntity.get(id); if (!rows) continue;
    const {nameSource}=definitions.get(id);
    territorialLifetimeIntervals(definitions.get(id).identity.properties.metadata.historicalTimeline.lifetime)
      .forEach((lifetime,i)=>records.lifetimes.push({ id: `historical-world:lifetimes:${id}:${i}`,
        objectRef: {domain:"territorial",id}, ...structuredClone(lifetime) }));
    for (const name of ['geometryBindings', 'parentRelations']) rows[name].forEach((row, i) => records[name].push({ id: `historical-world:${name}:${id}:${i}`, ...row }));
    records.propertyBindings.push(...compileBuiltinWorldNameBindings(nameSource,id,formalNames.get(nameSource.entityId)));
    records.propertyBindings.push(...compileBuiltinWorldFlagBindings(nameSource,id));
  }
  const normalized = normalizeTimelineRecords(records, { entities: identities.map(row => ({ objectRef: {domain:"territorial",id:row.id}, entityKind: row.properties.entityKind })), geometryType: ref => archive.get(ref)?.type ?? '' });
  const availability=new Map([...rowsByEntity].map(([id,rows])=>[id,rows.availability]));
  const snapshot={documentId:'6dcead54-3bc5-4ca2-a4f5-455305bba911',physicalSourceInfo:{},territorialEntities:[],fullAutosave:true,projectFields:{
    timelineRecords:{schemaVersion:3,lifetimes:[],geometryBindings:[],parentRelations:[],propertyBindings:[]},geometries:[],sourceInfo:null,
    labels:[],genericFeatures:[],hydroEdits:[],distributionLayers:[],distributionEntries:[],labelSettings:{},
    distributionSettings:{renderMode:'overlap',activeLayerId:'',boundaryVisible:true},
    projectSetup:{initialMonth:'1970-01',timelineRange:null,initialMapBounds:null,sourceMode:'builtin'},
    layerPresentation:{schemaVersion:5,styles:{},objectStyles:{},objectOrder:[]}}};
  const template=createProjectTemplateCompiler({appVersion:'builtin-world-v1',distributionModes:Object.values(DISTRIBUTION_MODES),
    now:()=>new Date(0),readSnapshot:()=>snapshot}).buildProject();
  delete template.projectSetup;
  const countries=[];
  const allGeometry=archive.snapshot();
  for(const [id,definition] of ordered){
    const timelineRecords=Object.fromEntries(Object.entries(normalized).map(([key,value])=>[key,
      Array.isArray(value)?value.filter(row=>row.objectRef.domain==="territorial"&&row.objectRef.id===id):value]));
    if(!timelineRecords.lifetimes.length)continue;
    const refs=new Set(timelineRecords.geometryBindings.map(row=>JSON.stringify(row.geometryRef)));
    const geometries=allGeometry.filter(row=>refs.has(JSON.stringify({id:row.id,version:row.version})));
    countries.push({schemaVersion:2,entityId:id,identity:definition.identity,timelineRecords,geometries,
      sourceBindings:sourceBindings.get(id)||[]});
  }
  const index={schema:'pandolab-builtin-world',schemaVersion:2,template,
    entities:countries.map(country=>({entityId:country.entityId,
      coverage:availability.get(country.entityId)?.map(({validFrom,validTo})=>({validFrom,validTo}))||[]})),sourceIdentities};
  return {index,countries,coverageReport:{schemaVersion:2,adjustments:coalesceCoverageAdjustments(adjustments),
    entities:countries.map(country=>({entityId:country.entityId,
      lifetime:structuredClone(country.identity.properties.metadata.historicalTimeline.lifetime),
      availability:index.entities.find(row=>row.entityId===country.entityId).coverage}))}};
}

// Unrelated countries can introduce extra temporal cuts. Keep evidence in the
// same maximal intervals whether a component is compiled alone or in a world.
export function coalesceCoverageAdjustments(adjustments) {
  const groups=new Map();
  for(const row of adjustments){
    const {validFrom,validTo,...value}=row,key=JSON.stringify(value);
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push({...value,validFrom,validTo});
  }
  return [...groups].sort(([a],[b])=>a.localeCompare(b,'en')).flatMap(([,values])=>{
    values.sort((a,b)=>a.validFrom===null?-1:b.validFrom===null?1:compare(parseTemporal(a.validFrom).startKey,parseTemporal(b.validFrom).startKey));
    const rows=[];
    // Grouping above already fixes entityId, kind, relatedIds and all evidence fields.
    // Coverage evidence is not a timeline record and must not require objectRef.
    for(const row of values)appendAdjacentInterval(rows,row,()=>true);
    return rows;
  });
}
