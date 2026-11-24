import {admittedGeometryKey as geometryKey,geometryReferenceFor} from '../geometry/geometry-version-store.js';
const immutableCollections=new WeakSet(),identities=new WeakMap();
// Cache only canonical immutable projections; mutable fixtures/edits are
// compared anew. A frozen array alone is not proof of immutable members.
export function immutableCountryRows(rows){
 if(!Object.isFrozen(rows))return false;
 if(immutableCollections.has(rows))return true;
 if(!rows.every(row=>Object.isFrozen(row)&&Object.isFrozen(row.properties)
  &&(!row.properties.style||Object.isFrozen(row.properties.style))
  &&(!row.properties.metadata||Object.isFrozen(row.properties.metadata))
  &&geometryReferenceFor(row.geometry)))return false;
 immutableCollections.add(rows);return true;
}
export function countryContentIdentity(features){
 if(!features.length)return '';
 if(identities.has(features))return identities.get(features);
 const identity=Object.freeze(features.map(feature=>Object.freeze([String(feature.id),geometryKey(feature.geometry)])));
 if(immutableCountryRows(features))identities.set(features,identity);
 return identity;
}
