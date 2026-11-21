import test from 'node:test';
import assert from 'node:assert/strict';
import {mapLibreVendorAssets} from '../../../scripts/lib/maplibre-vendor.mjs';
import {createLabelGlyphMasks,createLabelGlyphCollision} from '../../../scripts/lib/maplibre-label-glyphs.mjs';
import {transformSync} from 'esbuild';

test('Viewer receives the MapLibre module, worker, stylesheet and license',()=>{
 const assets=mapLibreVendorAssets(process.cwd());
 for(const name of ['maplibre-gl.mjs','maplibre-gl-worker.mjs','maplibre-gl-shared.mjs','maplibre-gl.css','LICENSE.txt'])
  assert.ok(assets.has('assets/vendor/maplibre-gl/'+name),name);
 assert.ok(assets.get('assets/vendor/maplibre-gl/maplibre-gl-worker.mjs').length>0);
 for(const name of ['maplibre-gl.mjs','maplibre-gl-worker.mjs'])
  assert.doesNotThrow(()=>transformSync(assets.get('assets/vendor/maplibre-gl/'+name).toString('utf8'),{format:'esm'}));
});

const quad=(x,y,tex={x:0,y:0,w:8,h:8})=>({
 tl:{x,y},tr:{x:x+8,y},bl:{x,y:y+8},br:{x:x+8,y:y+8},tex,
 glyphOffset:[0,0],isSDF:true,pixelOffsetTL:{x:0,y:0},pixelOffsetBR:{x:0,y:0},minFontScaleX:0,minFontScaleY:0,
});
const atlas=(width,x)=>({width,data:Uint8Array.from({length:width*8},(_,i)=>i%width===x&&i<width*4?255:0)});

test('label glyph masks are shared across atlases and survive tile transfers',()=>{
 const worker=createLabelGlyphMasks(),a=atlas(8,2),b=atlas(16,10);
 const first=worker.build(a,[quad(0,0)]);
 const next=worker.build(b,[quad(0,0,{x:8,y:0,w:8,h:8})]);
 assert.equal(first.reused,false);
 assert.equal(next.reused,true);
 assert.strictEqual(next.mask,first.mask);
 const bucket={text:{placedSymbolArray:{length:1}},pandoLabelAtlas:b};
 worker.add(bucket,[quad(0,0,{x:8,y:0,w:8,h:8})]);
 const transferred=bucket.pandoLabelMasks[0].bits;
 structuredClone(transferred,{transfer:[transferred.buffer]});
 assert.ok(next.mask.bits.byteLength>0);
 assert.equal(bucket.pandoLabelMaskStats.reused,1);
 assert.equal(worker.build(atlas(8,5),[quad(0,0)]).reused,false);
 assert.equal(worker.build(a,[quad(0,8)]).reused,false);
 const weak=atlas(16,2);weak.data[10]=160;
 assert.equal(worker.build(weak,[quad(0,0),quad(8,0,{x:8,y:0,w:8,h:8})]),null);
});

test('country and place names can overlap while same-type text and flags retain collision rules',()=>{
 const worker=createLabelGlyphMasks(),collision=createLabelGlyphCollision();
 const a=worker.build(atlas(8,0),[quad(0,0)]).mask;
 const b=worker.build(atlas(8,7),[quad(0,0)]).mask;
 const first={kind:'country',mask:a,x:0,y:0,scale:1};
 const separate={kind:'country',mask:b,x:0,y:0,scale:1};
 const overlap={...separate,x:-7};
 const key={},box=[0,0,8,8];
 collision.placed(box,first);
 collision.inserted(key,box);
 assert.equal(collision.predicate(separate)(key),false);
 assert.equal(collision.predicate(overlap)(key),true);
 assert.equal(collision.predicate({kind:'place'})(key),false);
 assert.equal(collision.predicate(separate)({}),true);
 assert.equal(collision.predicate(overlap,()=>false)(key),false);
 assert.equal(collision.predicate(null,undefined),undefined);
 const cityKey={},cityBox=[0,0,8,8];
 collision.placed(cityBox,{kind:'place'});
 collision.inserted(cityKey,cityBox);
 assert.equal(collision.predicate({kind:'place'})(cityKey),true);
 assert.equal(collision.predicate(overlap)(cityKey),false);
 const paint=['viewer-label-country','viewer-label-text'];
 assert.deepEqual(collision.placementOrder(paint),[...paint].reverse());
 assert.equal(paint[0],'viewer-label-country');
});
