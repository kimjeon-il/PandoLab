import {sameStructuredValue} from '../runtime/structured-value.js';

// Exact identities, not joined whole-world strings or unchecked hashes.
export const sameRenderIdentity = (left, right) => sameStructuredValue(left, right);

// GeoJSON updates contain only changed properties. All callers own the same
// fixed property schema, so removal of an absent key is not inferred here.
export function changedRenderProperties(previous,next){
 const changed=[];
 if(previous===next)return changed;
 for(const key of Object.keys(next))if(previous[key]!==next[key])changed.push({key,value:next[key]});
 return changed;
}
