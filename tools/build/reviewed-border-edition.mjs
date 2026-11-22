import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {coordinateBounds} from '../../src/geometry/coordinate-bounds.js';
import {temporalIntervalsOverlap,compareTemporal,parseTemporal,temporalFollowingDay} from '../../src/document/temporal.js';
import {decodeTerritorialSource,encodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {selectTerritorialChunkBytes} from '../data/territorial-chunk-compression.mjs';
import {assertIndexedTerritorialChunk} from '../data/territorial-metadata-projection.mjs';
import {encodeBuiltinCountries,finalizeBuiltinWorldFiles,readBuiltinCountry} from '../data/builtin-country-bytes.mjs';
import {assertHistoricalDisplayChanges,assertHistoricalSourceStorageChanges} from '../gis/historical-display-review.mjs';
import {assertHistoricalStorageChanges} from '../gis/historical-display-storage.mjs';
import {assertOriginalAuthoringSourceStorageChanges} from '../data/territorial-original-authoring.mjs';
import {historicalWorldClipper as clip} from '../gis/historical-world-territories.mjs';
import {territorialIndexEntry} from '../gis/territorial-index-entry.js';
import {territorialLifetimeIntervals} from '../gis/territorial-library.js';
import {gunzipSync} from 'node:zlib';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export const coordinateDigest=points=>digest(JSON.stringify(points));
const geometryDigest=geometry=>coordinateDigest([geometry.type,geometry.coordinates]);
const jsonBytes=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const geometryBytes=value=>Buffer.from(JSON.stringify(value)+'\n');
const fail=message=>{throw Error('Reviewed shared border: '+message);};
const parts=g=>g.type==='Polygon'?[g.coordinates]:g.coordinates;
const shaPattern=/^[a-f0-9]{64}$/;
const point=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&Math.abs(p[0])<=180&&Math.abs(p[1])<=90;
const chain=c=>Array.isArray(c)&&c.length>=2&&c.every(point)&&!equal(c[0],c.at(-1))
 &&c.every((p,i)=>!i||!equal(p,c[i-1]));
const overlaps=(a,b)=>a[0]<=b[2]&&b[0]<=a[2]&&a[1]<=b[3]&&b[1]<=a[3];
const dateOverlap=(a,b)=>temporalIntervalsOverlap(a,b);
const issued=new WeakMap();

function locate(geometry,coordinates){
 const matches=[];
 for(const [polygonIndex,[ring]] of parts(geometry).entries()){
  for(let startIndex=0;startIndex+coordinates.length<=ring.length;startIndex++){
   if(!equal(ring[startIndex],coordinates[0]))continue;
   if(coordinates.every((p,i)=>equal(p,ring[startIndex+i])))
    matches.push({polygonIndex,ringIndex:0,startIndex,endIndex:startIndex+coordinates.length-1});
  }
 }
 return matches;
}

/** The receipt supplies the untouched published endpoints, including any bridge
 * to the archived line. Both countries must contain the same old reciprocal arc. */
export function applyReviewedSharedArcs(before,changes){
 if(!Array.isArray(before)||before.length!==2||!Array.isArray(changes)||!changes.length)fail('paired sections required');
 const [left,right]=before.map(g=>structuredClone(g)),targets=[[],[]];
 for(const change of changes){
  const old=change.before,next=change.after;
  if(!chain(old)||coordinateDigest(old)!==change.beforeSha256)fail('stale section preimage');
  if(!chain(next)||equal(old,next)||!equal(old[0],next[0])||!equal(old.at(-1),next.at(-1)))fail('invalid fixed section endpoints');
  const forward=locate(left,old),reverse=locate(left,old.toReversed());
  const peerForward=locate(right,old),peerReverse=locate(right,old.toReversed());
  if(forward.length+reverse.length!==1||peerForward.length+peerReverse.length!==1||forward.length!==peerReverse.length)
   fail('unique reciprocal section preimages required');
  targets[0].push({...(forward[0]??reverse[0]),coordinates:forward.length?next:next.toReversed()});
  targets[1].push({...(peerReverse[0]??peerForward[0]),coordinates:peerForward.length?next:next.toReversed()});
 }
 for(const [i,geometry] of [left,right].entries()){
  const ranges=targets[i].sort((a,b)=>a.polygonIndex-b.polygonIndex||b.startIndex-a.startIndex);
  for(const [j,t] of ranges.entries()){
   const preceding=ranges[j-1];
   if(preceding?.polygonIndex===t.polygonIndex&&t.endIndex>preceding.startIndex)fail('overlapping section preimages');
   parts(geometry)[t.polygonIndex][0].splice(t.startIndex,t.endIndex-t.startIndex+1,...t.coordinates);
  }
 }
 return [left,right];
}

function validatePair(before,after,label){
 for(const g of after)if(!globalThis.PandoLabPolygonGeometry.normalizePolygonGeometry(g))fail('empty '+label+' country');
 if(clip.intersection(...after.map(parts)).length)fail(label+' pair overlaps');
 if(clip.xor(clip.union(...before.map(parts)),clip.union(...after.map(parts))).length)fail(label+' pair exterior changed');
}

function liesOnEdge([x,y],[ax,ay],[bx,by]){
 const dx=bx-ax,dy=by-ay,px=x-ax,py=y-ay,extent=dx*dx+dy*dy;
 const progress=px*dx+py*dy;
 return Math.abs(px*dy-py*dx)<=1e-12&&progress>=-1e-12&&progress<=extent+1e-12;
}

function proveNeighbors({sourceIndex,builtin,policy,ids,binding,raw,display,readRaw,readCountry,changes}){
 // Two simultaneous priority cutters subtract their union. This remains true
 // during a dated replacement and for its descendants if the union is equal.
 const cutters=new Map();
 for(const rule of policy.replacements){
  if(!dateOverlap(rule,binding))continue;
  if(ids.includes(rule.targetEntityId))fail('selected country has a dated replacement '+rule.targetEntityId);
  if(!ids.includes(rule.priorityEntityId))continue;
  const list=cutters.get(rule.targetEntityId)||[];
  list.push(rule);cutters.set(rule.targetEntityId,list);
 }
 for(const [id,rules] of cutters){
  if(rules.length!==2||!ids.every(owner=>rules.some(r=>r.priorityEntityId===owner))
    ||!equal([rules[0].validFrom,rules[0].validTo],[rules[1].validFrom,rules[1].validTo])
    ||compareTemporal(rules[0].validFrom,binding.validFrom)>0)fail('dated replacement is not paired '+id);
 }
 if((policy.parentRelations||[]).some(r=>dateOverlap(r,binding)&&[r.entityId,r.parentEntityId].some(id=>ids.includes(id))))
  fail('selected country has a dated parent dependency');
 const footprints=changes.map(c=>coordinateBounds([...c.before,...c.after]));
 const delta=(set)=>set[0].flatMap((before,i)=>clip.xor(parts(before),parts(set[1][i])));
 const rawDelta=delta(raw),displayDelta=delta(display);
 const readOnly=[];
 const masks=(polygons)=>polygons.map(p=>[p,coordinateBounds(p)]);
 const touches=(geometry,difference)=>{
  for(const polygon of parts(geometry)){
   const box=coordinateBounds(polygon);
   const nearby=difference.filter(([,bounds])=>overlaps(box,bounds)).map(([p])=>p);
   if(nearby.length&&clip.intersection([polygon],nearby).length)return true;
  }
  return false;
 };
 const rawMasks=masks(rawDelta),displayMasks=masks(displayDelta);
 for(const source of sourceIndex.entities){
  const id=source.entityId;
  if(ids.includes(id)||!footprints.some(bounds=>overlaps(bounds,source.bbox))
    ||!territorialLifetimeIntervals(source.lifetime).some(interval=>dateOverlap(interval,binding)))continue;
  if(cutters.has(id)){
   const [rule]=cutters.get(id);
   if(territorialLifetimeIntervals(source.lifetime).some(life=>dateOverlap(life,binding)
    &&(!life.validTo||!rule.validTo||compareTemporal(life.validTo,rule.validTo,{leftBoundary:'end',rightBoundary:'end'})>0)))
    fail('replacement period does not cover '+id);
   readOnly.push({id,reason:'equal paired priority union'});continue;
  }
  const owner=builtin.sourceIdentities.find(row=>row.sourceEntityIds.includes(id));
  if(!owner)continue;
  if(ids.some(selected=>source.parentEntityId===selected))fail('selected country has a child dependency '+id);
  const rawPeer=readRaw(id);
  const historical=readCountry(owner.projectEntityId);
  for(const version of rawPeer.geometryVersions)if(dateOverlap(version,binding)&&touches(version.geometry,rawMasks))
   fail('raw neighbor affected '+id+' '+version.versionId);
  for(const entry of historical.sourceBindings)if(dateOverlap(entry,binding)){
   const geometry=historical.geometries.find(g=>equal(entry.geometryRef,{id:g.id,version:g.version}));
   if(!geometry||touches(geometry.geojson,displayMasks))fail('display neighbor affected '+id+' '+entry.validFrom);
  }
  readOnly.push({id,reason:'disjoint from the changed area'});
 }
 return readOnly;
}

export function buildReviewedBorderEdition({baseline,entityIds,receipt,readBaseline,readEvidence,sourceRoot,sourceIndexPath,builtinIndexPath,policyPath}){
 const selected=[...entityIds].sort();
 if(selected.length!==2||selected[0]===selected[1]||selected.some(id=>!/^state:[A-Z]{3}$/.test(id)))fail('exactly two country IDs required');
 const reportFiles=new Map();
 const archived=ref=>{
  if(!ref||!/^reports\/borders\/(?:[\w.-]+\/)*[\w.-]+$/.test(ref.reference)
    ||ref.reference.split('/').some(p=>p==='.'||p==='..')||!shaPattern.test(ref.sha256||''))fail('invalid archived review reference');
  const bytes=readEvidence(ref.reference);
  if(!Buffer.isBuffer(bytes)||digest(bytes)!==ref.sha256)fail('review bytes differ '+ref.reference);
  reportFiles.set(ref.reference,ref.sha256);return bytes;
 };
 const input=JSON.parse(archived(receipt));
 if(input.schemaVersion!==1||input.baseline!==baseline||!equal(input.entities.map(row=>row.entityId),selected))fail('reviewed revision or country scope differs');
 archived(input.visual);
 const json=p=>JSON.parse(readBaseline(p));
 const v2=json(sourceIndexPath),index=json(builtinIndexPath),policy=json(policyPath);
 if(index.inputHashes.policy!==coordinateDigest(policy))fail('reviewed historical policy differs');
 const rawPath=id=>sourceRoot+'/countries/'+id.replace(':','-')+'.json';
 const source=(id,read)=>decodeTerritorialSource(JSON.parse(read(rawPath(id))),p=>read(sourceRoot+'/'+p));
 const countryBase=builtinIndexPath.slice(0,builtinIndexPath.lastIndexOf('/')+1);
 const nativeBase=sourceIndexPath.slice(0,sourceIndexPath.lastIndexOf('/')+1);
 const readCountry=(owner,read=readBaseline,catalog=index)=>{
  const spec=catalog.entities.find(row=>row.entityId===owner);
  if(!spec)fail('country payload missing '+owner);
  return readBuiltinCountry(spec,catalog,p=>read(countryBase+p));
 };
 const old=selected.map(id=>source(id,readBaseline));
 const oldVersions=old.map((entity,i)=>{
  const selection=v2.views[0].selections.find(row=>row.entityId===entity.entityId);
  const version=entity.geometryVersions.find(v=>v.versionId===selection?.geometryVersionId);
  if(!version||version.validTo!==null||input.entities[i].rawBefore!==geometryDigest(version.geometry))fail('source preimage differs '+entity.entityId);
  return version;
 });
 const ownerIds=old.map(entity=>entity.sourceInfo.featureId);
 const countries=ownerIds.map((id,i)=>{
  const identity=index.sourceIdentities.find(row=>row.projectEntityId===id);
  if(!equal(identity?.sourceEntityIds,[selected[i]])||!equal(identity?.sourceFeatureIds,[id]))fail('merged display identity '+id);
  return readCountry(id);
 });
 const bindings=countries.map((country,i)=>{
  const matches=country.sourceBindings.filter(row=>row.sourceVersionId===oldVersions[i].versionId&&row.validTo===null);
  const [row]=matches;
  if(matches.length!==1||!row.validFrom)fail('unsupported current binding '+country.entityId);
  return row;
 });
 const {validFrom,validTo,previousDisplayThrough}=reviewedDisplayPeriod(bindings,oldVersions,input);
 const binding={validFrom,validTo};
 if(countries.some(country=>country.timelineRecords.parentRelations.some(row=>row.parentId&&dateOverlap(row,binding))))
  fail('selected country has a current parent dependency');
 const reviewed=input.entities.map(row=>{
  const origin=JSON.parse(archived(row.origin));
  const rawReview=JSON.parse(archived(row.rebased));
  archived(rawReview.source);archived(rawReview.priorPreparedSourceReview);
  if(rawReview.previousSharedArcReview)archived(rawReview.previousSharedArcReview);
  const originals=origin.sharedArcChanges.map(a=>a.original);
  let previous=-1;
  for(const {original} of rawReview.sharedArcChanges){
   const index=originals.findIndex(candidate=>equal(candidate,original));
   if(index<=previous)fail('rebased original chains differ '+row.entityId);
   previous=index;
  }
  return rawReview;
 });
 const rawChanges=reviewed[0].sharedArcChanges.map(a=>({before:[a.original.coordinates[0],a.original.coordinates.at(-1)],
  beforeSha256:a.previousCoordinatesSha256,after:a.original.coordinates}));
 const beforeRaw=oldVersions.map(v=>v.geometry),afterRaw=applyReviewedSharedArcs(beforeRaw,rawChanges);
 const beforeDisplay=countries.map((country,i)=>{
  const ref=bindings[i].geometryRef,g=country.geometries.find(g=>g.id===ref.id&&g.version===ref.version);
  if(!g||geometryDigest(g.geojson)!==input.entities[i].displayBefore)fail('display preimage differs '+country.entityId);
  return g.geojson;
 });
 if(input.sections.length!==rawChanges.length||input.sections.some((section,i)=>{
  const {before,after}=section;
  if(!chain(before)||!chain(after))return true;
  const arc=rawChanges[i].after,at=after.findIndex(p=>equal(p,arc[0])),end=at+arc.length;
  return at<0||!equal(after.slice(at,end),arc)||at>2||after.length-end>2
   ||(at===2&&!liesOnEdge(after[1],before[0],before[1]))
   ||(after.length-end===2&&!liesOnEdge(after[end],before.at(-2),before.at(-1)));
 }))fail('display sections must carry the archived arcs in order');
 const afterDisplay=applyReviewedSharedArcs(beforeDisplay,input.sections);
 validatePair(beforeRaw,afterRaw,'raw');validatePair(beforeDisplay,afterDisplay,'display');
 const dependencies=proveNeighbors({sourceIndex:v2,builtin:index,policy,ids:selected,binding,raw:[beforeRaw,afterRaw],
  display:[beforeDisplay,afterDisplay],readRaw:id=>source(id,readBaseline),readCountry,changes:[...rawChanges,...input.sections]});

 const files=new Map(),nativeRows=new Map(),outCountries=[];
 const rawScope=selected.flatMap((id,i)=>[rawPath(id),sourceRoot+'/geometries/sha256-'+digest(geometryBytes(afterRaw[i]))+'.json']);
 for(const [i,entity] of old.entries()){
  const projected=structuredClone(entity),original=oldVersions[i],row=input.entities[i];
  const version=projected.geometryVersions.find(v=>v.versionId===original.versionId);
  const geometry=afterRaw[i],sha=geometryDigest(geometry),sourceId='dos-lsib-11.4-scoped-shared-arc';
  const resourcePath=rawScope[i*2+1],master={reference:resourcePath,sha256:digest(geometryBytes(geometry))};
  version.geometry=geometry;version.sourceId=sourceId;
  version.modernBoundarySupplement={...original.modernBoundarySupplement,sourceId,geometrySha256:sha,
   status:reviewed[i].status,adoptionMode:reviewed[i].method,priorPreparedAttribution:original.modernBoundarySupplement,
   sourceAdoptionReview:row.rebased,wholeCountryRaw:false};
  projected.sourceInfo={...projected.sourceInfo,sourceId,title:'Prepared current geometry with exact LSIB 11.4 shared arcs',geometrySha256:sha,geometryVersionId:version.versionId};
  const rawOptions={prefixes:rawScope,readEvidence};
  assertOriginalAuthoringSourceStorageChanges(projected,entity,rawOptions);
  assertHistoricalSourceStorageChanges(projected,entity,rawOptions);
  const rawApproved=structuredClone(projected);
  const anchors=rawChanges.flatMap(c=>c.before),extent=coordinateBounds(input.sections.map(c=>c.after));
  const displayReview={schemaVersion:1,status:'passed',entityId:projected.entityId,versionId:version.versionId,
   validFrom:version.validFrom,validTo:version.validTo,geometrySha256:sha,master,source:row.rebased,visual:input.visual,
   comparison:{reference:receipt,arcSha256:coordinateDigest(rawChanges.map(c=>c.after)),extent,scaleDenominator:10000000,
    projection:{definition:'+proj=aeqd +ellps=WGS84 +units=m',units:'metre',evidence:receipt}},
   method:'reviewed-display-generalization',reason:'Exact shared LSIB sections with reviewed connections to the pinned display boundary.',
   parameters:{reviewedSectionCount:rawChanges.length},topology:{status:'passed',evidence:receipt,
    checks:['validity','shared-boundary','union','gaps-overlaps','connectivity','holes-islands','dates']},
   counterpartVersions:[{entityId:selected[1-i],versionId:oldVersions[1-i].versionId,geometrySha256:geometryDigest(afterRaw[1-i])}],
   fixedAnchors:anchors};
  version.historicalProvenance={...version.historicalProvenance,displayDetailReview:displayReview};
  assertHistoricalSourceStorageChanges(projected,rawApproved,{prefixes:[rawPath(entity.entityId)],
   readEvidence:p=>p===resourcePath?geometryBytes(geometry):readEvidence(p)});
  assertHistoricalDisplayChanges(projected,entity);
  const {descriptor,geometries}=encodeTerritorialSource(projected);
  files.set(rawPath(entity.entityId),jsonBytes(descriptor));
  files.set(resourcePath,geometries.get(resourcePath.slice(sourceRoot.length+1)));
  const prior=v2.entities.find(r=>r.entityId===entity.entityId),descriptorBytes=jsonBytes(descriptor);
  const previous=readBaseline(nativeBase+prior.file);
  assertIndexedTerritorialChunk(prior,previous);
  const {stored}=selectTerritorialChunkBytes(descriptorBytes,previous);
  files.set(nativeBase+prior.file,stored);
  nativeRows.set(entity.entityId,territorialIndexEntry(projected,{sha256:digest(stored),compressedBytes:stored.length,
   decodedBytes:descriptorBytes.length,storageLayout:descriptor.storageLayout}));

  const country=structuredClone(countries[i]),oldRef=bindings[i].geometryRef,display=afterDisplay[i];
  const shapeId='historical-world:'+coordinateDigest(display),next={id:shapeId,version:1};
  country.sourceBindings=replaceReviewedDisplayBinding(country.sourceBindings,bindings[i],next,binding,previousDisplayThrough);
  country.timelineRecords.geometryBindings=replaceReviewedDisplayBinding(country.timelineRecords.geometryBindings,bindings[i],next,binding,previousDisplayThrough);
  if(!country.sourceBindings.some(r=>equal(r.geometryRef,next))||!country.timelineRecords.geometryBindings.some(r=>equal(r.geometryRef,next)))
   fail('paired Viewer binding missing '+country.entityId);
  const stillUses=country.timelineRecords.geometryBindings.some(r=>equal(r.geometryRef,oldRef));
  country.geometries=country.geometries.flatMap(g=>g.id===oldRef.id&&g.version===oldRef.version
   ?[...(stillUses?[g]:[]),{...next,geojson:display}]:[g]);
  const entry=country.identity.properties.metadata.historicalTimeline.geometryVersions.find(v=>v.versionId===version.versionId);
  entry.historicalProvenance={...entry.historicalProvenance,displayDetailReview:{...displayReview,
   compiledDerivatives:[{...displayReview,entityId:country.entityId,validFrom,validTo,geometrySha256:geometryDigest(display),
    counterpartVersions:[{entityId:ownerIds[1-i],versionId:oldVersions[1-i].versionId,geometrySha256:geometryDigest(afterDisplay[1-i])}]}]}};
  outCountries.push(country);
 }
 const native={...v2,entities:v2.entities.map(row=>nativeRows.get(row.entityId)||row)};
 files.set(sourceIndexPath,jsonBytes(native));
 const catalogue=structuredClone(index);
 for(const [id,entry] of nativeRows)catalogue.inputHashes.sourceRevisions[id]=entry.sha256;
 catalogue.inputHashes.entities=coordinateDigest(catalogue.inputHashes.sourceRevisions);
 const encoded=encodeBuiltinCountries(catalogue,outCountries,new Map());
 finalizeBuiltinWorldFiles(catalogue,encoded,{previousIndex:index});
 const outside=rows=>rows.filter(row=>!ownerIds.includes(row.entityId));
 if(!equal(outside(catalogue.entities),outside(index.entities)))fail('an unselected Viewer descriptor changed');
 const oldIndex=index.readIndex,newIndex=catalogue.readIndex;
 for(const [table,rows] of Object.entries(oldIndex.records)){
  if(!Array.isArray(rows))continue;
  const retained=records=>records.filter(row=>!ownerIds.includes(row.objectRef.id));
  if(!equal(retained(rows),retained(newIndex.records[table])))fail('an unselected Viewer interval changed '+table);
 }
 for(const [p,b] of encoded)files.set(countryBase+p,b);
 const readNext=p=>files.get(p)??readBaseline(p);
 const generated=(row,read)=>{
  const bytes=read(nativeBase+row.file);
  assertIndexedTerritorialChunk(row,bytes);
  const decoded=JSON.parse(gunzipSync(bytes));
  return decoded.storageLayout?decodeTerritorialSource(decoded,p=>read(sourceRoot+'/'+p)):decoded;
 };
 assertHistoricalStorageChanges({prefixes:[...files.keys()],sourceIndex:native,previousSourceIndex:v2,builtinIndex:catalogue,previousBuiltinIndex:index,
  readSource:row=>generated(row,readNext),readPreviousSource:row=>generated(row,readBaseline),
  readCountry:row=>readCountry(row.entityId,readNext,catalogue),readPreviousCountry:row=>readCountry(row.entityId),
  sourceFileChanged:row=>nativeRows.has(row.entityId),readRawSource:row=>source(row.entityId,readNext),
  countryFileChanged:row=>ownerIds.includes(row.entityId)});
 return issue({baseline,files,reports:Object.fromEntries([...reportFiles].sort(([a],[b])=>a.localeCompare(b))),
  plan:{entities:selected,binding,dependencies,writes:[...files.keys()].sort()}});
}

export function reviewedDisplayPeriod(bindings,versions,{displayValidFrom,previousDisplayThrough}){
 if(displayValidFrom===undefined){
  const {validFrom,validTo}=bindings[0];
  if(previousDisplayThrough!==undefined||bindings.some((row,i)=>row.validFrom!==validFrom||row.validFrom!==versions[i].validFrom))
   fail('an explicit common display period is required');
  return {validFrom,validTo};
 }
 const start=parseTemporal(displayValidFrom),end=parseTemporal(previousDisplayThrough);
 if(start?.precision!=='date'||end?.precision!=='date'||start.canonical!==displayValidFrom||end.canonical!==previousDisplayThrough
   ||!equal(temporalFollowingDay(end.endKey),start.startKey)||bindings.some(row=>compareTemporal(row.validFrom,start)>0))
  fail('the display period must begin within both current bindings and immediately follow the retained period');
 return {validFrom:displayValidFrom,validTo:null,previousDisplayThrough};
}

export function replaceReviewedDisplayBinding(rows,before,geometryRef,binding,previousDisplayThrough){
 let replaced=0;
 const next=rows.flatMap(row=>{
  if(!equal(row.geometryRef,before.geometryRef)||row.validFrom!==before.validFrom||row.validTo!==before.validTo)return [row];
  replaced++;
  const revised={...row,...binding,geometryRef};
  if(row.validFrom===binding.validFrom)return [revised];
  if(row.id)revised.id=row.id+':reviewed:'+binding.validFrom;
  return [{...row,validTo:previousDisplayThrough},revised];
 });
 if(replaced!==1)fail('a unique current display binding is required');
 return next;
}

export function buildReviewedBorderBatch({entityIds,receipts,readBaseline,...options}){
 const expected=[...entityIds].sort(),selected=new Set(),plans=[],files=new Map(),reports={};
 for(const receipt of receipts){
  const ids=JSON.parse(options.readEvidence(receipt.reference)).entities.map(row=>row.entityId);
  for(const id of ids){
   if(!expected.includes(id)||selected.has(id))fail('batch countries must be explicitly selected and disjoint: '+id);
   selected.add(id);
  }
  const edition=buildReviewedBorderEdition({...options,entityIds:ids,receipt,readBaseline:path=>files.get(path)??readBaseline(path)});
  for(const [path,bytes] of edition.files)files.set(path,bytes);
  Object.assign(reports,edition.reports);
  plans.push(edition.plan);
 }
 if(!equal([...selected].sort(),expected))fail('batch review scope differs from the selected countries');
 return issue({baseline:options.baseline,files,reports,plan:{entities:expected,borders:plans,writes:[...files.keys()].sort()}});
}

function issue(result){
 const {baseline,files}=result;
 issued.set(result,{baseline,files:new Map([...files].map(([p,b])=>[p,digest(b)])),reports:{...result.reports}});
 return result;
}

export function assertReviewedBorderEdition(result){
 const proof=issued.get(result);
 if(!proof||proof.baseline!==result.baseline||proof.files.size!==result.files.size||!equal(proof.reports,result.reports))fail('unissued or modified edition');
 for(const [p,b] of result.files)if(!Buffer.isBuffer(b)||proof.files.get(p)!==digest(b))fail('edition bytes changed '+p);
}
