import {patchMapLibreTopologyLod} from './maplibre-topology-lod.mjs';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createLabelGlyphMasks,createLabelGlyphCollision,createLabelGlyphPreparation} from './maplibre-label-glyphs.mjs';
import {createLabelZoomWorker,createLabelZoomRenderer} from './maplibre-label-zoom.mjs';

function replaceOnce(source,needle,replacement){
 const at=source.indexOf(needle);
 if(at<0||at!==source.lastIndexOf(needle))throw Error('MapLibre renderer hook changed: '+needle);
 return source.slice(0,at)+replacement+source.slice(at+needle.length);
}

// MapLibre has fill-antialias but no equivalent paint property for lines.
// Extend the pinned solid-line program without changing its default coverage.
function addHardLineEdges(source){
 const fragment='line:DO(`in vec2 v_width2;';
 source=replaceOnce(source,fragment,'line:DO(`uniform float u_pando_hard_edges;in vec2 v_width2;');
 const output='fragColor=color*(alpha*opacity);';
 const coverage='float alpha=clamp(min(dist-(v_width2.t-blur2),v_width2.s-dist)/blur2,0.0,1.0);';
 source=replaceOnce(source,coverage+output,coverage+
  'if(u_pando_hard_edges>0.5){float pad=0.5/u_device_pixel_ratio;'+
  'alpha=step(dist,v_width2.s-pad)*step(max(0.0,v_width2.t-pad),dist);}'+output);
 source=replaceOnce(source,
  'nM=(e,t)=>({u_translation:new Z(e,t.u_translation),u_ratio:new X(e,t.u_ratio)})',
  'nM=(e,t)=>({u_translation:new Z(e,t.u_translation),u_ratio:new X(e,t.u_ratio),u_pando_hard_edges:new X(e,t.u_pando_hard_edges)})');
 source=replaceOnce(source,
  'sM=(e,t,n,r)=>({u_translation:pM(e,t,n),u_ratio:r/rt(t,1,e.zoom)})',
  'sM=(e,t,n,r,hardEdges)=>({u_translation:pM(e,t,n),u_ratio:r/rt(t,1,e.zoom),u_pando_hard_edges:hardEdges?1:0})');
 return replaceOnce(source,'k=sM(g,r,n,O);','k=sM(g,r,n,O,e.pandoHardLineEdges?.(n));');
}

// Reuse the source's dirty-tile predicate for dormant tiles as well as the
// visible pyramid. Full source/style changes still clear native tile data.
function retainUnaffectedTiles(source){
 const reload='reload(e,t=void 0){if(this._paused)this._shouldReloadOnResume=!0;else{';
 const cache='this._outOfViewCache';
 return replaceOnce(source,reload+cache+'.reset();',
  reload+'if(t)'+cache+'.filter(tile=>!this._source.shouldReloadTile(tile,t));else '+cache+'.reset();');
}

function addLabelGlyphMasks(source){
 const layout='t.addFeatures({options:c,canonical:this.tileID.canonical,glyphMap:v,glyphPositions:S.positions,iconMap:y,iconPositions:w.iconPositions,patternMap:b,patternPositions:w.patternPositions,dashPositions:x,showCollisionBoxes:this.showCollisionBoxes})';
 source=replaceOnce(source,layout,
  '(t.layerIds?.includes(`viewer-label-country`)&&(t.pandoLabelAtlas=S.image),'+layout+',delete t.pandoLabelAtlas)');
 const vertices='e.addSymbols(e.text,g,v,s,a,o,u,t,l.lineStartIndex,l.lineLength,p,h,c);';
 source=replaceOnce(source,vertices,vertices+'if(e.pandoLabelAtlas&&!a&&(u===1||u===3))pandoLabelMasks.add(e,g);');
 return 'const pandoLabelMasks=('+createLabelGlyphMasks.toString()+')();\n'+source;
}

function addLabelZoomStops(source){
 const append='e.placedSymbolArray.emplaceBack(s.x,s.y,g,this.glyphOffsetArray.length-g,_,c,l,s.segment,n?n[0]:0,n?n[1]:0,r[0],r[1],o,0,!1,0,u,f)';
 source=replaceOnce(source,append,append+
  ';if(this.layerIds.includes(`viewer-label-country`)&&e===this.text&&!this.iconsInText&&!i)'+
  'pandoLabelZoom.add(this,e,a,d,m.length,t.length*4,zoom=>new K(zoom))');
 return 'const pandoLabelZoom=('+createLabelZoomWorker.toString()+')();\n'+source;
}

function addLabelGlyphCollision(source){
 const place='placeCollisionBox(e,t,n,r,i,a,o,s,c,l,u,d,f=0,p=!0)';
 source=replaceOnce(source,place,place.slice(0,-1)+',pandoText)');
 const result='return w||=g.perspectiveRatio<this.perspectiveRatioCutoff,w||=!this.isInsideGrid(y,b,x,S),w||t!==`always`&&this.grid.hitTest(y,b,x,S,t,c)?{box:[y,b,x,S],placeable:!1,offscreen:!1,occluded:C}:{box:[y,b,x,S],placeable:!0,offscreen:this.isOffscreen(y,b,x,S),occluded:C}';
 source=replaceOnce(source,result,
  'const text=pandoText?{kind:pandoText.kind,mask:pandoText.mask&&!a&&!o&&!u&&!f&&'+
  'Number.isFinite(g.perspectiveRatio)&&g.perspectiveRatio>0?pandoText.mask:null,'+
  'x:g.x,y:g.y,scale:pandoText.size/24*Math.min(4,g.perspectiveRatio)}:null;'+
  'const result=('+result.slice('return '.length).replace('t,c)', 't,pandoLabelCollision.predicate(text,c))')+
  ');if(result.placeable)pandoLabelCollision.placed(result.box,text);return result');
 const insert='o.insert(s,e[0],e[1],e[2],e[3])';
 source=replaceOnce(source,insert,'pandoLabelCollision.inserted(s,e);'+insert);
 const bucket='!r.collisionArrays&&d&&r.deserializeCollisionBoxes(d);let D=';
 source=replaceOnce(source,bucket,bucket.replace('let D=',
  'const pandoKind=r.layerIds.includes(`viewer-label-country`)?`country`:r.layerIds.includes(`viewer-label-text`)?`place`:null;'+
  'const pandoZoom=this.transform.zoom,pandoTextBand=pandoLabelZoom.band(r.text,r.textSizeData,pandoZoom);let D='));
 const call='this.collisionIndex.placeCollisionBox(t,g,l,D,s,x,b,a,p.predicate,O,void 0,k,C,w)';
 source=replaceOnce(source,'let i='+call,
  'const pandoIndex=e.centerJustifiedTextSymbolIndex,pandoMask=n===1&&r.pandoLabelMasks?.[pandoIndex];'+
  'const pandoSize=n===1&&pandoLabelZoom.collision(r.text,pandoTextBand,pandoIndex,t,pandoZoom,Bv,zv);'+
  'let i='+call.replace('placeCollisionBox(t,','placeCollisionBox(pandoSize?pandoSize.box:t,').slice(0,-1)+
  ',pandoKind?{kind:pandoKind,mask:pandoMask,size:pandoMask?(pandoSize?.size??zv(r.textSizeData,f,r.text.placedSymbolArray.get(pandoIndex))):0}:null)');
 return 'const pandoLabelCollision=('+createLabelGlyphCollision.toString()+')();\n'+source;
}

function addLabelZoomDrawing(source){
 // Only the text shader needs supplementary sizes for territorial names.
 // Preserve the stock icon and mixed text-and-inline-icon shaders.
 const start=source.indexOf('symbolIcon:DO('),end=source.indexOf('symbolTextAndIcon:DO(');
 if(start<0||end<=start)throw Error('MapLibre symbol shader boundary changed');
 const shader=source.slice(start,end);
 const attribute='layout(location=5) in float a_height_offset;';
 const size='size=mix(a_size_min,a_size[1],u_size_t)/128.0;';
 if(shader.split(attribute).length!==3||shader.split(size).length!==3)
  throw Error('MapLibre symbol size shader hook changed');
 // The pinned range contains symbolIcon first and the text shader second.
 // Exactly two matched vertex attributes and size expressions are required above.
 const textStart=shader.lastIndexOf(attribute);
 const textShader=replaceOnce(replaceOnce(shader.slice(textStart),attribute,attribute+'layout(location=6) in vec2 a_pando_label_size;'),
  size,'size=(a_pando_label_size.x>0.0?mix(a_pando_label_size.x,a_pando_label_size.y,u_size_t):'+
   'mix(a_size_min,a_size[1],u_size_t))/128.0;');
 source=source.slice(0,start)+shader.slice(0,textStart)+textShader+source.slice(end);
 const draw='k=Bv(S,h.zoom),A=f.getTerrainDataForTile(s)';
 source=replaceOnce(source,draw,'k=Bv(pandoLabelZoom.prepare(u,S,h.zoom,f.context),h.zoom),A=f.getTerrainDataForTile(s)');
 const buffers='e.dynamicLayoutVertexBuffer,e.opacityVertexBuffer)}function ZM';
 source=replaceOnce(source,buffers,buffers.replace('e.opacityVertexBuffer)','e.opacityVertexBuffer,e.pandoActiveSizeBuffer)'));
 const destroy='opacityVertexBuffer.destroy())}};G(`SymbolBuffers`';
 source=replaceOnce(source,destroy,destroy.replace('opacityVertexBuffer.destroy())','opacityVertexBuffer.destroy(),pandoLabelZoom.destroy(this))'));
 return 'const pandoLabelZoom=('+createLabelZoomRenderer.toString()+')();\n'+source;
}

function scheduleViewerGlyphRasterization(source){
 const draw='async _drawGlyph(e,t,n,r){let i=await this._getTinySDF(e,t,n,r);return this._getRasterizedGlyph(i,n)}';
 source=replaceOnce(source,draw,draw.replace('return this._getRasterizedGlyph(i,n)',
  'return this.rasterizedGlyphs.get(i)?.[n]??((t===`Pando Pretendard`||t===`Pando Pretendard ExtraBold`)?'+
  'pandoPrepareLabelGlyph(i,n,()=>this._getRasterizedGlyph(i,n)):this._getRasterizedGlyph(i,n))'));
 return 'const pandoPrepareLabelGlyph=('+createLabelGlyphPreparation.toString()+')();\n'+source;
}

// Package the dependency from the installed, lockfile-selected distribution.
export function mapLibreVendorAssets(root){
 const project=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'));
 const dependency=JSON.parse(readFileSync(resolve(root,'node_modules/maplibre-gl/package.json'),'utf8'));
 if(project.dependencies?.['maplibre-gl']!==dependency.version)throw Error('Installed MapLibre version differs from the pinned Viewer dependency');
 const files=['maplibre-gl.mjs','maplibre-gl-worker.mjs','maplibre-gl-shared.mjs','maplibre-gl.css'];
 const output=new Map(files.map(name=>['assets/vendor/maplibre-gl/'+name,readFileSync(resolve(root,'node_modules/maplibre-gl/dist',name))]));
 // Require exactly one native tile constructor across the pinned chunks.
 let lodHooks=0;
 for(const name of ['maplibre-gl-worker.mjs','maplibre-gl-shared.mjs','maplibre-gl.mjs']){
  const path='assets/vendor/maplibre-gl/'+name,patched=patchMapLibreTopologyLod(output.get(path).toString('utf8'));
  lodHooks+=patched.matches;if(patched.matches===1)output.set(path,Buffer.from(patched.source));
 }
 if(lodHooks!==1)throw Error('Pinned MapLibre topology LOD hook changed: '+lodHooks);
 const modulePath='assets/vendor/maplibre-gl/maplibre-gl.mjs';
 const workerPath='assets/vendor/maplibre-gl/maplibre-gl-worker.mjs';
 output.set(modulePath,Buffer.from(scheduleViewerGlyphRasterization(addLabelZoomDrawing(addLabelGlyphCollision(retainUnaffectedTiles(addHardLineEdges(output.get(modulePath).toString('utf8'))))))));
 output.set(workerPath,Buffer.from(addLabelZoomStops(addLabelGlyphMasks(output.get(workerPath).toString('utf8')))));
 output.set('assets/vendor/maplibre-gl/LICENSE.txt',readFileSync(resolve(root,'node_modules/maplibre-gl/LICENSE.txt')));
 return output;
}
