import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {gunzipSync} from 'node:zlib';
import {coordinateBounds} from '../../src/geometry/coordinate-bounds.js';
import {createBoundarySpatialIndex} from '../../src/geometry/boundary-spatial-index.js';
import {temporalIntervalsOverlap} from '../../src/document/temporal.js';
import {builtinCountryFileSpecs,builtinGeometryAssets} from '../../src/data/builtin-country-files.js';
import {applyPhysicalLandPatch,regionalLandLayout} from '../../src/data/physical-land-patch.js';
import {decodeTerritorialSource} from '../data/territorial-source-codec.mjs';
import {encodeBuiltinCountries,finalizeBuiltinWorldFiles,readBuiltinCountry} from '../data/builtin-country-bytes.mjs';
import {packLibraryGzip} from '../data/library-archive.mjs';
import {createPhysicalLandPatch} from '../data/physical-land-storage.mjs';
import {assertHistoricalCompiledChanges} from '../gis/historical-display-review.mjs';
import {historicalWorldClipper as clip} from '../gis/historical-world-territories.mjs';
import {territorialLifetimeIntervals} from '../gis/territorial-library.js';
import {applyReviewedExteriorArcs,coordinateDigest,createReviewedExteriorLookup,proveUnchangedMergedMembers,
 replaceReviewedDisplayBinding,replaceReviewedViewerBinding,reviewedBorderTouchesNeighbor,reviewedDisplayPeriod} from './reviewed-border-edition.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const geometryHash=g=>coordinateDigest([g.type,g.coordinates]);
const jsonBytes=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const parts=g=>g.type==='Polygon'?[g.coordinates]:g.coordinates;
const overlaps=(a,b)=>a[0]<=b[2]&&b[0]<=a[2]&&a[1]<=b[3]&&b[1]<=a[3];
const fail=reason=>{throw Error('Reviewed coastline: '+reason);};
const issued=new WeakMap();

export function moveReviewedCoastVertices(before,source,stationing){
 const isPoint=point=>Array.isArray(point)&&point.length===2&&point.every(Number.isFinite)
  &&Math.abs(point[0])<=180&&Math.abs(point[1])<=90;
 if(!Array.isArray(before)||before.length<3||!before.every(isPoint))fail('no movable coastline vertices');
 if(!Array.isArray(source)||source.length<2||!source.every(isPoint))fail('invalid shoreline source coordinates');
 if(stationing!==undefined&&!['between-projections','ordered-projections'].includes(stationing))fail('unknown shoreline stationing');
 const latitude=(before[0][1]+before.at(-1)[1])/2;
 const longitudeScale=Math.cos(latitude*Math.PI/180);
 const segments=source.slice(0,-1).map(([x,y],index)=>{
  const [nextX,nextY]=source[index+1],dx=(nextX-x)*longitudeScale,dy=nextY-y;
  if(Math.abs(nextX-x)>=180)fail('shoreline source crosses a projection seam');
  return {index,x,y,dx,dy,lengthSquared:dx*dx+dy*dy};
 }).filter(segment=>segment.lengthSquared>0);
 if(!segments.length)fail('empty shoreline source');
 const pointOnSegment=(index,fraction)=>{
  const [x,y]=source[index],next=source[index+1];
  return fraction===0?source[index]:fraction===1?next:[x+fraction*(next[0]-x),y+fraction*(next[1]-y)];
 };
 const closed=equal(before[0],before.at(-1));
 if(closed&&(!equal(source[0],source.at(-1))||stationing!==undefined))fail('full exterior requires a closed shoreline source');
 if(stationing==='ordered-projections')return orderedSourceProjections(before,segments,longitudeScale,pointOnSegment);
 // A source endpoint bounds the nearest possible distance. All segments
 // closer than that endpoint must intersect this projected search box.
 const spatial=segments.length*before.length>250000?createBoundarySpatialIndex():null;
 if(spatial)spatial.loadPacked(segments,segments.map(({index})=>coordinateBounds([source[index],source[index+1]])));
 let lastNearest=segments[0].index;
 const interior=(closed?before.slice(0,-1):before.slice(1,-1)).map(([lon,lat])=>{
  let candidates=segments;
  if(spatial&&Math.abs(longitudeScale)>1e-8){
   const [x,y]=source[lastNearest];
   const radius=Math.hypot((lon-x)*longitudeScale,lat-y)+1e-10,rx=radius/Math.abs(longitudeScale);
   candidates=spatial.query([lon-rx,lat-radius,lon+rx,lat+radius]);
  }
  let bestDistance=Infinity,bestPosition=-1,bestPoint,bestSegment=Infinity;
  for(const {index,x,y,dx,dy,lengthSquared} of candidates){
   const px=(lon-x)*longitudeScale,py=lat-y;
   const fraction=Math.max(0,Math.min(1,(px*dx+py*dy)/lengthSquared));
   const distance=(px-fraction*dx)**2+(py-fraction*dy)**2;
   if(distance>bestDistance||(distance===bestDistance&&index>=bestSegment))continue;
   bestSegment=index;
   bestDistance=distance;
   bestPosition=index+fraction;
   bestPoint=pointOnSegment(index,fraction);
  }
  lastNearest=bestSegment;
  return {position:bestPosition,point:bestPoint};
 });
 if(closed){
  const period=source.length-1;
  const locations=interior.map(({position})=>position%period);
  const moved=interior.map(({point})=>point);
  const descents=locations.filter((value,i)=>value<locations[(i+locations.length-1)%locations.length]).length;
  if(moved.length<3||new Set(moved.map(p=>p.join(','))).size!==moved.length||descents!==1)
   fail('closed shoreline projections do not preserve vertex order');
  return [...moved,moved[0]];
 }
 for(const [i,{position,point}] of interior.entries()){
  const previous=i?interior[i-1].position:-1;
  if(position<previous||(!stationing&&(position===previous||equal(point,before[0])||equal(point,before.at(-1)))))
   fail('shoreline projections do not preserve vertex order');
 }
 if(stationing)spreadCoincidentProjections(interior,before,source,longitudeScale,pointOnSegment);
 return [before[0],...interior.map(row=>row.point),before.at(-1)];
}

function orderedSourceProjections(before,segments,longitudeScale,pointOnSegment){
 let total=0;
 const source=segments.map(segment=>{
  const length=Math.sqrt(segment.lengthSquared),start=total;
  total+=length;
  return {...segment,start,length};
 });
 const intervals=before.length-1,divisions=Math.max(24,intervals*16);
 const gap=total/divisions;
 // Include positions between surveyed vertices so rounding to source nodes
 // cannot force two existing vertices onto the same position.
 let at=0;
 const grid=Array.from({length:divisions-1},(_,i)=>{
  const station=total*(i+1)/divisions;
  while(source[at].start+source[at].length<station)at++;
  const segment=source[at];
  return {station,point:pointOnSegment(segment.index,(station-segment.start)/segment.length)};
 });
 let previous=[{station:0,cost:0}];
 for(const [lon,lat] of before.slice(1,-1)){
  const projected=source.map(({index,x,y,dx,dy,lengthSquared,start,length})=>{
   const fraction=Math.max(0,Math.min(1,((lon-x)*longitudeScale*dx+(lat-y)*dy)/lengthSquared));
   return {station:start+fraction*length,point:pointOnSegment(index,fraction)};
  });
  const options=[...grid,...projected].sort((a,b)=>a.station-b.station),next=[];
  let cursor=0,best=null;
  for(const {station,point} of options){
   if(station>total-gap*.999999)break;
   while(cursor<previous.length&&previous[cursor].station<=station-gap*.999999){
    const candidate=previous[cursor++];
    if(!best||candidate.cost<best.cost)best=candidate;
   }
   if(!best||equal(point,before[0])||equal(point,before.at(-1)))continue;
   const offset=((point[0]-lon)*longitudeScale)**2+(point[1]-lat)**2;
   next.push({station,point,cost:best.cost+offset,previous:best});
  }
  if(!next.length)fail('no ordered shoreline projections for existing vertices');
  previous=next;
 }
 let result=previous.reduce((best,row)=>row.cost<best.cost?row:best);
 const after=before.slice();
 for(let i=after.length-2;i>0;i--){after[i]=result.point;result=result.previous;}
 if(new Set(after.map(point=>point.join(','))).size!==after.length)fail('shoreline projections do not preserve vertex order');
 return after;
}

function spreadCoincidentProjections(interior,before,source,longitudeScale,pointOnSegment){
 const distances=points=>points.reduce((result,[x,y],i)=>{
  if(i)result.push(result[i-1]+Math.hypot((x-points[i-1][0])*longitudeScale,y-points[i-1][1]));
  return result;
 },[0]);
 const donor=distances(source),original=distances(before);
 const stations=interior.map(({position})=>{
  const index=Math.floor(position);
  return position===index?donor[index]:donor[index]+(position-index)*(donor[index+1]-donor[index]);
 });
 for(let first=0;first<interior.length;){
  let past=first+1;
  while(stations[past]===stations[first])past++;
  const station=stations[first];
  if(past-first>1||equal(interior[first].point,before[0])||equal(interior[first].point,before.at(-1))){
   const low=first?(stations[first-1]+station)/2:0;
   const high=past<stations.length?(station+stations[past])/2:donor.at(-1);
   const originalSpan=original[past+1]-original[first];
   if(!(high>low&&originalSpan>0))fail('shoreline projections do not preserve vertex order');
   for(let i=first;i<past;i++){
    const length=low+(high-low)*(original[i+1]-original[first])/originalSpan;
    const stop=donor.findIndex(value=>value>length);
    if(stop<1||length<=low||length>=high)fail('shoreline projections do not preserve vertex order');
    interior[i].point=pointOnSegment(stop-1,(length-donor[stop-1])/(donor[stop]-donor[stop-1]));
   }
  }
  first=past;
 }
 const result=[before[0],...interior.map(row=>row.point),before.at(-1)];
 if(new Set(result.map(point=>point.join(','))).size!==result.length)fail('shoreline projections do not preserve vertex order');
}

const exteriorBounds=new WeakMap();
function polygonBounds(polygon){
 let bounds=exteriorBounds.get(polygon);
 if(!bounds){bounds=coordinateBounds(polygon[0]);exteriorBounds.set(polygon,bounds);}
 return bounds;
}

export function reviewedCoastComponents(sections){
 const bounds=sections.map(({before,after})=>{
  const [w,s,e,n]=coordinateBounds([before,after]);
  return [w-.001,s-.001,e+.001,n+.001];
 });
 const index=createBoundarySpatialIndex();
 index.loadPacked(sections.map((_,i)=>i),bounds);
 const visited=new Set(),groups=[];
 for(const i of sections.keys()){
  if(visited.has(i))continue;
  const component=[i];
  visited.add(i);
  for(const j of component)for(const peer of index.query(bounds[j])){
   if(visited.has(peer))continue;
   visited.add(peer);
   component.push(peer);
  }
  groups.push(component.sort((a,b)=>a-b));
 }
 return groups;
}

function indexExterior(geometry,changes,baseline){
 const locate=createReviewedExteriorLookup(geometry,changes.flatMap(({after})=>[after[0],after.at(-1)]));
 const footprints=changes.map(({after})=>coordinateBounds(after));
 const blocks=[],boxes=[];
 for(const [polygonIndex,polygon] of parts(geometry).entries()){
  const bounds=polygonBounds(polygon);
  if(!footprints.some(footprint=>overlaps(footprint,bounds)))continue;
  for(const [ringIndex,ring] of polygon.entries())for(let start=0;start<ring.length-1;start+=32){
   const end=Math.min(start+32,ring.length-1);
   const box=coordinateBounds(ring.slice(start,end+1));
   if(!footprints.some(footprint=>overlaps(footprint,box)))continue;
   blocks.push({polygonIndex,ringIndex,ring,start,end,bounds});boxes.push(box);
  }
 }
 const index=createBoundarySpatialIndex();
 index.loadPacked(blocks,boxes);
 return {locate,baseline:baseline&&parts(baseline),query:footprint=>index.query(footprint)};
}

function preservesExteriorJunction(target,edge,peer,i,oldTarget,oldPeer){
 const at=equal(target[edge],peer[i])||equal(target[edge],peer[i+1])?edge:edge+1;
 const point=target[at];
 const other=equal(point,peer[i])?i:i+1;
 if(!equal(point,peer[other])||!equal(point,oldTarget[at])||!equal(point,oldPeer[other]))return false;
 const rays=(ring,slot)=>{
  const period=ring.length-1;
  return [ring[(slot+period-1)%period],ring[(slot+1)%period]];
 };
 // Preserve the cyclic order of the four incident edges at the existing point.
 const oldRays=[...rays(oldTarget,at),...rays(oldPeer,other)];
 const newRays=[...rays(target,at),...rays(peer,other)];
 const order=incident=>{
  const angles=incident.map(([x,y])=>{
   const angle=Math.atan2(y-point[1],x-point[0]);
   return angle<0?angle+2*Math.PI:angle;
  });
  const groups=[...Map.groupBy(angles.map((_,i)=>i),i=>angles[i]).entries()]
   .sort(([a],[b])=>a-b).map(([,group])=>group);
  const start=groups.findIndex(group=>group.includes(0));
  return [...groups.slice(start),...groups.slice(0,start)];
 };
 const before=order(oldRays);
 return equal(before,order(newRays))&&before.every(group=>group.length===1||
  group.every(i=>equal(oldRays[i],newRays[i])));
}

function validateExterior(geometry,index,arc){
 const [match]=[...index.locate(arc),...index.locate(arc.toReversed())];
 if(!match)fail('corrected exterior missing');
 const polygons=parts(geometry),target=polygons[match.polygonIndex][0],period=target.length-1;
 const edges=new Set(Array.from({length:arc.length-1},(_,i)=>(match.startIndex+i)%period));
 const footprint=coordinateBounds(arc);
 const pairs=[];
 for(const {polygonIndex,ringIndex,ring,start,end,bounds:polygonExtent} of index.query(footprint)){
  if(!overlaps(footprint,polygonExtent))continue;
  for(let i=start;i<end;i++){
   const ends=[ring[i],ring[i+1]],bounds=coordinateBounds(ends);
   if(overlaps(footprint,bounds))pairs.push({polygonIndex,ringIndex,ring,i,ends,bounds});
  }
 }
 const side=([ax,ay],[bx,by],[x,y])=>Math.sign((bx-ax)*(y-ay)-(by-ay)*(x-ax));
 for(const edge of edges){
  const a=target[edge],b=target[edge+1],bounds=coordinateBounds([a,b]);
  for(const {polygonIndex,ringIndex,ring,i,ends:[c,d],bounds:peerBounds} of pairs){
   if(ring===target&&i===edge||!overlaps(bounds,peerBounds))continue;
   const x=side(a,b,c),y=side(a,b,d),z=side(c,d,a),w=side(c,d,b);
   if(x*y>0||z*w>0)continue;
   if(ring===target&&((edge+1)%period===i||(i+1)%period===edge)){
    if(x||y||z||w)continue;
    // Consecutive collinear segments are allowed only in the same direction.
    if((b[0]-a[0])*(d[0]-c[0])+(b[1]-a[1])*(d[1]-c[1])>0)continue;
   }
   if((x||y||z||w)&&index.baseline&&ringIndex===0&&polygonIndex!==match.polygonIndex&&
    preservesExteriorJunction(target,edge,ring,i,index.baseline[match.polygonIndex][0],index.baseline[polygonIndex][0]))continue;
   const error=new Error('Reviewed coastline: corrected exterior crosses or contacts another edge');
   error.contact={edge:[a,b],peer:[c,d],polygon:match.polygonIndex,edgeIndex:edge,peerPolygon:polygonIndex,peerRing:ringIndex,peerEdge:i};
   throw error;
  }
 }
}

function geometryFailure(position,section,phase,cause){
 const error=new Error(`Reviewed coastline section ${position} (${section.entityId}) ${phase} failed`,{cause});
 Object.assign(error,{sectionIndex:position,sectionId:section.originalSection,entityId:section.entityId,phase});
 return error;
}

function raiseGeometryFailures(failures,components){
 if(!failures.length)return;
 const error=new AggregateError(failures,'Reviewed coastline batch geometry validation failed');
 error.code='REVIEWED_COAST_GEOMETRY';
 error.components=components;
 throw error;
}

export function validateReviewedPhysicalCoast(geometry,sections,baseline){
 const index=indexExterior(geometry,sections,baseline),failures=[];
 for(const [position,section] of sections.entries()){
  try{validateExterior(geometry,index,section.after);}
  catch(cause){failures.push(geometryFailure(position,section,'physical exterior',cause));}
 }
 if(failures.length)throw new AggregateError(failures,'Reviewed coastline physical exterior validation failed');
}

export function inspectReviewedCoastExteriors(physicalBefore,territories,sections){
 const physicalAfter=applyReviewedExteriorArcs(physicalBefore,sections);
 const positions=new Map(sections.map((change,i)=>[change,i]));
 const displays=new Map([...Map.groupBy(sections,change=>change.entityId)].map(([id,changes])=>{
  const before=territories.get(id);
  if(!before)fail('missing territorial preimage '+id);
  return [id,{before,after:applyReviewedExteriorArcs(before,changes),changes}];
 }));
 const failures=[];
 try{validateReviewedPhysicalCoast(physicalAfter,sections,physicalBefore);}
 catch(error){if(!(error instanceof AggregateError))throw error;failures.push(...error.errors);}
 for(const {before,after,changes} of displays.values()){
  const displayIndex=indexExterior(after,changes,before);
  for(const change of changes){
   try{validateExterior(after,displayIndex,change.after);}
   catch(cause){failures.push(geometryFailure(positions.get(change),change,'display validation',cause));}
  }
 }
 return {physicalAfter,displays,failures};
}

function windowed(geometry,bounds,window){
 const candidates=parts(geometry).filter(polygon=>overlaps(bounds,polygonBounds(polygon)));
 return candidates.length?clip.intersection(candidates,window):[];
}

function coastlineChanges(territory,land,section,pairedTerritories){
 const [w,s,e,n]=coordinateBounds([section.before,section.after]);
 const bounds=[w,s,e,n];
 if(w===-180||e===180||e-w>=180||s===-90||n===90)fail('section touches a projection seam');
 const window=[[[[w-.001,s-.001],[e+.001,s-.001],[e+.001,n+.001],[w-.001,n+.001],[w-.001,s-.001]]]];
 const padded=coordinateBounds(window);
 const [before,after]=territory.map(g=>windowed(g,padded,window));
 const [allBefore,allAfter]=pairedTerritories.map(g=>windowed(g,padded,window));
 const [landBefore,landAfter]=land.map(g=>windowed(g,padded,window));
 for(const [oldSide,newSide,oldLand,newLand] of [[allBefore,allAfter,landBefore,landAfter],[allAfter,allBefore,landAfter,landBefore]]){
  const a=clip.difference(oldSide,newSide),b=clip.difference(oldLand,newLand);
  if((a.length||b.length)&&(!a.length||!b.length||clip.xor(a,b).length))fail('territorial and physical land deltas differ');
 }
 if(!clip.xor(before,after).length)fail('section has no area change');
 return {bounds,before:[before],after:[after]};
}

export function buildReviewedCoastEdition({baseline,entityIds,receipt,readBaseline,prefetchBaseline=()=>{},readEvidence,sourceRoot,sourceIndexPath,builtinIndexPath,physicalPath,policyPath}){
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
 if(input.schemaVersion!==2||input.kind!=='reviewed-coastline'||input.baseline!==baseline
  ||!selected.length||new Set(selected).size!==selected.length||!selected.every(id=>/^state:[A-Z]{3}$/.test(id))
  ||!equal(input.entities.map(row=>row.entityId),selected)||!input.sections?.length
  ||input.sections.some(row=>!selected.includes(row.entityId))||!selected.every(id=>input.sections.some(row=>row.entityId===id))
  ||input.displayValidFrom!=='2026-11-01')fail('reviewed revision, date or country scope differs');
 archived(input.visual);
 if(input.screening){
  archived(input.screening);
  const {attachments=[]}=input.screening;
  if(!Array.isArray(attachments))fail('invalid screening attachments');
  for(const attachment of attachments)archived(attachment);
 }
 const donor=JSON.parse(archived(input.source));
 if(donor.type!=='FeatureCollection'||!Array.isArray(donor.features)||typeof donor.provenance?.publication!=='string'
  ||!/^https:\/\//.test(donor.provenance.publication)||!/^\w/.test(donor.provenance.layer||'')
  ||!/^[a-f0-9]{64}$/.test(donor.provenance.originalSha256||''))fail('genuine source edition and lineage required');
 const lines=new Map(donor.features.map(row=>[row.id,row.geometry]));
 if(lines.size!==donor.features.length)fail('duplicate shoreline source ID');
 const sections=input.sections.map(({entityId,before,beforeSha256,after,lineId,part,sourceStart,sourceEnd,stationing,originalSection})=>{
  const geometry=lines.get(lineId),raw=geometry?.type==='LineString'&&part===0?geometry.coordinates:
   geometry?.type==='MultiLineString'?geometry.coordinates[part]:null;
  if(!raw||sourceStart===sourceEnd||![sourceStart,sourceEnd].every(i=>Number.isInteger(i)&&i>=0&&i<raw.length))
   fail('archived shoreline range missing');
  const source=sourceStart<sourceEnd?raw.slice(sourceStart,sourceEnd+1):raw.slice(sourceEnd,sourceStart+1).reverse();
  if(!equal(after,moveReviewedCoastVertices(before,source,stationing)))fail('reviewed vertex positions differ from shoreline projections');
  return {entityId,before,beforeSha256,after,originalSection};
 });

 const json=p=>JSON.parse(readBaseline(p));
 prefetchBaseline([sourceIndexPath,builtinIndexPath,policyPath,physicalPath]);
 const sourceIndex=json(sourceIndexPath),index=json(builtinIndexPath),policy=json(policyPath),physical=json(physicalPath);
 if(index.inputHashes.policy!==coordinateDigest(policy))fail('reviewed historical policy differs');
 const root=builtinIndexPath.slice(0,builtinIndexPath.lastIndexOf('/')+1);
 const descriptorPath=id=>sourceRoot+'/countries/'+id.replace(':','-')+'.json';
 const descriptors=new Map(),countriesById=new Map(index.entities.map(row=>[row.entityId,row]));
 const descriptorFor=id=>{
  if(!descriptors.has(id))descriptors.set(id,json(descriptorPath(id)));
  return descriptors.get(id);
 };
 const identities=new Map(index.sourceIdentities.flatMap(row=>row.sourceEntityIds.map(id=>[id,row])));
 const memberIds=[...new Set(selected.flatMap(id=>[id,...(identities.get(id)?.sourceEntityIds??[])]))];
 prefetchBaseline(memberIds.map(descriptorPath));
 const selectedIdentities=new Map(selected.map(id=>{
  const identity=identities.get(id);
  if(!identity||!identity.sourceFeatureIds.includes(descriptorFor(id).sourceInfo.featureId))
   fail('missing reviewed Viewer identity '+id);
  return [id,identity];
 }));
 const countryGeometry=new Map(builtinGeometryAssets(index).map(row=>[JSON.stringify([row.id,row.version]),row.file]));
 const countryPaths=ids=>[...new Set(ids)].flatMap(id=>{
  const row=countriesById.get(id);
  if(!row)fail('missing Viewer country '+id);
  return [...builtinCountryFileSpecs(row).map(item=>item.file),...row.geometryRefs.map(ref=>{
   const file=countryGeometry.get(JSON.stringify([ref.id,ref.version]));
   if(!file)fail('missing Viewer country geometry '+id);
   return file;
  })].map(file=>root+file);
 });
 const prior=physical.modernCoast;
 prefetchBaseline([...memberIds.flatMap(id=>descriptorFor(id).geometryVersions.map(row=>sourceRoot+'/'+row.geometryResource.file)),
  ...countryPaths([...selectedIdentities.values()].map(row=>row.projectEntityId)),physical.asset.url,
  ...(prior?[prior.asset.replacement.url]:[])]);
 const readRaw=id=>decodeTerritorialSource(descriptorFor(id),p=>readBaseline(sourceRoot+'/'+p));
 const readCountries=new Map();
 const readCountry=id=>{
  if(readCountries.has(id))return readCountries.get(id);
  const row=countriesById.get(id);
  if(!row)fail('missing Viewer country '+id);
  const country=readBuiltinCountry(row,index,p=>readBaseline(root+p));
  readCountries.set(id,country);
  return country;
 };
 const owners=input.entities.map(({entityId,displayBefore})=>{
  const source=readRaw(entityId),identity=selectedIdentities.get(entityId);
  const country=readCountry(identity.projectEntityId),selection=sourceIndex.views[0].selections.find(row=>row.entityId===entityId);
  const version=source.geometryVersions.find(row=>row.versionId===selection?.geometryVersionId&&row.validTo===null);
  const bindings=country.sourceBindings.filter(row=>row.sourceVersionId===version?.versionId&&row.validTo===null);
  const [entry]=bindings;
  const geometry=country.geometries.find(row=>equal({id:row.id,version:row.version},entry?.geometryRef));
  if(!identity||!version||bindings.length!==1||!Object.hasOwn(entry,'validFrom')||!geometry||geometryHash(geometry.geojson)!==displayBefore)
   fail('current Viewer preimage differs '+entityId);
  return {source,identity,country,version,entry,geometry};
 });
 const ids=owners.map(({country})=>country.entityId);
 const components=reviewedCoastComponents(sections);
 const positions=new Map(sections.map((change,i)=>[change,i]));
 const componentBySection=new Map(components.flatMap(group=>group.map(i=>[i,group])));
 const changesById=Map.groupBy(sections,change=>change.entityId);
 const failures=[];
 const deferOwner=(id,phase,cause)=>{
  for(const change of changesById.get(id))failures.push(geometryFailure(positions.get(change),change,phase,cause));
 };
 for(const group of Map.groupBy(owners,row=>row.country.entityId).values()){
  if(group.length>1)for(const {source} of group)deferOwner(source.entityId,'ownership validation',
   new Error('Reviewed coastline: selected source entities share one Viewer owner'));
 }
 raiseGeometryFailures(failures,components);
 const {validFrom,validTo,previousDisplayThrough}=reviewedDisplayPeriod(owners.map(o=>o.entry),owners.map(o=>o.version),input);
 const binding={validFrom,validTo};
 const related=rule=>temporalIntervalsOverlap(rule,binding);
 for(const {source} of owners){
  const id=source.entityId;
  if(policy.replacements.some(row=>related(row)&&[row.targetEntityId,row.priorityEntityId].includes(id)))
   deferOwner(id,'ownership validation',new Error('Reviewed coastline: selected entity has a current display replacement '+id));
 }
 raiseGeometryFailures(failures,components);

 const readLand=spec=>{
  const bytes=readBaseline(spec.url);
  if(bytes.length!==spec.compressedBytes||hash(bytes)!==spec.sha256)fail('land transfer differs '+spec.url);
  const decoded=spec.encoding==='gzip'?gunzipSync(bytes,{maxOutputLength:spec.decodedBytes+1}):bytes;
  if(decoded.length!==spec.decodedBytes)fail('decoded land size differs');
  return JSON.parse(decoded);
 };
 const base=readLand(physical.asset);
 if(prior&&(prior.validFrom!==validFrom||prior.asset.storageLayout!==regionalLandLayout||!equal(prior.asset.base,physical.asset)))
  fail('prior physical coastline has a different baseline or date');
 const physicalBefore=prior?applyPhysicalLandPatch(base,readLand(prior.asset.replacement)):base;
 if(geometryHash(physicalBefore)!==input.physicalBefore)fail('physical land preimage differs');
 const beforeByOwner=new Map(owners.map(({source,geometry})=>[source.entityId,geometry.geojson]));
 const {physicalAfter,displays,failures:exteriorFailures}=inspectReviewedCoastExteriors(physicalBefore,beforeByOwner,sections);
 failures.push(...exteriorFailures);
 const invalidComponents=new Set(failures.map(error=>componentBySection.get(error.sectionIndex)));
 const affected=[],dependencies=[];
 for(const component of components){
  if(invalidComponents.has(component))continue;
  const pair=[...new Set(component.map(i=>sections[i].entityId))].map(id=>displays.get(id));
  const coverage=['before','after'].map(side=>({type:'MultiPolygon',coordinates:pair.flatMap(row=>parts(row[side]))}));
  for(const i of component){
   const change=sections[i],{before,after}=displays.get(change.entityId);
   try{affected.push({entityId:change.entityId,sectionIndex:i,...coastlineChanges([before,after],[physicalBefore,physicalAfter],change,coverage)});}
   catch(cause){failures.push(geometryFailure(i,change,'paired land delta',cause));}
  }
 }
 raiseGeometryFailures(failures,components);

 const countries=owners.map(({source,identity,country,version,entry})=>{
  const {after:display,changes}=displays.get(source.entityId);
  try{dependencies.push(...proveUnchangedMergedMembers(identity,source,binding,changes,readRaw));}
  catch(cause){deferOwner(source.entityId,'merged member validation',cause);}
  const next=structuredClone(country),ref={id:'historical-world:'+coordinateDigest(display),version:1};
  next.sourceBindings=replaceReviewedDisplayBinding(next.sourceBindings,entry,ref,binding,previousDisplayThrough);
  next.timelineRecords.geometryBindings=replaceReviewedViewerBinding(next.timelineRecords.geometryBindings,entry,ref,binding,previousDisplayThrough);
  next.geometries.push({...ref,geojson:display});
  if(![...next.sourceBindings,...next.timelineRecords.geometryBindings].some(row=>equal(row.geometryRef,entry.geometryRef)))
   next.geometries=next.geometries.filter(row=>row.id!==entry.geometryRef.id||row.version!==entry.geometryRef.version);
  const descriptor=descriptorFor(source.entityId);
  const raw=descriptor.geometryVersions.find(row=>row.versionId===version.versionId).geometryResource;
  const master={reference:sourceRoot+'/'+raw.file,sha256:raw.sha256};
  if(hash(readBaseline(master.reference))!==master.sha256)fail('raw territorial source differs '+source.entityId);
  const meta=next.identity.properties.metadata.historicalTimeline.geometryVersions.find(row=>row.versionId===version.versionId);
  const existing=meta.historicalProvenance?.displayDetailReview;
  const review={schemaVersion:1,status:'passed',entityId:country.entityId,versionId:version.versionId,validFrom,validTo,
   geometrySha256:geometryHash(display),master,source:input.source,visual:input.visual,
   comparison:{reference:receipt,arcSha256:coordinateDigest(changes.map(c=>c.after)),extent:coordinateBounds(changes.map(c=>c.after)),
    scaleDenominator:10000000,projection:{definition:'+proj=aeqd +ellps=WGS84 +units=m',units:'metre',evidence:input.visual}},
   method:'reviewed-display-generalization',reason:'Moved the existing interior vertices onto the matched shoreline in both Viewer layers.',
   parameters:{reviewedSectionCount:changes.length},topology:{status:'passed',evidence:receipt,
    checks:['validity','shared-boundary','union','gaps-overlaps','connectivity','holes-islands','dates']},
   counterpartVersions:[],noSharedBoundaryReason:'Only a common exterior land and sea interface changed.',
   fixedAnchors:changes.flatMap(({before})=>[before[0],before.at(-1)])};
  meta.historicalProvenance={...meta.historicalProvenance,displayDetailReview:existing?
   {...existing,compiledDerivatives:[...(existing.compiledDerivatives||[]),review]}:review};
  assertHistoricalCompiledChanges(next,country);
  return next;
 });
 raiseGeometryFailures(failures,components);
 const checkNeighbor=(id,geometry,changes)=>{
  if(!reviewedBorderTouchesNeighbor(geometry,changes))return;
  for(const row of changes)if(reviewedBorderTouchesNeighbor(geometry,[row])){
   const cause=new Error('Reviewed coastline: neighbor intersects the changed area '+id);
   cause.contact={entityId:id,bounds:row.bounds};
   failures.push(geometryFailure(row.sectionIndex,sections[row.sectionIndex],'neighbor validation',cause));
  }
 };
 for(const {source} of owners)checkNeighbor(source.entityId,displays.get(source.entityId).after,affected.filter(row=>row.entityId!==source.entityId));
 const neighbors=sourceIndex.entities.filter(row=>!selected.includes(row.entityId)
  &&affected.some(({bounds})=>overlaps(bounds,row.bbox))&&territorialLifetimeIntervals(row.lifetime).some(related));
 const neighborOwners=neighbors.map(({entityId})=>identities.get(entityId)?.projectEntityId).filter(id=>id&&!ids.includes(id));
 prefetchBaseline(countryPaths(neighborOwners));
 for(const row of neighbors){
  const identity=identities.get(row.entityId);
  if(!identity||ids.includes(identity.projectEntityId))continue;
  const country=readCountry(identity.projectEntityId);
  for(const entry of country.sourceBindings.filter(related)){
   const geometry=country.geometries.find(g=>equal({id:g.id,version:g.version},entry.geometryRef));
   if(!geometry)fail('missing display neighbor geometry '+row.entityId);
   checkNeighbor(row.entityId,geometry.geojson,affected);
  }
  dependencies.push({id:row.entityId,reason:'disjoint from the changed area'});
 }
 raiseGeometryFailures(failures,components);

 const catalog=structuredClone(index),encoded=encodeBuiltinCountries(catalog,countries,new Map());
 finalizeBuiltinWorldFiles(catalog,encoded,{previousIndex:index});
 if(!equal(catalog.readIndex.records.parentRelations,index.readIndex.records.parentRelations))
  fail('a Viewer territorial parent relation changed');
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
 const result={baseline,files,reports,plan:{entities:selected,binding,dependencies,sections:sections.length,components,writes:[...files.keys()].sort()}};
 issued.set(result,{baseline,reports:{...reports},files:new Map([...files].map(([p,b])=>[p,hash(b)]))});
 return result;
}

export function assertReviewedCoastEdition(result){
 const proof=issued.get(result);
 if(!proof||proof.baseline!==result.baseline||!equal(proof.reports,result.reports)||proof.files.size!==result.files.size)
  fail('unissued or modified edition');
 for(const [path,bytes] of result.files)if(!Buffer.isBuffer(bytes)||proof.files.get(path)!==hash(bytes))fail('edition bytes changed '+path);
}
