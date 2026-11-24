import {builtinCountryAssets,validateBuiltinReadIndex} from './builtin-country-files.js';

export function parseBuiltinIndex(buffer){
 const value=JSON.parse(new TextDecoder().decode(buffer));
 builtinCountryAssets(value);validateBuiltinReadIndex(value);
 return value;
}
export async function serializeBuiltinProject(project){
 const bytes=new TextEncoder().encode(JSON.stringify(project));
 const fingerprint=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
  .map(value=>value.toString(16).padStart(2,'0')).join('');
 return {bytes,fingerprint};
}
