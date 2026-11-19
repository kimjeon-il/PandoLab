import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

// Package the dependency from the installed, lockfile-selected distribution.
export function mapLibreVendorAssets(root){
 const project=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'));
 const dependency=JSON.parse(readFileSync(resolve(root,'node_modules/maplibre-gl/package.json'),'utf8'));
 if(project.dependencies?.['maplibre-gl']!==dependency.version)throw Error('Installed MapLibre version differs from the pinned Viewer dependency');
 const files=['maplibre-gl.mjs','maplibre-gl-worker.mjs','maplibre-gl-shared.mjs','maplibre-gl.css'];
 const output=new Map(files.map(name=>['assets/vendor/maplibre-gl/'+name,readFileSync(resolve(root,'node_modules/maplibre-gl/dist',name))]));
 output.set('assets/vendor/maplibre-gl/LICENSE.txt',readFileSync(resolve(root,'node_modules/maplibre-gl/LICENSE.txt')));
 return output;
}
