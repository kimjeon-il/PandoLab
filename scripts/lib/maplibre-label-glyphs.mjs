// Embedded in the pinned MapLibre map module. The atlas and glyph cache remain
// MapLibre-owned. Only pending rasterization work is shared here.
export function createLabelGlyphPreparation({now=()=>performance.now(),schedule=callback=>setTimeout(callback,0)}={}) {
 const pendingByFont=new WeakMap(),queue=[];
 let scheduled=false;
 function drain(){
  const started=now();
  do {
   const {draw,resolve,reject}=queue.shift();
   try{resolve(draw());}catch(error){reject(error);}
  }while(queue.length&&now()-started<4);
  if(queue.length)schedule(drain);else scheduled=false;
 }
 return function prepare(font,text,draw){
  let pending=pendingByFont.get(font);
  if(!pending)pendingByFont.set(font,pending=new Map());
  const existing=pending.get(text);
  if(existing)return existing;
  const job=new Promise((resolve,reject)=>queue.push({draw,resolve,reject}));
  pending.set(text,job);
  const forget=()=>pending.delete(text);
  job.then(forget,forget);
  if(!scheduled){scheduled=true;schedule(drain);}
  return job;
 };
}

// These factories are embedded in the pinned MapLibre Worker and map module.
export function createLabelGlyphMasks() {
 const cache = new Map(), glyphsByAtlas = new WeakMap();
 const budget = 2 * 1024 * 1024;
 let residentBytes = 0;
 function glyph(atlas, {x,y,w,h}) {
  let entries = glyphsByAtlas.get(atlas);
  if (!entries) glyphsByAtlas.set(atlas, entries = new Map());
  const key = [x,y,w,h].join(',');
  if (entries.has(key)) return entries.get(key);
  const runs = [];
  let hasCoverage = false;
  // MapLibre's SDF shader uses 0.75 for the fill edge. Screen-space halo,
  // filtering and separation are added during placement.
  for (let row = 0; row < h; row++) {
   const start = (y + row) * atlas.width + x;
   let col = 0;
   while (col < w) {
    const alpha=atlas.data[start + col];
    hasCoverage ||= alpha > 0;
    if (alpha < 192) { col++; continue; }
    const left = col++;
    while (col < w && atlas.data[start + col] >= 192) col++;
    runs.push(row,left,col);
   }
  }
  // Thin SDF glyphs can still draw a halo below the fill threshold.
  const result = !runs.length&&hasCoverage ? null : {runs,key:[w,h,...runs].join(',')};
  entries.set(key,result);
  return result;
 }
 function build(atlas, quads) {
  const parts = [];
  for (const quad of quads) {
   const {tl,tr,bl,br,tex,glyphOffset,isSDF,pixelOffsetTL,pixelOffsetBR,minFontScaleX,minFontScaleY} = quad;
   if (!isSDF || tl.x !== bl.x || tr.x !== br.x || tl.y !== tr.y || bl.y !== br.y ||
       pixelOffsetTL.x || pixelOffsetTL.y || pixelOffsetBR.x || pixelOffsetBR.y ||
       minFontScaleX || minFontScaleY || !tex.w || !tex.h || tex.x<0 || tex.y<0 ||
       tex.x+tex.w>atlas.width || (tex.y+tex.h)*atlas.width>atlas.data.length) return null;
   const top = tl.y + glyphOffset[1], bottom = bl.y + glyphOffset[1];
   const box = [tl.x,top,tr.x,bottom].map(value=>Math.round(value*32)/32);
   if (!(box[2] > box[0] && box[3] > box[1])) return null;
   const shape = glyph(atlas,tex);
   if (!shape) return null;
   if (shape.runs.length) parts.push({box,shape,width:tex.w,height:tex.h});
  }
  if (!parts.length) return null;
  const key = parts.map(({box,shape})=>box.join(',')+':'+shape.key).join(';');
  if (cache.has(key)) {
   const entry = cache.get(key);
   cache.delete(key);
   cache.set(key,entry);
   return {mask:entry.mask, reused:true};
  }
  const left = Math.floor(Math.min(...parts.map(p=>p.box[0])));
  const top = Math.floor(Math.min(...parts.map(p=>p.box[1])));
  const width = Math.ceil(Math.max(...parts.map(p=>p.box[2]))) - left;
  const height = Math.ceil(Math.max(...parts.map(p=>p.box[3]))) - top;
  if (width > 1024 || height > 256) return null;
  const stride = Math.ceil(width / 32), bits = new Uint32Array(height * stride);
  for (const {box,shape,width:texWidth,height:texHeight} of parts) {
   const sx = (box[2]-box[0])/texWidth, sy = (box[3]-box[1])/texHeight;
   for (let i=0;i<shape.runs.length;i+=3) {
    const row=shape.runs[i], start=shape.runs[i+1], end=shape.runs[i+2];
    const x0 = Math.floor(box[0]+start*sx-left), x1 = Math.ceil(box[0]+end*sx-left);
    const y0 = Math.floor(box[1]+row*sy-top), y1 = Math.ceil(box[1]+(row+1)*sy-top);
    for (let y=y0;y<y1;y++) for (let x=x0;x<x1;x++) bits[y*stride+(x>>>5)] |= 1<<(x&31);
   }
  }
  const mask = {left,top,width,height,stride,bits};
  const bytes = bits.byteLength + key.length*2 + 128;
  if (bytes <= budget) {
   while (residentBytes+bytes > budget) {
    const oldest = cache.keys().next().value;
    residentBytes -= cache.get(oldest).bytes;
    cache.delete(oldest);
   }
   residentBytes += bytes;
   cache.set(key,{mask,bytes});
  }
  return {mask,reused:false};
 }
 function add(bucket,quads) {
  const result = build(bucket.pandoLabelAtlas,quads);
  if (!result) return;
  const {mask,reused} = result;
  // MapLibre transfers typed-array buffers. Keep the cached original in the Worker.
  const masks = bucket.pandoLabelMasks ??= {};
  masks[bucket.text.placedSymbolArray.length-1] = {...mask,bits:mask.bits.slice()};
  const stats = bucket.pandoLabelMaskStats ??= {generated:0,reused:0,bytes:0,residentBytes:0};
  stats[reused?'reused':'generated']++;
  stats.bytes += mask.bits.byteLength;
  stats.residentBytes = residentBytes;
 }
 return {add,build};
}

export function createLabelGlyphCollision() {
 const placedMasks = new WeakMap(), keyMasks = new WeakMap();
 // CSS pixels around each fill for the Viewer halo, filtering and separation.
 const margin = 2.26;
 function hasInk({mask,x,y,scale}, screenX, screenY) {
  const lo = Math.max(0,Math.floor((screenX-margin-x)/scale-mask.left));
  const hi = Math.min(mask.width-1,Math.ceil((screenX+1+margin-x)/scale-mask.left)-1);
  const top = Math.max(0,Math.floor((screenY-margin-y)/scale-mask.top));
  const bottom = Math.min(mask.height-1,Math.ceil((screenY+1+margin-y)/scale-mask.top)-1);
  if (lo>hi || top>bottom) return false;
  const first=lo>>>5, last=hi>>>5;
  const startMask=0xffffffff<<(lo&31), endMask=0xffffffff>>>(31-(hi&31));
  for(let row=top;row<=bottom;row++) {
   const base=row*mask.stride;
   if(first===last) {
    if(mask.bits[base+first]&startMask&endMask)return true;
   } else {
    if((mask.bits[base+first]&startMask)||(mask.bits[base+last]&endMask))return true;
    for(let word=first+1;word<last;word++)if(mask.bits[base+word])return true;
   }
  }
  return false;
 }
 function overlaps(a,b) {
  const left = Math.floor(Math.max(a.x+a.mask.left*a.scale,b.x+b.mask.left*b.scale)-margin);
  const right = Math.ceil(Math.min(a.x+(a.mask.left+a.mask.width)*a.scale,b.x+(b.mask.left+b.mask.width)*b.scale)+margin);
  const top = Math.floor(Math.max(a.y+a.mask.top*a.scale,b.y+b.mask.top*b.scale)-margin);
  const bottom = Math.ceil(Math.min(a.y+(a.mask.top+a.mask.height)*a.scale,b.y+(b.mask.top+b.mask.height)*b.scale)+margin);
  // Bound work for unusual labels; use the original hit in that case.
  if (right<=left || bottom<=top) return false;
  if ((right-left)*(bottom-top)>4096) return true;
  for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)if(hasInk(a,x,y)&&hasInk(b,x,y))return true;
  return false;
 }
 function predicate(candidate, original) {
  if (!candidate) return original;
  return key => {
   if (original && !original(key)) return false;
   const prior = keyMasks.get(key);
   if (!prior) return true;
   if (candidate.kind!==prior.kind) return false;
   // Only two country names use the finer glyph comparison.
   return !candidate.mask || !prior.mask || overlaps(candidate,prior);
  };
 }
 function placed(box,candidate) { if(candidate)placedMasks.set(box,candidate); }
 function inserted(key,box) {
  const candidate=placedMasks.get(box);
  if(candidate)keyMasks.set(key,candidate);
 }
 return {predicate,placed,inserted,overlaps};
}
