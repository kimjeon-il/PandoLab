import {admittedGeometryKey as geometryKey} from '../geometry/geometry-version-store.js';
// The empty sentinel preserves the existing empty-date admission contract.
export const countryContentIdentity=features=>features.length?features.map(feature=>[String(feature.id),geometryKey(feature.geometry)]):'';
