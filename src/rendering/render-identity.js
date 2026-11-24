// Exact structured render identities. Compare bounded rows, not a joined
// whole-world string or an unchecked hash; delimiters inside IDs are harmless.
export function sameRenderIdentity(a,b){
 if(a===b)return true;
 if(a==null||b==null||typeof a!=='object'||typeof b!=='object')return false;
 if(Array.isArray(a)||Array.isArray(b))
  return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((value,index)=>sameRenderIdentity(value,b[index]));
 const keys=Object.keys(a),other=Object.keys(b);
 return keys.length===other.length&&keys.every(key=>Object.hasOwn(b,key)&&sameRenderIdentity(a[key],b[key]));
}

// GeoJSON updates contain only changed properties. All callers own the same
// fixed property schema, so removal of an absent key is not inferred here.
export function changedRenderProperties(previous,next){
 const changed=[];
 if(previous===next)return changed;
 for(const key of Object.keys(next))if(previous[key]!==next[key])changed.push({key,value:next[key]});
 return changed;
}
