import {changedCountryGeometryIds,countryGeometrySignature} from './country-shared-boundary-cache.js';

// Presentation keys must not become canonical topology owner IDs.
export const countryBoundaryOwner=id=>String(id).startsWith('territorial:entity:')?decodeURIComponent(String(id).slice('territorial:entity:'.length)):String(id);
export function matchesCountryGeometrySignature(feature,signature){
 if(countryGeometrySignature(feature)===signature)return true;
 const g=feature.geometry,alternative=g?.type==='Polygon'?{type:'MultiPolygon',coordinates:[g.coordinates]}:g?.type==='MultiPolygon'&&g.coordinates.length===1?{type:'Polygon',coordinates:g.coordinates[0]}:null;
 return !!alternative&&countryGeometrySignature({geometry:alternative})===signature;
}
export function countryBoundarySeedOptions(features,seed){
 if(!seed)return undefined;
 if(seed.version!==1||seed.quality!=='canonical'||!Array.isArray(seed.segments)||!seed.signatures)throw Error('Invalid canonical boundary seed');
 const changedIds=changedCountryGeometryIds(features,seed.signatures);
 for(const feature of features)if(changedIds.has(String(feature.id))){
  if(matchesCountryGeometrySignature(feature,seed.signatures[String(feature.id)]))changedIds.delete(String(feature.id));
 }
 return {cachedSegments:seed.segments,changedIds};
}
export async function loadCountryBoundarySeed(meta,load){
 const spec=meta?.countryBoundarySeed;
 if(!spec||spec.worldCatalogSha256!==meta.projectCatalogs?.world?.sha256||spec.territorialCatalogSha256&&spec.territorialCatalogSha256!==meta.projectCatalogs?.territorial?.sha256)return null;
 if(!/^assets\/data\/[\w./-]+\.json\.gz$/.test(spec.url)||spec.url.split('/').includes('..')||!/^[a-f0-9]{64}$/.test(spec.sha256))throw Error('Invalid boundary seed receipt');
 const result=await load(spec);countryBoundarySeedOptions([],result);return result;
}
