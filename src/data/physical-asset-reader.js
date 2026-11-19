import {createStoredAssetLoader} from './stored-asset-loader.js';
import {PHYSICAL_LAND_DISPLAY_ALGORITHM} from '../rendering/physical-land-display.js';

// Raw, project-pinned physical asset bytes are owned outside the renderer.
// This service has no map, GPU, C++ timeline or object-selection dependencies.
export function createPhysicalAssetReader({
  buildMeta,resolveBaseUrl,onLandReady=()=>{},createLoader=createStoredAssetLoader,
}={}){
  if(typeof resolveBaseUrl!=='function')
    throw new TypeError('Physical asset reader requires build metadata and a source base URL');
  let loader=null,physicalLand=null,landLoading=null;
  const displays=new Map();
  const storedPhysicalAssets=()=>{
    if(!loader)loader=createLoader({dataRevision:buildMeta?.dataRevision,
      resolveUrl:spec=>new URL(spec.url.replace(/^assets\/data\//,''),resolveBaseUrl()).href});
    return loader;
  };
  const decodeGeometry=(buffer,label)=>{
    const geometry=JSON.parse(new TextDecoder().decode(buffer));
    if(geometry?.type!=='MultiPolygon'||!Array.isArray(geometry.coordinates))
      throw new TypeError('Invalid '+label+' geometry.');
    return geometry;
  };
  function loadPhysicalLandMask({notify=true}={}){
    if(physicalLand)return Promise.resolve(physicalLand);
    if(!landLoading)landLoading=(async()=>{
      const spec=buildMeta?.physicalLand;
      if(!spec)throw new Error('Missing pinned physical land asset.');
      // The code-owned display derivative and canonical mask load in parallel.
      // Its own publication path reports a failure; raw mask loading is independent.
      loadPhysicalLandDisplay(spec.sha256).catch(()=>{});
      const response=await storedPhysicalAssets().loadAsset(spec,'background','physical-land','육지 배경',
        buffer=>decodeGeometry(buffer,'physical land'));
      physicalLand=Object.freeze({geometry:response.value,revision:spec.sha256});
      if(notify)onLandReady();
      return physicalLand;
    })().catch(error=>{landLoading=null;throw error;});
    return landLoading;
  }
  async function loadPhysicalLandDisplay(identity){
    const spec=buildMeta?.physicalLandDisplays?.[identity];
    if(!spec)return null;
    if(spec.sourceSha256!==identity||spec.algorithmVersion!==PHYSICAL_LAND_DISPLAY_ALGORITHM||!/^([a-f0-9]{64})$/.test(spec.algorithmSha256||'')
      ||spec.encoding!=='gzip'||spec.url!==`assets/data/display-land/sha256-${spec.sha256}.json.gz`)
      throw new Error('Physical land display does not match its canonical source or algorithm.');
    if(!displays.has(identity)){
      const task=storedPhysicalAssets().loadAsset(spec,'background','physical-land-display:'+identity,'육지 표시',buffer=>decodeGeometry(buffer,'physical display'))
        .then(response=>response.value).catch(error=>{displays.delete(identity);throw error;});
      displays.set(identity,task);
    }
    return displays.get(identity);
  }
  return Object.freeze({storedPhysicalAssets,loadPhysicalLandMask,loadPhysicalLandDisplay,
    get physicalLand(){return physicalLand;}});
}
