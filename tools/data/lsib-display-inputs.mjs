import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {builtinGeometryAssets} from '../../src/data/builtin-country-files.js';
import {parseTemporal,temporalContains} from '../../src/document/temporal.js';
import {readBuiltinCountryStoredBytes} from './builtin-country-bytes.mjs';
import {approvedLsibSource} from './lsib-display-sources.mjs';
import {defaultRoot,decodeArchiveEntry,decodeArchiveEntries,git,libraryConfig,librarySharedCheckout} from './library-context.mjs';

const builtin='assets/data/builtin-world/generated/v1/';
const source='tools/historical-library/sources/lsib-11.4/';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const key=ref=>JSON.stringify([ref.id,ref.version]);

export function readLsibDisplayInputs({root=defaultRoot,cutoff,revision=libraryConfig(root).revision}){
 const date=parseTemporal(cutoff);
 if(date?.precision!=='date'||date.canonical!==cutoff)throw Error('Specify an exact LSIB display date');
 if(!/^[a-f0-9]{40}$/.test(revision))throw Error('Specify an exact Library revision');
 const checkout=librarySharedCheckout(root);
 const archive=JSON.parse(git(checkout,['show',revision+':archive/index.json']));
 function entry(path){
  if(!archive.files[path])throw Error('Missing LSIB display input: '+path);
  return archive.files[path];
 }
 const read=path=>decodeArchiveEntry(checkout,entry(path),revision);
 const batch=paths=>decodeArchiveEntries(checkout,new Map([...new Set(paths)].map(path=>[path,entry(path)])),revision);
 const index=JSON.parse(read(builtin+'index.json'));
 const current=index.entities.filter(row=>row.coverage.some(interval=>temporalContains(interval,cutoff)));
 const descriptors=batch(current.flatMap(row=>(row.parts??[row]).map(part=>builtin+part.file)));
 const assetByKey=new Map(builtinGeometryAssets(index).map(asset=>[key(asset),asset]));
 const objects=current.map(entry=>{
  const descriptor=JSON.parse(gunzipSync(readBuiltinCountryStoredBytes(entry,file=>descriptors.get(builtin+file))));
  const bindings=descriptor.sourceBindings.filter(row=>temporalContains(row,cutoff));
  if(bindings.length!==1)throw Error('No unique LSIB current display binding: '+entry.entityId);
  const [binding]=bindings,asset=assetByKey.get(key(binding.geometryRef));
  if(!asset)throw Error('Missing LSIB current display geometry: '+entry.entityId);
  const timeline=descriptor.identity.properties.metadata.historicalTimeline;
  const version=timeline.geometryVersions.find(row=>row.versionId===binding.sourceVersionId);
  const provenance=version?.historicalProvenance;
  const review=[...(provenance?.lsibDisplay??[]),...(provenance?.worldPolygonsDisplay??[])]
   .find(row=>row.validFrom===binding.validFrom&&row.validTo===binding.validTo);
  const sourceId=timeline.entityId;
  const {wpIds,division}=approvedLsibSource({sourceId,review},read);
  return {asset,entityId:entry.entityId,sourceId,binding,review:review??null,
   approvedWpIds:wpIds,...(division?{division}:{})};
 });
 const geometries=batch(objects.map(row=>builtin+row.asset.file));
 const features=objects.map(({asset,...properties})=>{
  const bytes=gunzipSync(geometries.get(builtin+asset.file));
  if(digest(bytes)!==asset.contentSha256)throw Error('Invalid LSIB baseline geometry: '+properties.entityId);
  return {type:'Feature',id:properties.entityId,properties,geometry:JSON.parse(bytes)};
 });
 const boundaries=read(source+'boundaries.geojson.gz');
 const provenance=JSON.parse(read(source+'provenance.json'));
 if(digest(boundaries)!==provenance.masterSha256)throw Error('LSIB baseline does not contain the pinned original boundaries');
 return {baseline:{type:'FeatureCollection',baseline:revision,cutoff,features},boundaries};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [cutoff,baselineFile,boundaryFile]=process.argv.slice(2);
 if(!cutoff||!baselineFile||!boundaryFile)throw Error('Usage: node tools/data/lsib-display-inputs.mjs YYYY-MM-DD BASELINE.json BOUNDARIES.geojson.gz');
 const {baseline,boundaries}=readLsibDisplayInputs({cutoff});
 writeFileSync(baselineFile,JSON.stringify(baseline),{flag:'wx'});
 writeFileSync(boundaryFile,boundaries,{flag:'wx'});
 console.log(JSON.stringify({revision:baseline.baseline,date:cutoff,objects:baseline.features.length}));
}
