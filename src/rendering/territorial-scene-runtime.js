import { geometryRevision } from '../geometry/geometry-versions.js';
import { immutableCountryRows } from './country-content-identity.js';
import { worldViewChange, rememberWorldViewChange } from '../document/world-view-change.js';
import { territorialSceneDisplayId } from '../document/territorial-display-identity.js';
import { territorialRootId } from '../document/territorial-units.js';

export function createTerritorialSceneRuntime() {
  let territorialScope, entityRepository, state, mapRenderer;
  function connect(ports) {
    if (territorialScope)throw new Error('Territorial scene runtime already connected');
    territorialScope=ports.territorialScope; entityRepository=ports.entityRepository;
    state=ports.state; mapRenderer=ports.mapRenderer;
    if (typeof territorialScope?.displayEntities!=='function' || typeof entityRepository?.get!=='function'
      || !state || typeof mapRenderer?.invalidateCountryPalette!=='function')
      throw new TypeError('Territorial scene runtime requires its canonical project and renderer owners');
  }
  let builtinRenderCache;
  const rootOffsets = new WeakMap();
  const isRoot = entity => entity.properties.entityKind==='general'&&!entity.properties.parentId;
  function rootFeatures(entities, immutable) {
    const prior = builtinRenderCache, previous = prior?.collection.features;
    const changes = immutable&&previous&&worldViewChange(prior.entities, entities);
    if (changes&&changes.every(i => isRoot(prior.entities[i])===isRoot(entities[i]))) {
      const offsets = rootOffsets.get(previous);
      if (offsets) {
        const patches = [];
        for (const i of changes)if (isRoot(entities[i]))patches.push([offsets.get(String(entities[i].id)), entities[i]]);
        if (!patches.length)return previous;
        if (patches.every(([i]) => Number.isInteger(i))) {
          const rows = previous.slice();
          for (const [i, row]of patches)rows[i] = row;
          Object.freeze(rows); rootOffsets.set(rows, offsets);
          rememberWorldViewChange(previous, rows, patches.map(([i]) => i)); return rows;
        }
      }
    }
    const rows = entities.filter(isRoot);
    if (!immutable)return rows;
    if (previous?.length===rows.length&&rows.every((row, i) => row===previous[i]))return previous;
    Object.freeze(rows); rootOffsets.set(rows, new Map(rows.map((row, i) => [String(row.id), i])));
    return rows;
  }
  let builtinPaletteKey;
  let builtinPaletteVisibility;

  function builtinTerritorialScene() {
    const entities = territorialScope.displayEntities();
    // Admitted canonical collections already carry immutable identity. The
    // legacy revision scan is needed only for mutable source collections.
    const immutable = immutableCountryRows(entities);
    if (immutable&&builtinRenderCache?.entities===entities
      &&builtinRenderCache.presentation===state.layerPresentation)return builtinRenderCache;
    const nativeGeometryRevision = immutable?0:entities.reduce((revision, entity) => revision + geometryRevision(
      entity.properties.entityKind === 'general' && entity.properties.parentId
        ? entityRepository.get(entity.id).geometry : entity.geometry), 0);
    if (builtinRenderCache?.entities === entities && builtinRenderCache.nativeGeometryRevision === nativeGeometryRevision
      && builtinRenderCache.presentation === state.layerPresentation) return builtinRenderCache;
    const features = rootFeatures(entities, immutable);
    const boundaryFeatures = [...features];
    const byId = new Map(features.map(feature => [String(feature.id), feature]));
    const countryIds = new Set(byId.keys());
    const labelById = new Map(byId);
    const labelRefs = new Map(features.map(feature => [String(feature.id), { domain: 'territorial', type: 'entity', id: String(feature.id) }]));
    for (const unit of entities.filter(entity => entity.properties.entityKind === 'regional' || !!entity.properties.parentId)) {
      const id = territorialSceneDisplayId(unit, countryIds);
      const feature = { type: 'Feature', id, properties: unit.properties, geometry: unit.geometry,
        boundaryRootId: territorialRootId(unit, entityId => entityRepository.get(entityId)) };
      labelById.set(id, feature);
      labelRefs.set(id, { domain: 'territorial', type: 'entity', id: unit.id });
      if (unit.properties.entityKind === 'general') boundaryFeatures.push(feature);
    }
    builtinRenderCache = { entities, nativeGeometryRevision, presentation: state.layerPresentation,
      collection: { type: 'FeatureCollection', features }, boundaryCollection: { type: 'FeatureCollection', features: boundaryFeatures },
      byId, labelById, labelRefs };
    return builtinRenderCache;
  }

  function syncBuiltinPalette() {
    const cache = builtinTerritorialScene();
    const visibility = JSON.stringify([state.layerVisibility.objects, state.itemVisibility.objects]);
    if (builtinPaletteKey === cache && builtinPaletteVisibility === visibility) return;
    builtinPaletteKey = cache;
    builtinPaletteVisibility = visibility;
    mapRenderer.invalidateCountryPalette({ base: true }, 'builtin-subunit-presentation');
  }

  return Object.freeze({
    connect,
    builtinTerritorialScene,
    territorialLabelFeatureById: id => builtinTerritorialScene().labelById.get(String(id)) || null,
    syncBuiltinPalette,
  });
}
