import {createHash} from 'node:crypto';
import {isDeepStrictEqual as eq} from 'node:util';
import {exactCyclicChain} from './retained-coast-source-review.mjs';

// Common exact-source primitives. Callers retain their registered version,
// archive paths, error context, topology proof and country-specific rules.
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const domain=geometry=>hash(JSON.stringify([geometry.type,geometry.coordinates]));
export const keys=(object,names)=>object&&eq(Object.keys(object).sort(),[...names].sort());
export const omit=(object,...names)=>Object.fromEntries(Object.entries(object??{}).filter(([key])=>!names.includes(key)));
export const active=entity=>entity.geometryVersions.filter(version=>version.validTo===null);

export function hasActiveSeam(entity,id,method){
 return entity?.entityId===id&&entity?.geometryVersions?.some(version=>version.validTo===null&&version.modernBoundarySupplement?.adoptionMode===method)===true;
}

export function createSeamReviewChecks(version,fail){
 const preserved=entity=>({...entity,sourceInfo:omit(entity.sourceInfo,'geometrySha256','geometryVersionId'),
  geometryVersions:entity.geometryVersions.map(row=>row.versionId===version?omit(row,'geometry','modernBoundarySupplement'):row)});
 const dig=(actual,expected,label)=>{if(actual!==expected)fail(label+' digest mismatch');};
 const bytes=(read,path,expected)=>{
  const value=read(path);
  if(!Buffer.isBuffer(value))fail(path+' exact archived bytes required');
  dig(hash(value),expected,path);
  return value;
 };
 return {preserved,dig,bytes};
}

// A previously admitted Belarus arc is checked against the same donor in
// each subsequent UKR seam review; the approved scope remains caller-owned.
export function assertPriorBelarusArc(previous,next,donor,arc,scope,fail){
 const points=exactCyclicChain(donor.coordinates[arc.polygonIndex][arc.ringIndex],arc.startIndex,arc.endIndex,arc.direction);
 const p=previous.coordinates[scope.polygonIndex]?.[scope.ringIndex], n=next.coordinates[scope.polygonIndex]?.[scope.ringIndex];
 if(points.length!==scope.length||!p||!n||!eq(p.slice(scope.beforeStart,scope.beforeStart+scope.length),points)||
  !eq(n.slice(scope.afterStart,scope.afterStart+scope.length),points))fail('previously approved Belarus seam vertices changed');
 return true;
}
