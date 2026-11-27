import { forwardAbort } from '../runtime/async-request.js';
import { normalizeObjectRef } from '../document/object-ref-identity.js';
import {
  globeRayIntersectsBounds, globeStrokePickPredicate, createGlobePickBudget, createGlobePacketIndex,
  pickGlobeSlotsCooperative, pickGlobeStrokeSlotsCooperative,
} from './globe-picking.js';

// A click belongs to the scene that was actually displayed at pointer-up.
// Optional packet arrivals, label rasterization and paint refreshes must not
// cancel a valid click while its lazily loaded identity is admitted to Core.
export function sameGlobePickScene(a,b){
  return !!a&&!!b&&a.generation===b.generation&&a.contextRevision===b.contextRevision&&a.month===b.month
    &&a.camera===b.camera&&a.viewport===b.viewport&&a.territories===b.territories
    &&a.physical?.spec.identity===b.physical?.spec.identity&&a.visibleSlots===b.visibleSlots
    &&a.lakesVisible===b.lakesVisible&&a.riversVisible===b.riversVisible&&a.hydroVisibilityKey===b.hydroVisibilityKey;
}

// Only visible required fill chunks participate in hover. A padded margin
// download cannot change hits on the current viewport, and labels/river
// strokes are deliberately excluded by the hover query contract.
export function reconcileGlobeFillPickIndex(previous, requiredRows, preparedRows) {
  if (previous?.requiredRows===requiredRows)return previous;
  const keys = requiredRows.map(row => row.key);
  const prepared = new Map(preparedRows.map(row => [row.key, row]));
  const rows = keys.map(key => {
    const row = prepared.get(key);
    if (!row)throw Error('Missing admitted fill pick coverage');
    return row;
  });
  const same = previous&&keys.length===previous.keys.length&&keys.every((key, i) => key===previous.keys[i]);
  return {requiredRows, keys, index:same?previous.index:createGlobePacketIndex(rows, row => row.mesh.packet.spatialBounds)};
}
export function sameGlobeHoverScene(a, b) {
  return !!a&&!!b&&a.generation===b.generation&&a.contextRevision===b.contextRevision&&a.month===b.month
    &&a.camera===b.camera&&a.viewport===b.viewport&&a.visibleSlots===b.visibleSlots
    &&a.lakesVisible===b.lakesVisible&&a.countryIndex===b.countryIndex&&a.waterIndex===b.waterIndex&&a.lakeIndex===b.lakeIndex;
}

/** Resolves map hits against the last accepted frame and admits visible hydro identities. */
export function createGlobeObjectQuery({
  getAcceptedPick, canPickFrame, cancelNeighborPrefetch, startRequest, finishRequest, refs,
  hydroFeaturesForSlots, isHydroFeatureVisible, hydroFeatureById, admitHydroFeatures,
}) {
  async function queryObjectRefs(point, {includeHydro = true, includeLabels = true, signal:consumerSignal} = {}) {
    if (includeHydro||includeLabels)cancelNeighborPrefetch();
    const sample = getAcceptedPick();
    if (!canPickFrame()||!sample)throw new DOMException('Picking frame unavailable','AbortError');
    const requestName = includeHydro||includeLabels?'pick-click':'pick-hover';
    const controller = startRequest(requestName);
    const detachAbort = forwardAbort(consumerSignal, controller);
    const {signal} = controller;
    const isCurrent = () => !signal.aborted&&canPickFrame()&&(requestName==='pick-click'
      ?sameGlobePickScene(sample,getAcceptedPick()):sameGlobeHoverScene(sample,getAcceptedPick()));
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (!isCurrent())throw new DOMException('Picking frame superseded','AbortError');
    };
    try {
      assertCurrent();
      const label = includeLabels?sample.labelHit(point):null;
      if (label)return [label];
      const sampledCamera = sample.camera, ray = sampledCamera.worldRay(point);
      if (!ray)return [];
      const budget = createGlobePickBudget({signal, isCurrent});
      const intersect = bounds => globeRayIntersectsBounds(ray, bounds);
      const waterFeatures = [], lakeSlots = new Set();
      for (const row of await sample.waterIndex.queryCooperative(intersect, budget)) {
        const packet = row.mesh.packet;
        if ((await pickGlobeSlotsCooperative(packet, packet.spatial, ray, undefined, {firstHit:true, budget})).length) {
          if (!includeHydro) {assertCurrent(); return [];}
          waterFeatures.push(row.feature);
        }
      }
      if (sample.lakesVisible)for (const row of await sample.lakeIndex.queryCooperative(intersect, budget)) {
        if (sampledCamera.view.zoom<row.minZoom)continue;
        const packet = row.mesh.packet;
        const hits = await pickGlobeSlotsCooperative(packet, packet.spatial, ray, undefined, {firstHit:!includeHydro, budget});
        if (hits.length&&!includeHydro) {assertCurrent(); return [];}
        for (const slot of hits)lakeSlots.add(slot);
      }
      let hydroRefs = [];
      if (includeHydro) {
        const slots = new Set(lakeSlots);
        if (sample.riversVisible&&sampledCamera.view.zoom>=sample.physical.spec.riverMinZoom) {
          const predicate = globeStrokePickPredicate(sampledCamera, point, 5);
          for (const row of await sample.riverIndex.queryCooperative(predicate, budget)) {
            if (sampledCamera.view.zoom<row.minZoom)continue;
            for (const slot of await pickGlobeStrokeSlotsCooperative(row.packet, row.index, sampledCamera, point, 5, {predicate, budget}))
              slots.add(slot);
          }
        }
        const candidates = await hydroFeaturesForSlots(slots, waterFeatures, signal);
        assertCurrent();
        const visible = [...new Map(candidates.filter(isHydroFeatureVisible).map(feature => [feature.id, feature])).values()];
        const missing = visible.filter(feature => {
          const existing = hydroFeatureById(feature.id);
          return !existing||existing.__awBounds!==feature.__awBounds;
        });
        if (missing.length)await admitHydroFeatures(missing, {isCurrent});
        assertCurrent();
        hydroRefs = visible.map(feature => normalizeObjectRef({domain:'hydro', type:feature.properties.category, id:feature.id}));
      }
      if (waterFeatures.length||lakeSlots.size)return hydroRefs;
      const hits = [];
      for (const {mesh:{packet}} of await sample.countryIndex.queryCooperative(intersect, budget))
        hits.push(...await pickGlobeSlotsCooperative(packet, packet.spatial, ray, slot => sample.visibleSlots.has(slot), {budget}));
      assertCurrent();
      return [...hydroRefs, ...hits.map(slot => refs[slot])];
    } finally {
      detachAbort();
      finishRequest(requestName, controller);
    }
  }
  return Object.freeze({queryObjectRefs});
}
