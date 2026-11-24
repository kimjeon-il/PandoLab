import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAffiliationMetadata,affiliationTypeAt} from '../../../src/document/territorial-affiliation.js';
import {normalizeTerritorialIdentity} from '../../../src/document/territorial-units.js';
import {normalizeTerritorialLibraryEntity} from '../../../tools/gis/territorial-library.js';
import {applyBuiltinAffiliation} from '../../../tools/build/builtin-world-compiler.mjs';

const dated=[
  {validFrom:'1930-01-01',validTo:'1935-03-31',type:'총독부'},
  {validFrom:'1936',validTo:'1940-12-31',type:'보호령'},
];

test('child-authored free-text affiliation is preserved in project identity and library source',()=>{
  const metadata=normalizeAffiliationMetadata({affiliationType:'  구성국  ',other:'preserved'});
  assert.equal(metadata.affiliationType,'구성국');
  assert.equal(metadata.other,'preserved');
  assert.equal(affiliationTypeAt(metadata,'1950-01'),'구성국');
  const identity=normalizeTerritorialIdentity({type:'Feature',id:'state:TEST',geometry:null,
    properties:{schemaVersion:6,entityKind:'general',name:'테스트',metadata}});
  assert.equal(identity.properties.metadata.affiliationType,'구성국');
  const library=normalizeTerritorialLibraryEntity({
    schemaVersion:2,entityId:'state:TEST',entityKind:'general',names:{ko:'테스트'},lifetime:{validFrom:null,validTo:null},
    parentEntityId:'state:ROOT',geometryVersions:[{versionId:'v1',validFrom:null,validTo:null}],
    metadata:{affiliationType:' 구성국 '},
  },{normalizeVersionGeometry:()=>({geometry:{type:'Polygon',coordinates:[]}})});
  assert.equal(library.metadata.affiliationType,'구성국');
});

test('dated affiliation uses canonical end-of-month cursor and leaves unlabeled gaps blank',()=>{
  const metadata=normalizeAffiliationMetadata({affiliationTypeHistory:dated});
  assert.equal(affiliationTypeAt(metadata,'1929-12'),'');
  assert.equal(affiliationTypeAt(metadata,'1935-03'),'총독부');
  assert.equal(affiliationTypeAt(metadata,'1935-04'),'');
  assert.equal(affiliationTypeAt(metadata,'1936-01'),'보호령');
  assert.equal(affiliationTypeAt(metadata,'1941-01'),'');
});

test('builtin child generation copies reviewed affiliation types without changing identity metadata',()=>{
  const source={affiliationTypeHistory:dated,builtinSubunit:{sourceCountryId:'A'}};
  const display={affiliationType:'임시유형',builtinSubunit:{sourceCountryId:'B'}};
  applyBuiltinAffiliation(display,source);
  assert.deepEqual(display,{affiliationTypeHistory:dated,builtinSubunit:{sourceCountryId:'B'}});
  assert.equal(affiliationTypeAt(display,'1936-01'),'보호령');
  assert.notEqual(display.affiliationTypeHistory,dated);
});

test('invalid child-authored affiliation intervals and mixed static/dynamic definitions are rejected',()=>{
  for(const metadata of [
    {affiliationType:7},
    {affiliationType:'A',affiliationTypeHistory:dated},
    {affiliationTypeHistory:[{validFrom:null,validTo:null,type:''}]},
    {affiliationTypeHistory:[{validFrom:'1940',validTo:'1939',type:'A'}]},
    {affiliationTypeHistory:[{validFrom:'1930',validTo:'1935',type:'A'},
      {validFrom:'1935',validTo:'1940',type:'B'}]},
    {affiliationTypeHistory:[{validFrom:'1930',validTo:'1931',type:'A',parentId:'root'}]},
  ])assert.throws(()=>normalizeAffiliationMetadata(metadata));
});
