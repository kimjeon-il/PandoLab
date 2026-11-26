/**
 * Page-scoped first-map reveal gate. The canonical map frame can be accepted
 * without waiting for unrelated post-presentation work. Reveal the
 * approved canonical map as soon as its frame is admitted.
 */
export function createViewerInitialMapSkeleton({
  setLoading, readRenderer,
} = {}) {
 if (typeof setLoading!=='function'||typeof readRenderer!=='function')
  throw new TypeError('Initial map skeleton requires its display and readiness ports.');
 let firstMapPresented = false, revealed = false;
 function reconsider() {
  if (revealed||!firstMapPresented)return false;
  const renderer = readRenderer();
  if (!renderer)return false;
  if (renderer.getStats().mapReadiness?.mapReady!==true)return false;
  revealed = true;
  setLoading(false);
  return true;
 }
 return Object.freeze({
  onFirstMapPresented() {firstMapPresented = true; return reconsider();},
  reconsider,
  get revealed() {return revealed;},
 });
}
