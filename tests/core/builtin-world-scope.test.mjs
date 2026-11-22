import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {applyReviewedSharedArcs,coordinateDigest,proveUnchangedMergedMembers,replaceReviewedDisplayBinding,replaceReviewedViewerBinding,reviewedBorderTouchesNeighbor,reviewedDisplayPeriod,validateDisplayedBorderAuthority,validateReviewedPair} from '../../tools/build/reviewed-border-edition.mjs';
import {temporalContains} from '../../src/document/temporal.js';
import {assertHistoricalCompiledChanges,assertHistoricalSourceStorageChanges} from '../../tools/gis/historical-display-review.mjs';

test('a reviewed waterway uses the exact midpoint of each surveyed cross section',()=>{
  const baseline='a'.repeat(40),entities=['state:AAA','state:BBB'];
  const arc=[[1,.03],[1.1,.5],[1,.97]],before=[[1,0],[1,1]];
  const section={before,beforeSha256:coordinateDigest(before),after:[before[0],...arc,before[1]]};
  const authority={schemaVersion:1,baseline,entities,kind:'surveyed-bank-midpoints',source:{reference:'https://example.org/water',sha256:'b'.repeat(64)},arcs:[{coordinates:arc,banks:[[[.99,.03],[1.01,.03]],[[1.09,.5],[1.11,.5]],[[.99,.97],[1.01,.97]]]}]};
  assert.doesNotThrow(()=>validateDisplayedBorderAuthority(authority,[section],{baseline,entities}));
  authority.arcs[0].banks[1][0][0]=1;
  assert.throws(()=>validateDisplayedBorderAuthority(authority,[section],{baseline,entities}),/bank midpoint/);
});

test('a selected LSIB arc carries original line vertices in either direction',()=>{
  const baseline='a'.repeat(40),entities=['state:AAA','state:BBB'],line=[[1,0],[1,.25],[1.1,.5],[1,.75],[1,1]];
  const bytes=gzipSync(JSON.stringify({features:[{properties:{ID:'claim'},geometry:{type:'LineString',coordinates:line}}]}));
  const source={reference:'tools/historical-library/sources/lsib-11.4/boundaries.geojson.gz',sha256:createHash('sha256').update(bytes).digest('hex')};
  const before=[line.at(-1),line[0]],coordinates=line.slice(1,4).reverse();
  const section={before,beforeSha256:coordinateDigest(before),after:[before[0],...coordinates,before[1]]};
  const authority={schemaVersion:1,baseline,entities,source,naturalEarthSha256:'c'.repeat(64),kind:'lsib-line-selected-by-natural-earth',arcs:[{lineId:'claim',part:0,start:1,end:3,coordinates}]};
  const options={baseline,entities,readEvidence:()=>bytes};
  assert.doesNotThrow(()=>validateDisplayedBorderAuthority(authority,[section],options));
  authority.arcs[0].lineId='other';
  assert.throws(()=>validateDisplayedBorderAuthority(authority,[section],options),/exact LSIB line slice/);
});

test('a reviewed shared arc updates only its reciprocal sections',()=>{
  const polygon=ring=>({type:'Polygon',coordinates:[ring]});
  const before=[polygon([[0,0],[1,0],[1,1],[0,1],[0,0]]),polygon([[1,0],[2,0],[2,1],[1,1],[1,0]])];
  const section=[[1,0],[1,1]],replacement=[[1,0],[1.1,.5],[1,1]];
  const change={before:section,beforeSha256:coordinateDigest(section),after:replacement};
  const expected=[polygon([[0,0],[1,0],[1.1,.5],[1,1],[0,1],[0,0]]),
    polygon([[1,0],[2,0],[2,1],[1,1],[1.1,.5],[1,0]])];
  assert.deepEqual(applyReviewedSharedArcs(before,[change]),expected);
  assert.deepEqual(applyReviewedSharedArcs(before,[change]),expected);
  const sections=validateReviewedPair(before,expected,[change],'source');
  const neighbor=(west,south,east,north)=>polygon([[west,south],[east,south],[east,north],[west,north],[west,south]]);
  assert.equal(reviewedBorderTouchesNeighbor(neighbor(1.02,.48,1.04,.52),sections),true);
  assert.equal(reviewedBorderTouchesNeighbor(neighbor(1.08,.08,1.09,.09),sections),false);
  assert.throws(()=>validateReviewedPair(before,[expected[0],before[1]],[change],'source'),/pair overlaps/);
  const gapChange={...change,after:[[1,0],[.9,.5],[1,1]]};
  const gap=[polygon([[0,0],[1,0],[.9,.5],[1,1],[0,1],[0,0]]),before[1]];
  assert.throws(()=>validateReviewedPair(before,gap,[gapChange],'source'),/pair exterior changed/);
  assert.throws(()=>applyReviewedSharedArcs(before,[{...change,beforeSha256:'stale'}]),/preimage/);
  assert.throws(()=>applyReviewedSharedArcs([before[0],before[0]],[change]),/reciprocal/);
});

test('a reciprocal border with collinear bridges passes topology verification',()=>{
  const north=[29.588147,64.991435],south=[29.633622,64.90715];
  const southEdge=[29.634573371937773,64.90615],northEdge=[29.58838526933377,64.992435];
  const west=29.587146999999998,east=29.634622,bottom=64.90615,top=64.992435;
  const polygon=(...ring)=>({type:'Polygon',coordinates:[[...ring,ring[0]]]});
  const before=[
    polygon([west,bottom],southEdge,south,north,northEdge,[west,top]),
    polygon(north,south,southEdge,[east,bottom],[east,top],northEdge),
  ];
  const old=[north,south];
  const change={before:old,beforeSha256:coordinateDigest(old),after:[north,
    [29.60598098219588,64.95838085619836],[29.619184800000028,64.95965900000004],
    [29.610994900000037,64.92731090000007],[29.615221100000042,64.91745700000007],
    [29.627422000770384,64.91864130148583],south]};
  const after=applyReviewedSharedArcs(before,[change]);
  assert.doesNotThrow(()=>validateReviewedPair(before,after,[change],'display'));
});

test('a display splice preserves the other archived members of a merged country',()=>{
  const current={validFrom:'2026-11-01',validTo:null};
  const expired={validFrom:null,validTo:'2026-10-31'};
  const member='state:CCC';
  const polygon=(west,east)=>({type:'Polygon',coordinates:[[[west,0],[east,0],[east,1],[west,1],[west,0]]]});
  const before=[[1,0],[1,1]],after=[[1,0],[1.1,.5],[1,1]];
  const sections=[{before,after}];
  const selected={entityId:'state:AAA',sourceInfo:{featureId:'AAA'}};
  const identity={sourceEntityIds:[selected.entityId,member],sourceFeatureIds:['AAA','CCC']};
  const readMember=geometryVersions=>()=>({entityId:member,sourceInfo:{featureId:'CCC'},geometryVersions});
  const check=(read,owner=identity)=>proveUnchangedMergedMembers(owner,selected,current,sections,read);
  assert.deepEqual(check(readMember([
    {...expired,geometry:polygon(1,1.05)},{...current,geometry:polygon(4,5)},
  ])),[{id:member,reason:'merged source disjoint from every display section'}]);
  assert.throws(()=>check(readMember([{...current,geometry:polygon(1.03,1.06)}])),/merged source intersects.*CCC/);
  assert.throws(()=>check(readMember([{...expired,geometry:polygon(4,5)}])),/merged source geometry missing.*CCC/);
  assert.throws(()=>check(readMember([{...current,geometry:polygon(4,5)}]),
    {...identity,sourceFeatureIds:['AAA','CCC','DDD']}),/merged source identity is incomplete.*AAA/);
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

test('a modern border review splits the current Viewer binding at the reviewed date',()=>{
  const objectRef={domain:'territorial',id:'AAA'};
  const oldRef={id:'existing',version:1},nextRef={id:'reviewed',version:1};
  const reviewed={validFrom:'2026-11-01',validTo:null};
  const source={objectRef,geometryRef:oldRef,validFrom:'1995-09-25',validTo:null};
  const viewer={id:'active',objectRef,geometryRef:oldRef,validFrom:'1991-12-16',validTo:null};
  const earlier={...viewer,id:'earlier',validFrom:'1980-01-01',validTo:'1991-12-15'};
  const replace=replaceReviewedViewerBinding;
  const updated=replace([earlier,viewer],source,nextRef,reviewed,'2026-10-31');
  assert.equal(updated[0],earlier);
  assert.deepEqual(updated[1],{...viewer,validTo:'2026-10-31'});
  assert.deepEqual(updated[2],{...viewer,...reviewed,id:'active:reviewed:2026-11-01',geometryRef:nextRef});
  assert.throws(()=>replace([viewer,{...viewer,id:'duplicate'}],source,nextRef,reviewed,'2026-10-31'),/unique active Viewer binding/);
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
