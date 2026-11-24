// MapLibre owns tile clipping, simplification and zoom-dependent reuse.
// The tolerance is in native tile pixels, not geographic degrees. Never
// introduce a second whole-world source rebuild when the camera zoom changes.
export const MAPLIBRE_DISPLAY_TOLERANCE=0.5;
const exactKinds=new Set(['territories','physical-land','physical-water','hydro-edits','highlight','overlay']);
export function mapLibreGeoJsonSource(kind,data={type:'FeatureCollection',features:[]},options={}){
 if(!exactKinds.has(kind)&&kind!=='hydro'&&kind!=='derived-line')throw new TypeError('Unknown map source kind: '+kind);
 return {type:'geojson',data,...options,tolerance:exactKinds.has(kind)?0:MAPLIBRE_DISPLAY_TOLERANCE};
}
// Only generated, nonselectable lines may use native DP simplification.
// Canonical country/overlay lines retain the shared junction coordinates.
export function mapLibreVectorSourceKind(rows){
 return rows.length&&rows.every(row=>row.kind==='line'&&row.role==='graticule'&&!row.objectKey)?'derived-line':'overlay';
}
