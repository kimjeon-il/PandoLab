import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repository=fileURLToPath(new URL('../',import.meta.url));
const readCatalog=()=>JSON.parse(readFileSync(new URL('./contracts/application-checks.json',import.meta.url),'utf8'));
const browser=group=>group.argv[0]==='node'&&group.argv[2]==='test';
const testFile=value=>/\.(?:test|spec)\.mjs$/.test(value);
const lintFile=(group,file)=>/\.(?:js|mjs)$/.test(file)&&
  !file.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('-'))&&
  !/[\\*?[\]{}:\s]/.test(file)&&
  (group.argv.slice(2).some(path=>file===path||file.startsWith(path+'/'))||['eslint.config.js','playwright.config.js'].includes(file));
const accepts=(group,file)=>group.id==='lint'?lintFile(group,file):testFile(file)&&group.argv.includes(file);

/** Plan exactly the declared scope. No implicit whole-project execution. */
export function selectChecks({groups,catalog=readCatalog(),testNamePattern,files}={}) {
 if(!Array.isArray(groups)||!groups.length||groups.some(id=>typeof id!=='string')||new Set(groups).size!==groups.length)
  throw Error('Explicit distinct check groups are required (--group=node|gis|browser|lint)');
 const selected=groups.map(id=>{
  const group=catalog.groups.find(row=>row.id===id);
  if(!group||!Array.isArray(group.argv)||!group.argv.length)throw Error('Unknown check group: '+id);
  return group;
 });
 if(files!==undefined&&(!Array.isArray(files)||!files.length||new Set(files).size!==files.length||
  files.some(file=>typeof file!=='string'||!selected.some(group=>accepts(group,file)))))
  throw Error('Selected files must be registered in the selected groups or within their lint scope');
 if(testNamePattern&&selected.some(group=>group.argv[0]!=='node'||(group.argv[1]!=='--test'&&!browser(group))))
  throw Error('Test name selection applies to Node or browser test scenarios only');
 return selected.flatMap(group=>{
  const scoped=files?.filter(file=>accepts(group,file));
  if(scoped&&!scoped.length)return [];
  const argv=group.id==='lint'&&scoped?[...group.argv.slice(0,2),'--',...scoped]:
    group.argv.filter(value=>!scoped||!testFile(value)||scoped.includes(value));
  if(argv[0]==='node')argv[0]=process.execPath;
  if(testNamePattern){
   if(browser(group))argv.push('--grep',testNamePattern);
   else argv.splice(2,0,'--test-name-pattern='+testNamePattern);
  }
  return [{id:group.id,argv}];
 });
}

export function executeChecks({root=repository,run=(argv,options)=>spawnSync(argv[0],argv.slice(1),{...options,stdio:'inherit',windowsHide:true}),...scope}={}) {
 const selected=selectChecks(scope);
 for(const {id,argv} of selected) {
  const result=run(argv,{cwd:resolve(root),env:process.env});
  if(result?.error)throw result.error;
  if(result?.status!==0)throw Error('Check failed or blocked: '+id+' (exit '+String(result?.status)+')');
 }
 return {ok:true,groups:selected.map(group=>group.id)};
}

export function main(args=process.argv.slice(2)) {
 const options={};let plan=false;
 for(let i=0;i<args.length;i++){
  const raw=args[i],at=raw.indexOf('='),key=at<0?raw:raw.slice(0,at);
  if(key==='--plan'&&at<0){plan=true;continue;}
  if(!['--group','--test-name-pattern','--file'].includes(key))throw Error('Unknown check option: '+key);
  const value=at<0?args[++i]:raw.slice(at+1);
  if(!value||(at<0&&value.startsWith('--')))throw Error('Missing check option value: '+key);
  if(key==='--group')options.groups=value.split(',');
  else if(key==='--file')options.files=(options.files||[]).concat(value);
  else options.testNamePattern=value;
 }
 const result=plan?{plan:selectChecks(options)}:executeChecks(options);
 console.log(JSON.stringify(result));return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))try{main();}catch(error){console.error(error.stack);process.exitCode=1;}
