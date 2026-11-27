import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import test from 'node:test';
import {verifyGlobePreviewIdentity} from '../../../tools/checks/verify-pages-identity.mjs';

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
 const physical=identity=>({identity,waters:[{chunks:[chunk(identity+'-water')]}],lakes:[{chunks:[chunk(identity+'-lake')]}],riverChunks:[chunk(identity+'-river')],riverDetail:[chunk(identity+'-detail')]});
 const history={version:1,historicalCountries:[{countryChunks:[chunk('dated-country')],outlineChunks:[chunk('dated-outline')]}],
  historicalBorders:[{chunks:[chunk('dated-border')]}],physicalContexts:[physical('dated')],
  history:{version:1,stride:32,rows:[]},historyTimeline:[]};
 const globe={countrySlots:[],countryChunks:[chunk('country')],outlineChunks:[chunk('outline')],borderChunks:[chunk('border')],
  graticule:emit('grid'),hydroMetadata:emit('hydro'),physical:physical('current'),historySlotCount:1,
  historyCatalog:emit(history,'catalog/')};
 return {globe,history,files,bytes,verify:()=>verifyGlobePreviewIdentity(globe,files,path=>bytes.get(path))};
}

test('Pages identity traverses current and historical spatial assets',()=>{
 const f=fixture();
 assert.equal(f.verify(),f.files.size);
 f.files.delete(f.history.physicalContexts[0].riverDetail[0].spec.url);
 assert.throws(f.verify,{code:'ARTIFACT_DEPLOY_DATA_PIN'});
});

test('Pages identity rejects retired unpartitioned manifests and physical packets',()=>{
 const f=fixture();
 const chunks=f.globe.countryChunks;
 f.globe.countries=chunks[0].spec;delete f.globe.countryChunks;
 assert.throws(f.verify,{code:'ARTIFACT_DEPLOY_DATA_PIN'});
 f.globe.countryChunks=chunks;
 f.globe.physical.rivers=f.globe.physical.riverChunks[0].spec;delete f.globe.physical.riverChunks;
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
  context.riverChunks=variants(context.riverChunks);context.riverDetail=variants(context.riverDetail);
 };
 f.globe.countryChunks=variants(f.globe.countryChunks);
 f.globe.borderChunks=variants(f.globe.borderChunks);
 f.globe.outlineChunks=variants(f.globe.outlineChunks);
 physical(f.globe.physical);
 assert.throws(f.verify,{code:'ARTIFACT_DEPLOY_DATA_PIN'});
 f.history.lodVersion=1;
 for(const row of f.history.historicalCountries){row.countryChunks=variants(row.countryChunks);row.outlineChunks=variants(row.outlineChunks);}
 for(const row of f.history.historicalBorders)row.chunks=variants(row.chunks);
 for(const context of f.history.physicalContexts)physical(context);
 const decoded=Buffer.from(JSON.stringify(f.history)),compressed=gzipSync(decoded),sha256=createHash('sha256').update(compressed).digest('hex');
 const old=f.globe.historyCatalog.url,url='assets/data/globe-preview/catalog/sha256-'+sha256+'.bin.gz';
 f.globe.historyCatalog={url,sha256,encoding:'gzip',compressedBytes:compressed.length,decodedBytes:decoded.length};
 f.files.delete(old);f.files.set(url,{sha256,bytes:compressed.length});f.bytes.set(url,compressed);
 assert.equal(f.verify(),f.files.size);
 f.globe.countryChunks=f.globe.countryChunks.filter(row=>row.lod!==1);
 assert.throws(f.verify,{code:'ARTIFACT_DEPLOY_DATA_PIN'});
});
