import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertHistoricalCompiledChanges,assertHistoricalSourceStorageChanges} from '../../tools/gis/historical-display-review.mjs';
import * as physicalLand from '../../src/data/physical-land-patch.js';

test('the reviewed modern coast is selected without replacing historical land masks',()=>{
  const base={sha256:'a'.repeat(64)},historical={sha256:'b'.repeat(64)},asset={sha256:'c'.repeat(64)};
  const modern={validFrom:'2026-11-01',asset};
  const select=physicalLand.selectPhysicalLandAsset;
  assert.equal(select(base,modern,base,'2026-10'),base);
  assert.equal(select(base,modern,historical,'1922-06'),historical);
  assert.equal(select(base,modern,base,'2026-11'),asset);
  assert.equal(select(base,modern,base,null),base);
  assert.throws(()=>select(base,modern,historical,'2026-11'),/land derivative/);
});

test('retired border generation options fail before loading map inputs',()=>{
  const cases=[
    ['--review=receipt.json','Unknown builtin world option --review=receipt.json'],
    ['--plan','Unknown builtin world option --plan'],
    ['--entities=state:AAA','--entities requires --names-only'],
  ];
  const script=fileURLToPath(new URL('../../tools/build/build-builtin-world.mjs',import.meta.url));
  for(const [option,message] of cases){
    const result=spawnSync(process.execPath,[script,option],{encoding:'utf8'});
    assert.equal(result.status,1,result.error?.message??result.stderr);
    assert.ok(result.stderr.includes('Error: '+message),result.stderr);
  }
});

test('a verified display review can follow a stored shared-arc correction',()=>{
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const geometry={type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]};
  const geometrySha256=hash(JSON.stringify([geometry.type,geometry.coordinates]));
  const archive=new Map();
  const archived=(reference,value)=>{
    const bytes=Buffer.from(JSON.stringify(value)+'\n');
    archive.set(reference,bytes);
    return {reference,sha256:hash(bytes)};
  };
  const binding={entityId:'state:AAA',versionId:'current',validFrom:'2000-01-01',validTo:null,geometrySha256};
  const method='lossless-original-current-version-shared-arc',status='raw-source-only-not-display-approved';
  const originalReview=archived('reports/borders/validation/source.json',{schemaVersion:1,...binding,method,status});
  const before={entityId:binding.entityId,sourceInfo:{featureId:'AAA'},geometryVersions:[{
    versionId:binding.versionId,validFrom:binding.validFrom,validTo:null,geometry,
    modernBoundarySupplement:{adoptionMode:method,status,geometrySha256,sourceAdoptionReview:originalReview},
    historicalProvenance:{status:'retained'},
  }]};
  const next=structuredClone(before),version=next.geometryVersions[0];
  const reviewEvidence=archived('reports/borders/validation/display.json',{scope:'synthetic review'});
  const masterPath='assets/data/territorial-entities/source/geometries/sha256-'+hash(JSON.stringify(geometry)+'\n')+'.json';
  version.historicalProvenance.displayDetailReview={schemaVersion:1,status:'passed',...binding,
    method:'measured-detail-match',reason:'Fixed identical source boundaries',parameters:{},
    master:archived(masterPath,geometry),source:originalReview,comparison:{reference:reviewEvidence,
      arcSha256:geometrySha256,extent:[0,0,1,1],scaleDenominator:10000000,
      projection:{definition:'EPSG:3857',units:'metre',evidence:reviewEvidence}},
    visual:reviewEvidence,topology:{status:'passed',evidence:reviewEvidence,
      checks:['validity','shared-boundary','union','gaps-overlaps','connectivity','holes-islands','dates']},
    counterpartVersions:[{entityId:'state:BBB',versionId:'current',geometrySha256}],fixedAnchors:[[0,0],[1,0]],
  };
  const review=version.historicalProvenance.displayDetailReview;
  review.compiledDerivatives=[{...review,entityId:'AAA'}];
  const input={prefixes:['assets/data/territorial-entities/source/countries/state-AAA.json'],readEvidence:p=>archive.get(p)};
  assert.equal(assertHistoricalSourceStorageChanges(next,before,input),1);
  const withoutProvenance=structuredClone(before),withFirstReview=structuredClone(next);
  delete withoutProvenance.geometryVersions[0].historicalProvenance;
  delete withFirstReview.geometryVersions[0].historicalProvenance.status;
  assert.equal(assertHistoricalSourceStorageChanges(withFirstReview,withoutProvenance,input),1);
  assert.equal(assertHistoricalCompiledChanges({entityId:'AAA',
    identity:{properties:{metadata:{historicalTimeline:{geometryVersions:[version]}}}},
    sourceBindings:[{sourceVersionId:binding.versionId,validFrom:binding.validFrom,validTo:null,geometryRef:{id:'g',version:1}}],
    geometries:[{id:'g',version:1,geojson:geometry}],
  },null),1);
  version.historicalProvenance.status='different provenance';
  assert.throws(()=>assertHistoricalSourceStorageChanges(next,before,input),/only the display review/);
  version.historicalProvenance.status='retained';
  archive.delete(reviewEvidence.reference);
  assert.throws(()=>assertHistoricalSourceStorageChanges(next,before,input),/archived display evidence/);
});
