import test from 'node:test';
import assert from 'node:assert/strict';
import {createViewerInitialMapSkeleton} from '../../../src/app/viewer-initial-map-skeleton.js';

function fixture({style='natural',terrain='loading',baseType='fill',supported=true}={}){
 let loading=true,ready=true,tiles=true,failed=false;
 const map={getLayer:()=>({type:baseType}),areTilesLoaded:()=>tiles};
 const renderer={map,getStats:()=>({terrainFailed:failed,mapReadiness:{mapReady:ready}})};
 const skeleton=createViewerInitialMapSkeleton({
  setLoading:value=>{loading=value;},readMapStyle:()=>style,
  readRenderer:()=>renderer,readTerrainStatus:()=>terrain,terrainSupported:()=>supported,
 });
 return {skeleton,get loading(){return loading;},
  setStyle:value=>{style=value;},setTerrain:value=>{terrain=value;},
  setBaseType:value=>{baseType=value;},setReady:value=>{ready=value;},
  setTiles:value=>{tiles=value;},setFailed:value=>{failed=value;}};
}

test('general, natural and historical skeletons wait for the actual terrain base to finish painting',()=>{
 for(const style of ['general','natural','historical']){
  const f=fixture({style});
  assert.equal(f.skeleton.reconsider(),false,'do not release before the first accepted map');
  assert.equal(f.skeleton.onFirstMapPresented(),false);
  assert.equal(f.loading,true,'the flat placeholder should stay covered');
  f.setTerrain('ready');f.setBaseType('raster');f.setTiles(false);
  assert.equal(f.skeleton.reconsider(),false,'raster layer existence is not tile readiness');
  f.setTiles(true);f.setReady(false);
  assert.equal(f.skeleton.reconsider(),false,'a stale frame cannot unveil the map');
  f.setReady(true);
  assert.equal(f.skeleton.reconsider(),true);assert.equal(f.loading,false);
  assert.equal(f.skeleton.reconsider(),false,'already revealed loading is not restarted');
 }
});

test('blank theme reveals the flat base immediately after first accepted map',()=>{
 const f=fixture({style:'blank',terrain:'loading'});
 assert.equal(f.skeleton.onFirstMapPresented(),true);
 assert.equal(f.loading,false);
});

test('missing terrain or render failure uncovers the usable flat-map fallback',()=>{
 for(const mode of ['load-failure','renderer-failure','unsupported']){
  const f=fixture();
  assert.equal(f.skeleton.onFirstMapPresented(),false);
  if(mode==='load-failure')f.setTerrain('error');
  else if(mode==='renderer-failure')f.setFailed(true);
  else f.setBaseType('fill');
  if(mode==='unsupported'){
   const x=fixture({supported:false});
   assert.equal(x.skeleton.onFirstMapPresented(),true);
   continue;
  }
  assert.equal(f.skeleton.reconsider(),true);
  assert.equal(f.loading,false);
 }
});

test('historical parchment waits for its raster even when the optional DEM fails',()=>{
 const f=fixture({style:'historical',terrain:'error',baseType:'fill'});
 assert.equal(f.skeleton.onFirstMapPresented(),false);
 f.setBaseType('raster');f.setTiles(false);
 assert.equal(f.skeleton.reconsider(),false);
 f.setTiles(true);
 assert.equal(f.skeleton.reconsider(),true);
 assert.equal(f.loading,false);
});

test('visual cover persists when theme changes before the first raster frame',()=>{
 const f=fixture({style:'blank'});
 f.setBaseType('raster');
 assert.equal(f.skeleton.onFirstMapPresented(),false);
 f.setStyle('historical');
 assert.equal(f.skeleton.reconsider(),true);
 assert.equal(f.loading,false);
});
