import { layerStyle, resolveLayerDisplayColor } from "../ui/layer-presentation.js";
import { resolveTerritorialColor } from "../ui/color-adapter.js";

// One material contract for all objects. Independent regions never claim land
// ownership or inherit the general hierarchy's paint.
export function createTerritorialFillResolver({ state, entityRepository, mapSubstrate = null, neutralColor = null, resolveStoredColors = false }) {
  const cache = new Map();
  const original = state.layerPresentation;
  const presentation = resolveStoredColors
    ? {...original, styles:{...original?.styles, objects:{...original?.styles?.objects, colorVisible:true}}}
    : original;
  const colorsEnabled = layerStyle(presentation, 'objects').colorVisible;
  const colorVisible = feature => colorsEnabled
    && layerStyle(presentation, 'objects', `territorial:entity:${feature.id}`).colorVisible;
  function resolve(feature, visiting = new Set()) {
    const entity = entityRepository.get(feature.id) || feature;
    const id = String(entity.id), properties = entity.properties;
    if (cache.has(id)) return cache.get(id);
    if (visiting.has(id)) throw new Error(`객체 표시 관계가 순환합니다: ${id}`);
    visiting.add(id);
    const group = 'objects';
    const independent = properties.entityKind === 'regional';
    const parent = independent ? null : entityRepository.parent(id);
    const inherited = parent ? resolve(parent, visiting) : null;
    const style = layerStyle(presentation, group, `territorial:entity:${id}`);
    const explicit = presentation?.objectStyles?.[`territorial:entity:${id}`] || {};
    const groupStyle = presentation?.styles?.[group] || {};
    const blendMode = inherited ? explicit.blendMode ?? (groupStyle.blendMode === 'multiply' ? 'multiply' : inherited.blendMode) : style.blendMode;
    const color = colorVisible(entity) ? resolveLayerDisplayColor(presentation, group, {
      objectKey: `territorial:entity:${id}`, explicitColor: properties.style?.color,
      inheritedColor: resolveTerritorialColor(entity, { entityRepository, colorVisible, fallback: '' }), fallbackColor: '',
    }) : '';
    const substrate = !independent && !parent && !color ? mapSubstrate : null;
    // Neutral opaque geometry remains pickable without modifying stored colors.
    const neutral = !colorsEnabled ? neutralColor : null;
    const result = Object.freeze({ color: neutral || color || substrate?.color || '', blendMode: neutral ? 'normal' : blendMode,
      fillAlpha: neutral ? 1 : color ? 1 : substrate?.fillAlpha || 0,
      depth: inherited ? inherited.depth + 1 : 0,
      ownerId: independent ? '' : inherited?.ownerId || id, parentId: String(properties.parentId || '') });
    visiting.delete(id);
    cache.set(id, result);
    return result;
  }
  return resolve;
}
