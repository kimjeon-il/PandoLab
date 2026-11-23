import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {builtinCountryFileSpecs,builtinGeometryAssets} from '../../src/data/builtin-country-files.js';
import {applyPhysicalLandPatch,regionalLandLayout} from '../../src/data/physical-land-patch.js';
import {coordinateBounds} from '../../src/geometry/coordinate-bounds.js';
import {replaceReviewedDisplayBinding,replaceReviewedViewerBinding} from '../build/reviewed-border-edition.mjs';
import {assertHistoricalCompiledChanges} from '../gis/historical-display-review.mjs';
import {readBuiltinCountry,encodeBuiltinCountries,finalizeBuiltinWorldFiles} from './builtin-country-bytes.mjs';
import {packLibraryGzip} from './library-archive.mjs';
import {createPhysicalLandPatch} from './physical-land-storage.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>Buffer.from(JSON.stringify(value)+'\n');
const seals=new WeakMap();

// Serialize the supplied GeoJSON as drawn. Each output coordinate must be the
// original coordinate or its exact replacement from the retained edit record.
export function packEditedPolygons({baseline,receipt,readReport,readBaseline,prefetch,catalogPath,physicalPath,sourceRoot}){
 const reports={};
 function report(path){
  assert.ok(path.startsWith('reports/borders/validation/')&&!path.split('/').some(part=>part==='..'||part==='.'));
  const bytes=readReport(path);reports[path]=hash(bytes);return bytes;
 }
 const edit=JSON.parse(report(receipt));
 assert.equal(edit.baseline,baseline);
 for(const p of edit.evidence)report(p);
 const load=p=>JSON.parse(gunzipSync(report(p)));
 const journal=load(edit.coordinates),territories=load(edit.territories),land=load(edit.land);
 assert.equal(journal.baseline,baseline);
 assert.equal(journal.phase,'direct-final');
 const moves=new Map(journal.moves.map(([from,to])=>{
  for(const p of [from,to])assert.ok(p.length===2&&p.every(Number.isFinite)&&Math.abs(p[0])<=180&&Math.abs(p[1])<=90);
  return [from.join(','),to];
 }));
 assert.equal(moves.size,journal.moves.length);
 const seen=new Set();
 function compare(before,after){
  assert.equal(before.type,after.type);
  function slots(old,next){
   assert.equal(old.length,next.length);
   if(typeof old[0]==='number'){
    const k=old.join(',');if(moves.has(k))seen.add(k);
    const expected=moves.get(k)??old;
    assert.ok(next[0]===expected[0]&&next[1]===expected[1],'Edited coordinate disagrees with the recorded vertex');
   }else for(let i=0;i<old.length;i++)slots(old[i],next[i]);
  }
  slots(before.coordinates,after.coordinates);
 }
 const catalog=JSON.parse(readBaseline(catalogPath)),previous=structuredClone(catalog);
 const folder=catalogPath.slice(0,catalogPath.lastIndexOf('/')+1);
 const owners=new Map(catalog.entities.map(row=>[row.entityId,row]));
 const identities=new Map(catalog.sourceIdentities.map(row=>[row.projectEntityId,row.sourceEntityIds]));
 const descriptor=id=>sourceRoot+'/countries/'+id.replace(':','-')+'.json';
 const assets=new Map(builtinGeometryAssets(catalog).map(a=>[JSON.stringify([a.id,a.version]),a.file]));
 const landInfo=JSON.parse(readBaseline(physicalPath));
 const paths=[landInfo.asset.url,landInfo.modernCoast.asset.replacement.url];
 for(const f of territories.features){
  const entry=owners.get(f.id);assert.ok(entry,'Unknown edited territory '+f.id);
  paths.push(...identities.get(f.id).map(descriptor));
  paths.push(...builtinCountryFileSpecs(entry).map(row=>folder+row.file),...entry.geometryRefs.map(r=>folder+assets.get(JSON.stringify([r.id,r.version]))));
 }
 prefetch([...new Set(paths)]);
 const period={validFrom:edit.validFrom,validTo:null};
 assert.equal(landInfo.modernCoast.validFrom,period.validFrom);
 const updated=[],reviews=[],versions=new Map();
 const evidence=reference=>({reference,sha256:reports[reference]});
 const digest=g=>hash(JSON.stringify([g.type,g.coordinates]));
 for(const feature of territories.features){
  const old=readBuiltinCountry(owners.get(feature.id),catalog,p=>readBaseline(folder+p));
  const next=structuredClone(old),bindings=next.sourceBindings.filter(b=>b.validTo===null);
  assert.equal(bindings.length,1,'Ambiguous modern source for '+feature.id);
  const [binding]=bindings;
  assert.ok(binding.validFrom==null||binding.validFrom<=period.validFrom);
  const oldGeometry=next.geometries.find(g=>g.id===binding.geometryRef.id&&g.version===binding.geometryRef.version);
  compare(oldGeometry.geojson,feature.geometry);
  const ref={id:'historical-world:'+hash(JSON.stringify(feature.geometry)),version:1};
  next.sourceBindings=replaceReviewedDisplayBinding(next.sourceBindings,binding,ref,period,edit.previousThrough);
  next.timelineRecords.geometryBindings=replaceReviewedViewerBinding(next.timelineRecords.geometryBindings,binding,ref,period,edit.previousThrough);
  next.geometries.push({...ref,geojson:feature.geometry});
  const active=new Set([...next.sourceBindings,...next.timelineRecords.geometryBindings].map(b=>JSON.stringify([b.geometryRef.id,b.geometryRef.version])));
  next.geometries=next.geometries.filter(g=>active.has(JSON.stringify([g.id,g.version])));
  const member=identities.get(feature.id).flatMap(id=>JSON.parse(readBaseline(descriptor(id))).geometryVersions)
   .find(v=>v.versionId===binding.sourceVersionId);
  const meta=next.identity.properties.metadata.historicalTimeline.geometryVersions.find(v=>v.versionId===binding.sourceVersionId);
  assert.ok(member?.geometryResource&&meta,'Missing coordinate master for '+feature.id);
  const raw=member.geometryResource;
  versions.set(feature.id,{entityId:feature.id,versionId:binding.sourceVersionId,geometrySha256:digest(feature.geometry)});
  const review={...versions.get(feature.id),schemaVersion:1,status:'passed',...period,
   source:evidence(receipt),visual:evidence(edit.visual),master:{reference:sourceRoot+'/'+raw.file,sha256:raw.sha256},
   comparison:{reference:evidence(edit.coordinates),arcSha256:reports[edit.coordinates],extent:coordinateBounds(feature.geometry.coordinates),
    scaleDenominator:10000000,projection:{definition:edit.projection,units:'metre',evidence:evidence(edit.visual)}},
   method:'reviewed-display-generalization',reason:'Existing polygon slots moved directly to surveyed LSIB paths.',
   parameters:{recordedMoves:journal.moves.length},topology:{status:'passed',checks:['validity','shared-boundary','union','gaps-overlaps','connectivity','holes-islands','dates'],evidence:evidence(receipt)},
   counterpartVersions:[],fixedAnchors:[]};
  const prior=meta.historicalProvenance?.displayDetailReview;
  meta.historicalProvenance={...meta.historicalProvenance,displayDetailReview:prior?{...prior,compiledDerivatives:[...(prior.compiledDerivatives??[]),review]}:review};
  reviews.push({next,old,review});
  updated.push(next);
 }
 for(const {next,old,review} of reviews){
  review.counterpartVersions=(edit.counterparts[next.entityId]??[]).map(id=>{assert.ok(versions.has(id));return versions.get(id);});
  if(!review.counterpartVersions.length)review.noSharedBoundaryReason='Only the exterior shoreline moved for this territory.';
  assertHistoricalCompiledChanges(next,old);
 }
 const unpack=spec=>JSON.parse(spec.encoding==='gzip'?gunzipSync(readBaseline(spec.url)):readBaseline(spec.url));
 const base=unpack(landInfo.asset);
 compare(applyPhysicalLandPatch(base,unpack(landInfo.modernCoast.asset.replacement)),land);
 assert.equal(seen.size,moves.size,'Recorded vertex missing from edited geometries');
 const encoded=encodeBuiltinCountries(catalog,updated,new Map());
 finalizeBuiltinWorldFiles(catalog,encoded,{previousIndex:previous});
 const files=new Map([...encoded].map(([file,bytes])=>[folder+file,bytes]));
 const patch=createPhysicalLandPatch(base,land,period),decoded=json(patch),stored=packLibraryGzip(decoded),sha256=hash(stored);
 const url=physicalPath.slice(0,physicalPath.lastIndexOf('/')+1)+'replacements/sha256-'+sha256+'.json.gz';
 const replacement={url,encoding:'gzip',sha256,compressedBytes:stored.length,decodedBytes:decoded.length};
 landInfo.modernCoast.asset={...replacement,storageLayout:regionalLandLayout,base:landInfo.asset,replacement,contentSha256:patch.resultContentSha256};
 files.set(url,stored);files.set(physicalPath,json(landInfo));
 const result={baseline,reports,files};
 seals.set(result,{baseline,reports:{...reports},files:new Map([...files].map(([p,b])=>[p,hash(b)]))});
 return result;
}

export function assertEditedPolygonFiles(result){
 const seal=seals.get(result);
 assert.ok(seal,'Unissued edited polygon files');
 assert.equal(result.baseline,seal.baseline);assert.deepEqual(result.reports,seal.reports);
 assert.deepEqual(new Map([...result.files].map(([p,b])=>[p,hash(b)])),seal.files);
}
