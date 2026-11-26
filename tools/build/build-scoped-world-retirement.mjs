import {builtinSubunitId} from '../../src/document/territorial-display-identity.js';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {retainAbsorbedTerritory} from '../gis/territorial-retirement.mjs';
import '../../assets/js-vendor/polygon-clipping.min.js';
const clipping=globalThis.polygonClipping;
const scopes={
 'four-object-world-retirement':{retired:['KAB','BJN','SER','PGA'],recipients:['KAZ','COL','VNM','PHL','CHN','TWN']},
 'existing-colombian-territories':{retired:['BJN','SER','PGA'],recipients:['COL']},
 'split-us-minor-outlying-islands':{retired:['UMI'],recipients:MINOR_OUTLYING_ISLAND_FEATURE_IDS},
 ...Object.fromEntries(Object.entries(INDEPENDENT_WORLD_RETIREMENT_IDS).map(([kind,id])=>[kind,{retired:[id],recipients:[]}])),
};
const originalKind='four-object-world-retirement';
const verifiedPublications=new WeakMap();
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
export function assertVerifiedScopedWorldRetirement(files){const proof=verifiedPublications.get(files);assert(proof,'unverified scoped world publication');assert.equal(files.size,proof.files.length);for(const row of proof.files){const bytes=files.get(row.path);assert(Buffer.isBuffer(bytes));assert.equal(bytes.length,row.bytes);assert.equal(sha(bytes),row.sha256,'mutated scoped world publication');}return proof;}
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const polygons=g=>{assert(['Polygon','MultiPolygon'].includes(g?.type),'polygon geometry required');return g.type==='Polygon'?[g.coordinates]:g.coordinates;};
/** Layer-specific gate: never substitute the source or another runtime layer. */
export function patchWorldRetirementLayer({before,candidates,additions,replacements,kind=originalKind}){
 const {retired,recipients}=scopes[kind]||{};
 assert(retired,'unsupported scoped retirement');
 assert.equal(before?.type,'FeatureCollection');assert(Array.isArray(before.features));
 const byId=new Map(before.features.map(f=>[String(f.id),f]));assert.equal(byId.size,before.features.length,'duplicate feature');
 if(kind==='split-us-minor-outlying-islands'){
  assert(byId.has('UMI'),'missing island aggregate');
  assert.deepEqual(replacements.map(f=>f.id),recipients,'exact outlying-island replacement scope');
  for(const feature of replacements){
   assert(feature.type==='Feature'&&typeof feature.properties?.name==='string'&&polygons(feature.geometry).length);
   assert(!byId.has(feature.id),'replacement island already exists: '+feature.id);
  }
  return {...structuredClone(before),features:structuredClone([...before.features.filter(f=>f.id!=='UMI'),...replacements])};
 }
 assert.deepEqual(Object.keys(candidates).sort(),[...recipients].sort(),'exact scoped recipients required');
 for(const id of [...retired,...recipients])assert(byId.has(id),'missing scoped feature '+id);
 for(const id of recipients){const old=byId.get(id).geometry,{beforeSha256,geometry}=candidates[id];assert.equal(hash(old),beforeSha256,'stale layer preimage');
  if(kind==='existing-colombian-territories'){assert.deepEqual(geometry,retainAbsorbedTerritory(old,['BJN','SER'].map(id=>byId.get(id).geometry)),'absorbed coordinates changed');}
  else if(['KAZ','COL'].includes(id)){const absorbed=id==='KAZ'?['KAB']:['BJN','SER'];const union=clipping.union(polygons(old),...absorbed.map(id=>polygons(byId.get(id).geometry)));
   assert.deepEqual(clipping.difference(union,polygons(geometry)),[],'lost absorbed territory');assert.deepEqual(clipping.difference(polygons(geometry),union),[],'outside scoped union');
  }else{assert.equal(additions[id]?.length,{VNM:4,PHL:4,CHN:1,TWN:1}[id]);assert.equal(geometry.type,'MultiPolygon');assert.deepEqual(geometry.coordinates,[...polygons(old),...additions[id]],'non-exact approved component append');}
 }
 return {...structuredClone(before),features:before.features.filter(f=>!retired.includes(String(f.id))).map(f=>({...structuredClone(f),...(candidates[f.id]?{geometry:structuredClone(candidates[f.id].geometry)}:{})}))};
}
import {decodeCountryMesh,encodeCountryMesh,extractCountryMeshSlot} from '../../src/rendering/country-mesh-codec.js';
import {createCountryMeshPreparation} from '../../src/rendering/country-mesh-preparation.js';
const coordinateCount=g=>polygons(g).reduce((n,p)=>n+p.reduce((n,r)=>n+r.length,0),0);
export async function rebuildScopedWorldMesh({before,after,buffer,engine,maxEdgeDegrees,kind=originalKind}){
 const {recipients}=scopes[kind];
 assert.equal(engine.MESH_ALGORITHM_REVISION,6,'pinned mesh algorithm required');
 const ids=before.features.map(f=>String(f.id)),old=decodeCountryMesh(buffer,ids).mesh,slots=new Map(ids.map((id,i)=>[id,i])),byId=new Map(before.features.map(f=>[String(f.id),f]));
 const built=[],reused=[];const preparation=createCountryMeshPreparation({engine,loadPreparedPart:async(_key,f)=>{
  const prior=byId.get(String(f.id));
  if(!prior||hash(prior.geometry)!==hash(f.geometry)){assert(recipients.includes(String(f.id))&&(prior||kind==='split-us-minor-outlying-islands'),'unscoped mesh change');built.push(String(f.id));return null;}
  reused.push(String(f.id));return extractCountryMeshSlot(old,slots.get(String(f.id)));
 }});
 const mesh=await preparation.build(after.features,{throwIfCancelled(){}},()=>{},{validate:true,maxEdgeDegrees});
 const nextIds=after.features.map(f=>String(f.id)),encoded=encodeCountryMesh(mesh,nextIds,after.features.reduce((n,f)=>n+coordinateCount(f.geometry),0)),decoded=decodeCountryMesh(encoded,nextIds).mesh;
 for(const id of reused){const a=extractCountryMeshSlot(old,slots.get(id)),b=extractCountryMeshSlot(decoded,nextIds.indexOf(id));for(const key of ['positions','triangleIndices','lineIndices','countryBounds','countryBoundsFlags'])assert.deepEqual(b[key],a[key],'untouched mesh slot changed: '+id+'/'+key);}
 return{buffer:encoded,built,reused};
}
import {gzipSync,gunzipSync} from 'node:zlib';
import {createCanonicalCountryStore,inspectCanonicalCountryPacket} from '../../src/rendering/canonical-country-packet.js';
import {encodeCanonicalCountryPacket} from './canonical-country-packet-encoder.mjs';
import {retainedLabelAnchors} from '../gis/publication-label-anchors.mjs';
import {geometryFingerprint} from '../../src/document/project-baseline-fingerprint.js';
import {INDEPENDENT_WORLD_RETIREMENT_IDS,MINOR_OUTLYING_ISLAND_FEATURE_IDS,validateWorldBundle} from '../../src/data/world-bundle-manifest.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
const arrayBuffer=b=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
const roles={canonicalCountryPacket:['countries-canonical','.pcg.gz'],canonicalMesh:['world-mesh','.bin.gz'],previewCountries:['countries-preview','.geojson.gz'],previewMesh:['world-mesh-preview','.bin.gz'],labelAnchors:['country-label-anchors','.json']};
/** Pure paired producer. Only its caller may archive outputs, after the retirement owner validates the same receipts. */
export async function buildScopedWorldRetirement({worldBytes,currentWorldBytes,readAsset,layers,additions,replacements,engine,patchReceipt,readEvidence,kind=originalKind}){
 const {retired,recipients}=scopes[kind]||{};
 assert(retired,'unsupported scoped retirement');
 const world=JSON.parse(worldBytes),split=kind==='split-us-minor-outlying-islands';
 const independent=Object.hasOwn(INDEPENDENT_WORLD_RETIREMENT_IDS,kind), useExistingLayers=split||independent||kind==='existing-colombian-territories';
 assert.equal(world.source.url,'territorial-entities/generated/current-world.geojson','exact paired source path');
 assert.equal(world.derivation.preview,(split||independent)?'scoped-retirement-patch':'canonical-topology-simplified','unexpected baseline world derivation');assert.equal(world.derivation.meshAlgorithmRevision,6);assert.equal(sha(currentWorldBytes),world.source.sha256,'current-world source binding');
 const decoded=new Map();function asset(role){if(decoded.has(role))return decoded.get(role);const spec=world.assets[role],bytes=readAsset(spec.url);assert(Buffer.isBuffer(bytes));assert.equal(sha(bytes),spec.sha256);assert.equal(bytes.length,spec.compressedBytes);const raw=spec.encoding==='gzip'?gunzipSync(bytes):bytes;assert.equal(raw.length,spec.decodedBytes);if(spec.header)assert.deepEqual([...new Uint32Array(raw.buffer,raw.byteOffset,spec.header.length)],spec.header);decoded.set(role,raw);return raw;}
 const before={currentworld:JSON.parse(currentWorldBytes),pcg:createCanonicalCountryStore(arrayBuffer(asset('canonicalCountryPacket')),{expectedHeader:world.assets.canonicalCountryPacket.header}).materializeCollectionSync(),preview:JSON.parse(asset('previewCountries'))},after={};
 let proofBytes;
 if(useExistingLayers){
  assert(!layers&&!additions&&!patchReceipt,'existing layer geometry supplies the retirement preimages');
  additions=split?replacements:{};
  layers=Object.fromEntries(Object.entries(before).map(([key,collection])=>{
   if(split)return [key,Object.fromEntries(replacements.map(f=>[f.id,{geometry:f.geometry}]))];
   if(independent)return [key,{}];
   const geometries=new Map(collection.features.map(feature=>[feature.id,feature.geometry]));
   for(const id of ['COL','BJN','SER'])assert(geometries.has(id),'missing Colombian component: '+id);
   const old=geometries.get('COL'),geometry=retainAbsorbedTerritory(old,['BJN','SER'].map(id=>geometries.get(id)));
   return [key,{COL:{beforeSha256:hash(old),geometry}}];
  }));
  proofBytes=Buffer.from(JSON.stringify({schemaVersion:1,kind,baselineWorldSha256:sha(worldBytes),additionsSha256:hash(additions),
   layerPreimages:Object.fromEntries(Object.entries(before).map(([key,value])=>[key,hash(value)])),
   layerCandidates:Object.fromEntries(Object.entries(layers).map(([key,value])=>[key,Object.fromEntries(Object.entries(value).map(([id,candidate])=>[id,hash(candidate.geometry)]))]))})+'\n');
  patchReceipt={sha256:sha(proofBytes)};
 }else proofBytes=readEvidence(patchReceipt);
 assert(Buffer.isBuffer(proofBytes));assert.equal(sha(proofBytes),patchReceipt.sha256,'patch receipt mismatch');
 const proof=JSON.parse(proofBytes);assert.equal(proof.schemaVersion,1);assert.equal(proof.kind,kind);assert.equal(proof.baselineWorldSha256,sha(worldBytes));assert.equal(proof.additionsSha256,hash(additions));
 assert.deepEqual(Object.keys(layers).sort(),['currentworld','pcg','preview']);
 for(const key of Object.keys(before)){assert.equal(hash(before[key]),proof.layerPreimages[key],'layer preimage receipt mismatch');assert.equal(before[key].features.length,world.source.countryCount);assert.deepEqual(Object.fromEntries(Object.entries(layers[key]).map(([id,c])=>[id,hash(c.geometry)])),proof.layerCandidates[key],'candidate receipt mismatch');after[key]=patchWorldRetirementLayer({before:before[key],candidates:layers[key],additions,replacements,kind});}
 assert.deepEqual(after.pcg.features.map(f=>f.id),after.preview.features.map(f=>f.id),'paired slot IDs');
 const canonical=await rebuildScopedWorldMesh({before:before.pcg,after:after.pcg,buffer:arrayBuffer(asset('canonicalMesh')),engine,maxEdgeDegrees:engine.MAX_RENDER_EDGE_DEGREES,kind});
 const preview=await rebuildScopedWorldMesh({before:before.preview,after:after.preview,buffer:arrayBuffer(asset('previewMesh')),engine,maxEdgeDegrees:2,kind});
 const pcg=encodeCanonicalCountryPacket(after.pcg),anchors=retainedLabelAnchors({before:before.pcg,after:after.pcg,anchors:JSON.parse(asset('labelAnchors'))});
 const files=new Map(),next=structuredClone(world);next.assets={};
 function store(role,raw,header){raw=Buffer.from(raw);const encoding=role==='labelAnchors'?'identity':'gzip',stored=encoding==='gzip'?gzipSync(raw,{level:9,mtime:0}):raw;if(encoding==='gzip')stored[9]=3;const digest=sha(stored),[name,ext]=roles[role],url='world/objects/'+name+'-sha256-'+digest+ext;files.set('assets/data/'+url,stored);next.assets[role]={url,encoding,sha256:digest,compressedBytes:stored.length,decodedBytes:raw.length,...(header?{header}:{} )};}
 store('canonicalCountryPacket',Buffer.from(pcg),inspectCanonicalCountryPacket(pcg).words);for(const[role,mesh]of [['canonicalMesh',canonical],['previewMesh',preview]])store(role,Buffer.from(mesh.buffer),[...new Uint32Array(mesh.buffer,0,12)]);
 store('previewCountries',Buffer.from(JSON.stringify(after.preview)));store('labelAnchors',Buffer.from(JSON.stringify(anchors)+'\n'));
 const currentBytes=Buffer.from(JSON.stringify(after.currentworld)+'\n');files.set('assets/data/'+world.source.url,currentBytes);next.source={...next.source,sha256:sha(currentBytes),countryCount:after.currentworld.features.length};
 const classification=next.defaultClassification;for(const key of ['countries','changed','units'])if(classification[key])for(const id of [...retired,...retired.map(builtinSubunitId)])delete classification[key][id];if(classification.removedIds)classification.removedIds=classification.removedIds.filter(id=>!retired.includes(id));
 if(split){
  const units=classification.units??={};
  const revision=world.defaultClassification.units[builtinSubunitId('UMI')].revision;
  for(const {id,geometry} of replacements)units[builtinSubunitId(id)]={parentId:'USA',geometry:geometryFingerprint(geometry),revision};
  classification.removedIds=[...(classification.removedIds||[]),...recipients];
 }
 for(const feature of after.pcg.features.filter(f=>recipients.includes(String(f.id)))){if(Object.hasOwn(classification.countries,feature.id))classification.countries[feature.id]=geometryFingerprint(feature.geometry);if(classification.changed&&Object.hasOwn(classification.changed,feature.id))classification.changed[feature.id]=geometryFingerprint(feature.geometry);}
 next.derivation={...next.derivation,preview:'scoped-retirement-patch',coordinateCount:after.preview.features.reduce((n,f)=>n+coordinateCount(f.geometry),0),scopedRetirement:{schemaVersion:1,baselinePreview:world.derivation.preview,baselineWorldSha256:sha(worldBytes),patchReceiptSha256:patchReceipt.sha256,retiredIds:retired,recipientIds:recipients,detachedCaches:['preparedCountryScene','sharedBoundaries'],layerPreimages:proof.layerPreimages}};
 next.compatibility={...next.compatibility,sharedBoundaries:{}};
 validateWorldBundle(next);files.set('assets/data/world/current.json',Buffer.from(JSON.stringify(next,null,2)+'\n'));
 const baselineAssets=Object.values(world.assets).map(spec=>({path:'assets/data/'+spec.url,sha256:spec.sha256,bytes:spec.compressedBytes}));
 for(const url of Object.values(world.compatibility?.sharedBoundaries||{})){const bytes=readAsset(url);assert(Buffer.isBuffer(bytes),'missing detached boundary baseline');baselineAssets.push({path:'assets/data/'+url,sha256:sha(bytes),bytes:bytes.length});}
 verifiedPublications.set(files,freeze({baselineWorldSha256:sha(worldBytes),baselineCurrentWorldSha256:sha(currentWorldBytes),baselineAssets,additionsSha256:hash(additions),canonicalAdditionsSha256:hash(Object.fromEntries(Object.entries(additions).sort(([a],[b])=>a.localeCompare(b)))),patchReceiptSha256:patchReceipt.sha256,files:[...files].map(([path,bytes])=>({path,sha256:sha(bytes),bytes:bytes.length}))}));
 return{files,world:next,...(useExistingLayers?{proofBytes}:{}),summary:{canonical:{built:canonical.built,reused:canonical.reused.length},preview:{built:preview.built,reused:preview.reused.length}}};
}
