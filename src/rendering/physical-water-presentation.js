import {geometryReferenceFor} from '../geometry/geometry-version-store.js';
import '../../assets/js-vendor/polygon-clipping.min.js';

// Physical-water replacement geometry is rendered from the C++-selected
// source; the immutable source and timeline are not mutated here.
// Derived mask presentation belongs to the existing physical resource owner.
// Project water identity/periods remain owned by the common C++ document.
export function createPhysicalWaterPresentation() {
  let previousKey=null,previous=null;
  let ringBounds=new WeakMap();
  const polygons=geometry=>geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;
  const emptyBounds=()=>[Infinity,Infinity,-Infinity,-Infinity];
  function extend(box,x,y){
    if(x<box[0])box[0]=x;if(y<box[1])box[1]=y;
    if(x>box[2])box[2]=x;if(y>box[3])box[3]=y;
  }
  function boundsFor(ring){
    let box=ringBounds.get(ring);
    if(!box){box=emptyBounds();for(const [x,y]of ring)extend(box,x,y);ringBounds.set(ring,box);}
    return box;
  }
  const present=(context,replacement,visible)=>{
    if(!replacement)return visible?context:{...context,water:null};
    const ref=geometryReferenceFor(replacement.geometry);
    if(!ref)throw new Error('A copied water mask requires an admitted geometry version.');
    const key=JSON.stringify([context.revision,context.waterRevision,ref.id,ref.version]);
    if(key===previousKey)return previous;
    const replacementPolygons=polygons(replacement.geometry),waterPolygons=polygons(context.water),extent=emptyBounds();
    for(const shapes of [replacementPolygons,waterPolygons])for(const polygon of shapes)for(const ring of polygon){
      const box=boundsFor(ring);extend(extent,box[0],box[1]);extend(extent,box[2],box[3]);
    }
    const local=[],unchanged=[];
    for(const polygon of context.geometry.coordinates){
      const box=boundsFor(polygon[0]);
      (box[0]<=extent[2]&&box[2]>=extent[0]&&box[1]<=extent[3]&&box[3]>=extent[1]?local:unchanged).push(polygon);
    }
    const filled=globalThis.polygonClipping.union(...local.map(polygon=>[polygon]),waterPolygons);
    const changed=globalThis.polygonClipping.difference(filled,replacementPolygons);
    previousKey=key;previous=Object.freeze({...context,geometry:{type:'MultiPolygon',coordinates:[...unchanged,...changed]},revision:key,water:null});
    return previous;
  };
  present.clear=()=>{previousKey=null;previous=null;ringBounds=new WeakMap();};
  return present;
}
