import {createStoredAssetLoader} from './stored-asset-loader.js';
import {PHYSICAL_LAND_DISPLAY_ALGORITHM} from '../rendering/physical-land-display.js';
import {loadPhysicalLandGeometry} from './physical-land-patch.js';

// Raw, project-pinned physical asset bytes are owned outside the renderer.
// This service has no map, GPU, C++ timeline or object-selection dependencies.
export function createPhysicalAssetReader({
  buildMeta,resolveBaseUrl,onLandReady=()=>{},createLoader=createStoredAssetLoader,
}={}){
  if(typeof resolveBaseUrl!=='function')
    throw new TypeError('Physical asset reader requires build metadata and a source base URL');
  let loader=null,physicalLand=null;
  const preparedLand=new Map();
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
  async function loadPhysicalLandDisplay(identity){
    const spec=buildMeta?.physicalLandDisplays?.[identity];
    if(!spec)return null;
    if(spec.sourceSha256!==identity||spec.algorithmVersion!==PHYSICAL_LAND_DISPLAY_ALGORITHM||!/^([a-f0-9]{64})$/.test(spec.algorithmSha256||'')
      ||spec.encoding!=='gzip'||spec.url!==`assets/data/display-land/sha256-${spec.sha256}.json.gz`)
      throw new Error('Physical land display does not match its canonical source or algorithm.');
    const response=await storedPhysicalAssets().loadAsset(spec,'background','physical-land-display:'+identity,'육지 표시',buffer=>decodeGeometry(buffer,'physical display'));
    return response.value;
  }
  async function loadPhysicalLand(spec=buildMeta?.physicalLand){
    if(!spec)throw new Error('Missing pinned physical land asset.');
    const key=spec.sha256;
    if(!preparedLand.has(key))preparedLand.set(key,(async()=>{
      // Both render paths use the same verified coverage. Canonical patches
      // still read their original base when the display asset is unavailable.
      const display=await loadPhysicalLandDisplay(key).catch(()=>null);
      const load=(asset,decode)=>storedPhysicalAssets().loadAsset(asset,'background',asset.sha256,'육지 배경',decode).then(result=>result.value);
      const geometry=display??await loadPhysicalLandGeometry(spec,{
        loadGeometry:asset=>load(asset,buffer=>decodeGeometry(buffer,'physical land')),
        loadPatch:asset=>load(asset,buffer=>JSON.parse(new TextDecoder().decode(buffer))),
      });
      const context=Object.freeze({geometry,revision:key,displayPrepared:display!==null});
      if(key===buildMeta.physicalLand.sha256){physicalLand=context;onLandReady();}
      return context;
    })().catch(error=>{preparedLand.delete(key);throw error;}));
    return preparedLand.get(key);
  }
  return Object.freeze({storedPhysicalAssets,loadPhysicalLand,
    get physicalLand(){return physicalLand;}});
}
