import {partitionGlobeSpatialCatalog,describeGlobeTerritorialChunks,selectGlobeSpatialPages,collectGlobeSpatialPages} from '../../../src/rendering/globe-spatial-catalog.js';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import test from 'node:test';
import {verifyGlobePreviewIdentity} from '../../../tools/checks/verify-pages-identity.mjs';
import {partitionGlobeHistoryCatalog,selectGlobeHistoryPages,collectGlobeHistoryPages,validateGlobeHistoryDirectory} from '../../../src/rendering/globe-history-catalog.js';
import {partitionGlobePhysicalCatalog,collectGlobePhysicalPages,validateGlobePhysicalCatalog} from '../../../src/rendering/globe-physical-catalog.js';

function fixture(){
 const files=new Map(),bytes=new Map();
 const emit=(value,directory='')=>{
  const decoded=Buffer.from(JSON.stringify(value)),compressed=gzipSync(decoded);
  const sha256=createHash('sha256').update(compressed).digest('hex');
  const url='assets/data/globe-preview/'+directory+'sha256-'+sha256+'.bin.gz';
  const spec={url,sha256,encoding:'gzip',compressedBytes:compressed.length,decodedBytes:decoded.length};
  files.set(url,{sha256,bytes:compressed.length});bytes.set(url,compressed);return spec;
 };
 const chunk=id=>({spec:emit(id),bounds:[-1,-1,-1,1,1,1]});
 const physical=identity=>({identity,riverMinZoom:2,waters:[{id:'water',chunks:[chunk(identity+'-water')]}],lakes:[{minZoom:2,chunks:[chunk(identity+'-lake')]}],riverChunks:[chunk(identity+'-river')],riverDetail:[{...chunk(identity+'-detail'),id:'detail',minZoom:5}]});
 const history={historicalCountries:[{countryChunks:[chunk('dated-country')],outlineChunks:[chunk('dated-outline')]}],
  historicalBorders:[{chunks:[chunk('dated-border')]}],physicalContexts:[physical('dated')],
  history:{version:1,stride:32,rows:[]},historyTimeline:[]};
 const basePhysical=physical('current');
 const baseTerritory={countryChunks:[chunk('country')],outlineChunks:[{...chunk('outline'),ownerSlots:[],owners:[]}],borderChunks:[chunk('border')]};
 const globe={countrySlots:[],
  graticule:emit('grid'),hydroMetadata:emit('hydro'),physical:null,historySlotCount:1};
 function publishHistory(){
  for(const path of files.keys())if(path.includes('/catalog/')){files.delete(path);bytes.delete(path);}
  const physicalDirectory=context=>partitionGlobePhysicalCatalog(context,history.lodVersion,value=>emit(value,'catalog/physical/'));
  globe.physical=physicalDirectory(basePhysical);
  globe.territorialCatalog=partitionGlobeSpatialCatalog(describeGlobeTerritorialChunks(baseTerritory,history.lodVersion),history.lodVersion,value=>emit(value,'catalog/territorial/'));
  const directory=partitionGlobeHistoryCatalog({...history,physicalContexts:history.physicalContexts.map(physicalDirectory)},value=>emit(value,'catalog/pages/'));
  const root={...directory,history:history.history,historyTimeline:history.historyTimeline};
  globe.historyCatalog=emit(root,'catalog/');return root;
 }
 publishHistory();
 return {globe,history,basePhysical,baseTerritory,files,bytes,publishHistory,verify:()=>verifyGlobePreviewIdentity(globe,files,path=>bytes.get(path))};
}

test('Pages identity traverses current and historical spatial assets',()=>{
 const f=fixture();
 assert.equal(f.verify(),f.files.size);
 f.files.delete(f.history.physicalContexts[0].riverDetail[0].spec.url);
 assert.throws(f.verify,{code:'ARTIFACT_DEPLOY_DATA_PIN'});
});

test('Pages identity rejects retired unpartitioned manifests and physical packets',()=>{
 const f=fixture();
 const catalog=f.globe.territorialCatalog;delete f.globe.territorialCatalog;
 assert.throws(f.verify,{code:'ARTIFACT_DEPLOY_DATA_PIN'});
 f.globe.territorialCatalog=catalog;
 delete f.globe.physical.catalog;
 assert.throws(f.verify,{code:'ARTIFACT_DEPLOY_DATA_PIN'});
});

test('Pages identity binds compressed history content and slot count to the staged manifest',()=>{
 const f=fixture();
 f.globe.historySlotCount=2;
 assert.throws(f.verify,{code:'ARTIFACT_DEPLOY_DATA_PIN'});
 f.globe.historySlotCount=1;
 f.bytes.set(f.globe.historyCatalog.url,Buffer.from('corrupt'));
 assert.throws(f.verify,{code:'ARTIFACT_DEPLOY_DATA_PIN'});
});


test('Pages identity rejects incomplete LOD families and inconsistent history versions',()=>{
 const f=fixture();
 f.globe.lodVersion=1;
 const variants=rows=>rows.flatMap(row=>[0,1,2].map(lod=>({...row,lod})));
 const physical=context=>{
  for(const row of [...context.waters,...context.lakes])row.chunks=variants(row.chunks);
  context.riverChunks=variants(context.riverChunks);context.riverDetail=variants(context.riverDetail).map(row=>({...row,id:row.id+':'+row.lod}));
 };
 f.baseTerritory.countryChunks=variants(f.baseTerritory.countryChunks);
 f.baseTerritory.borderChunks=variants(f.baseTerritory.borderChunks);
 f.baseTerritory.outlineChunks=variants(f.baseTerritory.outlineChunks);
 physical(f.basePhysical);
 assert.throws(f.verify,{code:'ARTIFACT_DEPLOY_DATA_PIN'});
 f.history.lodVersion=1;
 for(const row of f.history.historicalCountries){row.countryChunks=variants(row.countryChunks);row.outlineChunks=variants(row.outlineChunks);}
 for(const row of f.history.historicalBorders)row.chunks=variants(row.chunks);
 for(const context of f.history.physicalContexts)physical(context);
 f.publishHistory();
 assert.equal(f.verify(),f.files.size);
 const catalog=f.globe.territorialCatalog;
 catalog.pages=catalog.pages.filter(page=>page.role!=='country'||page.lod!==1);
 catalog.counts.country=catalog.pages.filter(page=>page.role==='country').reduce((sum,page)=>sum+page.count,0);
 assert.throws(f.verify,{code:'ARTIFACT_DEPLOY_DATA_PIN'});
});

test('historical directory selects only active spatial pages and preserves original indices',()=>{
 const near=[0,0,0,.1,.1,.1],far=[-1,-1,-1,-.9,-.9,-.9];
 const family=(bounds,id)=>[0,1,2].map(lod=>({lod,bounds,spec:{sha256:id+lod}}));
 const source={lodVersion:1,historicalCountries:[
  {id:'far',countryChunks:family(far,'a'),outlineChunks:[]},
  {id:'near',countryChunks:family(near,'b'),outlineChunks:[]},
  {id:'inactive',countryChunks:family(near,'c'),outlineChunks:[]},
 ],historicalBorders:[{chunks:family(far,'d')},{chunks:family(near,'e')}],
 physicalContexts:[]};
 const values=[];
 const directory=partitionGlobeHistoryCatalog(source,value=>{
  values.push(value);return {sha256:String(values.length),decodedBytes:JSON.stringify(value).length};
 },{maxRows:1});
 Object.assign(directory,{history:{},historyTimeline:[]});
 validateGlobeHistoryDirectory(directory,{lodVersion:1,slotCount:3});
 const ids=selectGlobeHistoryPages(directory,{slots:[1,2],view:{borders:[0,1]}},
  {baseCount:1,cull:box=>box[3]>=0});
 assert.deepEqual(ids,[directory.historicalCountries[1].page,directory.historicalBorders[1].page].sort((a,b)=>a-b));
 const loaded=collectGlobeHistoryPages(directory,ids,ids.map(id=>values[id]));
 assert.equal(loaded.historicalCountries[0],undefined);
 assert.equal(loaded.historicalCountries[1].countryChunks[0].spec.sha256,'b0');
 assert.equal(loaded.historicalCountries[2],undefined);
 assert.equal(loaded.historicalBorders[1].chunks[0].spec.sha256,'e0');
 assert.throws(()=>collectGlobeHistoryPages(directory,ids,[]),/Incomplete/);
 const f=fixture(),root=f.publishHistory();
 f.files.delete(root.pages[0].spec.url);
 assert.throws(f.verify,{code:'ARTIFACT_DEPLOY_DATA_PIN'});
});

test('physical catalog pages select by spatial coverage, zoom, layer and LOD',()=>{
 const near=[.8,0,0,1,.1,.1],far=[-1,0,0,-.8,.1,.1];
 const family=(bounds,id)=>[0,1,2].map(lod=>({lod,bounds,spec:{sha256:id+lod}}));
 const raw={identity:'world',riverMinZoom:3,waters:[{id:'sea',chunks:[...family(near,'w'),...family(far,'f')]}],
  lakes:[{minZoom:4,chunks:family(near,'l')}],riverChunks:family(near,'r'),
  riverDetail:family(near,'d').map(row=>({...row,id:'detail-'+row.lod,minZoom:5}))};
 const values=[],emit=value=>{values.push(value);return {sha256:String(values.length),decodedBytes:JSON.stringify(value).length};};
 const root=partitionGlobePhysicalCatalog(raw,1,emit,{maxRows:1});
 validateGlobePhysicalCatalog(root,1);
 const ids=selectGlobeSpatialPages(root.catalog,{cull:box=>box[3]>0,zoom:3,lod:1,roles:['water','lake','river']});
 assert.deepEqual(collectGlobePhysicalPages(root,ids,ids.map(id=>values[id])).map(row=>row.spec.sha256),['w1','r1']);
 const detail=selectGlobeSpatialPages(root.catalog,{zoom:5,lod:2,roles:['detail']});
 assert.deepEqual(collectGlobePhysicalPages(root,detail,detail.map(id=>values[id])).map(row=>row.spec.sha256),['d2']);
 const all=root.catalog.pages.map((_,i)=>i);
 assert.equal(collectGlobePhysicalPages(root,all,all.map(id=>values[id]),{complete:true}).length,15);
 assert.throws(()=>collectGlobePhysicalPages(root,ids,ids.map(id=>values[id]),{complete:true}),/Incomplete/);
 const f=fixture(),page=f.globe.physical.catalog.pages[0];f.files.delete(page.spec.url);
 assert.throws(f.verify,{code:'ARTIFACT_DEPLOY_DATA_PIN'});
});

test('base territorial descriptor pages preserve keys and outline ordering across viewport selection',()=>{
 const near=[.8,0,0,1,.1,.1],far=[-1,0,0,-.8,.1,.1];
 const family=(bounds,id)=>[0,1,2].map(lod=>({lod,bounds,ownerSlots:[0],spec:{sha256:id+lod}}));
 const roles=describeGlobeTerritorialChunks({countryChunks:[...family(near,'c'),...family(far,'f')],borderChunks:family(near,'b'),outlineChunks:[...family(far,'o'),...family(near,'p')]},1);
 const values=[],emit=value=>{values.push(value);return {sha256:String(values.length),decodedBytes:JSON.stringify(value).length};};
 const root=partitionGlobeSpatialCatalog(roles,1,emit,{maxRows:1}),ids=selectGlobeSpatialPages(root,{cull:box=>box[3]>0,maxLod:1}),rows=collectGlobeSpatialPages(root,ids,ids.map(i=>values[i]));
 assert.ok(rows.every(row=>row.lod<=1&&row.bounds[3]>0));
 assert.deepEqual(rows.filter(row=>row.role==='outline').map(row=>[row.order,row.count]),[[1,2],[1,2]]);
 assert.equal(rows.find(row=>row.role==='country').key,roles.country[0].key);
 const f=fixture(),page=f.globe.territorialCatalog.pages[0];f.files.delete(page.spec.url);
 assert.throws(f.verify,{code:'ARTIFACT_DEPLOY_DATA_PIN'});
});
