import {overlayVisualOrder} from '../ui/layer-presentation.js';
import {admittedGeometryKey} from '../geometry/geometry-version-store.js';

/** One prepared overlay state for the MapLibre renderer. */
export function createMapScene() {
  let dependencies = null;
  const domains = new Map();
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
    const renderable = item => item?.key && item?.geometry;
    const snapshot = item => Object.freeze({...item});
    const nextPolygons = polygons.filter(renderable).map(snapshot);
    const nextStrokes = strokes.filter(renderable).map(snapshot);
    const items = [...nextPolygons,...nextStrokes];
    const signature = JSON.stringify(items.map(item => [
      item.key,item.geometryRevision,item.objectKey,item.role,item.order,item.blendMode,item.style,
    ]));
    if (domains.get(name)?.signature === signature) return false;
    domains.set(name,{signature,polygons:nextPolygons,strokes:nextStrokes});
    return true;
  }
  function syncMapScene() {
    dependencies.rendering.mapRenderer.setSceneDomains(domains);
    return domains;
  }
  return Object.freeze({
    connect,featureFromGeometry,selectionGeometryRevision,sceneOrder,
    replaceSceneDomain,syncMapScene,
    initializeSceneDomains(){ domains.clear(); },
  });
}
