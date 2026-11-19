import {readdirSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const variation=values=>{const mean=values.reduce((a,b)=>a+b,0)/values.length;return mean?Math.sqrt(values.reduce((sum,value)=>sum+(value-mean)**2,0)/values.length)/mean:0;};
export function compareMapLibrePerformance(baseline,candidate){
 const rows=[];
 for(const side of [baseline,candidate]){
  if(side.some(row=>['sourceSha256','wasmManifestSha256','browserVersion'].some(key=>typeof row.identity?.[key]!=='string'||!row.identity[key])||['width','height','dpr'].some(key=>!Number.isFinite(row.identity?.viewport?.[key])||row.identity.viewport[key]<=0)))throw Error('Missing performance identities');
  if(new Set(side.map(row=>row.identity.sourceSha256)).size!==1)throw Error('Performance source snapshots must not be mixed');
 }
 const pins=[...baseline,...candidate].map(row=>row.identity?.dataPin);
 if(pins.some(pin=>typeof pin!=='string'||!pin)||new Set(pins).size!==1)throw Error('Performance captures must share their data pin');
 const versions=[...baseline,...candidate].map(row=>row.metricVersion);
 if(versions.some(version=>version!==5)||new Set(versions).size!==1)throw Error('Performance captures must share their metric version');
 const groupKey=row=>JSON.stringify([row.scenario||'interaction',row.profile||'desktop',row.zoom??null]);
 const groups=[...new Set(baseline.map(groupKey))];
 if(!groups.length||JSON.stringify([...groups].sort())!==JSON.stringify([...new Set(candidate.map(groupKey))].sort()))throw Error('Performance scenarios must match');
 for(const group of groups){
  const [scenario,profile,zoom]=JSON.parse(group),select=values=>values.filter(value=>groupKey(value)===group);
  const before=select(baseline),after=select(candidate);
  if(before.length!==3||after.length!==3||new Set(before.map(row=>row.iteration)).size!==3||new Set(after.map(row=>row.iteration)).size!==3)throw Error('Each zoom requires three distinct baseline and candidate runs');
  const identities=[...before,...after].map(row=>JSON.stringify([row.identity.wasmManifestSha256,row.identity.viewport,row.identity.browserVersion]));
  if(new Set(identities).size!==1)throw Error('Performance environments must match');
  const metrics={...(scenario==='startup-date'?{}:{p95:row=>row.measured.frameGapP95Ms,p99:row=>row.measured.frameGapP99Ms}),initial:row=>row.initial.presentedAtMs,
   dateFirst:row=>row.dateTransitions[0].elapsedMs,dateOther:row=>row.dateTransitions[1].elapsedMs,dateRevisit:row=>row.dateTransitions[2].elapsedMs};
  for(const row of [...before,...after])if(scenario!=='startup-date'&&row.measured.sampleCount<500)throw Error('Insufficient active-frame samples');
  for(const [metric,read]of Object.entries(metrics)){
   const b=before.map(read),a=after.map(read);if([...b,...a].some(value=>!Number.isFinite(value)||value<0))throw Error('Missing performance metric: '+metric);
   const cv=variation(b),limit=Math.max(.1,2*cv),base=median(b),current=median(a);
   rows.push({scenario,profile,zoom,metric,baseline:base,candidate:current,baselineVariation:cv,limit,status:cv>.1?'unstable':current>base*(1+limit)?'regression':'passed'});
  }
 }
 return {ok:rows.every(row=>row.status==='passed'),rows};
}
function readCaptures(root){
 const output=[];
 function visit(directory){for(const entry of readdirSync(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isSymbolicLink())throw Error('Performance inputs must not be links');if(entry.isDirectory())visit(path);else if(entry.name==='globe-performance.json'){const value=JSON.parse(readFileSync(path,'utf8'));if(value.measured&&(value.zoom||value.scenario==='startup-date'))output.push(value);}}}
 visit(root);return output;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let baseline=readCaptures(process.argv[2]||'test-results/performance/baseline');
 if(!process.argv[2]&&existsSync('test-results/performance/baseline-retry')){const key=row=>JSON.stringify([row.scenario||'interaction',row.profile||'desktop',row.zoom??null]);const retry=readCaptures('test-results/performance/baseline-retry').filter(row=>row.metricVersion===baseline[0]?.metricVersion),groups=new Set(retry.map(key));baseline=[...baseline.filter(row=>!groups.has(key(row))),...retry];}
 let candidate=readCaptures(process.argv[3]||'test-results/performance/candidate');
 if(!process.argv[3]&&existsSync('test-results/performance/candidate-retry')){const key=row=>JSON.stringify([row.scenario||'interaction',row.profile||'desktop',row.zoom??null]);const retry=readCaptures('test-results/performance/candidate-retry').filter(row=>row.metricVersion===candidate[0]?.metricVersion),groups=new Set(retry.map(key));candidate=[...candidate.filter(row=>!groups.has(key(row))),...retry];}
 const result=compareMapLibrePerformance(baseline,candidate);
 console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;
}
