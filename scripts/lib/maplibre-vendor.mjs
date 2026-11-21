import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

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

// Package the dependency from the installed, lockfile-selected distribution.
export function mapLibreVendorAssets(root){
 const project=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'));
 const dependency=JSON.parse(readFileSync(resolve(root,'node_modules/maplibre-gl/package.json'),'utf8'));
 if(project.dependencies?.['maplibre-gl']!==dependency.version)throw Error('Installed MapLibre version differs from the pinned Viewer dependency');
 const files=['maplibre-gl.mjs','maplibre-gl-worker.mjs','maplibre-gl-shared.mjs','maplibre-gl.css'];
 const output=new Map(files.map(name=>['assets/vendor/maplibre-gl/'+name,readFileSync(resolve(root,'node_modules/maplibre-gl/dist',name))]));
 const modulePath='assets/vendor/maplibre-gl/maplibre-gl.mjs';
 output.set(modulePath,Buffer.from(retainUnaffectedTiles(addHardLineEdges(output.get(modulePath).toString('utf8')))));
 output.set('assets/vendor/maplibre-gl/LICENSE.txt',readFileSync(resolve(root,'node_modules/maplibre-gl/LICENSE.txt')));
 return output;
}
