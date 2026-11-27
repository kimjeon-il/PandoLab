import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

export const put=(root,p,b)=>{const f=path.join(root,p);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,b);};
export const git=(root,...args)=>execFileSync('git',['-c','core.autocrlf=false',...args],{cwd:root,encoding:'utf8',stdio:'pipe'}).trim();
export const rejected=(s,pattern)=>{assert.throws(s.store,pattern);assert.equal(git(s.data,'rev-parse','HEAD'),s.head);assert.deepEqual(fs.readFileSync(path.join(s.data,'archive/index.json')),s.index);assert.deepEqual(fs.readFileSync(path.join(s.root,'config/library-data.json')),s.config);};

// Fixture repositories must not inherit the runner's init.defaultBranch.
export function initFixtureRepository(root){
 fs.mkdirSync(root,{recursive:true});
 git(root,'init','-q','-b','main');
 git(root,'config','core.longpaths','true');
 git(root,'config','user.name','Fixture');
 git(root,'config','user.email','fixture@example.invalid');
}
