import {normalizeHydronym} from './hydronym-normalize.mjs';
import {validateIndependentHydronyms} from './hydro-independent-name-policy.mjs';

const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
// Python sorts Unicode code points, rather than UTF-16 code units.
function compareNames(left,right){
 const a=Array.from(left,char=>char.codePointAt(0)),b=Array.from(right,char=>char.codePointAt(0));
 for(let i=0;i<Math.min(a.length,b.length);i++)if(a[i]!==b[i])return a[i]-b[i];
 return a.length-b.length;
}
const sortedUnique=values=>[...new Set(values)].sort(compareNames);

export function createHydroSystemNamer({aliases,systemOverrides,independentDocument}={}){
 if(!isObject(aliases)||!isObject(systemOverrides)||Object.values(aliases).some(value=>typeof value!=='string')||
   Object.values(systemOverrides).some(row=>!isObject(row)||typeof row.nameKo!=='string'||
     (row.aliases!==undefined&&(!Array.isArray(row.aliases)||row.aliases.some(value=>typeof value!=='string')))))
   throw Error('Invalid Hydro name overrides');
 const aliasSnapshot=structuredClone(aliases),overrideSnapshot=structuredClone(systemOverrides);
 const independent=validateIndependentHydronyms(structuredClone(independentDocument));
 const reviewed=new Set([...Object.values(aliasSnapshot),...Object.values(overrideSnapshot).map(row=>row.nameKo.trim())]);
 const normalize=value=>normalizeHydronym(value,'river',aliasSnapshot);
 return function nameSystem(input){
   const {systemId,chainIndexes,mainstemIndex,neNames}=input??{};
   if(!Number.isSafeInteger(systemId)||systemId<=0||!Array.isArray(chainIndexes)||!chainIndexes.length||
     chainIndexes.some(index=>!Number.isSafeInteger(index)||index<0)||new Set(chainIndexes).size!==chainIndexes.length||
     !chainIndexes.includes(mainstemIndex)||!isObject(neNames)||Object.values(neNames).some(value=>typeof value!=='string'))
     throw Error('Invalid Hydro system naming input');
   const override=overrideSnapshot[String(systemId)],replacement=independent[String(systemId)];
   const main=normalize(neNames[mainstemIndex]||'');
   const neOther=sortedUnique(chainIndexes.map(index=>normalize(neNames[index]||'')).filter(Boolean));
   const reviewedName=[main,...neOther].find(name=>reviewed.has(name))||'';
   const chosen=replacement?.nameKo||override?.nameKo||reviewedName||main||neOther[0]||'';
   let displayName=normalize(chosen),nameEnriched=Boolean(displayName);
   if(!displayName)displayName=`미명명 수계 ${systemId}`;
   let outputAliases=sortedUnique([...neOther,...(override?.aliases||[])].filter(name=>name&&name!==displayName));
   let tributaryNames=sortedUnique(chainIndexes.filter(index=>index!==mainstemIndex)
     .map(index=>normalize(neNames[index]||'')).filter(name=>name&&name!==displayName));
   if(replacement){
     outputAliases=[...replacement.aliases].sort(compareNames);
     tributaryNames=[...replacement.tributaryNames].sort(compareNames);
   }
   return {displayName,nameEnriched,aliases:outputAliases,tributaryNames,independent:Boolean(replacement)};
 };
}
export async function nameHydroSystems(input,options={}){
 options.signal?.throwIfAborted();
 const {aliases,systemOverrides,independentDocument}=input??{};
 if(!Array.isArray(input?.systems)||!isObject(input.neNames))
   throw Error('Explicit Hydro systems and Natural Earth names required');
 const systems=structuredClone(input.systems),neNames=structuredClone(input.neNames);
 const namer=createHydroSystemNamer({aliases,systemOverrides,independentDocument});
 const seenSystems=new Set(),seenChains=new Set();
 for(const system of systems){
   if(!Number.isSafeInteger(system?.systemId)||system.systemId<=0||seenSystems.has(system.systemId)||
     !Array.isArray(system.chainIndexes)||!system.chainIndexes.length||
     new Set(system.chainIndexes).size!==system.chainIndexes.length||
     !system.chainIndexes.includes(system.mainstemIndex)||
     system.chainIndexes.some(index=>!Number.isSafeInteger(index)||index<0||seenChains.has(index)))
     throw Error('Invalid Hydro naming systems');
   seenSystems.add(system.systemId);
   for(const index of system.chainIndexes)seenChains.add(index);
 }
 options.signal?.throwIfAborted();
 return systems.map(system=>({systemId:system.systemId,name:namer({...system,neNames})}));
}
