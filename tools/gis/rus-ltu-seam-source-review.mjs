import assert from 'node:assert/strict';
import {isDeepStrictEqual as eq} from 'node:util';
import {replayRetainedCoast,exactCyclicChain} from './retained-coast-source-review.mjs';

// Explicit replay helper for the completed Lithuania source construction;
// automatic admission is owned by seam-source-admission.mjs.
export const rusLtuSeamMethod='exact-original-rus-ltu-readonly-counterpart-seam';
export function buildCandidate(old,windows,donor){
 const ops=operations.map((op,i)=>{
  const s=windows[i];assert.deepEqual(s.index,op.raw,'only exact frozen source indices');
  assert(s.points.length===[64,22617,73][i],'exact source counts');
  return {...op,raw:{polygonIndex:i,ringIndex:0,startIndex:0,endIndex:s.points.length-1,direction:1}};
 });
 const p=windows.map(x=>x.points);
 assert.deepEqual(p[0].slice(0,-1),exactCyclicChain(donor.coordinates[2][0],3313,3251,-1),'native Lithuania coast-terminal chain');
 assert.deepEqual(p[1],exactCyclicChain(donor.coordinates[11][0],119328,96712,-1),'native Lithuania mainland chain');
 assert.deepEqual(p[2],exactCyclicChain(donor.coordinates[11][0],69,119329,-1),'native Lithuania wrapped land chain');
 const raw={type:'MultiPolygon',coordinates:p.map(x=>[[...x,x[0]]])};
 const out=replayRetainedCoast(old,raw,ops,ringStarts);
 out.coordinates[12][0]=rotateClosedAt(out.coordinates[12][0],old.coordinates[12][0][0]);
 assert.deepEqual(old.coordinates[1],out.coordinates[1],'prior Poland Vistula part unchanged');
 assertOldChain(old.coordinates[11][0],out.coordinates[11][0],411,22938,646);
 return out;
}

export const operations=[[11,156,161,28,9934,9997],[11,264,411,28,16002,38618],[12,9,5,34,28,100]].map(
 ([polygonIndex,startIndex,endIndex,p,rs,re])=>Object.freeze({polygonIndex,ringIndex:0,startIndex,endIndex,raw:Object.freeze({polygonIndex:p,ringIndex:0,startIndex:rs,endIndex:re,direction:1})}));
Object.freeze(operations);
export const ringStarts=Object.freeze([Object.freeze({polygonIndex:11,ringIndex:0,startIndex:0}),Object.freeze({polygonIndex:12,ringIndex:0,startIndex:9})]);
export function rotateClosedAt(closed,origin){
 assert(closed.length>=4&&eq(closed[0],closed.at(-1)),'closed ring origin');
 const v=closed.slice(0,-1),i=v.findIndex(p=>eq(p,origin));
 assert(i>=0&&v.findIndex((p,k)=>k>i&&eq(p,origin))<0,'unique exact retained origin required');
 return [...v.slice(i),...v.slice(0,i),v[i]];
}
export function assertOldChain(old,next,i,j,n){
 assert([i,j,n].every(Number.isSafeInteger)&&i>=0&&j>=0&&n>=2&&old.length>=i+n&&next.length>=j+n&&eq(old.slice(i,i+n),next.slice(j,j+n)),'prior original point chain differs');
 return true;
}
