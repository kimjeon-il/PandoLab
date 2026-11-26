import { countryGeometrySignature } from './country-shared-boundary-cache.js';

// Presentation keys must not become canonical topology owner IDs.
export const countryBoundaryOwner = id => String(id).startsWith('territorial:entity:')?decodeURIComponent(String(id).slice('territorial:entity:'.length)):String(id);
export function matchesCountryGeometrySignature(feature, signature) {
  if (countryGeometrySignature(feature)===signature)return true;
  const g = feature.geometry, alternative = g?.type==='Polygon'?{type:'MultiPolygon', coordinates:[g.coordinates]}:g?.type==='MultiPolygon'&&g.coordinates.length===1?{type:'Polygon', coordinates:g.coordinates[0]}:null;
  return !!alternative&&countryGeometrySignature({geometry:alternative})===signature;
}
