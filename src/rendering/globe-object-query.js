import { normalizeObjectRef } from '../document/object-ref-identity.js';
import {
  globeRayIntersectsBounds, globeStrokePickPredicate, createGlobePickBudget,
  pickGlobeSlotsCooperative, pickGlobeStrokeSlotsCooperative,
} from './globe-picking.js';

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
    const abort = () => controller.abort(consumerSignal?.reason);
    consumerSignal?.addEventListener('abort', abort, {once:true});
    if (consumerSignal?.aborted)abort();
    const {signal} = controller;
    const isCurrent = () => !signal.aborted&&canPickFrame()&&getAcceptedPick()===sample;
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
          if (!includeHydro)return [];
          waterFeatures.push(row.feature);
        }
      }
      if (sample.lakesVisible)for (const row of await sample.lakeIndex.queryCooperative(intersect, budget)) {
        if (sampledCamera.view.zoom<row.minZoom)continue;
        const packet = row.mesh.packet;
        const hits = await pickGlobeSlotsCooperative(packet, packet.spatial, ray, undefined, {firstHit:!includeHydro, budget});
        if (hits.length&&!includeHydro)return [];
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
      for (const {packet} of await sample.countryIndex.queryCooperative(intersect, budget))
        hits.push(...await pickGlobeSlotsCooperative(packet, packet.spatial, ray, slot => sample.visibleSlots.has(slot), {budget}));
      assertCurrent();
      return [...hydroRefs, ...hits.map(slot => refs[slot])];
    } finally {
      consumerSignal?.removeEventListener('abort', abort);
      finishRequest(requestName, controller);
    }
  }
  return Object.freeze({queryObjectRefs});
}
