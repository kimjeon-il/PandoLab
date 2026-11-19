import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTopology,rotateClosedAt,assertOldChain} from '../../../tools/gis/rus-ltu-seam-source-review.mjs';
test('Lithuania-Russia requires exact zero, preserved historical frontier and all fixed peers',()=>{
 const t={data:'p',newOverlapAreaDeg2:0,oldLandLossEmpty:true,peers:{POL:{shapeIntersectionEqual:true,sharedBoundaryExactlyEqual:true}}};
 const w={data:'p',wholeNewOverlapAreaDeg2:0,pairDE9IM:'FF2F11212',ltuNativeExact:true,changedComponents:[11,12],p12OriginalStartPreserved:true,polOldIntersectionEqualsNew:true,polExactSharedEdgeCount:645,polExactSharedUniqueVertices:646};
 assert.doesNotThrow(()=>validateTopology(t,w,'p',['POL']));
 for (const [a,b] of [[{...t,newOverlapAreaDeg2:1e-18},w],[{...t,oldLandLossEmpty:false},w],[t,{...w,ltuNativeExact:false}],[t,{...w,polExactSharedEdgeCount:644}],[{...t,peers:{}},w]])assert.throws(()=>validateTopology(a,b,'p',['POL']));
});
test('wrapped retained origin must be exact/unique and inherited old arc contiguous',()=>{
 const r=[[2,0],[3,1],[0,0],[1,0],[2,0]];
 assert.deepEqual(rotateClosedAt(r,[0,0]),[[0,0],[1,0],[2,0],[3,1],[0,0]]);
 assert.throws(()=>rotateClosedAt(r,[9,8]),/origin/);
 assert.throws(()=>rotateClosedAt([[0,0],[1,0],[0,0],[2,0],[0,0]],[0,0]),/origin/);
 assertOldChain(r,[[5,5],...r],0,1,3);
 assert.throws(()=>assertOldChain(r,[[5,5],...r],0,0,3),/prior/);
});

