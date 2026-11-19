import {overlayVisualOrder} from '../ui/layer-presentation.js';
import {admittedGeometryKey} from '../geometry/geometry-version-store.js';

/** One prepared overlay state for the MapLibre renderer. */
export function createGpuScene() {
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
  function gpuSceneOrder(group, detail = 'fill', objectKey = '', fragment = 0) {
    return overlayVisualOrder(dependencies.projectState.state.layerPresentation, group, detail, objectKey, fragment);
  }
  function replaceGpuSceneDomain(domain, {polygons = [], strokes = []} = {}) {
    const name = String(domain);
    const independent = ['base-graticule','generic-features','distributions'].includes(name);
    const normalize = item => Object.freeze({
      ...item, domain:name,
      chunkKey:String(item?.chunkKey || `${name}:${item?.key || ''}`),
      lodPolicy:String(item?.lodPolicy || (independent ? 'independent' : 'exact')),
      priority:Number(item?.priority ?? (item?.protected ? 100 : 0)),
    });
    const nextPolygons = polygons.filter(item => item?.key && item?.geometry).map(normalize);
    const nextStrokes = strokes.filter(item => item?.key && (item?.geometry || item?.startsEnds)).map(normalize);
    const items = [...nextPolygons,...nextStrokes];
    const signature = JSON.stringify(items.map(item => [
      item.key,item.geometryRevision,item.objectKey || '',item.chunkKey,
      item.lodPolicy,item.priority,item.protected === true,item.role,
      item.ownerId,item.parentId,item.territoryDepth,
      item.order,item.blendMode,item.style,
    ]));
    if (domains.get(name)?.signature === signature) return false;
    domains.set(name,{signature,polygons:nextPolygons,strokes:nextStrokes});
    return true;
  }
  function syncGpuRenderScene() {
    dependencies.rendering.gpuMapRenderer.setSceneDomains(domains);
    return domains;
  }
  return Object.freeze({
    connect,featureFromGeometry,selectionGeometryRevision,gpuSceneOrder,
    replaceGpuSceneDomain,syncGpuRenderScene,
    initializeGpuSceneDomains(){ domains.clear(); },
  });
}
