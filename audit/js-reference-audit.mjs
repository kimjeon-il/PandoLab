import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const espree=createRequire(require.resolve('eslint'))('espree');
const roots=[['PandoLab','.'],['map-toolkit','_audit/map-toolkit'],['PandoLab-Data','_audit/library']];
const retired=['JobScheduler','JobToken','JobTicket','JobStats','JobStop','JobDisposition','jobDispositionCode','endpointValue','validityValue','readGeometryProvenance','TimelineChangePeriod','timelineChangePeriods','snapshotTimelineStorage','timelineInitialMonth','distributionReferenceDiagnostics','distributionReferencesForWeb','admitExternalBaseline'];
const reference=['referenceImageCalculate','referenceImagePlacement','referenceGradientField','referenceSnapAnchor','referenceTraceTree','referenceTracePath','referenceSimplifyTrace','referenceRefineTrace','referenceBoundaryGraph','PreparedReferenceImageWarp'];
const inventory=(root)=>execFileSync('git',['-C',root,'ls-files','-z'],{encoding:'utf8',maxBuffer:64*1024*1024}).split('\0').filter(Boolean);
const native=/\.(?:cpp|cc|cxx|h|hpp|hxx|cmake)$|(?:^|\/)CMakeLists\.txt$/;
const javascript=/\.(?:mjs|js|cjs|jsx)$/;
const generated=/^assets\/(?:wasm|js-vendor)\//;
const own=inventory('.');
const bindings=[];
for(const file of own.filter(f=>/\/native\/bindings\/.*\.cpp$/.test(f))){
 const source=fs.readFileSync(file,'utf8');
 for(const [kind,pattern] of [
  ['function',/emscripten::function\s*\(\s*"([^"]+)"/g],
  ['method',/\.function\s*\(\s*"([^"]+)"/g],
  ['class',/emscripten::class_<[^>]+>\s*\(\s*"([^"]+)"/g],
  ['constant',/emscripten::constant\s*\(\s*"([^"]+)"/g]
 ])for(const match of source.matchAll(pattern))bindings.push({kind,name:match[1],file,line:source.slice(0,match.index).split('\n').length});
}
const names=new Set([...bindings.map(b=>b.name),...retired,...reference]);
const report={bindings,retired,reference,repositories:[],references:{},nativeReferences:{},parseErrors:[],missingFiles:[],edges:[],dynamicCalls:[]};
const record=(table,name,row)=>{(table[name]??=[]).push(row);};
const sourceKind=f=>f.startsWith('tests/')?'test':f.startsWith('src/')||f.startsWith('plugins/')?'runtime':f.startsWith('reports/')?'report':'tool';
function scanNative(root,repo,file){
 const source=fs.readFileSync(path.join(root,file),'utf8');
 const clean=source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,m=>m.replace(/[^\n]/g,' '));
 for(const name of retired){
  const re=new RegExp('\\b'+name+'\\b','g');
  for(const m of clean.matchAll(re))record(report.nativeReferences,name,{repo,file,line:clean.slice(0,m.index).split('\n').length});
 }
}
function scanJs(root,repo,file,files){
 const source=fs.readFileSync(path.join(root,file),'utf8');
 let ast;
 try{ast=espree.parse(source,{ecmaVersion:'latest',sourceType:'module',loc:true,range:true,ecmaFeatures:{jsx:true}});}
 catch(first){try{ast=espree.parse(source,{ecmaVersion:'latest',sourceType:'script',loc:true,range:true,ecmaFeatures:{jsx:true}});}
 catch(second){report.parseErrors.push({repo,file,error:second.message});for(const name of names){const re=new RegExp('\\b'+name+'\\b','g');for(const m of source.matchAll(re))record(report.references,name,{repo,file,line:source.slice(0,m.index).split('\n').length,kind:'unparsed-token',scope:sourceKind(file)});}return;}}
 const add=(name,node,kind)=>{if(names.has(name))record(report.references,name,{repo,file,line:node.loc.start.line,kind,scope:sourceKind(file)});};
 const edge=(s,node,kind)=>{
  if(typeof s!=='string'||!s.startsWith('.'))return;
  const p=path.posix.normalize(path.posix.join(path.posix.dirname(file),s.split(/[?#]/)[0]));
  const target=[p,p+'.js',p+'.mjs',p+'/index.js'].find(x=>files.has(x));
  report.edges.push({repo,from:file,to:target??p,resolved:!!target,kind,line:node.loc.start.line});
 };
 function walk(node,parent=null){
  if(!node||typeof node.type!=='string')return;
  if(node.type==='Identifier'||(node.type==='Literal'&&typeof node.value==='string')){
   const name=node.type==='Identifier'?node.name:node.value;
   let kind=node.type==='Identifier'?'identifier':'string';
   if(parent?.type==='MemberExpression'&&parent.property===node)kind='member';
   if((parent?.type==='CallExpression'||parent?.type==='NewExpression')&&parent.callee===node)kind='direct-call';
   if(parent?.type==='CallExpression'&&parent.arguments.includes(node)&&node.type==='Literal')kind='dispatch-or-argument';
   add(name,node,kind);
  }
  if(node.type==='CallExpression'||node.type==='NewExpression'){
   const c=node.callee;
   if(c?.type==='MemberExpression'){
    const name=c.computed?c.property.value:c.property.name;
    if(typeof name==='string')add(name,node,node.type==='NewExpression'?'member-constructor':'member-call');
    else if(c.computed&&/^(?:core|session|module|sharedCalculationCore|engine|wasm)$/i.test(c.object?.name??''))report.dynamicCalls.push({repo,file,line:node.loc.start.line,text:source.slice(...node.range).slice(0,220)});
   }
   if(c?.type==='Identifier'&&['URL','importScripts'].includes(c.name)){
    for(const a of node.arguments)if(a?.type==='Literal')edge(a.value,node,c.name);
   }
  }
  if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration','ImportExpression'].includes(node.type)&&node.source?.type==='Literal')edge(node.source.value,node,node.type);
  for(const [key,v] of Object.entries(node)){if(['loc','range','start','end','type'].includes(key))continue;if(Array.isArray(v)){for(const child of v)if(child&&typeof child.type==='string')walk(child,node);}else if(v&&typeof v.type==='string')walk(v,node);}
 }
 walk(ast);
}
for(const [repo,root] of roots){
 const files=inventory(root), set=new Set(files);let js=0,cpp=0,excluded=0;
 for(const file of files){
  if(generated.test(file)){if(javascript.test(file))excluded++;continue;}
  if(!javascript.test(file)&&!native.test(file))continue;
  if(!fs.existsSync(path.join(root,file))){report.missingFiles.push({repo,file});continue;}
  if(javascript.test(file)){js++;scanJs(root,repo,file,set);}
  if(native.test(file)){cpp++;scanNative(root,repo,file);}
 }
 report.repositories.push({repo,revision:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),js,cpp,excluded});
}
const graph=new Map();
for(const e of report.edges.filter(e=>e.repo==='PandoLab'&&e.resolved)){const rows=graph.get(e.from)??[];rows.push(e.to);graph.set(e.from,rows);}
const reached=new Set(),todo=['src/app/viewer.js'];while(todo.length){const f=todo.pop();if(reached.has(f))continue;reached.add(f);todo.push(...(graph.get(f)??[]));}
report.viewerReachable=[...reached].sort();
const unique=(rows)=>[...new Set((rows??[]).map(r=>r.repo+':'+r.file+':'+r.line))];
const summary={repositories:report.repositories,bindings:bindings.length,jsParseErrors:report.parseErrors.length,missingFiles:report.missingFiles.length,edges:report.edges.length,viewerReachable:reached.size,dynamicCalls:report.dynamicCalls.length,retired:Object.fromEntries(retired.map(n=>[n,{js:unique(report.references[n]),native:unique(report.nativeReferences[n])}])),reference:Object.fromEntries(reference.map(n=>[n,unique(report.references[n])])),globalExportCandidates:bindings.filter(b=>b.kind!=='method'&&!report.references[b.name]?.some(r=>r.kind!=='identifier'&&r.scope!=='report')).map(b=>b.name)};
fs.mkdirSync('audit-results',{recursive:true});fs.writeFileSync('audit-results/js-reference-graph.json',JSON.stringify(report,null,2)+'\n');fs.writeFileSync('audit-results/js-summary.json',JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
if(report.missingFiles.length||report.parseErrors.length)process.exitCode=1;
