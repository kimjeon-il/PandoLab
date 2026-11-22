import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {gunzipSync} from 'node:zlib';
import {coordinateBounds} from '../../src/geometry/coordinate-bounds.js';
import {createBoundarySpatialIndex} from '../../src/geometry/boundary-spatial-index.js';
import {temporalIntervalsOverlap} from '../../src/document/temporal.js';
import {applyPhysicalLandPatch,regionalLandLayout} from '../../src/data/physical-land-patch.js';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {encodeBuiltinCountries,finalizeBuiltinWorldFiles,readBuiltinCountry} from '../data/builtin-country-bytes.mjs';
import {packLibraryGzip} from '../data/library-archive.mjs';
import {createPhysicalLandPatch} from '../data/physical-land-storage.mjs';
import {assertHistoricalCompiledChanges} from '../gis/historical-display-review.mjs';
import {historicalWorldClipper as clip} from '../gis/historical-world-territories.mjs';
import {territorialLifetimeIntervals} from '../gis/territorial-library.js';
import {applyReviewedExteriorArcs,carriesArc,coordinateDigest,createReviewedExteriorLookup,proveUnchangedMergedMembers,
 replaceReviewedDisplayBinding,replaceReviewedViewerBinding,reviewedBorderTouchesNeighbor,reviewedDisplayPeriod} from './reviewed-border-edition.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const geometryHash=g=>coordinateDigest([g.type,g.coordinates]);
const jsonBytes=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const parts=g=>g.type==='Polygon'?[g.coordinates]:g.coordinates;
const overlaps=(a,b)=>a[0]<=b[2]&&b[0]<=a[2]&&a[1]<=b[3]&&b[1]<=a[3];
const fail=reason=>{throw Error('Reviewed coastline: '+reason);};
const issued=new WeakMap();

const exteriorBounds=new WeakMap();
function polygonBounds(polygon){
 let bounds=exteriorBounds.get(polygon);
 if(!bounds){bounds=coordinateBounds(polygon[0]);exteriorBounds.set(polygon,bounds);}
 return bounds;
}

function indexExterior(geometry,changes){
 const locate=createReviewedExteriorLookup(geometry,changes.flatMap(({after})=>[after[0],after.at(-1)]));
 const footprints=changes.map(({after})=>coordinateBounds(after));
 const blocks=[],boxes=[];
 for(const polygon of parts(geometry)){
  const bounds=polygonBounds(polygon);
  if(!footprints.some(footprint=>overlaps(footprint,bounds)))continue;
  for(const ring of polygon)for(let start=0;start<ring.length-1;start+=32){
   const end=Math.min(start+32,ring.length-1);
   const box=coordinateBounds(ring.slice(start,end+1));
   if(!footprints.some(footprint=>overlaps(footprint,box)))continue;
   blocks.push({ring,start,end,bounds});boxes.push(box);
  }
 }
 const index=createBoundarySpatialIndex();
 index.loadPacked(blocks,boxes);
 return {locate,query:footprint=>index.query(footprint)};
}

function validateExterior(geometry,index,arc){
 const [match]=[...index.locate(arc),...index.locate(arc.toReversed())];
 if(!match)fail('corrected exterior missing');
 const polygons=parts(geometry),target=polygons[match.polygonIndex][0],period=target.length-1;
 const edges=new Set(Array.from({length:arc.length-1},(_,i)=>(match.startIndex+i)%period));
 const footprint=coordinateBounds(arc);
 const pairs=[];
 for(const {ring,start,end,bounds:polygonExtent} of index.query(footprint)){
  if(!overlaps(footprint,polygonExtent))continue;
  for(let i=start;i<end;i++){
   const ends=[ring[i],ring[i+1]],bounds=coordinateBounds(ends);
   if(overlaps(footprint,bounds))pairs.push({ring,i,ends,bounds});
  }
 }
 const side=([ax,ay],[bx,by],[x,y])=>Math.sign((bx-ax)*(y-ay)-(by-ay)*(x-ax));
 for(const edge of edges){
  const a=target[edge],b=target[edge+1],bounds=coordinateBounds([a,b]);
  for(const {ring,i,ends:[c,d],bounds:peerBounds} of pairs){
   if(ring===target&&i===edge||!overlaps(bounds,peerBounds))continue;
   const x=side(a,b,c),y=side(a,b,d),z=side(c,d,a),w=side(c,d,b);
   if(x*y>0||z*w>0)continue;
   if(ring===target&&((edge+1)%period===i||(i+1)%period===edge)){
    if(x||y||z||w)continue;
    // Consecutive collinear segments are allowed only in the same direction.
    if((b[0]-a[0])*(d[0]-c[0])+(b[1]-a[1])*(d[1]-c[1])>0)continue;
   }
   fail('corrected exterior crosses or contacts another edge');
  }
 }
}

export function validateReviewedPhysicalCoast(geometry,sections){
 const index=indexExterior(geometry,sections),failures=[];
 for(const [position,section] of sections.entries()){
  try{validateExterior(geometry,index,section.after);}
  catch(cause){failures.push(new Error(`Reviewed coastline section ${position} (${section.entityId}) physical exterior failed`,{cause}));}
 }
 if(failures.length)throw new AggregateError(failures,'Reviewed coastline physical exterior validation failed');
}

function windowed(geometry,bounds,window){
 const candidates=parts(geometry).filter(polygon=>overlaps(bounds,polygonBounds(polygon)));
 return candidates.length?clip.intersection(candidates,window):[];
}

function coastlineChanges(territory,land,section){
 const [w,s,e,n]=coordinateBounds([section.before,section.after]);
 const bounds=[w,s,e,n];
 if(w===-180||e===180||e-w>=180||s===-90||n===90)fail('section touches a projection seam');
 const window=[[[[w-.001,s-.001],[e+.001,s-.001],[e+.001,n+.001],[w-.001,n+.001],[w-.001,s-.001]]]];
 const padded=coordinateBounds(window);
 const [before,after]=territory.map(g=>windowed(g,padded,window));
 const [landBefore,landAfter]=land.map(g=>windowed(g,padded,window));
 for(const [oldSide,newSide,oldLand,newLand] of [[before,after,landBefore,landAfter],[after,before,landAfter,landBefore]]){
  const a=clip.difference(oldSide,newSide),b=clip.difference(oldLand,newLand);
  if((a.length||b.length)&&(!a.length||!b.length||clip.xor(a,b).length))fail('territorial and physical land deltas differ');
 }
 if(!clip.xor(before,after).length)fail('section has no area change');
 return {bounds,before:[before],after:[after]};
}

export function buildReviewedCoastEdition({baseline,entityIds,receipt,readBaseline,readEvidence,sourceRoot,sourceIndexPath,builtinIndexPath,physicalPath,policyPath}){
 const reports={};
 const archived=ref=>{
  if(!ref||!/^reports\/borders\/validation\/(?:[\w.-]+\/)*[\w.-]+$/.test(ref.reference)
    ||ref.reference.split('/').some(p=>p==='.'||p==='..')||!/^[a-f0-9]{64}$/.test(ref.sha256||''))fail('invalid archived review reference');
  const bytes=readEvidence(ref.reference);
  if(!Buffer.isBuffer(bytes)||hash(bytes)!==ref.sha256)fail('review bytes differ '+ref.reference);
  reports[ref.reference]=ref.sha256;
  return bytes;
 };
 const input=JSON.parse(archived(receipt));
 const selected=[...entityIds].sort();
 if(input.schemaVersion!==1||input.kind!=='reviewed-coastline'||input.baseline!==baseline
  ||!selected.length||new Set(selected).size!==selected.length||!selected.every(id=>/^state:[A-Z]{3}$/.test(id))
  ||!equal(input.entities.map(row=>row.entityId),selected)||!input.sections?.length
  ||input.sections.some(row=>!selected.includes(row.entityId))||!selected.every(id=>input.sections.some(row=>row.entityId===id))
  ||input.displayValidFrom!=='2026-11-01')fail('reviewed revision, date or country scope differs');
 archived(input.visual);
 if(input.screening)archived(input.screening);
 const donor=JSON.parse(archived(input.source));
 if(donor.type!=='FeatureCollection'||!Array.isArray(donor.features)||typeof donor.provenance?.publication!=='string'
  ||!/^https:\/\//.test(donor.provenance.publication)||!/^\w/.test(donor.provenance.layer||'')
  ||!/^[a-f0-9]{64}$/.test(donor.provenance.originalSha256||''))fail('genuine source edition and lineage required');
 const lines=new Map(donor.features.map(row=>[row.id,row.geometry]));
 if(lines.size!==donor.features.length)fail('duplicate shoreline source ID');
 const sections=input.sections.map(({entityId,before,beforeSha256,after,lineId,part,indexes})=>{
  const geometry=lines.get(lineId),raw=geometry?.type==='LineString'&&part===0?geometry.coordinates:
   geometry?.type==='MultiLineString'?geometry.coordinates[part]:null;
  if(!raw||!Array.isArray(indexes)||indexes.length<2||indexes.some(i=>!Number.isInteger(i)||i<0||i>=raw.length))fail('archived source line or vertex missing');
  const direction=Math.sign(indexes[1]-indexes[0]);
  if(!direction||indexes.some((i,j)=>j&&Math.sign(i-indexes[j-1])!==direction)
    ||!carriesArc({before,after},indexes.map(i=>raw[i])))fail('corrected arc differs from the reviewed source');
  return {entityId,before,beforeSha256,after};
 });

 const json=p=>JSON.parse(readBaseline(p));
 const sourceIndex=json(sourceIndexPath),index=json(builtinIndexPath),policy=json(policyPath),physical=json(physicalPath);
 if(index.inputHashes.policy!==coordinateDigest(policy))fail('reviewed historical policy differs');
 const root=builtinIndexPath.slice(0,builtinIndexPath.lastIndexOf('/')+1);
 const readRaw=id=>decodeTerritorialSource(json(sourceRoot+'/countries/'+id.replace(':','-')+'.json'),p=>readBaseline(sourceRoot+'/'+p));
 const readCountry=id=>{
  const row=index.entities.find(entry=>entry.entityId===id);
  if(!row)fail('missing Viewer country '+id);
  return readBuiltinCountry(row,index,p=>readBaseline(root+p));
 };
 const owners=input.entities.map(({entityId,displayBefore})=>{
  const source=readRaw(entityId),owner=source.sourceInfo.featureId;
  const identity=index.sourceIdentities.find(row=>row.projectEntityId===owner&&row.sourceEntityIds.includes(entityId));
  const country=readCountry(owner),selection=sourceIndex.views[0].selections.find(row=>row.entityId===entityId);
  const version=source.geometryVersions.find(row=>row.versionId===selection?.geometryVersionId&&row.validTo===null);
  const bindings=country.sourceBindings.filter(row=>row.sourceVersionId===version?.versionId&&row.validTo===null);
  const [entry]=bindings;
  const geometry=country.geometries.find(row=>equal({id:row.id,version:row.version},entry?.geometryRef));
  if(!identity||!version||bindings.length!==1||!Object.hasOwn(entry,'validFrom')||!geometry||geometryHash(geometry.geojson)!==displayBefore)
   fail('current Viewer preimage differs '+entityId);
  return {source,identity,country,version,entry,geometry};
 });
 const ids=owners.map(({country})=>country.entityId);
 if(new Set(ids).size!==owners.length)fail('each selected entity needs a distinct Viewer owner');
 const {validFrom,validTo,previousDisplayThrough}=reviewedDisplayPeriod(owners.map(o=>o.entry),owners.map(o=>o.version),input);
 const binding={validFrom,validTo};
 const related=rule=>temporalIntervalsOverlap(rule,binding);
 if(policy.replacements.some(row=>related(row)&&[row.targetEntityId,row.priorityEntityId].some(id=>selected.includes(id)))
   ||(policy.parentRelations||[]).some(row=>related(row)&&[row.entityId,row.parentEntityId].some(id=>selected.includes(id)))
   ||owners.some(({country})=>country.timelineRecords.parentRelations.some(row=>row.parentId&&related(row))))fail('selected entity has a current territorial dependency');

 const readLand=spec=>{
  const bytes=readBaseline(spec.url);
  if(bytes.length!==spec.compressedBytes||hash(bytes)!==spec.sha256)fail('land transfer differs '+spec.url);
  const decoded=spec.encoding==='gzip'?gunzipSync(bytes,{maxOutputLength:spec.decodedBytes+1}):bytes;
  if(decoded.length!==spec.decodedBytes)fail('decoded land size differs');
  return JSON.parse(decoded);
 };
 const base=readLand(physical.asset),prior=physical.modernCoast;
 if(prior&&(prior.validFrom!==validFrom||prior.asset.storageLayout!==regionalLandLayout||!equal(prior.asset.base,physical.asset)))
  fail('prior physical coastline has a different baseline or date');
 const physicalBefore=prior?applyPhysicalLandPatch(base,readLand(prior.asset.replacement)):base;
 if(geometryHash(physicalBefore)!==input.physicalBefore)fail('physical land preimage differs');
 const physicalAfter=applyReviewedExteriorArcs(physicalBefore,sections);
 validateReviewedPhysicalCoast(physicalAfter,sections);
 const affected=[],dependencies=[];

 const countries=owners.map(({source,identity,country,version,entry,geometry})=>{
  const changes=sections.filter(row=>row.entityId===source.entityId);
  dependencies.push(...proveUnchangedMergedMembers(identity,source,binding,changes,readRaw));
  const display=applyReviewedExteriorArcs(geometry.geojson,changes);
  const displayIndex=indexExterior(display,changes);
  for(const change of changes){
   try{
    validateExterior(display,displayIndex,change.after);
    affected.push({entityId:source.entityId,...coastlineChanges([geometry.geojson,display],[physicalBefore,physicalAfter],change)});
   }catch(cause){throw new Error(`Reviewed coastline section ${sections.indexOf(change)} (${source.entityId}) display validation failed`,{cause});}
  }
  const next=structuredClone(country),ref={id:'historical-world:'+coordinateDigest(display),version:1};
  next.sourceBindings=replaceReviewedDisplayBinding(next.sourceBindings,entry,ref,binding,previousDisplayThrough);
  next.timelineRecords.geometryBindings=replaceReviewedViewerBinding(next.timelineRecords.geometryBindings,entry,ref,binding,previousDisplayThrough);
  next.geometries.push({...ref,geojson:display});
  if(![...next.sourceBindings,...next.timelineRecords.geometryBindings].some(row=>equal(row.geometryRef,entry.geometryRef)))
   next.geometries=next.geometries.filter(row=>row.id!==entry.geometryRef.id||row.version!==entry.geometryRef.version);
  const descriptor=json(sourceRoot+'/countries/'+source.entityId.replace(':','-')+'.json');
  const raw=descriptor.geometryVersions.find(row=>row.versionId===version.versionId).geometryResource;
  const master={reference:sourceRoot+'/'+raw.file,sha256:raw.sha256};
  if(hash(readBaseline(master.reference))!==master.sha256)fail('raw territorial source differs '+source.entityId);
  const meta=next.identity.properties.metadata.historicalTimeline.geometryVersions.find(row=>row.versionId===version.versionId);
  const existing=meta.historicalProvenance?.displayDetailReview;
  const review={schemaVersion:1,status:'passed',entityId:country.entityId,versionId:version.versionId,validFrom,validTo,
   geometrySha256:geometryHash(display),master,source:input.source,visual:input.visual,
   comparison:{reference:receipt,arcSha256:coordinateDigest(changes.map(c=>c.after)),extent:coordinateBounds(changes.map(c=>c.after)),
    scaleDenominator:10000000,projection:{definition:'+proj=aeqd +ellps=WGS84 +units=m',units:'metre',evidence:input.visual}},
   method:'reviewed-display-generalization',reason:'Matched route between fixed coastal anchors in both Viewer layers.',
   parameters:{reviewedSectionCount:changes.length},topology:{status:'passed',evidence:receipt,
    checks:['validity','shared-boundary','union','gaps-overlaps','connectivity','holes-islands','dates']},
   counterpartVersions:[],noSharedBoundaryReason:'Only a common exterior land and sea interface changed.',
   fixedAnchors:changes.flatMap(({before})=>[before[0],before.at(-1)])};
  meta.historicalProvenance={...meta.historicalProvenance,displayDetailReview:existing?
   {...existing,compiledDerivatives:[...(existing.compiledDerivatives||[]),review]}:review};
  assertHistoricalCompiledChanges(next,country);
  return next;
 });
 for(const {source,geometry} of owners)if(reviewedBorderTouchesNeighbor(geometry.geojson,affected.filter(row=>row.entityId!==source.entityId)))
  fail('another selected country intersects the changed area '+source.entityId);
 for(const row of sourceIndex.entities){
  if(selected.includes(row.entityId)||!affected.some(({bounds})=>overlaps(bounds,row.bbox))
   ||!territorialLifetimeIntervals(row.lifetime).some(related))continue;
  const identity=index.sourceIdentities.find(entry=>entry.sourceEntityIds.includes(row.entityId));
  if(!identity||ids.includes(identity.projectEntityId))continue;
  const country=readCountry(identity.projectEntityId);
  for(const entry of country.sourceBindings.filter(related)){
   const geometry=country.geometries.find(g=>equal({id:g.id,version:g.version},entry.geometryRef));
   if(!geometry||reviewedBorderTouchesNeighbor(geometry.geojson,affected))fail('display neighbor affected '+row.entityId);
  }
  dependencies.push({id:row.entityId,reason:'disjoint from the changed area'});
 }

 const catalog=structuredClone(index),encoded=encodeBuiltinCountries(catalog,countries,new Map());
 finalizeBuiltinWorldFiles(catalog,encoded,{previousIndex:index});
 const other=rows=>rows.filter(row=>!ids.includes(row.entityId));
 if(!equal(other(catalog.entities),other(index.entities)))fail('an unselected Viewer descriptor changed');
 for(const [table,rows] of Object.entries(index.readIndex.records)){
  if(!Array.isArray(rows))continue;
  const retained=records=>records.filter(row=>!ids.includes(row.objectRef.id));
  if(!equal(retained(rows),retained(catalog.readIndex.records[table])))fail('an unselected Viewer interval changed '+table);
 }
 const files=new Map([...encoded].map(([file,bytes])=>[root+file,bytes]));
 const patch=createPhysicalLandPatch(base,physicalAfter,binding);
 const decoded=Buffer.from(JSON.stringify(patch)+'\n'),stored=packLibraryGzip(decoded),sha256=hash(stored);
 const url=physicalPath.slice(0,physicalPath.lastIndexOf('/')+1)+'replacements/sha256-'+sha256+'.json.gz';
 const replacement={url,encoding:'gzip',sha256,compressedBytes:stored.length,decodedBytes:decoded.length};
 physical.modernCoast={validFrom,asset:{...replacement,storageLayout:regionalLandLayout,base:physical.asset,replacement,
  contentSha256:patch.resultContentSha256}};
 files.set(url,stored);
 files.set(physicalPath,jsonBytes(physical));
 const result={baseline,files,reports,plan:{entities:selected,binding,dependencies,sections:sections.length,writes:[...files.keys()].sort()}};
 issued.set(result,{baseline,reports:{...reports},files:new Map([...files].map(([p,b])=>[p,hash(b)]))});
 return result;
}

export function assertReviewedCoastEdition(result){
 const proof=issued.get(result);
 if(!proof||proof.baseline!==result.baseline||!equal(proof.reports,result.reports)||proof.files.size!==result.files.size)
  fail('unissued or modified edition');
 for(const [path,bytes] of result.files)if(!Buffer.isBuffer(bytes)||proof.files.get(path)!==hash(bytes))fail('edition bytes changed '+path);
}
