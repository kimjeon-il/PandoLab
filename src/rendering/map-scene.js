import {overlayVisualOrder} from '../ui/layer-presentation.js';
import {admittedGeometryKey} from '../geometry/geometry-version-store.js';
import {sameRenderIdentity} from './render-identity.js';

const preparedDomains=new WeakSet();
export const isPreparedSceneDomain=value=>preparedDomains.has(value);
function freezeStyle(value){
 if(value&&typeof value==='object'&&!Object.isFrozen(value)){
  for(const child of Object.values(value))freezeStyle(child);
  Object.freeze(value);
 }
 return value;
}
const rowRevision=row=>row.geometryRevision??admittedGeometryKey(row.geometry);
function reuseRows(items,previous){
 const next=[];let same=true,byKey=null;
 for(const item of items){
  if(!item?.key||!item.geometry)continue;
  const at=previous[next.length],revision=rowRevision(item);
  let prior=at;
  if(at?.key!==item.key){byKey??=new Map(previous.map(row=>[row.key,row]));prior=byKey.get(item.key);}
  if(prior!==at)same=false;
  if(prior&&prior.geometryRevision===revision&&prior.key===item.key&&prior.objectKey===item.objectKey
   &&prior.role===item.role&&prior.order===item.order&&prior.blendMode===item.blendMode
   &&sameRenderIdentity(prior.style,item.style))next.push(prior);
  else{
   same=false;
   next.push(Object.freeze({...item,geometryRevision:revision,style:freezeStyle(structuredClone(item.style))}));
  }
 }
 return same&&next.length===previous.length?previous:Object.freeze(next);
}

/** One prepared overlay state for the MapLibre renderer. */
export function createMapScene() {
  let dependencies = null;
  let domains = new Map();
  function connect(ports) {
    if (dependencies) throw new Error('map scene already connected');
    dependencies = ports;
  }
  const featureFromGeometry = (geometry, properties = {}) =>
    geometry ? {type:'Feature', properties, geometry} : null;

  function selectionGeometryRevision(key, role = 'outline', feature = null) {
    const geometry = feature?.geometry;
    return geometry
      ? `${key}:${role}:${admittedGeometryKey(geometry)}`
      : `${key}:${role}:state-${dependencies.projectState.state.stateRevision}:country-${dependencies.countries.countryLandRevision}`;
  }
  function sceneOrder(group, detail = 'fill', objectKey = '', fragment = 0) {
    return overlayVisualOrder(dependencies.projectState.state.layerPresentation, group, detail, objectKey, fragment);
  }
  function replaceSceneDomain(domain, {polygons = [], strokes = []} = {}) {
    const name = String(domain);
    const prior=domains.get(name);
    const nextPolygons=reuseRows(polygons,prior?.polygons??[]);
    const nextStrokes=reuseRows(strokes,prior?.strokes??[]);
    if(prior&&nextPolygons===prior.polygons&&nextStrokes===prior.strokes)return false;
    const prepared=Object.freeze({polygons:nextPolygons,strokes:nextStrokes});
    preparedDomains.add(prepared);
    domains=new Map(domains);domains.set(name,prepared);
    return true;
  }
  function syncMapScene() {
    dependencies.rendering.mapRenderer.setSceneDomains(domains);
    return domains;
  }
  return Object.freeze({
    connect,featureFromGeometry,selectionGeometryRevision,sceneOrder,
    replaceSceneDomain,syncMapScene,
    initializeSceneDomains(){ domains=new Map(); },
  });
}
