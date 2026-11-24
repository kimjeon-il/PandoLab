import {readdirSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const variation=values=>{const mean=values.reduce((a,b)=>a+b,0)/values.length;return mean?Math.sqrt(values.reduce((sum,value)=>sum+(value-mean)**2,0)/values.length)/mean:0;};
const interactionCoverage=[['interaction','desktop',1], ['interaction','desktop',3],
 ['interaction','desktop',5], ['polar-interaction','desktop',3]];
const startupCoverage=[['startup-date','desktop',null], ['startup-date','mobile',null]];
const comparisonCoverage={
 full:[...interactionCoverage,...startupCoverage],
 interaction:interactionCoverage,
 'startup-date':startupCoverage,
};

const groupKey=row=>JSON.stringify([row.scenario,row.profile,row.zoom??null]);
const hash=/^[a-f0-9]{64}$/;
const commit=/^[a-f0-9]{40}$/;

export function compareMapLibrePerformance(baseline,candidate,{allowWasmChange=false,scope='full'}={}){
 if(!Object.hasOwn(comparisonCoverage,scope))throw Error('Unknown performance comparison scope: '+scope);
 const rows=[];
 for(const side of [baseline,candidate]){
  if(side.some(row=>['sourceSha256','wasmManifestSha256','browserVersion'].some(key=>typeof row.identity?.[key]!=='string'||!row.identity[key])||['width','height','dpr'].some(key=>!Number.isFinite(row.identity?.viewport?.[key])||row.identity.viewport[key]<=0)))throw Error('Missing performance identities');
  if(side.some(({identity})=>!commit.test(identity.sourceCommit||'')||
   !hash.test(identity.mapLibre?.module||'')||!hash.test(identity.mapLibre?.worker||'')))throw Error('Missing performance source or MapLibre transfer identity');
  if(new Set(side.map(({identity})=>identity.sourceCommit+'|'+identity.sourceSha256)).size!==1)throw Error('Performance source snapshots must not be mixed');
  if(new Set(side.map(({identity})=>identity.mapLibre.module+'|'+identity.mapLibre.worker)).size!==1)
   throw Error('Performance MapLibre transfers must not be mixed');
  if(new Set(side.map(row=>row.identity.wasmManifestSha256)).size!==1)throw Error('Performance WASM snapshots must not be mixed');
 }
 if(baseline[0].identity.sourceSha256===candidate[0].identity.sourceSha256)
  throw Error('Performance baseline and candidate must use distinct source snapshots');
 const pins=[...baseline,...candidate].map(row=>row.identity?.dataPin);
 if(pins.some(pin=>typeof pin!=='string'||!pin)||new Set(pins).size!==1)throw Error('Performance captures must share their data pin');
 if([...baseline,...candidate].some(row=>row.metricVersion!==(row.scenario==='startup-date'?7:5)))
  throw Error('Performance captures must use the current scenario metric version');
 const required=comparisonCoverage[scope].map(group=>JSON.stringify(group));
 for(const captures of [baseline,candidate]){
  const actual=new Set(captures.map(groupKey));
  if(actual.size!==required.length||required.some(group=>!actual.has(group)))
   throw Error('Performance scenarios must match required coverage for '+scope);
 }
 for(const group of required){
  const [scenario,profile,zoom]=JSON.parse(group),select=values=>values.filter(value=>groupKey(value)===group);
  const before=select(baseline),after=select(candidate);
  if(before.length!==3||after.length!==3||new Set(before.map(row=>row.iteration)).size!==3||new Set(after.map(row=>row.iteration)).size!==3)throw Error('Each zoom requires three distinct baseline and candidate runs');
  const identities=[...before,...after].map(row=>JSON.stringify([allowWasmChange?null:row.identity.wasmManifestSha256,row.identity.viewport,row.identity.browserVersion,row.dateTransitions.map(date=>date.month)]));
  if(new Set(identities).size!==1)throw Error('Performance environments must match');
  const metrics={...(scenario==='startup-date'?{warmInitial:row=>row.warmInitialMs}:{p95:row=>row.measured.frameGapP95Ms,p99:row=>row.measured.frameGapP99Ms}),initial:row=>row.initial.presentedAtMs,
   dateFirst:row=>row.dateTransitions[0].elapsedMs,dateOther:row=>row.dateTransitions[1].elapsedMs,dateRevisit:row=>row.dateTransitions[2].elapsedMs};
  if(scenario!=='startup-date'){
   for(const {measured,iteration,label} of [...before,...after]){
    const context=`${label||'capture'}, ${scenario}, ${profile}, zoom ${zoom}, repeat ${iteration}`;
    if(!Number.isInteger(measured?.sampleCount)||measured.sampleCount<500)
     throw Error(`Insufficient active-frame samples (${measured?.sampleCount ?? 'missing'}; ${context})`);
    if(!Number.isInteger(measured?.nativeSampleCount)||measured.nativeSampleCount<500)
     throw Error(`Insufficient native render samples (${measured?.nativeSampleCount ?? 'missing'}; ${context})`);
   }
   metrics.nativeP95=row=>row.measured.nativeFrameGapP95Ms;
   metrics.nativeP99=row=>row.measured.nativeFrameGapP99Ms;
  }
  for(const [metric,read]of Object.entries(metrics)){
   const b=before.map(read),a=after.map(read);if([...b,...a].some(value=>!Number.isFinite(value)||value<0))throw Error('Missing performance metric: '+metric);
   const cv=variation(b),limit=Math.max(.1,2*cv),base=median(b),current=median(a);
   rows.push({scenario,profile,zoom,metric,baseline:base,candidate:current,baselineVariation:cv,limit,status:cv>.1?'unstable':current>base*(1+limit)?'regression':'passed'});
  }
 }
 const before=baseline[0].identity,after=candidate[0].identity;
 return {scope,ok:rows.every(row=>row.status==='passed'),wasmChanged:before.wasmManifestSha256!==after.wasmManifestSha256,
  mapLibre:{baseline:before.mapLibre,candidate:after.mapLibre,changed:before.mapLibre.module!==after.mapLibre.module||before.mapLibre.worker!==after.mapLibre.worker},rows};
}
function readCaptures(root){
 const output=[];
 function visit(directory){for(const entry of readdirSync(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isSymbolicLink())throw Error('Performance inputs must not be links');if(entry.isDirectory())visit(path);else if(entry.name==='globe-performance.json'){const value=JSON.parse(readFileSync(path,'utf8'));if(value.measured&&(value.zoom||value.scenario==='startup-date'))output.push(value);}}}
 visit(root);return output;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const readSide=(directory,label)=>{
  const rows=readCaptures(directory||'test-results/performance/'+label);
  const retryPath='test-results/performance/'+label+'-retry';
  if(directory||!existsSync(retryPath))return rows;
  const key=row=>JSON.stringify([groupKey(row),row.metricVersion]);
  const current=new Set(rows.map(key));
  const retries=readCaptures(retryPath).filter(row=>current.has(key(row)));
  const retried=new Set(retries.map(key));
  return [...rows.filter(row=>!retried.has(key(row))),...retries];
 };
 const args=process.argv.slice(2);
 const scopes=args.filter(arg=>arg.startsWith('--scope='));
 const directories=args.filter(arg=>!arg.startsWith('--'));
 if(scopes.length>1||directories.length===1||directories.length>2
   ||args.some(arg=>arg.startsWith('--')&&arg!=='--allow-wasm-change'&&!arg.startsWith('--scope=')))
  throw Error('Usage: compare-maplibre-performance.mjs [baseline candidate] [--scope=full|interaction|startup-date] [--allow-wasm-change]');
 const scope=scopes[0]?.slice('--scope='.length)??'full';
 const baseline=readSide(directories[0],'baseline'),candidate=readSide(directories[1],'candidate');
 const result=compareMapLibrePerformance(baseline,candidate,{scope,allowWasmChange:args.includes('--allow-wasm-change')});
 console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;
}
