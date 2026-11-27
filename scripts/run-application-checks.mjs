import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repository=fileURLToPath(new URL('../',import.meta.url));
const readCatalog=()=>JSON.parse(readFileSync(new URL('./contracts/application-checks.json',import.meta.url),'utf8'));
const browser=group=>group.argv[0]==='node'&&group.argv[2]==='test';
const testFile=value=>/\.(?:test|spec)\.mjs$/.test(value);
const nodeReporter='--test-reporter='+new URL('./lib/nonempty-node-reporter.mjs',import.meta.url).href;

// Unapproved title filters are literal fragments, with escaped punctuation.
// General regular expressions can select the entire group through countless
// equivalent spellings; do not maintain a blacklist of catch-all patterns.
function requireFocusedPattern(pattern,allowWholeGroup) {
 if(pattern===undefined||allowWholeGroup)return;
 const plain=pattern.replace(/\\[\\^$.*+?()[\]{}|/]/g,'');
 if(pattern.startsWith('/')||/[\\^$.*+?()[\]{}|]/.test(plain)||!/[\p{L}\p{N}]/u.test(plain))
  throw Error('Regular-expression or broad scenario selection requires --allow-whole-group');
}
const lintFile=(group,file)=>/\.(?:js|mjs)$/.test(file)&&
  !file.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('-'))&&
  !/[\\*?[\]{}:\s]/.test(file)&&
  (group.argv.slice(2).some(path=>file===path||file.startsWith(path+'/'))||['eslint.config.js','playwright.config.js'].includes(file));
const accepts=(group,file)=>group.id==='lint'?lintFile(group,file):testFile(file)&&group.argv.includes(file);

/** Plan exactly the declared scope. No implicit whole-project execution. */
export function selectChecks({groups,catalog=readCatalog(),testNamePattern,files,allowWholeGroup=false}={}) {
 if(!Array.isArray(groups)||!groups.length||groups.some(id=>typeof id!=='string')||new Set(groups).size!==groups.length)
  throw Error('Explicit distinct check groups are required (--group=node|gis|browser|lint)');
 if(typeof allowWholeGroup!=='boolean')throw Error('Whole-group approval must be explicit');
 if(testNamePattern!==undefined&&(typeof testNamePattern!=='string'||!testNamePattern.trim()))throw Error('A nonempty scenario pattern is required');
 requireFocusedPattern(testNamePattern,allowWholeGroup);
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
  // Node's name filter still loads every selected file. A browser file
  // contains all scenarios, so its filename alone is not a focused scope.
  const registered=group.argv.filter(testFile);
  const filtered=Boolean(testNamePattern)&&(browser(group)||Boolean(scoped));
  const allFiles=registered.length>0&&scoped?.length===registered.length;
  if(!allowWholeGroup&&(
    (!scoped&&!filtered)||
    (browser(group)&&!testNamePattern)||
    (allFiles&&!browser(group))
  ))throw Error('Whole-group check requires --allow-whole-group: '+group.id);
  const argv=group.id==='lint'&&scoped?[...group.argv.slice(0,2),'--',...scoped]:
    group.argv.filter(value=>!scoped||!testFile(value)||scoped.includes(value));
  if(argv[0]==='node')argv[0]=process.execPath;
  if(testNamePattern){
   if(browser(group))argv.push('--grep',testNamePattern);
   else argv.splice(2,0,'--test-name-pattern='+testNamePattern);
  }
  if(group.argv[1]==='--test')argv.splice(2,0,nodeReporter);
  return [{id:group.id,argv}];
 });
}

function requireSuccess(result,id) {
 if(result?.error)throw result.error;
 if(result?.status!==0)throw Error('Check failed or blocked: '+id+' (exit '+String(result?.status)+')');
}

function listedBrowserCount(argv,run,options) {
 const result=run([...argv,'--list','--reporter=json'],{
  ...options,stdio:['ignore','pipe','inherit'],encoding:'utf8',maxBuffer:16*1024*1024,
 });
 if(result?.status!==0&&result?.stdout)console.error(result.stdout);
 requireSuccess(result,'browser scenario listing');
 const count=suites=>{
  if(!Array.isArray(suites))throw Error('Invalid browser scenario listing');
  return suites.reduce((sum,suite)=>sum+
   (suite.specs??[]).reduce((n,spec)=>{
    if(!Array.isArray(spec.tests))throw Error('Invalid browser scenario listing');
    return n+spec.tests.length;
   },0)+count(suite.suites??[]),0);
 };
 return count(JSON.parse(result.stdout).suites);
}

export function executeChecks({root=repository,run=(argv,options)=>spawnSync(argv[0],argv.slice(1),{stdio:'inherit',windowsHide:true,...options}),...scope}={}) {
 const selected=selectChecks(scope),options={cwd:resolve(root),env:process.env};
 for(const {id,argv} of selected) {
  if(id==='browser'&&!scope.allowWholeGroup){
   // Playwright grep also matches project/file names and tags. Compare the
   // actual discovered scope, without launching Chromium or the map server.
   const matched=listedBrowserCount(argv,run,options);
   if(matched===0)throw Error('No browser scenarios matched the requested scope');
   const at=argv.indexOf('--grep'),unfiltered=argv.slice();
   if(at<0)throw Error('Browser scenario selection requires an explicit filter');
   unfiltered.splice(at,2);
   const total=listedBrowserCount(unfiltered,run,options);
   if(matched>=total)throw Error('All browser scenarios selected; requires --allow-whole-group');
  }
  requireSuccess(run(argv,options),id);
 }
 return {ok:true,groups:selected.map(group=>group.id)};
}

export function main(args=process.argv.slice(2)) {
 const options={};let plan=false;
 for(let i=0;i<args.length;i++){
  const raw=args[i],at=raw.indexOf('='),key=at<0?raw:raw.slice(0,at);
  if(key==='--plan'&&at<0){plan=true;continue;}
  if(key==='--allow-whole-group'&&at<0){options.allowWholeGroup=true;continue;}
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
