import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {compareMapLibrePerformance} from '../../../scripts/compare-maplibre-performance.mjs';
import {historicalPerformanceMapLibreAssets,performanceMapLibreIdentity} from '../../../scripts/lib/performance-maplibre-assets.mjs';
import {createRenderingMetrics} from '../../../src/rendering/rendering-metrics.js';
import {countryBoundaryOwner,countryBoundarySeedOptions,loadCountryBoundarySeed} from '../../../src/rendering/country-boundary-seed.js';
import {countryGeometrySignature} from '../../../src/rendering/country-shared-boundary-cache.js';

const transferIdentity=source=>({sourceCommit:(source==='baseline'?'1':'2').repeat(40),mapLibre:{module:'a'.repeat(64),worker:'b'.repeat(64)}});

test('historical performance uses the selected vendor generator, helper and config bytes',async()=>{
 const root=process.cwd(),commit='1'.repeat(40),readCurrent=path=>readFileSync(resolve(root,path));
 const fixture=new Map([
  ['package.json',JSON.stringify({...JSON.parse(readCurrent('package.json')),name:'historical-viewer'})],
  ['scripts/lib/maplibre-vendor.mjs',`import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {marker} from './vendor-helper.mjs';
export function mapLibreVendorAssets(root){
 const name=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')).name;
 return new Map([
  ['assets/vendor/maplibre-gl/maplibre-gl.mjs',Buffer.from(name+':'+marker.toString())],
  ['assets/vendor/maplibre-gl/maplibre-gl-worker.mjs',Buffer.from(marker())]
 ]);
}`],
  ['scripts/lib/vendor-helper.mjs',"export function marker(){ return 'previous-worker'; }"]
 ]);
 const readBaseline=path=>fixture.has(path)?Buffer.from(fixture.get(path)):readCurrent(path);
 const old=await historicalPerformanceMapLibreAssets({root,commit,readBaseline});
 assert.equal(old.get('assets/vendor/maplibre-gl/maplibre-gl.mjs').toString(),"historical-viewer:function marker(){ return 'previous-worker'; }");
 assert.equal(old.get('assets/vendor/maplibre-gl/maplibre-gl-worker.mjs').toString(),'previous-worker');
 fixture.set('scripts/lib/vendor-helper.mjs',"export function marker(){ return 'candidate-worker'; }");
 const next=await historicalPerformanceMapLibreAssets({root,commit,readBaseline});
 assert.notDeepEqual(performanceMapLibreIdentity(old),performanceMapLibreIdentity(next));
 fixture.set('pnpm-lock.yaml',readCurrent('pnpm-lock.yaml').toString().replace(/(maplibre-gl@[^:]+:\s+resolution: \{integrity: )sha512-[^}]+/,'$1sha512-different'));
 await assert.rejects(historicalPerformanceMapLibreAssets({root,commit,readBaseline}),/verified Pages artifact/);
});

test('a different locked MapLibre build requires matching Pages bytes and provenance',async t=>{
 const root=process.cwd(),commit='1'.repeat(40),pin={revision:'2'.repeat(40),repository:'owner/library'};
 const artifactRoot=mkdtempSync(join(tmpdir(),'pando-perf-maplibre-'));
 t.after(()=>rmSync(artifactRoot,{recursive:true,force:true}));
 const receiptPath=join(artifactRoot,'pages-evidence.json');
 const assets=new Map(['maplibre-gl.mjs','maplibre-gl-worker.mjs','maplibre-gl-shared.mjs','maplibre-gl.css','LICENSE.txt']
  .map(file=>['assets/vendor/maplibre-gl/'+file,Buffer.from('historical '+file)]));
 const frontendInputSha256='a'.repeat(64);
 const expected={schema:'pando-web-pages-staging',productMode:'viewer',sourceCommit:commit,frontendInputSha256,
  deploymentIdentity:{schema:'pando-p2-deploy-identity-v1',verified:true,sourceCommit:commit,dataCommit:pin.revision,frontendInputSha256},
  dataCommit:pin.revision,dataRepository:pin.repository,files:[...assets].map(([path,bytes])=>({
   path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),
  }))};
 for(const [path,bytes] of assets){const file=resolve(artifactRoot,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,bytes);}
 writeFileSync(receiptPath,JSON.stringify(expected));
 const readBaseline=path=>path==='config/library-data.json'?Buffer.from(JSON.stringify(pin)):
  path==='pnpm-lock.yaml'?Buffer.from(readFileSync(resolve(root,path),'utf8').replace(/(maplibre-gl@[^:]+:\s+resolution: \{integrity: )sha512-[^}]+/,'$1sha512-different')):readFileSync(resolve(root,path));
 const options={root,commit,readBaseline,artifactRoot,receiptPath};
 assert.deepEqual(await historicalPerformanceMapLibreAssets(options),assets);
 await assert.rejects(historicalPerformanceMapLibreAssets({...options,commit:'3'.repeat(40)}),/does not match the baseline/);
 writeFileSync(receiptPath,JSON.stringify({...expected,deploymentIdentity:undefined}));
 await assert.rejects(historicalPerformanceMapLibreAssets(options),/does not match the baseline/);
 writeFileSync(receiptPath,JSON.stringify(expected));
 writeFileSync(resolve(artifactRoot,expected.files[1].path),'wrong Worker');
 await assert.rejects(historicalPerformanceMapLibreAssets(options),/baseline artifact hash mismatch/);
});

test('performance comparison rejects regressions, unstable baselines and missing active samples',()=>{
 const make=(scale=1,sourceSha256='candidate')=>[1,3,5,'polar'].flatMap(view=>[1,2,3].map(iteration=>({
  metricVersion:5,scenario:view==='polar'?'polar-interaction':'interaction',profile:'desktop',zoom:view==='polar'?3:view,iteration,initial:{presentedAtMs:100*scale},
  identity:{...transferIdentity(sourceSha256),dataPin:'same',sourceSha256,wasmManifestSha256:'wasm',browserVersion:'browser',
   viewport:{width:1280,height:800,dpr:1}},
  measured:{sampleCount:520,frameGapP95Ms:20*scale,frameGapP99Ms:30*scale,
   nativeSampleCount:520,nativeFrameGapP95Ms:20*scale,nativeFrameGapP99Ms:30*scale},
  dateTransitions:Array.from({length:3},()=>({elapsedMs:50*scale})),
 })));
 const baseline=make(1,'baseline');
 const compare=(before,after)=>compareMapLibrePerformance(before,after,{scope:'interaction'});
 assert.equal(compare(baseline,make(1.05)).ok,true);
 assert.ok(compare(baseline,make(1.3)).rows.every(row=>row.status==='regression'));
 const unstable=make(1,'baseline');unstable[0].measured.frameGapP95Ms=60;assert.equal(compare(unstable,make()).rows.find(row=>row.zoom===1&&row.metric==='p95').status,'unstable');
 const missing=make();missing[0].measured.sampleCount=499;assert.throws(()=>compare(baseline,missing),/samples/);
 const nativeRegression=make();
 for(const row of nativeRegression)row.measured.nativeFrameGapP99Ms=999;
 assert.equal(compare(baseline,nativeRegression).ok,false);
 nativeRegression[0].measured.nativeSampleCount=499;
 assert.throws(()=>compare(baseline,nativeRegression),/native.*samples/);
 delete nativeRegression[0].measured.nativeSampleCount;
 assert.throws(()=>compare(baseline,nativeRegression),/native.*samples/);
 const different=make();different[0].identity.dataPin='other';assert.throws(()=>compare(baseline,different),/data pin/);
 const oldMetric=make();oldMetric[0].metricVersion=2;assert.throws(()=>compare(baseline,oldMetric),/metric version/);
 const changedVendor=make();for(const row of changedVendor)row.identity.mapLibre.worker='c'.repeat(64);
 assert.equal(compare(baseline,changedVendor).mapLibre.changed,true);
 assert.equal(compare(baseline,make()).mapLibre.changed,false);
 changedVendor[0].identity.mapLibre.worker='d'.repeat(64);
 assert.throws(()=>compare(baseline,changedVendor),/MapLibre transfers must not be mixed/);
 delete changedVendor[0].identity.mapLibre;
 assert.throws(()=>compare(baseline,changedVendor),/MapLibre transfer identity/);
});

test('startup and date comparisons are independent of drag captures and reject changed environments',()=>{
 const make=(sourceSha256='candidate')=>['desktop','mobile'].flatMap(profile=>[1,2,3].map(iteration=>({metricVersion:7,scenario:'startup-date',profile,iteration,identity:{...transferIdentity(sourceSha256),dataPin:'same',sourceSha256,wasmManifestSha256:'same',viewport:{width:profile==='mobile'?390:1280,height:800,dpr:1},browserVersion:'same'},initial:{presentedAtMs:100},warmInitialMs:70,measured:{},dateTransitions:[{elapsedMs:50},{elapsedMs:50},{elapsedMs:40}]})));
 const baseline=make('baseline');
 const compare=(before,after,options)=>compareMapLibrePerformance(before,after,{scope:'startup-date',...options});
 assert.equal(compare(baseline,make()).ok,true);
 const previousProbe=make();previousProbe[0].metricVersion=6;
 assert.throws(()=>compare(baseline,previousProbe),/metric version/);
 const mixedWasm=make();mixedWasm[0].identity.wasmManifestSha256='other';
 assert.throws(()=>compare(baseline,mixedWasm,{allowWasmChange:true}),/snapshots must not be mixed/);
 const changed=make();for(const row of changed)row.identity.wasmManifestSha256='another verified WASM';
 assert.throws(()=>compare(baseline,changed),/environments/);
 assert.equal(compare(baseline,changed,{allowWasmChange:true}).wasmChanged,true);
 assert.throws(()=>compare(baseline,make().filter(row=>row.profile==='desktop')),/scenarios/);
 const missing=make();for(const row of missing)delete row.identity.browserVersion;
 assert.throws(()=>compare(missing,missing),/identit/);
 const mixed=make();mixed[1].identity.sourceSha256='another-source';
 assert.throws(()=>compare(baseline,mixed),/source/);
});

test('performance report requires distinct snapshots and complete requested coverage',()=>{
 const make=sourceSha256=>[1,2,3].map(iteration=>({
  metricVersion:7,scenario:'startup-date',profile:'desktop',iteration,
  identity:{...transferIdentity(sourceSha256),dataPin:'data',sourceSha256,wasmManifestSha256:'wasm',browserVersion:'browser',viewport:{width:1280,height:800,dpr:1}},
  initial:{presentedAtMs:100},warmInitialMs:70,measured:{},
  dateTransitions:[{month:'2025-12',elapsedMs:50},{month:'1925-12',elapsedMs:50},{month:'2025-12',elapsedMs:40}],
 }));
 const desktop=make('baseline');
 assert.throws(()=>compareMapLibrePerformance(desktop,desktop),/distinct/);
 assert.throws(()=>compareMapLibrePerformance(desktop,make('candidate')),/coverage/);
 assert.throws(()=>compareMapLibrePerformance(desktop,make('candidate'),{scope:'startup-date'}),/coverage/);
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
