import {geometryRevision} from "../geometry/geometry-versions.js";
import {immutableCountryRows} from './country-content-identity.js';
import {territorialSceneDisplayId} from "../document/territorial-display-identity.js";
import {territorialRootId} from "../document/territorial-units.js";

export function createTerritorialSceneRuntime({getDependencies}={}){
  if(typeof getDependencies!=='function')
    throw new TypeError('Territorial scene requires an admitted project read-port accessor');
  let builtinRenderCache;
  let builtinPaletteKey;
  let builtinPaletteVisibility;

  function builtinTerritorialScene() {
    const dependencies=getDependencies();
    const entities = dependencies.territorialObjectModel.territorialScope.displayEntities();
    // Admitted canonical collections already carry immutable identity. The
    // legacy revision scan is needed only for mutable source collections.
    const immutable=immutableCountryRows(entities);
    if(immutable&&builtinRenderCache?.entities===entities
      &&builtinRenderCache.presentation===dependencies.projectState.state.layerPresentation)return builtinRenderCache;
    const nativeGeometryRevision = immutable?0:entities.reduce((revision, entity) => revision + geometryRevision(
      entity.properties.entityKind === 'general' && entity.properties.parentId
        ? dependencies.territorialModel.entityRepository.get(entity.id).geometry : entity.geometry), 0);
    if (builtinRenderCache?.entities === entities && builtinRenderCache.nativeGeometryRevision === nativeGeometryRevision
      && builtinRenderCache.presentation === dependencies.projectState.state.layerPresentation) return builtinRenderCache;
    const features = entities.filter(entity => entity.properties.entityKind === 'general' && !entity.properties.parentId);
    const boundaryFeatures = [...features];
    const byId = new Map(features.map(feature => [String(feature.id), feature]));
    const countryIds = new Set(byId.keys());
    const labelById = new Map(byId);
    const labelRefs = new Map(features.map(feature => [String(feature.id), { domain: 'territorial', type: 'entity', id: String(feature.id) }]));
    for (const unit of entities.filter(entity => entity.properties.entityKind === 'regional' || !!entity.properties.parentId)) {
      const id = territorialSceneDisplayId(unit, countryIds);
      const feature = { type: 'Feature', id, properties: unit.properties, geometry: unit.geometry,
        boundaryRootId: territorialRootId(unit, entityId => dependencies.territorialModel.entityRepository.get(entityId)) };
      labelById.set(id, feature);
      labelRefs.set(id, { domain: 'territorial', type: 'entity', id: unit.id });
      if (unit.properties.entityKind === 'general') boundaryFeatures.push(feature);
    }
    builtinRenderCache = { entities, nativeGeometryRevision, presentation: dependencies.projectState.state.layerPresentation,
      collection: { type: 'FeatureCollection', features }, boundaryCollection: { type: 'FeatureCollection', features: boundaryFeatures },
      byId, labelById, labelRefs };
    return builtinRenderCache;
  }

  function syncBuiltinPalette() {
    const dependencies=getDependencies();
    const cache = builtinTerritorialScene();
    const visibility = JSON.stringify([dependencies.projectState.state.layerVisibility.objects, dependencies.projectState.state.itemVisibility.objects]);
    if (builtinPaletteKey === cache && builtinPaletteVisibility === visibility) return;
    builtinPaletteKey = cache;
    builtinPaletteVisibility = visibility;
    dependencies.rendering.mapRenderer.invalidateCountryPalette({ base: true }, 'builtin-subunit-presentation');
  }

  return Object.freeze({
    builtinTerritorialScene,
    territorialLabelFeatureById: id => builtinTerritorialScene().labelById.get(String(id)) || null,
    syncBuiltinPalette,
  });
}
