import test from 'node:test';
import assert from 'node:assert/strict';
import {rotateClosedAt,assertOldChain} from '../../../tools/gis/rus-ltu-seam-source-review.mjs';
test('wrapped retained origin must be exact/unique and inherited old arc contiguous',()=>{
 const r=[[2,0],[3,1],[0,0],[1,0],[2,0]];
 assert.deepEqual(rotateClosedAt(r,[0,0]),[[0,0],[1,0],[2,0],[3,1],[0,0]]);
 assert.throws(()=>rotateClosedAt(r,[9,8]),/origin/);
 assert.throws(()=>rotateClosedAt([[0,0],[1,0],[0,0],[2,0],[0,0]],[0,0]),/origin/);
 assertOldChain(r,[[5,5],...r],0,1,3);
 assert.throws(()=>assertOldChain(r,[[5,5],...r],0,0,3),/prior/);
});

