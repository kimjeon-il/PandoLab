import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium} from '@playwright/test';
import {build} from 'esbuild';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {Compression, TileType, zxyToTileId} from 'pmtiles';

const extent=4096, zoom=4, tileY=7, tileLineY=3200;
const latitude=Math.atan(Math.sinh(Math.PI*(1-2*(tileY+tileLineY/extent)/2**zoom)))*180/Math.PI;
const objectKey='territorial:entity:fixture-meridian';
const layerName='fixture-boundary';
const bounds=[-12,latitude-.1,12,latitude+.1];
const geometry={type:'FeatureCollection',features:[{type:'Feature',id:'base',properties:{objectKey},
 geometry:{type:'LineString',coordinates:[[-11.25,latitude],[0,latitude],[11.25,latitude]]}}]};

function varint(value){
 const bytes=[];
 while(value>=128){bytes.push(value%128+128);value=Math.floor(value/128);}
 return [...bytes,value];
}

function createArchive(tiles){
 const ordered=[...tiles].sort((a,b)=>a.tileId-b.tileId);
 const lengths=ordered.map(({bytes})=>bytes.byteLength);
 const directory=Buffer.from([
  ...varint(ordered.length),...ordered.flatMap(({tileId},index)=>varint(tileId-(ordered[index-1]?.tileId??0))),
  ...ordered.map(()=>1),...lengths.flatMap(varint),...ordered.map((_tile,index)=>index===0?1:0),
 ]);
 const metadata=Buffer.from(JSON.stringify({vector_layers:[{id:layerName,fields:{objectKey:'String',piece:'String'}}]}));
 const header=Buffer.alloc(127);header.write('PMTiles');header[7]=3;
 // Put tile data beyond the reader's initial archive header range.
 const tileDataOffset=16384, metadataOffset=header.length+directory.length;
 [header.length,directory.length,metadataOffset,metadata.length,tileDataOffset,0,tileDataOffset,
  lengths.reduce((sum,length)=>sum+length,0),ordered.length,ordered.length,ordered.length]
  .forEach((value,index)=>header.writeBigUInt64LE(BigInt(value),8+index*8));
 header.set([1,Compression.None,Compression.None,TileType.Mvt,zoom,zoom],96);
 bounds.forEach((value,index)=>header.writeInt32LE(Math.round(value*1e7),102+index*4));
 header[118]=zoom;header.writeInt32LE(Math.round(latitude*1e7),123);
 const prefix=Buffer.alloc(tileDataOffset);header.copy(prefix);directory.copy(prefix,header.length);metadata.copy(prefix,metadataOffset);
 return {bytes:Buffer.concat([prefix,...ordered.map(tile=>tile.bytes)]),tileDataOffset};
}

async function decoderTimings(geojson,tiles){
 const resolveDecoder=createRequire(import.meta.resolve('maplibre-gl'));
 const [{VectorTile},{PbfReader}]=await Promise.all(['@mapbox/vector-tile','pbf']
  .map(dependency=>import(pathToFileURL(resolveDecoder.resolve(dependency)))));
 const times=(decode,expectedVertices)=>{
  const repetitions=100,start=performance.now();
  let vertices=0;
  for(let i=0;i<repetitions;i++)vertices+=decode();
  const elapsed=performance.now()-start;
  assert.equal(vertices,repetitions*expectedVertices);
  return elapsed/repetitions;
 };
 const direct=times(()=>JSON.parse(geojson).features[0].geometry.coordinates.length,3);
 const binary=times(()=>tiles.reduce((count,{bytes})=>{
  const layer=new VectorTile(new PbfReader(bytes)).layers[layerName];
  return count+layer.feature(0).loadGeometry()[0].length;
 },0),4);
 return {geojson:direct,mvt:binary,pmtiles:binary};
}

test('MapLibre MVT and PMTiles Range keep a joined boundary and promoted ID across tile windows', {timeout:30000}, async t=>{
 const root=fileURLToPath(new URL('../../../',import.meta.url));
 const vendor=dirname(fileURLToPath(import.meta.resolve('maplibre-gl')));
 const pmtiles=(await build({stdin:{contents:'export { Protocol } from "pmtiles";',resolveDir:root},
  bundle:true,format:'esm',write:false})).outputFiles[0].contents;
 const tiles=[['west',7,extent/2,extent],['east',8,0,extent/2]].map(([piece,x,left,right],index)=>({
  path:`/mvt/${zoom}/${x}/${tileY}.pbf`,tileId:zxyToTileId(zoom,x,tileY),
  bytes:fromGeojsonVt({[layerName]:{features:[{id:index+1,type:2,tags:{objectKey,piece},
   geometry:[[[left,tileLineY],[right,tileLineY]]]}]}},{version:2,extent}),
 }));
 const archive=createArchive(tiles),requests=[];
 const geojson=JSON.stringify(geometry),parseMs=await decoderTimings(geojson,tiles);
 const tileByPath=new Map(tiles.map(tile=>[tile.path,tile.bytes]));
 const modules=new Map([['/maplibre-gl.mjs',await readFile(resolve(vendor,'maplibre-gl.mjs'))],
  ['/maplibre-gl-worker.mjs',await readFile(resolve(vendor,'maplibre-gl-worker.mjs'))],['/pmtiles.mjs',pmtiles]]);
 const server=createServer((request,response)=>{
  const path=new URL(request.url,'http://localhost').pathname;
  if(path==='/'){
   response.writeHead(200,{'Content-Type':'text/html'}).end('<style>body{margin:0}#map{width:800px;height:600px}</style><div id="map"></div>');return;
  }
  if(modules.has(path)){response.writeHead(200,{'Content-Type':'text/javascript'}).end(modules.get(path));return;}
  if(path==='/fixture.geojson'){
   const body=Buffer.from(geojson);requests.push({path,status:200,bytes:body.length});
   response.writeHead(200,{'Content-Type':'application/geo+json'}).end(body);return;
  }
  if(path.startsWith('/mvt/')){
   const body=tileByPath.get(path);requests.push({path,status:body?200:404,bytes:body?.byteLength??0});
   response.writeHead(body?200:404,{'Content-Type':'application/vnd.mapbox-vector-tile'}).end(body);return;
  }
  if(path==='/fixture.pmtiles'){
   const range=/^bytes=(\d+)-(\d+)$/.exec(request.headers.range||'');
   if(range){
    const start=Number(range[1]),end=Math.min(Number(range[2]),archive.bytes.length-1);
    if(start<=end){
     requests.push({path,status:206,bytes:end-start+1,start,end});
     response.writeHead(206,{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${archive.bytes.length}`,
      'Content-Length':end-start+1,ETag:'"fixture-v1"','Content-Type':'application/vnd.pmtiles'}).end(archive.bytes.subarray(start,end+1));return;
    }
   }
   requests.push({path,status:416,bytes:0});response.writeHead(416,{'Content-Range':`bytes */${archive.bytes.length}`}).end();return;
  }
  response.writeHead(404).end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const browser=await chromium.launch({headless:true,args:process.platform==='win32'?['--use-angle=d3d11']:[]});
 t.after(()=>browser.close());
 const page=await browser.newPage();
 await page.goto('http://127.0.0.1:'+server.address().port);
 const result=await page.evaluate(async({latitude,bounds,zoom,layerName})=>{
  const maplibre=await import('/maplibre-gl.mjs');
  const {Protocol}=await import('/pmtiles.mjs');
  maplibre.setWorkerUrl('/maplibre-gl-worker.mjs');
  const protocol=new Protocol({metadata:true});
  maplibre.addProtocol('pmtiles',protocol.tile);
  const origin=globalThis.location.origin;
  const vector={type:'vector',promoteId:{[layerName]:'objectKey'}};
  const variants={
   geojson:{type:'geojson',data:origin+'/fixture.geojson',promoteId:'objectKey',tolerance:0},
   mvt:{...vector,tiles:[origin+'/mvt/{z}/{x}/{y}.pbf'],minzoom:zoom,maxzoom:zoom,bounds},
   pmtiles:{...vector,url:'pmtiles://'+origin+'/fixture.pmtiles'},
  };
  async function variant(name,source){
   const started=performance.now(),errors=[],tileLoadAndParseMs=[];
   const map=new maplibre.Map({container:'map',center:[0,latitude],zoom:zoom-1,interactive:false,
    attributionControl:false,fadeDuration:0,collectResourceTiming:true,canvasContextAttributes:{preserveDrawingBuffer:true},
    style:{version:8,projection:{type:'globe'},sources:{fixture:source},layers:[
     {id:'background',type:'background',paint:{'background-color':'#fff'}},
     {id:'boundary',type:'line',source:'fixture',minzoom:zoom,...(name==='geojson'?{}:{'source-layer':layerName}),
      layout:{'line-cap':'butt'},paint:{'line-color':'#a000fe','line-width':7}},
    ]}});
   map.on('error',event=>errors.push(event.error?.message));
   async function idle(phase){
    let timeout,countdown;
    const wait=new Promise(resolve=>{countdown=resolve;map.once('idle',resolve);});
    const deadline=new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error(`${name} ${phase}: ${errors.join(', ')||'idle event timed out'}`)),3000);});
    map.triggerRepaint();
    try{await Promise.race([wait,deadline]);}
    finally{clearTimeout(timeout);map.off('idle',countdown);}
   }
   const inspect=longitude=>{
    const point=map.project([longitude,latitude]);
    const canvas=map.getCanvas(),gl=canvas.getContext('webgl2'),rgb=new Uint8Array(4),ratio=map.getPixelRatio();
    gl.readPixels(Math.round(point.x*ratio),canvas.height-1-Math.round(point.y*ratio),1,1,gl.RGBA,gl.UNSIGNED_BYTE,rgb);
    const rendered=map.queryRenderedFeatures(point,{layers:['boundary']});
    return {paint:rgb[0]>110&&rgb[1]<70&&rgb[2]>190,ids:[...new Set(rendered.map(({id})=>id))],
     pieces:[...new Set(rendered.map(feature=>feature.properties.piece).filter(Boolean))]};
   };
   try{
    await idle('below zoom');
    const below=inspect(0);
    const nativeSource=map.getSource('fixture'),loadTile=nativeSource.loadTile.bind(nativeSource);
    nativeSource.loadTile=async tile=>{
     const requested=performance.now(),result=await loadTile(tile);
     if(tile.state!=='errored')tileLoadAndParseMs.push(performance.now()-requested);
     return result;
    };
    map.jumpTo({center:[-9,latitude],zoom:zoom+2});await idle('west window');const west=inspect(-9);
    map.jumpTo({center:[0,latitude],zoom});await idle('joined tile window');
    const seam=inspect(0),left=inspect(-2),right=inspect(2),readyMs=performance.now()-started;
    map.jumpTo({center:[9,latitude],zoom:zoom+2});await idle('east window');const east=inspect(9);
    return {below,west,seam,left,right,east,errors,readyMs,tileLoadAndParseMs};
   }finally{map.remove();}
  }
  try{
   const results={};
   for(const [name,source] of Object.entries(variants))results[name]=await variant(name,source);
   return results;
  }finally{maplibre.removeProtocol('pmtiles');}
 },{latitude,bounds,zoom,layerName});
 for(const [name,run] of Object.entries(result)){
  assert.deepEqual(run.errors,[],name);
  assert.deepEqual(run.below,{paint:false,ids:[],pieces:[]},name);
  for(const sample of ['west','seam','left','right','east']){
   assert.equal(run[sample].paint,true,`${name} painted ${sample}`);
   assert.deepEqual(run[sample].ids,[objectKey],`${name} resolves canonical ID at ${sample}`);
  }
  assert.ok(run.tileLoadAndParseMs.length>0&&run.tileLoadAndParseMs.every(Number.isFinite),name);
 }
 for(const name of ['mvt','pmtiles']){
  assert.deepEqual(result[name].west.pieces,['west']);
  assert.deepEqual(result[name].east.pieces,['east']);
 }
 const geojsonRequests=requests.filter(({path})=>path.endsWith('.geojson'));
 const mvtRequests=requests.filter(({path})=>path.startsWith('/mvt/'));
 const rangeRequests=requests.filter(({path})=>path.endsWith('.pmtiles'));
 assert.equal(geojsonRequests.length,1);
 assert.deepEqual([...new Set(mvtRequests.map(({path})=>path))].sort(),tiles.map(({path})=>path).sort());
 assert.ok(mvtRequests.every(({status})=>status===200));
 assert.ok(rangeRequests.every(({status})=>status===206));
 assert.ok(rangeRequests.some(({start})=>start===0),'archive header was read with Range');
 assert.ok(rangeRequests.filter(({start})=>start>=archive.tileDataOffset).length>=2,'both archive tile payloads used Range');
 for(const [name,network] of Object.entries({geojson:geojsonRequests,mvt:mvtRequests,pmtiles:rangeRequests})){
  const {readyMs,tileLoadAndParseMs}=result[name];
  const ordered=[...tileLoadAndParseMs].sort((a,b)=>a-b);
  t.diagnostic(JSON.stringify({name,requests:network.length,responseBytes:network.reduce((sum,row)=>sum+row.bytes,0),
   firstSeamReadyMs:readyMs,decodedFixtureMs:parseMs[name],tileLoads:ordered.length,
   medianTileLoadAndParseMs:ordered[Math.floor(ordered.length/2)]}));
 }
});
