import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {applyReviewedSharedArcs,coordinateDigest,replaceReviewedDisplayBinding,reviewedDisplayPeriod} from '../../tools/build/reviewed-border-edition.mjs';
import {temporalContains} from '../../src/document/temporal.js';
import {assertHistoricalCompiledChanges,assertHistoricalSourceStorageChanges} from '../../tools/gis/historical-display-review.mjs';

test('a reviewed shared arc updates only its reciprocal sections',()=>{
  const polygon=ring=>({type:'Polygon',coordinates:[ring]});
  const before=[polygon([[0,0],[1,0],[1,1],[0,1],[0,0]]),polygon([[1,0],[2,0],[2,1],[1,1],[1,0]])];
  const section=[[1,0],[1,1]],replacement=[[1,0],[1.1,.5],[1,1]];
  const change={before:section,beforeSha256:coordinateDigest(section),after:replacement};
  const expected=[polygon([[0,0],[1,0],[1.1,.5],[1,1],[0,1],[0,0]]),
    polygon([[1,0],[2,0],[2,1],[1,1],[1.1,.5],[1,0]])];
  assert.deepEqual(applyReviewedSharedArcs(before,[change]),expected);
  assert.deepEqual(applyReviewedSharedArcs(before,[change]),expected);
  assert.throws(()=>applyReviewedSharedArcs(before,[{...change,beforeSha256:'stale'}]),/preimage/);
  assert.throws(()=>applyReviewedSharedArcs([before[0],before[0]],[change]),/reciprocal/);
});

test('a modern border review preserves the historical geometry on both sides',()=>{
  const oldRef={id:'existing',version:1},newRef={id:'reviewed',version:1};
  const rows=[
    {id:'left',validFrom:'1914-08-01',validTo:null,geometryRef:oldRef},
    {id:'right',validFrom:'1991-08-27',validTo:null,geometryRef:oldRef},
  ];
  const versions=[{validFrom:null},{validFrom:'1991-08-27'}];
  const input={displayValidFrom:'2026-11-01',previousDisplayThrough:'2026-10-31'};
  const {previousDisplayThrough,...binding}=reviewedDisplayPeriod(rows,versions,input);
  for(const row of rows){
    const historical={...row,id:'historical',validFrom:'1900-01-01',validTo:'1910-12-31'};
    const updated=replaceReviewedDisplayBinding([historical,row],row,newRef,binding,previousDisplayThrough);
    assert.equal(updated[0],historical);
    assert.deepEqual(updated[1],{...row,validTo:input.previousDisplayThrough});
    assert.deepEqual(updated.filter(r=>temporalContains(r,'2026-10-31')).map(r=>r.geometryRef),[oldRef]);
    assert.deepEqual(updated.filter(r=>temporalContains(r,'2026-11-01')).map(r=>r.geometryRef),[newRef]);
    assert.notEqual(updated[1].id,updated[2].id);
  }
  assert.throws(()=>reviewedDisplayPeriod(rows,versions,{...input,previousDisplayThrough:'2026-11-01'}),/immediately follow/);
  assert.throws(()=>reviewedDisplayPeriod(rows,versions,{}),/explicit common/);
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
