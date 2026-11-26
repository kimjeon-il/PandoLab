import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {applyReviewedSharedArcs,coordinateDigest,replaceReviewedDisplayBinding,reviewedBorderTouchesNeighbor,reviewedDisplayPeriod,validateReviewedPair} from '../../tools/build/reviewed-border-edition.mjs';
import {temporalContains} from '../../src/document/temporal.js';
import {assertHistoricalCompiledChanges,assertHistoricalSourceStorageChanges,worldPolygonsCompositionGeometry,worldPolygonsDisplayEvidencePath,worldPolygonsPartitionGeometry,worldPolygonsReviewedGeometry,worldPolygonsViewerGeometry} from '../../tools/gis/historical-display-review.mjs';
import * as reviewedEdition from '../../tools/build/reviewed-border-edition.mjs';

import {selectPhysicalLandAsset} from '../../src/data/physical-land-patch.js';

test('World Polygons limits only floating-point spill at a geographic boundary',()=>{
  const source={type:'Polygon',coordinates:[[[180.0000000000001,-89],[178,-89],[178,-90],[180.0000000000001,-89]]]};
  const normalized=worldPolygonsViewerGeometry(source);
  assert.deepEqual(normalized.coordinates,[[[180,-89],[178,-89],[178,-90],[180,-89]]]);
  assert.equal(source.coordinates[0][0][0],180.0000000000001);
  const invalid={type:'Polygon',coordinates:[[[180.001,-89],[178,-89],[178,-90],[180.001,-89]]]};
  assert.throws(()=>worldPolygonsViewerGeometry(invalid),/World Polygons geographic coordinate/);
});

test('World Polygons omits only explicitly detached holes outside every shell',()=>{
  const shell=[[0,0],[2,0],[2,2],[0,2],[0,0]];
  const otherShell=[[4,4],[6,4],[6,6],[4,6],[4,4]];
  const inside=[[1,1],[1.5,1],[1,1.5],[1,1]];
  const detached=[[10,10],[11,10],[10,11],[10,10]];
  const source={type:'MultiPolygon',coordinates:[[shell,inside,detached],[otherShell]]};
  assert.deepEqual(worldPolygonsViewerGeometry(source,{detachedHoles:[{polygon:0,ring:2}]}),
    {type:'MultiPolygon',coordinates:[[shell,inside],[otherShell]]});
  assert.deepEqual(source.coordinates[0],[shell,inside,detached]);
  assert.throws(()=>worldPolygonsViewerGeometry(source,{detachedHoles:[{polygon:0,ring:1}]}),/overlaps a World Polygons exterior/);
  assert.throws(()=>worldPolygonsViewerGeometry(source,{detachedHoles:[{polygon:0,ring:0}]}),/Invalid detached World Polygons hole/);
  const insideOther=[[5,5],[5.5,5],[5,5.5],[5,5]];
  const wrongParent={type:'MultiPolygon',coordinates:[[shell,insideOther],[otherShell]]};
  assert.throws(()=>worldPolygonsViewerGeometry(wrongParent,{detachedHoles:[{polygon:0,ring:1}]}),
    /overlaps a World Polygons exterior/);
});

test('World Polygons removes a duplicate polygon only when a retained polygon covers its filled area',()=>{
  const shell=[[0,0],[10,0],[10,10],[0,10],[0,0]];
  const hole=[[4,4],[6,4],[6,6],[4,6],[4,4]];
  const covered=[[1,1],[2,1],[2,2],[1,2],[1,1]];
  const island=[[4.5,4.5],[5,4.5],[5,5],[4.5,5],[4.5,4.5]];
  const source={type:'MultiPolygon',coordinates:[[covered],[shell,hole],[island]]};
  assert.deepEqual(worldPolygonsViewerGeometry(source,{coveredPolygons:[{polygon:0,coveredBy:1}]}),
    {type:'MultiPolygon',coordinates:[[shell,hole],[island]]});
  assert.throws(()=>worldPolygonsViewerGeometry(source,{coveredPolygons:[{polygon:2,coveredBy:1}]}),
    /World Polygons component is not fully covered/);
});

test('World Polygons composes the two Palestinian source polygons with their original rings',()=>{
  const gaza={type:'Polygon',coordinates:[[[34.2,31.2],[34.5,31.2],[34.5,31.6],[34.2,31.2]]]};
  const westBank={type:'MultiPolygon',coordinates:[[[[34.9,31.4],[35.5,31.4],[35.5,32.5],[34.9,31.4]]]]};
  const first='7abdd7db-fe64-4143-93b6-64a7af99b24b',second='78a503d5-8806-4e88-b28d-0a37c6648b06';
  const publication={geometries:{[first]:gaza,[second]:westBank},sourceFeatures:{
   [first]:{name:'Gaza Strip',genc:'XGZ'},[second]:{name:'West Bank',genc:'XWB'},
  }};
  const row={entityId:'state:PSX',method:'west-bank-and-gaza',candidateIds:[first,second]};
  assert.deepEqual(worldPolygonsCompositionGeometry(publication,row),{
    type:'MultiPolygon',coordinates:[gaza.coordinates,...westBank.coordinates],
  });
  assert.throws(()=>worldPolygonsCompositionGeometry(publication,{...row,candidateIds:[first,first]}));
  assert.throws(()=>worldPolygonsCompositionGeometry(publication,{...row,entityId:'state:UMI'}));
  assert.throws(()=>worldPolygonsCompositionGeometry({...publication,geometries:{[first]:gaza,[second]:gaza}},row),/non-overlapping/);
});

test('World Polygons resolves Colombia to its exact 99.5% source feature',()=>{
  const id='0d62fc32-17cb-4754-be06-a7e918ecfe3b';
  const geometry={type:'Polygon',coordinates:[[[0,0],[2,0],[0,2],[0,0]]]};
  const publication={geometries:{[id]:geometry},sourceFeatures:{[id]:{genc:'COL',wkbSha256:'a'.repeat(64)}}};
  const row={entityId:'state:COL',method:'confirmed-original-features',candidateIds:[id]};
  assert.deepEqual(worldPolygonsCompositionGeometry(publication,row),geometry);
  assert.throws(()=>worldPolygonsCompositionGeometry(publication,{...row,candidateIds:[id,id]}));
});

test('the Australian Indian Ocean Territories require both original islands',()=>{
  const ids=['de540a9e-416f-43ee-ac9f-4187bd4ca9e1','0ddbd39d-1604-4f42-8446-983fcd76104a'];
  const polygons=ids.map((_,i)=>({type:'Polygon',coordinates:[[[3*i,0],[3*i+1,0],[3*i,1],[3*i,0]]]}));
  const publication={geometries:Object.fromEntries(ids.map((id,i)=>[id,polygons[i]])),
    sourceFeatures:Object.fromEntries(ids.map((id,i)=>[id,{genc:['CCK','CXR'][i],wkbSha256:'a'.repeat(64)}]))};
  const row={entityId:'state:IOA',method:'confirmed-original-features',candidateIds:ids};
  assert.deepEqual(worldPolygonsCompositionGeometry(publication,row),{type:'MultiPolygon',coordinates:polygons.map(p=>p.coordinates)});
  assert.throws(()=>worldPolygonsCompositionGeometry(publication,{...row,candidateIds:ids.slice(1)}));
});

test('a reviewed composite uses the original owner and member polygons from the same edition',()=>{
  const mainland=[[[0,0],[2,0],[2,2],[0,2],[0,0]]];
  const amended=[[[6,0],[7,0],[7,1],[6,1],[6,0]]];
  const owner={type:'Polygon',coordinates:mainland};
  const donor={type:'MultiPolygon',coordinates:[amended]};
  const row={ownerSourceEntityId:'state:BRA',entityId:'state:BRI',ownerFeatureId:'brazil'};
  assert.deepEqual(worldPolygonsReviewedGeometry(donor,row,owner),{type:'MultiPolygon',coordinates:[mainland,amended]});
  assert.throws(()=>worldPolygonsReviewedGeometry(donor,row),/original owner/);
  assert.throws(()=>worldPolygonsReviewedGeometry(donor,row,donor),/overlap/);
  const adjoining={type:'Polygon',coordinates:[[[2,0],[3,0],[3,2],[2,2],[2,0]]]};
  const joined=worldPolygonsReviewedGeometry(adjoining,row,owner);
  assert.deepEqual(joined,{type:'MultiPolygon',coordinates:[[[[0,0],[3,0],[3,2],[0,2],[0,0]]]]});
});

test('World Polygons replaces one display binding without changing the earlier territory',()=>{
  const older={type:'Polygon',coordinates:[[[0,0],[2,0],[0,2],[0,0]]]};
  const current={type:'Polygon',coordinates:[[[0,0],[1,0],[0,1],[0,0]]]};
  const generalized={type:'Polygon',coordinates:[[[0,0],[1,0],[0,0.75],[0,0]]]};
  const oldRef={id:'older',version:1},currentRef={id:'current',version:1},objectRef={domain:'territorial',id:'AAA'};
  const olderRow={objectRef,geometryRef:oldRef,validFrom:'1900-01-01',validTo:'1950-12-31',sourceVersionId:'old'};
  const currentRow={objectRef,geometryRef:currentRef,validFrom:'1951-01-01',validTo:null,sourceVersionId:'current'};
  const country={entityId:'AAA',geometries:[{...oldRef,geojson:older},{...currentRef,geojson:current}],
    sourceBindings:[olderRow,currentRow],timelineRecords:{geometryBindings:[
      {id:'old',objectRef,geometryRef:oldRef,validFrom:olderRow.validFrom,validTo:olderRow.validTo},
      {id:'current',objectRef,geometryRef:currentRef,validFrom:currentRow.validFrom,validTo:null},
    ]},identity:{properties:{metadata:{historicalTimeline:{entityId:'state:AAA',geometryVersions:[
      {versionId:'old',validFrom:olderRow.validFrom,validTo:olderRow.validTo},
      {versionId:'current',validFrom:currentRow.validFrom,validTo:null},
    ]}}}}};
  const featureId='00000000-0000-4000-a000-000000000001';
  const source=gzipSync(JSON.stringify({sourceLayer:'DoS_WP_11_4_G99_5',sourceCrs:'EPSG:4326',
    sourcePackageSha256:'55fab422ef09e35eb48d68141b9ece0ace86d4276dfe332a04dfd401c0bfc80c',
    current:[{entityId:'state:AAA',versionId:'current',outcome:'candidate',candidateIds:[featureId]}],
    geometries:{[featureId]:generalized}}));
  const reference={reference:'assets/data/builtin-world/source/world-polygons-11.4-g99_5.json.gz',
    sha256:createHash('sha256').update(source).digest('hex')};
  const next=reviewedEdition.applyWorldPolygonsDisplay(country,[{binding:currentRow,geometry:generalized,featureId}],reference);
  const {sourceBindings,timelineRecords,geometries}=next;
  assert.deepEqual(sourceBindings[0],olderRow);
  assert.deepEqual(timelineRecords.geometryBindings[0],country.timelineRecords.geometryBindings[0]);
  assert.deepEqual(geometries.find(g=>g.id===sourceBindings[1].geometryRef.id).geojson,generalized);
  assert.deepEqual(sourceBindings.map(row=>[row.validFrom,row.validTo]),country.sourceBindings.map(row=>[row.validFrom,row.validTo]));
  assert.equal(timelineRecords.geometryBindings[1].geometryRef.id,sourceBindings[1].geometryRef.id);
  assert.deepEqual(country.geometries[1].geojson,current);
  assert.equal(assertHistoricalCompiledChanges(next,country,{readDisplayEvidence:()=>source}),1);
  const edited=reviewedEdition.applyWorldPolygonsDisplay(country,[{binding:currentRow,geometry:{
    type:'Polygon',coordinates:[[[0,0],[1,0],[0,.8],[0,0]]],
  },featureId}],reference);
  assert.throws(()=>assertHistoricalCompiledChanges(edited,country,{readDisplayEvidence:()=>source}),/differs from selected World Polygons/);
});

test('World Polygons partitions one original feature and switches both display bindings on the same day',()=>{
  const rectangle=(w,s,e,n)=>({type:'Polygon',coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]});
  const host=rectangle(0,0,5,4),mask=rectangle(-1,2,6,5);
  const {owner,member}=worldPolygonsPartitionGeometry(host,mask);
  assert.deepEqual(owner,rectangle(0,0,5,2));
  assert.deepEqual(member,rectangle(0,2,5,4));
  assert.throws(()=>worldPolygonsPartitionGeometry(host,rectangle(-1,5,6,7)),/two nonempty sides/);
  const period={displayValidFrom:'2026-11-26',previousDisplayThrough:'2026-11-25'};
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const edition={sourceLayer:'DoS_WP_11_4_G99_5',sourceCrs:'EPSG:4326',
    sourcePackageSha256:'55fab422ef09e35eb48d68141b9ece0ace86d4276dfe332a04dfd401c0bfc80c'};
  const original=gzipSync(JSON.stringify({...edition,current:[{entityId:'state:SOM',outcome:'candidate',candidateIds:['donor']}],geometries:{donor:host}}));
  const originalSource={reference:worldPolygonsDisplayEvidencePath(),sha256:hash(original)};
  const receipt=gzipSync(JSON.stringify({...edition,...period,originalSource,partitions:[{
    ownerEntityId:'state:SOM',memberEntityId:'state:SOL',featureId:'donor',mask,
    references:[{reference:'https://example.org/survey',sha256:'a'.repeat(64)},{reference:'https://example.org/map',sha256:'b'.repeat(64)}],
  }]}));
  const source={reference:worldPolygonsDisplayEvidencePath(hash(receipt),'partitions'),sha256:hash(receipt)};
  const readDisplayEvidence=path=>path===source.reference?receipt:original;
  for(const [entityId,validFrom,before,after] of [
    ['state:SOM',null,host,owner],['state:SOL','1991-05-18',rectangle(0,1,5,4),member],
  ]){
    const objectRef={domain:'territorial',id:entityId.slice(6)},geometryRef={id:'before',version:1};
    const binding={objectRef,geometryRef,validFrom,validTo:null,sourceVersionId:'current'};
    const country={entityId:objectRef.id,geometries:[{...geometryRef,geojson:before}],sourceBindings:[binding],
      timelineRecords:{geometryBindings:[{id:'binding',objectRef,geometryRef,validFrom,validTo:null}]},
      identity:{properties:{metadata:{historicalTimeline:{entityId,geometryVersions:[{versionId:'current',validFrom,validTo:null}]}}}}};
    const next=reviewedEdition.applyWorldPolygonsDisplay(country,[{binding,geometry:after,featureId:'donor'}],source,period);
    assert.equal(assertHistoricalCompiledChanges(next,country,{readDisplayEvidence}),1);
    for(const rows of [next.sourceBindings,next.timelineRecords.geometryBindings]){
      assert.deepEqual(rows.map(({validFrom,validTo})=>[validFrom,validTo]),[[validFrom,'2026-11-25'],['2026-11-26',null]]);
      const resolve=date=>next.geometries.find(g=>g.id===rows.find(row=>temporalContains(row,date)).geometryRef.id).geojson;
      assert.deepEqual(resolve('2026-11-25'),before);
      assert.deepEqual(resolve('2026-11-26'),after);
    }
  }
});

test('a reviewed waterway uses the exact midpoint of each surveyed cross section',()=>{
  const baseline='a'.repeat(40),entities=['state:AAA','state:BBB'];
  const arc=[[1,.03],[1.1,.5],[1,.97]],before=[[1,0],[1,1]];
  const section={before,beforeSha256:coordinateDigest(before),after:[before[0],...arc,before[1]]};
  const authority={schemaVersion:1,baseline,entities,kind:'surveyed-bank-midpoints',source:{reference:'https://example.org/water',sha256:'b'.repeat(64)},arcs:[{coordinates:arc,banks:[[[.99,.03],[1.01,.03]],[[1.09,.5],[1.11,.5]],[[.99,.97],[1.01,.97]]]}]};
  assert.doesNotThrow(()=>reviewedEdition.validateDisplayedBorderAuthority(authority,[section],{baseline,entities}));
  authority.arcs[0].banks[1][0][0]=1;
  assert.throws(()=>reviewedEdition.validateDisplayedBorderAuthority(authority,[section],{baseline,entities}),/bank midpoint/);
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

test('the reviewed modern coast is selected without replacing historical land masks',()=>{
  const base={sha256:'a'.repeat(64)},historical={sha256:'b'.repeat(64)},asset={sha256:'c'.repeat(64)};
  const modern={validFrom:'2026-11-01',asset};
  const select=selectPhysicalLandAsset;
  assert.equal(select(base,modern,base,'2026-10'),base);
  assert.equal(select(base,modern,historical,'1922-06'),historical);
  assert.equal(select(base,modern,base,'2026-11'),asset);
  assert.equal(select(base,modern,base,null),base);
  assert.throws(()=>select(base,modern,historical,'2026-11'),/land derivative/);
});
