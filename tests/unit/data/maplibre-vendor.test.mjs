import test from 'node:test';
import assert from 'node:assert/strict';
import {mapLibreVendorAssets} from '../../../scripts/lib/maplibre-vendor.mjs';
import {createLabelGlyphMasks,createLabelGlyphCollision} from '../../../scripts/lib/maplibre-label-glyphs.mjs';
import {createLabelZoomWorker,createLabelZoomRenderer} from '../../../scripts/lib/maplibre-label-zoom.mjs';
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
 assert.equal(collision.predicate({kind:'country'})(cityKey),false,'a city name must not hide a country flag and its paired name');
 assert.equal(collision.predicate({kind:'country'})(key),true,'country flags still participate in country-label collision');
});

test('a retained symbol bucket updates only its supplementary size buffer at the next stop band',()=>{
 const worker=createLabelZoomWorker(),renderer=createLabelZoomRenderer();
 const native={kind:'composite',minZoom:4,maxZoom:5,interpolationType:{name:'linear'}};
 const stops=[3,4,5,6,7],sizes=[13,14,17,21,26];
 const value={expression:{kind:'composite',zoomStops:stops},
  possiblyEvaluate:zoom=>({evaluate:feature=>sizes[zoom-3]+feature.offset})};
 const bucket={zoom:4,layers:[{_unevaluatedLayout:{_values:{'text-size':value}}}]};
 const buffers={placedSymbolArray:{length:1},layoutVertexBuffer:{length:12}};
 worker.add(bucket,buffers,'text-size',{offset:0},{},4,4,zoom=>zoom);
 buffers.placedSymbolArray.length++;
 worker.add(bucket,buffers,'text-size',{offset:3},{},12,8,zoom=>zoom);
 const uploads=[];
 const read=data=>uploads.push(Array.from(new Uint16Array(data.arrayBuffer)));
 let destroyed=0;
 const gpu={updateData:read,destroy:()=>destroyed++};
 const context={createVertexBuffer(data,attributes,dynamic){
  assert.equal(attributes[0].name,'a_pando_label_size');
  assert.equal(dynamic,true);
  read(data);
  return gpu;
 }};
 assert.equal(renderer.prepare(buffers,native,4.3,context),native);
 const next=renderer.prepare(buffers,native,5.3,context);
 assert.deepEqual([next.minZoom,next.maxZoom],[5,6]);
 assert.deepEqual(uploads[0],[...Array(4).fill([17*128,21*128]).flat(),...Array(8).fill([20*128,24*128]).flat()]);
 assert.equal(buffers.pandoActiveSizeBuffer,gpu);
 renderer.prepare(buffers,native,5.7,context);
 assert.equal(uploads.length,1);
 const interval=renderer.band(buffers,native,5.7);
 const zoomFactor=(data,zoom)=>(zoom-data.minZoom)/(data.maxZoom-data.minZoom);
 const featureSize=(_data,t,{lowerSize,upperSize})=>(lowerSize+(upperSize-lowerSize)*t)/128;
 const collision=renderer.collision(buffers,interval,0,{x1:-10,y1:-5,x2:10,y2:5},5.7,zoomFactor,featureSize);
 assert.equal(collision.size,19.8);
 assert.ok(collision.box.x2>10);
 renderer.prepare(buffers,native,6.2,context);
 assert.equal(uploads.length,2);
 renderer.prepare(buffers,native,4.7,context);
 assert.equal(buffers.pandoActiveSizeBuffer,null);
 renderer.prepare(buffers,native,3.6,context);
 assert.deepEqual(uploads[2].slice(0,2),[13*128,14*128]);
 renderer.destroy(buffers);
 assert.equal(destroyed,1);
});
