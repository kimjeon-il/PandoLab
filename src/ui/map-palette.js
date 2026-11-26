import { layerStyle } from './layer-presentation.js';
import { resolveMapStrokeStyle } from '../map/map-interaction-style.js';

// A single white cartographic surface. App light/dark mode does not recolor it.
// Territorial colors are resolved separately from the canonical object data.
export function resolveMapPalette({state} = {}) {
  const country = state?.layerPresentation?layerStyle(state.layerPresentation,'objects'):{boundaryVisible:true, boundaryWidth:1};
  const rivers = state?.layerPresentation?layerStyle(state.layerPresentation,'rivers'):{boundaryVisible:true, boundaryWidth:1};
  const lakes = state?.layerPresentation?layerStyle(state.layerPresentation,'lakes'):{boundaryVisible:true, boundaryWidth:1};
  const base = {
    defaultLand:'#f1f1f1', baseLandAlpha:1,
    ocean:'#ffffff', oceanGpu:[1, 1, 1], border:'#515151', borderGpu:[81/255,81/255,81/255],
    borderAlpha:country.boundaryVisible?1:0, borderWidth:country.boundaryWidth,
    riverWidth:rivers.boundaryWidth, lakeBoundaryVisible:lakes.boundaryVisible, lakeBoundaryWidth:lakes.boundaryWidth,
    loadingSurface:Object.freeze({ocean:'#ffffff', land:'#f1f1f1'}),
    labels:Object.freeze({text:'#1c2229', halo:'rgba(255,255,255,.94)', point:'#373b42', selection:'#315e9d'}),
  };
  const strokes = Object.fromEntries(['country','country-internal','river','hydro-boundary']
    .map(role => [role, resolveMapStrokeStyle({theme:base}, role)]));
  delete base.borderWidth; delete base.riverWidth; delete base.lakeBoundaryWidth;
  return Object.freeze({...base, strokes:Object.freeze(strokes)});
}
