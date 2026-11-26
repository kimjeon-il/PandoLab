import { layerStyle } from '../ui/layer-presentation.js';
import { globeInteractionStyles, globeRoleStyleKey, globeInteractionRoles, sameGlobeRoleInputs, emptyRoleStyles } from './globe-style-state.js';

// Own the mutable country/hydro/material presentation cache and its invalidation.
// The frame coordinator reads snapshots and announces changes, not individual flags.
export function createGlobePaintState({
  state, refs, hydroSlots, readPalette, territorialColor, objectRefVisible, highlightCandidates,
  onPickingChanged, onOutlineRolesChanged,
}) {
  let countryPaintInputsDirty = true, paintDirty = true, fullPaintDirty = true;
  let countryRolesDirty = true, countryEmphasisDirty = true, hydroRolesDirty = true, hydroStyleDirty = true;
  let layerPaintDirty = true, paletteDirty = true, renderPalette = null;
  const basePaint = new Map(), dirtyPaintSlots = new Set();
  let visiblePaintSlots = new Set(), countryRoles = new Map(), hydroRoles = new Map(), waterRoles = new Map();
  let style = null, roleStyles = emptyRoleStyles, interactionRefs = globeInteractionRoles(null);
  const paintStats = {countrySlots:0, countryRoleUpdates:0, hydroRoleUpdates:0, paletteUpdates:0};
  function markCountryInputs() {countryPaintInputsDirty = countryRolesDirty = paintDirty = true;}
  function markHydroInputs() {hydroRolesDirty = hydroStyleDirty = paintDirty = true; onPickingChanged();}
  function markCountryBase() {countryPaintInputsDirty = paintDirty = true;}
  function markCountrySlot(slot) {dirtyPaintSlots.add(slot); paintDirty = true;}
  function markCountryRoles() {countryRolesDirty = paintDirty = true;}
  function markHydroRoles() {hydroRolesDirty = paintDirty = true;}
  function markHydroStyle() {hydroStyleDirty = paintDirty = true;}
  function markPhysicalStyle() {paletteDirty = hydroStyleDirty = paintDirty = true;}
  function markPalette() {paletteDirty = paintDirty = true;}
  function markLayers() {layerPaintDirty = paintDirty = true;}
  function setSelection(value) {
    const roles = globeInteractionRoles(value, highlightCandidates());
    if (!sameGlobeRoleInputs(interactionRefs.territorial, roles.territorial))markCountryRoles();
    if (!sameGlobeRoleInputs(interactionRefs.hydro, roles.hydro))markHydroRoles();
    interactionRefs = roles;
  }
  function setInteractionStyle(value) {
    const next = globeInteractionStyles(value);
    if (globeRoleStyleKey(roleStyles,'fill')!==globeRoleStyleKey(next,'fill'))countryEmphasisDirty = paintDirty = true;
    if (globeRoleStyleKey(roleStyles,'outline')!==globeRoleStyleKey(next,'outline'))onOutlineRolesChanged();
    if (globeRoleStyleKey(roleStyles,'hydro')!==globeRoleStyleKey(next,'hydro'))markHydroStyle();
    if (Boolean(style)!==Boolean(value)) {markCountryRoles(); markHydroRoles();}
    style = value; roleStyles = next;
  }
  function refreshPalette(surface) {
    if (paletteDirty) {
      const next = readPalette();
      if (!renderPalette||renderPalette.defaultLand!==next.defaultLand) {fullPaintDirty = true; markCountryInputs();}
      if (!renderPalette||renderPalette.ocean!==next.ocean)hydroStyleDirty = true;
      renderPalette = next; surface?.setPalette(next); paletteDirty = false; paintStats.paletteUpdates++;
    }
  }
  function updatePaint(surface, {activeSlots, activeSlotByKey, features, bordersNeeded}) {
    refreshPalette(surface);
    const changed = new Set();
    if (fullPaintDirty||countryPaintInputsDirty||dirtyPaintSlots.size) {
      const colors = layerStyle(state.layerPresentation,'objects').colorVisible!==false;
      const pendingSlots = fullPaintDirty||countryPaintInputsDirty?new Set([...basePaint.keys(), ...activeSlots]):dirtyPaintSlots;
      let nextVisible = null;
      for (const slot of pendingSlots) {
        paintStats.countrySlots++;
        const previous = basePaint.get(slot);
        if (!activeSlots.has(slot)) {
          if (previous) {basePaint.delete(slot); changed.add(slot);}
          if (visiblePaintSlots.has(slot)) {nextVisible??=new Set(visiblePaintSlots); nextVisible.delete(slot);}
          continue;
        }
        const ref = refs[slot], color = colors?territorialColor(features.get(ref.id)):null, visible = Boolean(objectRefVisible(ref));
        if (fullPaintDirty||!previous||previous.color!==color||previous.visible!==visible) {basePaint.set(slot, {color, visible}); changed.add(slot);}
        if (visible!==visiblePaintSlots.has(slot)) {
          nextVisible??=new Set(visiblePaintSlots); if (visible)nextVisible.add(slot); else nextVisible.delete(slot);
        }
      }
      if (nextVisible) {visiblePaintSlots = nextVisible; countryRolesDirty = true; onPickingChanged();}
      countryPaintInputsDirty = false; dirtyPaintSlots.clear();
    }
    if (countryRolesDirty) {
      const nextRoles = new Map();
      if (style)for (const [key, {code}] of interactionRefs.territorial) {
        const slot = activeSlotByKey.get(key); if (slot!==undefined&&visiblePaintSlots.has(slot))nextRoles.set(slot, code);
      }
      for (const slot of new Set([...countryRoles.keys(), ...nextRoles.keys()]))if (countryRoles.get(slot)!==nextRoles.get(slot))changed.add(slot);
      const roleChanged = nextRoles.size!==countryRoles.size||[...nextRoles].some(([slot, code]) => countryRoles.get(slot)!==code);
      if (roleChanged)onOutlineRolesChanged();
      countryRoles = nextRoles; countryRolesDirty = false; paintStats.countryRoleUpdates++;
    }
    if (countryEmphasisDirty)for (const slot of countryRoles.keys())changed.add(slot);
    if (changed.size)surface.setCountryPaint([...changed].map(slot => {
      const base = basePaint.get(slot)??{color:null, visible:false}, appearance = roleStyles[countryRoles.get(slot)];
      return [slot, {...base, highlight:appearance?{color:appearance.color, alpha:appearance.fillAlpha}:null}];
    }), {full:changed.size>Math.max(64, activeSlots.size/2)});
    if (hydroRolesDirty) {
      hydroRoles = new Map(); waterRoles = new Map();
      if (style)for (const {ref, code} of interactionRefs.hydro.values()) {
        if (!objectRefVisible(ref))continue;
        const slot = hydroSlots.get(ref.id); if (slot!==undefined)hydroRoles.set(slot, code);
        waterRoles.set(ref.id, code);
      }
      hydroRolesDirty = false; hydroStyleDirty = true; paintStats.hydroRoleUpdates++;
    }
    if (hydroStyleDirty) {surface.setHydroPaint(hydroRoles, waterRoles, roleStyles, style?.selection.color); hydroStyleDirty = false;}
    if (layerPaintDirty) {
      for (const layer of ['lakes','rivers'])surface.setLayerVisibility(layer, state.layerVisibility[layer]!==false);
      surface.setLayerVisibility('borders', bordersNeeded()); layerPaintDirty = false;
    }
    paintDirty = fullPaintDirty = countryEmphasisDirty = false;
  }
  function resetProject() {
    dirtyPaintSlots.clear();
    countryPaintInputsDirty = paintDirty = countryRolesDirty = hydroRolesDirty = hydroStyleDirty = layerPaintDirty = true;
  }
  return Object.freeze({
    initializePalette:() => {renderPalette = readPalette(); return renderPalette;},
    currentPalette:() => renderPalette??readPalette(), roleStyles:() => roleStyles,
    countryRoles:() => countryRoles, outlineColor:() => style?.selection.color, visibleSlots:() => visiblePaintSlots,
    pendingCountrySlots:() => dirtyPaintSlots.size, needsUpdate:() => paintDirty,
    markCountryInputs, markCountryBase, markCountrySlot, markCountryRoles, markHydroInputs,
    markHydroRoles, markHydroStyle, markPhysicalStyle, markPalette, markLayers,
    setSelection, setInteractionStyle, refreshPalette, updatePaint, resetProject,
    stats:() => ({...paintStats}), dispose:() => {basePaint.clear(); dirtyPaintSlots.clear();},
  });
}
