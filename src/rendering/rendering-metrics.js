// Aggregate timings only; no per-frame history or geometry is retained.
export function createRenderingMetrics(now=()=>performance.now()){
 const phases=new Map();let publications=0,firstPublishedAt=null;
 function record(name,elapsed){
  if(!phases.has(name)&&phases.size>=63)name='other';
  const row=phases.get(name)||{count:0,totalMs:0,maxMs:0};
  row.count++;row.totalMs+=elapsed;row.maxMs=Math.max(row.maxMs,elapsed);phases.set(name,row);
 }
 function begin(name){const started=now();let ended=false;return ()=>{if(ended)return;ended=true;record(name,Math.max(0,now()-started));};}
 function run(name,work){const end=begin(name);try{return work();}finally{end();}}
 function track(name,work){const end=begin(name);try{return Promise.resolve(work()).finally(end);}catch(error){end();throw error;}}
 return {begin,run,track,record,publish(){publications++;firstPublishedAt??=now();},snapshot:()=>({publications,firstPublishedAt,phases:Object.fromEntries([...phases].map(([name,row])=>[name,{...row}]))})};
}
