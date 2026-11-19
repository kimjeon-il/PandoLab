import test from 'node:test';
import assert from 'node:assert/strict';
import {compareMapLibrePerformance} from '../../../scripts/compare-maplibre-performance.mjs';
import {createRenderingMetrics} from '../../../src/rendering/rendering-metrics.js';
import {countryBoundaryOwner,countryBoundarySeedOptions,loadCountryBoundarySeed} from '../../../src/rendering/country-boundary-seed.js';
import {countryGeometrySignature} from '../../../src/rendering/country-shared-boundary-cache.js';

test('performance comparison rejects regressions, unstable baselines and missing active samples',()=>{
 const make=(scale=1)=>[1,3,5].flatMap(zoom=>[1,2,3].map(iteration=>({metricVersion:5,zoom,iteration,initial:{presentedAtMs:100*scale},identity:{dataPin:'same',sourceSha256:'source',wasmManifestSha256:'wasm',browserVersion:'browser',viewport:{width:1280,height:800,dpr:1}},measured:{sampleCount:520,frameGapP95Ms:20*scale,frameGapP99Ms:30*scale,stats:{firstCanonicalFrameMs:100*scale}},dateTransitions:Array.from({length:3},()=>({elapsedMs:50*scale}))})));
 const baseline=make();assert.equal(compareMapLibrePerformance(baseline,make(1.05)).ok,true);
 assert.ok(compareMapLibrePerformance(baseline,make(1.3)).rows.every(row=>row.status==='regression'));
 const unstable=make();unstable[0].measured.frameGapP95Ms=60;assert.equal(compareMapLibrePerformance(unstable,make()).rows.find(row=>row.zoom===1&&row.metric==='p95').status,'unstable');
 const missing=make();missing[0].measured.sampleCount=499;assert.throws(()=>compareMapLibrePerformance(baseline,missing),/samples/);
 const different=make();different[0].identity.dataPin='other';assert.throws(()=>compareMapLibrePerformance(baseline,different),/data pin/);
 const oldMetric=make();oldMetric[0].metricVersion=2;assert.throws(()=>compareMapLibrePerformance(baseline,oldMetric),/metric version/);
});

test('startup and date comparisons are independent of drag captures and reject changed environments',()=>{
 const make=()=>['desktop','mobile'].flatMap(profile=>[1,2,3].map(iteration=>({metricVersion:6,scenario:'startup-date',profile,iteration,identity:{dataPin:'same',sourceSha256:'source',wasmManifestSha256:'same',viewport:{width:profile==='mobile'?390:1280,height:800,dpr:1},browserVersion:'same'},initial:{presentedAtMs:100},warmInitialMs:70,measured:{},dateTransitions:[{elapsedMs:50},{elapsedMs:50},{elapsedMs:40}]})));
 assert.equal(compareMapLibrePerformance(make(),make()).ok,true);
 const changed=make();changed[0].identity.wasmManifestSha256='other';assert.throws(()=>compareMapLibrePerformance(make(),changed),/environments/);
 assert.throws(()=>compareMapLibrePerformance(make(),make().filter(row=>row.profile==='desktop')),/scenarios/);
 const missing=make();for(const row of missing)delete row.identity.browserVersion;
 assert.throws(()=>compareMapLibrePerformance(missing,missing),/identit/);
 const mixed=make();mixed[1].identity.sourceSha256='another-source';
 assert.throws(()=>compareMapLibrePerformance(make(),mixed),/source/);
});

test('rendering timings close failures and expose detached aggregate snapshots',async()=>{
 let now=0;const metrics=createRenderingMetrics(()=>now);
 assert.throws(()=>metrics.run('sync',()=>{now=7;throw Error('failed');}),/failed/);
 await assert.rejects(metrics.track('source',async()=>{now=15;throw Error('failed');}),/failed/);
 const snapshot=metrics.snapshot();assert.equal(snapshot.phases.sync.totalMs,7);assert.equal(snapshot.phases.source.totalMs,8);
 snapshot.phases.sync.totalMs=100;assert.equal(metrics.snapshot().phases.sync.totalMs,7);
});

test('boundary seed reuse is source-bound and changed geometry is recomputed',async()=>{
 const feature={id:'A',geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[0,1],[0,0]]]}},seed={version:1,quality:'canonical',segments:[],signatures:{A:countryGeometrySignature(feature)}};
 assert.equal(countryBoundaryOwner('territorial:entity:history%3AA'),'history:A');
 assert.equal(countryBoundarySeedOptions([feature],seed).changedIds.size,0);
 assert.equal(countryBoundarySeedOptions([{...feature,geometry:{type:'MultiPolygon',coordinates:[feature.geometry.coordinates]}}],seed).changedIds.size,0,'a one-polygon wrapper has identical topology');
 assert.deepEqual([...countryBoundarySeedOptions([{...feature,geometry:{type:'Polygon',coordinates:[[[0,0],[2,0],[0,1],[0,0]]]}}],seed).changedIds],['A']);
 const meta={countryBoundarySeed:{url:'assets/data/seed.json.gz',sha256:'a'.repeat(64),worldCatalogSha256:'world'},projectCatalogs:{world:{sha256:'other'}}};
 assert.equal(await loadCountryBoundarySeed(meta,()=>{throw Error('must not fetch a different project seed');}),null);
 meta.projectCatalogs.world.sha256='world';assert.equal(await loadCountryBoundarySeed(meta,async()=>seed),seed);
 await assert.rejects(loadCountryBoundarySeed(meta,async()=>({...seed,quality:'preview'})),/canonical/);
});
