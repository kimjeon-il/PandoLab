import test from 'node:test';
import assert from 'node:assert/strict';
import {historicalWorldCases} from '../../fixtures/historical-world-cases.mjs';
import {normalizeTerritorialLibraryEntity,normalizeTerritorialLibraryIndex,
  territorialEntityExistsAt,selectGeometryVersion,historicalSourceAvailability,
  territorialNameData} from '../../../tools/gis/territorial-library.js';
import {territorialIndexEntry} from '../../../tools/gis/territorial-index-entry.js';
import {compileBuiltinWorldCatalog} from '../../../tools/build/builtin-world-compiler.mjs';

const periods=[{validFrom:'1900',validTo:'1910'},{validFrom:'1991-08-24',validTo:'2014-03-17'}];

function source() {
 const example=historicalWorldCases().entities.find(row=>row.entityId==='state:test-ukraine');
 return {...example,instantiation:{mode:"independent",countryUpdates:{},coverageMode:"explicit"},schemaVersion:2,lifetime:structuredClone(periods),metadata:{
  ...example.metadata,flagHistory:[{validFrom:'1900',validTo:'2014-03-17',policy:'none'}]},
  sourceInfo:{sourceId:'fixture'},geometryVersions:[
   {...example.geometryVersions[0],versionId:'ukraine-old',validFrom:'1900',validTo:'1910'},
   example.geometryVersions[0],
  ]};
}
test('library source admits disjoint lifetimes and leaves the interval between them inactive',()=>{
 const entity=normalizeTerritorialLibraryEntity(source());
 assert.deepEqual(entity.lifetime,periods);
 assert.equal(territorialEntityExistsAt(entity,'1905-06-01'),true);
 assert.equal(territorialEntityExistsAt(entity,'1950-01-01'),false);
 assert.equal(territorialEntityExistsAt(entity,'2000-01-01'),true);
 assert.equal(territorialEntityExistsAt(entity,'2015-01-01'),false);
 assert.equal(selectGeometryVersion(entity,'1905-06-01').versionId,'ukraine-old');
 assert.equal(selectGeometryVersion(entity,'1950-01-01'),null);
 assert.equal(selectGeometryVersion(entity,'2000-01-01').versionId,'ukraine-v1');
 assert.equal(historicalSourceAvailability(entity,'1950-01-01'),'absent');
 assert.equal(historicalSourceAvailability(entity,'2000-01-01'),'available');
 assert.equal(territorialNameData(entity,'1950-01-01').name,'');
 assert.equal(territorialNameData(entity,'2000-01-01').name,entity.names.ko);
 const indexEntry=territorialIndexEntry(entity,{sha256:'a'.repeat(64),compressedBytes:100,decodedBytes:200});
 assert.equal(Object.hasOwn(indexEntry,'validFrom'),false);
 assert.equal(Object.hasOwn(indexEntry,'validTo'),false);
 normalizeTerritorialLibraryIndex({schemaVersion:2,entities:[indexEntry],
  lineages:[{schemaVersion:2,lineageId:entity.lineageId,names:{ko:'역사'},entityRefs:[entity.entityId],relations:[]}],
  snapshots:[],views:[]});
});
test('source rejects overlapping, reversed and unordered lifetimes',()=>{
 for(const lifetime of [[],[periods[0],{validFrom:'1909',validTo:'1920'}],
  [...periods].reverse(),[{validFrom:'1910',validTo:'1900'}]]) {
  assert.throws(()=>normalizeTerritorialLibraryEntity({...source(),lifetime}),/lifetime|interval|date/i);
 }
});
test('builtin compiler emits separate lifetime, geometry, name and flag bindings',()=>{
 const fixture=historicalWorldCases();
 const replacement=source();
 const index=fixture.entities.findIndex(row=>row.entityId===replacement.entityId);
 fixture.entities[index]=replacement;
 const selections=fixture.currentSnapshot.entityRefs.map(entityId=>{
  const entity=fixture.entities.find(row=>row.entityId===entityId);
  return {entityId,geometryVersionId:entity.geometryVersions[0].versionId};
 });
 const {countries}=compileBuiltinWorldCatalog({entities:fixture.entities,
  view:{schemaVersion:1,id:'world-test',selections,sourceInfo:{collectionMetadata:{}}},currentWorld:fixture.currentWorld,
  policy:fixture.policy,displayPolicy:fixture.displayPolicy});
 const country=countries.find(row=>row.entityId===replacement.entityId);
 assert(country);
 assert.deepEqual(country.timelineRecords.lifetimes.map(row=>({validFrom:row.validFrom,validTo:row.validTo})),periods);
 for(const prop of ['name','flag']) {
  const bindings=country.timelineRecords.propertyBindings.filter(row=>row.property===prop);
  assert.equal(bindings.length,2);
  assert.equal(bindings.some(row=>row.validFrom==='1900-01-01'&&row.validTo==='1910-12-31'),true,JSON.stringify(bindings));
  assert.equal(bindings.some(row=>row.validFrom==='1991-08-24'&&row.validTo==='2014-03-17'),true);
 }
 const windows=country.timelineRecords.geometryBindings;
 assert(windows.some(row=>row.validTo==='1910-12-31'));
 assert(windows.some(row=>row.validFrom==='1991-08-24'));
 assert(windows.every(row=>row.validTo!=='1950-01-01'&&row.validFrom!=='1950-01-01'));
});
