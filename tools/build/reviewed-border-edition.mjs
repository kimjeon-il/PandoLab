import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {coordinateBounds} from '../../src/geometry/coordinate-bounds.js';
import {temporalIntervalsOverlap,compareTemporal,parseTemporal,temporalFollowingDay} from '../../src/document/temporal.js';
import {decodeTerritorialSource,encodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {selectTerritorialChunkBytes} from '../data/territorial-chunk-compression.mjs';
import {assertIndexedTerritorialChunk} from '../data/territorial-metadata-projection.mjs';
import {encodeBuiltinCountries,finalizeBuiltinWorldFiles,readBuiltinCountry} from '../data/builtin-country-bytes.mjs';
import {approvedLsibSource} from '../data/lsib-display-sources.mjs';
import {assertHistoricalCompiledChanges,assertHistoricalDisplayChanges,assertHistoricalSourceStorageChanges,historicalLsibDisplayEvidencePath,lsibDisplayEvidencePath,readHistoricalLsibDisplayEvidence,readWorldPolygonsPartition,worldPolygonsCompositionGeometry,worldPolygonsDisplayEvidencePath,worldPolygonsReviewedGeometry,worldPolygonsViewerGeometry} from '../gis/historical-display-review.mjs';
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

const sectionBounds=({before,after})=>coordinateBounds([before,after]);

export function validateReviewedPair(before,after,changes,label){
 for(const g of after)if(!globalThis.PandoLabPolygonGeometry.normalizePolygonGeometry(g))fail('empty '+label+' country');
 if(clip.intersection(...after.map(parts)).length)fail(label+' pair overlaps');
 // An exact splice replaces one chain between fixed endpoints. Its winding
 // contribution is unchanged outside the bounds of the old and new chains.
 // Clip each edition before comparing so untouched coastlines do not enter
 // the same polygon operation twice.
 return changes.map(change=>{
  const bounds=sectionBounds(change);
  const [west,south,east,north]=bounds;
  const padding=.001;
  const left=Math.max(-180,west-padding),right=Math.min(180,east+padding);
  const bottom=Math.max(-90,south-padding),top=Math.min(90,north+padding);
  const window=[[[[left,bottom],[right,bottom],[right,top],[left,top],[left,bottom]]]];
  const withinWindow=geometry=>clip.intersection(parts(geometry),window);
  const original=before.map(withinWindow),updated=after.map(withinWindow);
  if(clip.xor(clip.union(...original),clip.union(...updated)).length)fail(label+' pair exterior changed');
  return {bounds,before:original,after:updated};
 });
}

export function reviewedBorderTouchesNeighbor(geometry,sections){
 // A neighbor intersects a changed area exactly when its intersections with
 // a country's old and new territory differ. Clip to the neighbor first to
 // avoid computing a symmetric difference along the entire shared arc.
 for(const polygon of parts(geometry)){
  const bounds=coordinateBounds(polygon);
  for(const {bounds:footprint,before,after} of sections){
   if(!overlaps(bounds,footprint))continue;
   for(const [i,oldSide] of before.entries()){
    const previous=clip.intersection([polygon],oldSide);
    const current=clip.intersection([polygon],after[i]);
    if(!equal(previous,current)&&(!previous.length||!current.length||clip.xor(previous,current).length))return true;
   }
  }
 }
 return false;
}

function liesOnEdge([x,y],[ax,ay],[bx,by]){
 const dx=bx-ax,dy=by-ay,px=x-ax,py=y-ay,extent=dx*dx+dy*dy;
 const progress=px*dx+py*dy;
 return Math.abs(px*dy-py*dx)<=1e-12&&progress>=-1e-12&&progress<=extent+1e-12;
}

function carriesArc(section,arc){
 const {before,after}=section;
 if(!chain(before)||!chain(after)||!chain(arc))return false;
 const at=after.findIndex(p=>equal(p,arc[0])),end=at+arc.length;
 return at>=0&&equal(after.slice(at,end),arc)&&at<=2&&after.length-end<=2
  &&(at!==2||liesOnEdge(after[1],before[0],before[1]))
  &&(after.length-end!==2||liesOnEdge(after[end],before.at(-2),before.at(-1)));
}

export function validateDisplayedBorderAuthority(authority,sections,{baseline,entities,readEvidence}){
 const {source,arcs,kind}=authority;
 if(authority.schemaVersion!==1||authority.baseline!==baseline||!equal(authority.entities,entities)
  ||!Array.isArray(arcs)||!arcs.length||arcs.length!==sections.length||!shaPattern.test(source?.sha256||''))
  fail('invalid display authority scope');
 let features;
 if(kind==='lsib-line-selected-by-natural-earth'){
  if(source.reference!=='tools/historical-library/sources/lsib-11.4/boundaries.geojson.gz'
   ||!shaPattern.test(authority.naturalEarthSha256||''))fail('LSIB and Natural Earth source identities required');
  const bytes=readEvidence(source.reference);
  if(digest(bytes)!==source.sha256)fail('LSIB line archive bytes differ');
  features=JSON.parse(gunzipSync(bytes)).features;
 }else if(kind!=='surveyed-bank-midpoints'||!/^https:\/\//.test(source.reference||''))fail('unsupported display authority');
 for(const [i,arc] of arcs.entries()){
  if(!carriesArc(sections[i],arc.coordinates))fail('display section differs from its source arc');
  if(features){
   const feature=features.find(row=>row.properties.ID===arc.lineId);
   const geometry=feature?.geometry;
   const lines=geometry?.type==='LineString'?[geometry.coordinates]:geometry?.type==='MultiLineString'?geometry.coordinates:[];
   const raw=lines[arc.part];
   const slice=raw?.slice(arc.start,arc.end+1);
   if(!Number.isInteger(arc.part)||!Number.isInteger(arc.start)||!Number.isInteger(arc.end)||arc.start<0||arc.end>=raw?.length
    ||!slice||(!equal(slice,arc.coordinates)&&!equal(slice.toReversed(),arc.coordinates)))fail('display arc is not an exact LSIB line slice');
  }else if(!Array.isArray(arc.banks)||arc.banks.length!==arc.coordinates.length||arc.banks.some((pair,j)=>{
   if(!Array.isArray(pair)||pair.length!==2||!pair.every(point)||equal(pair[0],pair[1]))return true;
   return arc.coordinates[j].some((v,k)=>Math.abs(v-(pair[0][k]+pair[1][k])/2)>1e-12);
  }))fail('surveyed bank midpoint differs');
 }
}

function proveNeighbors({sourceIndex,builtin,policy,ids,binding,rawSections,displaySections,readRaw,readCountry}){
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
 const footprints=[...rawSections,...displaySections].map(section=>section.bounds);
 const readOnly=[];
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
  for(const version of rawPeer.geometryVersions)if(dateOverlap(version,binding)&&reviewedBorderTouchesNeighbor(version.geometry,rawSections))
   fail('raw neighbor affected '+id+' '+version.versionId);
  for(const entry of historical.sourceBindings)if(dateOverlap(entry,binding)){
   const geometry=historical.geometries.find(g=>equal(entry.geometryRef,{id:g.id,version:g.version}));
   if(!geometry||reviewedBorderTouchesNeighbor(geometry.geojson,displaySections))fail('display neighbor affected '+id+' '+entry.validFrom);
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
 const authority=input.displayAuthority?JSON.parse(archived(input.displayAuthority)):null;
 if(authority)validateDisplayedBorderAuthority(authority,input.sections,{baseline,entities:selected,readEvidence});
 const reviewed=authority?[]:input.entities.map(row=>{
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
 const rawChanges=authority?[]:reviewed[0].sharedArcChanges.map(a=>({before:[a.original.coordinates[0],a.original.coordinates.at(-1)],
  beforeSha256:a.previousCoordinatesSha256,after:a.original.coordinates}));
 const beforeRaw=oldVersions.map(v=>v.geometry),afterRaw=authority?beforeRaw:applyReviewedSharedArcs(beforeRaw,rawChanges);
 const beforeDisplay=countries.map((country,i)=>{
  const ref=bindings[i].geometryRef,g=country.geometries.find(g=>g.id===ref.id&&g.version===ref.version);
  if(!g||geometryDigest(g.geojson)!==input.entities[i].displayBefore)fail('display preimage differs '+country.entityId);
  return g.geojson;
 });
 if(!authority&&(input.sections.length!==rawChanges.length||input.sections.some((section,i)=>!carriesArc(section,rawChanges[i].after))))
  fail('display sections must carry the archived arcs in order');
 const afterDisplay=applyReviewedSharedArcs(beforeDisplay,input.sections);
 const rawSections=authority?[]:validateReviewedPair(beforeRaw,afterRaw,rawChanges,'raw');
 const displaySections=validateReviewedPair(beforeDisplay,afterDisplay,input.sections,'display');
 const dependencies=proveNeighbors({sourceIndex:v2,builtin:index,policy,ids:selected,binding,rawSections,displaySections,
  readRaw:id=>source(id,readBaseline),readCountry});

 const files=new Map(),nativeRows=new Map(),outCountries=[];
 const rawScope=selected.flatMap((id,i)=>[rawPath(id),sourceRoot+'/geometries/sha256-'+digest(geometryBytes(afterRaw[i]))+'.json']);
 const provenArcs=authority?authority.arcs.map(arc=>arc.coordinates):rawChanges.map(c=>c.after);
 const anchors=(authority?input.sections:rawChanges).flatMap(({before})=>[before[0],before.at(-1)]);
 const extent=coordinateBounds(input.sections.map(c=>c.after));
 for(const [i,entity] of old.entries()){
  const projected=structuredClone(entity),original=oldVersions[i],row=input.entities[i];
  const version=projected.geometryVersions.find(v=>v.versionId===original.versionId);
  const geometry=afterRaw[i],sha=geometryDigest(geometry),sourceId='dos-lsib-11.4-scoped-shared-arc';
  const resourcePath=rawScope[i*2+1];
  const resource=authority?json(rawPath(entity.entityId)).geometryVersions.find(v=>v.versionId===version.versionId).geometryResource:null;
  const master=authority?{reference:sourceRoot+'/'+resource.file,sha256:resource.sha256}:{reference:resourcePath,sha256:digest(geometryBytes(geometry))};
  const displayReview={schemaVersion:1,status:'passed',entityId:projected.entityId,versionId:version.versionId,
   validFrom:version.validFrom,validTo:version.validTo,geometrySha256:sha,master,source:input.displayAuthority??row.rebased,visual:input.visual,
   comparison:{reference:receipt,arcSha256:coordinateDigest(provenArcs),extent,scaleDenominator:10000000,
    projection:{definition:'+proj=aeqd +ellps=WGS84 +units=m',units:'metre',evidence:receipt}},
   method:'reviewed-display-generalization',reason:authority?.kind==='surveyed-bank-midpoints'?'Shared display line through surveyed bank midpoints.':
    authority?'Exact LSIB line selected using the Natural Earth display route.':'Exact shared LSIB sections with reviewed connections to the pinned display boundary.',
   parameters:{reviewedSectionCount:input.sections.length},topology:{status:'passed',evidence:receipt,
    checks:['validity','shared-boundary','union','gaps-overlaps','connectivity','holes-islands','dates']},
   counterpartVersions:[{entityId:selected[1-i],versionId:oldVersions[1-i].versionId,geometrySha256:geometryDigest(afterRaw[1-i])}],
   fixedAnchors:anchors};
  if(!authority){
   version.geometry=geometry;version.sourceId=sourceId;
   version.modernBoundarySupplement={...original.modernBoundarySupplement,sourceId,geometrySha256:sha,
    status:reviewed[i].status,adoptionMode:reviewed[i].method,priorPreparedAttribution:original.modernBoundarySupplement,
    sourceAdoptionReview:row.rebased,wholeCountryRaw:false};
   projected.sourceInfo={...projected.sourceInfo,sourceId,title:'Prepared current geometry with exact LSIB 11.4 shared arcs',geometrySha256:sha,geometryVersionId:version.versionId};
   const rawOptions={prefixes:rawScope,readEvidence};
   assertOriginalAuthoringSourceStorageChanges(projected,entity,rawOptions);
   assertHistoricalSourceStorageChanges(projected,entity,rawOptions);
   const rawApproved=structuredClone(projected);
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
  }

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
 if(!authority)files.set(sourceIndexPath,jsonBytes(native));
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
  ||!equal(temporalFollowingDay(end.endKey),start.startKey)||bindings.some(row=>row.validFrom&&compareTemporal(row.validFrom,start)>0))
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

function findReviewedTimelineBinding(country,binding){
 const rows=country.timelineRecords.geometryBindings.filter(row=>equal(row.geometryRef,binding.geometryRef)
  &&row.validTo===binding.validTo);
 const exact=rows.find(row=>row.validFrom===binding.validFrom);
 if(exact)return {row:exact};
 if(rows.length!==1||binding.validTo!==null||!binding.validFrom
  ||(rows[0].validFrom&&compareTemporal(rows[0].validFrom,binding.validFrom)>=0))return null;
 const start=parseTemporal(binding.validFrom).startKey;
 const previous=country.sourceBindings.find(row=>row.validTo&&equal(row.geometryRef,binding.geometryRef)
  &&equal(temporalFollowingDay(parseTemporal(row.validTo).endKey),start));
 return previous?{row:rows[0],previousDisplayThrough:previous.validTo}:null;
}

export function applyWorldPolygonsDisplay(country,replacements,source,cutover){
 return applyReviewedDisplayGeometry(country,replacements,source,cutover,'worldPolygonsDisplay');
}

export function applyLsibDisplay(country,feature,source,cutover,readBaseline){
 const timeline=country.identity.properties.metadata.historicalTimeline;
 const current=country.sourceBindings.filter(row=>row.validTo===null);
 const [binding]=current;
 const properties=feature.properties;
 if(current.length!==1||country.entityId!==feature.id||timeline.entityId!==properties?.sourceEntityId
  ||!equal(binding.geometryRef,properties.before)||!Array.isArray(properties.wpIds)||!properties.wpIds.length)
  fail('LSIB display candidate differs from the current object or geometry');
 const version=timeline.geometryVersions.find(row=>row.versionId===binding.sourceVersionId);
 const provenance=version?.historicalProvenance;
 const approved=[...(provenance?.lsibDisplay??[]),...(provenance?.worldPolygonsDisplay??[])]
  .find(row=>row.validFrom===binding.validFrom&&row.validTo===binding.validTo);
 const {wpIds,division}=approvedLsibSource({sourceId:timeline.entityId,review:approved},readBaseline);
 if(!equal(properties.wpIds,wpIds)||!equal(properties.divisionSource,division?.source))
  fail('LSIB display differs from the approved World Polygons source');
 assertLsibPolygon(feature.geometry);
 return applyReviewedDisplayGeometry(country,[{binding,geometry:feature.geometry,featureIds:properties.wpIds,
  ...(division?{divisionSource:division.source}:{})}],
  source,cutover,'lsibDisplay');
}

function assertLsibPolygon(geometry){
 if(!['Polygon','MultiPolygon'].includes(geometry?.type)||!Array.isArray(geometry.coordinates)||!parts(geometry).length
  ||parts(geometry).some(polygon=>!Array.isArray(polygon)||!polygon.length||polygon.some(ring=>
   !Array.isArray(ring)||ring.length<4||!equal(ring[0],ring.at(-1))||!ring.every(point))))
  fail('LSIB display candidate requires closed geographic polygon rings');
}

export function applyHistoricalLsibDisplay(country,row,source){
 const timeline=country.identity.properties.metadata.historicalTimeline;
 const bindings=country.sourceBindings.filter(binding=>binding.sourceVersionId===row.sourceVersionId
  &&binding.validFrom===row.validFrom&&binding.validTo===row.validTo&&equal(binding.geometryRef,row.before));
 if(country.entityId!==row.entityId||timeline.entityId!==row.sourceEntityId||row.validTo==null||bindings.length!==1)
  fail('historical display binding differs from the selected object, dates or previous shape');
 assertLsibPolygon(row.geometry);
 return applyReviewedDisplayGeometry(country,[{binding:bindings[0],geometry:row.geometry}],
  source,undefined,'historicalLsibDisplay');
}

function applyReviewedDisplayGeometry(country,replacements,source,cutover,provenanceField){
 const next=structuredClone(country);
 const timeline=next.identity.properties.metadata.historicalTimeline;
 for(const {binding,geometry,featureId,featureIds,sourceMemberEntityId,divisionSource} of replacements){
  const before=next.geometries.find(g=>equal({id:g.id,version:g.version},binding.geometryRef));
  const version=timeline.geometryVersions.find(v=>v.versionId===binding.sourceVersionId);
  if(!before||!version||!['Polygon','MultiPolygon'].includes(geometry?.type)||!parts(geometry).length)
   fail('invalid World Polygons binding '+country.entityId);
  if(geometryDigest(before.geojson)===geometryDigest(geometry))continue;
  const ref={id:'historical-world:'+coordinateDigest(geometry),version:1};
  const {previousDisplayThrough,validFrom,validTo}=cutover?reviewedDisplayPeriod([binding],[version],cutover):binding;
  const dates={validFrom,validTo};
  const scheduled=findReviewedTimelineBinding(next,binding);
  if(!scheduled)fail('invalid World Polygons timeline binding '+country.entityId);
  next.sourceBindings=replaceReviewedDisplayBinding(next.sourceBindings,binding,ref,dates,previousDisplayThrough);
  next.timelineRecords.geometryBindings=replaceReviewedDisplayBinding(next.timelineRecords.geometryBindings,
   scheduled.row,ref,dates,previousDisplayThrough??scheduled.previousDisplayThrough);
  if(!next.geometries.some(g=>g.id===ref.id&&g.version===ref.version))next.geometries.push({...ref,geojson:geometry});
  const provenance=version.historicalProvenance??={};
  const previousReviews=(provenance[provenanceField]??[]).filter(row=>row.validFrom!==dates.validFrom||row.validTo!==dates.validTo);
  provenance[provenanceField]=[...previousReviews,{...dates,...(featureIds?{featureIds}:featureId?{featureId}:{}),source,
   ...(sourceMemberEntityId?{sourceMemberEntityId}:{}),
   ...(divisionSource?{divisionSource}:{}),
   previousGeometrySha256:geometryDigest(before.geojson),geometrySha256:geometryDigest(geometry)}];
 }
 const retained=[...next.sourceBindings,...next.timelineRecords.geometryBindings];
 next.geometries=next.geometries.filter(g=>retained.some(r=>r.geometryRef.id===g.id&&r.geometryRef.version===g.version));
 return next;
}

export function buildLsibDisplayEdition({baseline,readBaseline,indexPath,sourceBytes,expectedDisplayValidFrom}){
 const evidence=JSON.parse(gunzipSync(sourceBytes));
 const {features,displayValidFrom,previousDisplayThrough}=evidence;
 if(evidence.type!=='FeatureCollection'||evidence.baseline!==baseline||displayValidFrom!==expectedDisplayValidFrom
  ||!Array.isArray(features)||!features.length
  ||new Set(features.map(row=>row.id)).size!==features.length||evidence.method!=='geos-coverage-visvalingam-whyatt')
  fail('LSIB display evidence does not match the pinned Viewer edition');
 const lsib=JSON.parse(readBaseline('tools/historical-library/sources/lsib-11.4/provenance.json'));
 const wp=JSON.parse(gunzipSync(readBaseline(worldPolygonsDisplayEvidencePath())));
 if(evidence.source?.lsibVersion!=='11.4'||evidence.source.boundarySha256!==lsib.masterSha256
  ||evidence.source.worldPolygonsSha256!==wp.sourcePackageSha256
  ||evidence.source.shorelineLayer!=='DoS_WP_Shoreline'||evidence.source.polygonLayer!=='DoS_WP_11_4'
  ||!Number.isFinite(evidence.toleranceDegrees)||evidence.toleranceDegrees<=0||evidence.toleranceDegrees>=1)
  fail('LSIB display evidence uses an unverified GIS source or tolerance');
 const sha256=digest(sourceBytes),reference=lsibDisplayEvidencePath(sha256);
 const index=JSON.parse(readBaseline(indexPath)),nextIndex=structuredClone(index);
 const directory=indexPath.slice(0,indexPath.lastIndexOf('/')+1);
 const bySourceId=new Map(features.map(row=>[row.properties.sourceEntityId,row]));
 for(const {properties} of features){
  if(!properties.divisionSource)continue;
  const {reference:proofPath,sha256:proofHash}=properties.divisionSource;
  const proof=readBaseline(proofPath);
  if(digest(proof)!==proofHash)fail('LSIB retained division evidence differs');
  const division=JSON.parse(gunzipSync(proof)).partitions?.find(row=>row.featureId===properties.wpIds[0]
   &&[row.ownerEntityId,row.memberEntityId].includes(properties.sourceEntityId));
  if(!division||![division.ownerEntityId,division.memberEntityId].every(id=>
   equal(bySourceId.get(id)?.properties.divisionSource,properties.divisionSource)))
   fail('LSIB display requires both sides of the approved division');
 }
 const changed=features.map(feature=>{
  const entry=index.entities.find(row=>row.entityId===feature.id);
  if(!entry)fail('LSIB display candidate has no existing Viewer object '+feature.id);
  const prior=readBuiltinCountry(entry,index,file=>readBaseline(directory+file));
  const next=applyLsibDisplay(prior,feature,{reference,sha256},{displayValidFrom,previousDisplayThrough},readBaseline);
  if(assertHistoricalCompiledChanges(next,prior,{readDisplayEvidence:p=>p===reference?sourceBytes:null})!==1)
   fail('LSIB display candidate did not produce exactly one new display binding '+feature.id);
  return next;
 });
 const encoded=encodeBuiltinCountries(nextIndex,changed,new Map());
 finalizeBuiltinWorldFiles(nextIndex,encoded,{previousIndex:index});
 for(const field of ['lifetimes','parentRelations','propertyBindings'])
  if(!equal(index.readIndex.records[field],nextIndex.readIndex.records[field]))fail('LSIB display changed '+field);
 const files=new Map([...encoded].map(([file,bytes])=>[directory+file,bytes]));
 files.set(reference,sourceBytes);
 return issue({baseline,files,reports:{},plan:{changed:changed.map(country=>country.entityId),held:evidence.held}});
}

const reviewedSudanCoast='reports/borders/validation/ne-world-map-rebase-2026-11-08/historical-modern-reuse-local-20261109/sdn-red-sea-coast-20261110/safe-coast-source-provenance.json';
const reviewedIndonesiaUnion='reports/borders/validation/ne-world-map-rebase-2026-11-08/historical-modern-reuse-local-20261109/idn-complete-modern-union-correction-20261110/source-provenance.json';

function readHistoricalGeometryProof(proof,readBaseline){
 const bytes=readBaseline(proof.reference);
 if(digest(bytes)!==proof.sha256)fail('historical LSIB geometry proof differs');
 return JSON.parse(bytes);
}

function assertHistoricalLsibCoast(row,readBaseline){
 if(row.sourceEntityId!=='state:SDN'||row.donorSourceEntityId!==row.sourceEntityId
  ||row.sourceVersionId!=='state:sudan:1956-2011-r1'||row.validFrom!=='1956-01-01'||row.validTo!=='2011-07-08'
  ||row.review?.reference!==reviewedSudanCoast)
  fail('unreviewed historical LSIB coastline '+row.entityId);
 const {topology}=readHistoricalGeometryProof(row.review,readBaseline);
 const record=readHistoricalGeometryProof(topology,readBaseline);
 if(record.status!=='passed-for-safe-coast-source-change'||!record.allOriginalPoliticalEdgesExact)
  fail('missing protected historical LSIB coastline limits');
}

function readHistoricalLsibDonor(country,sourceEntityId,geometryRef){
 const timeline=country.identity.properties.metadata.historicalTimeline;
 const current=country.sourceBindings.filter(binding=>binding.validTo===null&&equal(binding.geometryRef,geometryRef));
 const [modern]=current;
 const version=timeline.geometryVersions.find(row=>row.versionId===modern?.sourceVersionId);
 if(current.length!==1||timeline.entityId!==sourceEntityId
  ||!version?.historicalProvenance?.lsibDisplay?.some(claim=>claim.validFrom===modern.validFrom&&claim.validTo===null))
  fail('unverified current LSIB display donor '+country.entityId);
 return modern;
}

function assertHistoricalLsibUnion(row,readBaseline,readCountry){
 if(row.sourceEntityId!=='state:IDN'||row.donorSourceEntityId!==row.sourceEntityId
  ||row.review?.reference!==reviewedIndonesiaUnion||row.additionalDonor?.entityId!=='TLS'
  ||row.additionalDonor.sourceEntityId!=='state:TLS')fail('unreviewed historical LSIB union '+row.entityId);
 const review=readHistoricalGeometryProof(row.review,readBaseline);
 const target=review.originalVersion;
 if(target?.versionId!==row.sourceVersionId||target.validFrom!==row.validFrom||target.validTo!==row.validTo
  ||!equal(review.donors?.map(donor=>donor.versionId.split(':').slice(0,2).join(':')),['state:IDN','state:TLS']))
  fail('historical LSIB union differs from the reviewed territorial grouping');
 const {entityId,sourceEntityId,geometryRef}=row.additionalDonor;
 readHistoricalLsibDonor(readCountry(entityId),sourceEntityId,geometryRef);
}

export function buildHistoricalLsibDisplayEdition({baseline,readBaseline,indexPath,sourceBytes,includeSameSource=false}){
 const {data,sha256}=readHistoricalLsibDisplayEvidence(sourceBytes);
 if(data.baseline!==baseline||!data.rows.length)fail('historical LSIB display evidence differs from the pinned Viewer edition');
 const reference=historicalLsibDisplayEvidencePath(sha256),source={reference,sha256};
 const wp=JSON.parse(gunzipSync(readBaseline(worldPolygonsDisplayEvidencePath())));
 const index=JSON.parse(readBaseline(indexPath)),nextIndex=structuredClone(index);
 const directory=indexPath.slice(0,indexPath.lastIndexOf('/')+1);
 const entries=new Map(index.entities.map(entry=>[entry.entityId,entry]));
 const countries=new Map(),replacements=new Map(),counts=new Map();
 const readCountry=id=>{
  if(!entries.has(id))fail('missing historical LSIB display object '+id);
  if(!countries.has(id))countries.set(id,readBuiltinCountry(entries.get(id),index,file=>readBaseline(directory+file)));
  return countries.get(id);
 };
 for(const row of data.rows){
  const country=readCountry(row.entityId),donor=readCountry(row.donor);
  const modern=readHistoricalLsibDonor(donor,row.donorSourceEntityId,row.donorGeometryRef);
  const start=parseTemporal(modern.validFrom)?.startKey;
  const prior=start&&donor.sourceBindings.find(binding=>binding.validTo&&binding.sourceVersionId===modern.sourceVersionId
   &&equal(temporalFollowingDay(parseTemporal(binding.validTo).endKey),start));
  if(!prior)fail('missing previous LSIB display donor '+row.donor);
  const scopeApproved=wp.historical.some(review=>review.outcome==='candidate'&&review.entityId===row.sourceEntityId
   &&review.versionId===row.sourceVersionId&&review.donor===row.donorSourceEntityId
   &&(review.validFrom==null||(row.validFrom!=null&&compareTemporal(review.validFrom,row.validFrom)<=0))
   &&compareTemporal(review.validTo,row.validTo,{leftBoundary:'end',rightBoundary:'end'})>=0);
  const sameOutline=equal(prior.geometryRef,row.before);
  if(row.kind==='same-source'){
   if(!includeSameSource||row.entityId!==row.donor||row.sourceVersionId!==prior.sourceVersionId||!sameOutline||row.validTo!==prior.validTo)
    fail('historical LSIB same-source window is outside the selected scope '+row.entityId);
  }else if(row.kind==='reviewed-coast'){
   assertHistoricalLsibCoast(row,readBaseline);
  }else if(row.kind==='reviewed-union'){
   assertHistoricalLsibUnion(row,readBaseline,readCountry);
  }else if(row.kind!=='approved-copy'||!scopeApproved||!sameOutline){
   fail('missing reviewed historical donor relationship '+row.entityId);
  }
  if(row.application==='approved-outline'){
   const geometry=donor.geometries.find(asset=>equal({id:asset.id,version:asset.version},row.donorGeometryRef));
   if(!sameOutline||!equal(row.geometry,geometry?.geojson))fail('historical LSIB outline differs from the approved donor');
  }else if(row.application!=='common-sections')fail('unrecognized historical LSIB display application');
  replacements.set(row.entityId,applyHistoricalLsibDisplay(replacements.get(row.entityId)??country,row,source));
  counts.set(row.entityId,(counts.get(row.entityId)??0)+1);
 }
 const changed=[...replacements.values()];
 for(const country of changed){
  const prior=countries.get(country.entityId);
  const checked=assertHistoricalCompiledChanges(country,prior,{readDisplayEvidence:path=>path===reference?sourceBytes:null});
  if(checked!==counts.get(country.entityId))fail('historical LSIB display did not replace every selected binding '+country.entityId);
 }
 const encoded=encodeBuiltinCountries(nextIndex,changed,new Map());
 finalizeBuiltinWorldFiles(nextIndex,encoded,{previousIndex:index});
 for(const field of ['lifetimes','parentRelations','propertyBindings'])
  if(!equal(index.readIndex.records[field],nextIndex.readIndex.records[field]))fail('historical LSIB display changed '+field);
 const files=new Map([...encoded].map(([file,bytes])=>[directory+file,bytes]));
 files.set(reference,sourceBytes);
 return issue({baseline,files,reports:{},plan:{changed:changed.map(country=>country.entityId),bindings:data.rows.length,reference}});
}

export function buildWorldPolygonsDisplayEdition({baseline,readBaseline,indexPath,sourcePath,sourceBytes}){
 const publication=JSON.parse(gunzipSync(sourceBytes));
 const source={reference:sourcePath,sha256:digest(sourceBytes)};
 if(publication.sourceLayer!=='DoS_WP_11_4_G99_5'||publication.sourceCrs!=='EPSG:4326')
  fail('expected World Polygons 11.4 99.5% geometry');
 const composition=sourcePath===worldPolygonsDisplayEvidencePath(source.sha256,'compositions');
 const mapped=composition&&publication.current.some(row=>row.method==='confirmed-original-features');
 const reviewed=sourcePath===worldPolygonsDisplayEvidencePath(source.sha256,'reviewed');
 const partition=sourcePath===worldPolygonsDisplayEvidencePath(source.sha256,'partitions');
 if(composition&&!mapped&&(publication.current.length!==1||publication.current[0].entityId!=='state:PSX'
  ||publication.historical.length))fail('composition is limited to current Palestine');
 if((reviewed||mapped)&&(publication.baseline!==baseline||!publication.current.length||publication.historical.length
  ||new Set(publication.current.map(row=>row.entityId)).size!==publication.current.length
  ||publication.current.some(row=>row.outcome!=='candidate')))fail('exact current reviewed scope required');
 if(mapped&&(typeof publication.displayValidFrom!=='string'||typeof publication.previousDisplayThrough!=='string'
  ||publication.current.some(row=>row.method!=='confirmed-original-features')))fail('current original feature mapping requires an explicit display cutover');
 const index=JSON.parse(readBaseline(indexPath));
 const root=indexPath.slice(0,indexPath.lastIndexOf('/')+1);
 const owners=new Map(index.sourceIdentities.flatMap(row=>row.sourceEntityIds.map(id=>[id,row])));
 const countries=new Map();
 const readCountry=id=>{
  if(!countries.has(id)){
   const entry=index.entities.find(row=>row.entityId===id);
   if(!entry)fail('missing display owner '+id);
   countries.set(id,readBuiltinCountry(entry,index,file=>readBaseline(root+file)));
  }
  return countries.get(id);
 };
 const replacements=new Map(),current=new Map(),skipped=[];
 let originalWorld;
 const cutover=partition||mapped?{displayValidFrom:publication.displayValidFrom,previousDisplayThrough:publication.previousDisplayThrough}:undefined;
 const bind=(row,historical)=>{
  const owner=owners.get(row.entityId);
  if(!owner||!reviewed&&owner.sourceEntityIds.length!==1)return 'composite or missing Viewer identity';
  const country=readCountry(owner.projectEntityId);
  const ownerSourceEntityId=country.identity.properties.metadata.historicalTimeline.entityId;
  const member=reviewed&&row.entityId!==ownerSourceEntityId;
  if(reviewed&&row.ownerSourceEntityId!==ownerSourceEntityId)return 'reviewed Viewer identity differs';
  if(member){
   originalWorld??=JSON.parse(gunzipSync(readBaseline(worldPolygonsDisplayEvidencePath())));
   const original=originalWorld.current.find(feature=>feature.entityId===ownerSourceEntityId&&feature.outcome==='candidate');
   if(owner.sourceEntityIds.length!==2||originalWorld.sourcePackageSha256!==publication.sourcePackageSha256
    ||!equal(original?.candidateIds,[row.ownerFeatureId])||!originalWorld.geometries[row.ownerFeatureId]
    ||!equal(originalWorld.geometries[row.ownerFeatureId],publication.geometries[row.ownerFeatureId]))
    return 'paired original owner feature required';
  }else if(reviewed&&owner.sourceEntityIds.length!==1)return 'explicit composite member required';
  const bindings=country.sourceBindings.filter(b=>b.sourceVersionId===row.versionId&&(historical?b.validTo!==null:b.validTo===null));
  if(!bindings.length)return 'no matching Viewer interval';
  const donor=historical?current.get(row.donor):null;
  if(historical&&!donor)return 'no paired current Viewer donor';
  const featureId=row.candidateIds?.[0],donorGeometry=publication.geometries[featureId];
  if(!composition&&(row.candidateIds?.length!==1||!donorGeometry))return 'no unique polygon';
  if(reviewed&&(!publication.sourceFeatures?.[featureId]?.genc||!shaPattern.test(publication.sourceFeatures[featureId].wkbSha256)))
   return 'verified original source feature required';
  if(!bindings.every(binding=>{
   if(historical&&!equal(binding.geometryRef,donor.before.geometryRef))return false;
   return Boolean(findWorldPolygonsTimelineBinding(country,binding));
  }))return 'Viewer geometry or interval differs from the reviewed scope';
  if(!replacements.has(country.entityId))replacements.set(country.entityId,[]);
  const selected=replacements.get(country.entityId);
  const geometry=composition?worldPolygonsCompositionGeometry(publication,row)
   :reviewed?worldPolygonsReviewedGeometry(donorGeometry,row,publication.geometries[row.ownerFeatureId]):worldPolygonsViewerGeometry(donorGeometry,row);
  for(const binding of bindings)
   selected.push({binding,geometry,...(composition?{featureIds:row.candidateIds}:{featureId}),...(member?{sourceMemberEntityId:row.entityId}:{})});
  if(!historical)current.set(row.entityId,{before:bindings[0]});
  return null;
 };
 if(partition){
  if(publication.baseline!==baseline||typeof cutover.displayValidFrom!=='string'||typeof cutover.previousDisplayThrough!=='string'
   ||!Array.isArray(publication.partitions)||!publication.partitions.length)
   fail('exact current partition scope required');
  for(const row of publication.partitions){
   const {owner,member}=readWorldPolygonsPartition(publication,row,readBaseline);
   for(const [sourceId,geometry] of [[row.ownerEntityId,owner],[row.memberEntityId,member]]){
    const target=owners.get(sourceId);
    if(target?.sourceEntityIds.length!==1||replacements.has(target.projectEntityId))
     fail('partition requires distinct existing Viewer objects '+sourceId);
    const country=readCountry(target.projectEntityId);
    const bindings=country.sourceBindings.filter(b=>b.validTo===null);
    if(bindings.length!==1||!findWorldPolygonsTimelineBinding(country,bindings[0]))
     fail('partition requires a unique current display binding '+sourceId);
    replacements.set(country.entityId,[{binding:bindings[0],geometry,featureId:row.featureId}]);
    current.set(sourceId,{before:bindings[0]});
   }
  }
 }else{
  for(const [historical,rows] of [[false,publication.current],[true,publication.historical]])
   for(const row of rows)if(row.outcome==='candidate'){
    const reason=bind(row,historical);
    if(reason)skipped.push({entityId:row.entityId,versionId:row.versionId,historical,reason});
   }
 }
 const nextIndex=structuredClone(index), changed=[];
 for(const [id,rows] of replacements){
  const before=readCountry(id),country=applyWorldPolygonsDisplay(before,rows,source,cutover);
  const verified=assertHistoricalCompiledChanges(country,before,{readDisplayEvidence:p=>p===sourcePath?sourceBytes:partition?readBaseline(p):null});
  if(partition&&verified!==1)fail('missing changed partition side '+id);
  if(!equal(country,before))changed.push(country);
 }
 if(!changed.length)fail('no World Polygons display replacements');
 if((reviewed||mapped)&&(skipped.length||current.size!==publication.current.length))
  fail('incomplete reviewed replacements '+JSON.stringify(skipped));
 const encoded=encodeBuiltinCountries(nextIndex,changed,new Map());
 finalizeBuiltinWorldFiles(nextIndex,encoded,{previousIndex:index});
 const files=new Map([...encoded].map(([file,bytes])=>[root+file,bytes]));
 files.set(sourcePath,sourceBytes);
 const changedIds=new Set(changed.map(row=>row.entityId));
 for(const field of ['lifetimes','parentRelations','propertyBindings'])
  if(!equal(index.readIndex.records[field],nextIndex.readIndex.records[field]))fail('World Polygons changed '+field);
 if(!equal(index.entities.filter(row=>!changedIds.has(row.entityId)),nextIndex.entities.filter(row=>!changedIds.has(row.entityId))))
  fail('World Polygons changed an unselected Viewer object');
 return issue({baseline,files,reports:{},plan:{
  current:[...current.keys()],historical:(publication.historical??[]).filter(row=>row.outcome==='candidate'
   &&!skipped.some(s=>s.entityId===row.entityId&&s.versionId===row.versionId)).map(row=>({entityId:row.entityId,versionId:row.versionId})),
  skipped,changed:changed.map(row=>row.entityId),
 }});
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
