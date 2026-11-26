// One immutable snapshot of the active globe camera and the displayed document.
const frozenPair = (pair, fallback) => Object.freeze(
  (Array.isArray(pair) ? pair : fallback).map(value => Number(value)),
);

export function createMapVisualFrame({
  frameId=0, viewRevision=0, projectGeneration=0, projectionRevision=0,
  viewState, layoutSnapshot=null, projectCoordinate, projectVisibleCoordinate,
}={}) {
  if (!viewState || viewState.projection !== 'globe')
    throw new TypeError('MapVisualFrame requires the globe projection.');
  if (typeof projectCoordinate !== 'function' || typeof projectVisibleCoordinate !== 'function')
    throw new TypeError('MapVisualFrame requires the current renderer projection.');

  const width=Math.max(1,Number(viewState.size?.width ?? layoutSnapshot?.width ?? 1));
  const height=Math.max(1,Number(viewState.size?.height ?? layoutSnapshot?.height ?? 1));
  const dpr=Math.max(.25,Number(viewState.dpr ?? layoutSnapshot?.dpr ?? 1));
  const size=Object.freeze({width,height});
  const cssTranslate=frozenPair(viewState.translate,[width/2,height/2]);
  const insets=viewState.safeInset || layoutSnapshot?.safe || {};
  const safeInset=Object.freeze(Object.fromEntries(
    ['top','right','bottom','left'].map(key=>[key,Number(insets[key] || 0)]),
  ));
  const rotation=frozenPair(
    viewState.rotation || viewState.globeRotation || [0,0,0],
    [0,0,0],
  );
  const resolvedFrameId=Math.max(0,Number(frameId) || 0);
  const revision=Math.max(0,Number(viewRevision ?? viewState.revision) || 0);
  const camera=viewState.camera || {};
  const signature=[
    resolvedFrameId,revision,projectGeneration,projectionRevision,
    width,height,dpr,...cssTranslate,
    viewState.zoom,...rotation,
    camera.bearing,camera.pitch,camera.roll,
    ...Object.values(safeInset),
  ].join(':');
  const snapshot=Object.freeze({
    ...viewState,size,safeInset,translate:cssTranslate,
    rotation,globeRotation:rotation,
  });
  return Object.freeze({
    __mapVisualFrame:true,frameId:resolvedFrameId,viewRevision:revision,
    revision,projectGeneration:Number(projectGeneration) || 0,
    projectionRevision:Number(projectionRevision) || 0,
    projection:'globe',projectionKind:'globe',signature,
    size,safeInset,dpr,cssTranslate,
    projectCoordinate,projectVisibleCoordinate,viewState:snapshot,
  });
}

export function isMapVisualFrame(value) {
  return value?.__mapVisualFrame === true
    && Number.isFinite(value.frameId)
    && typeof value.signature === 'string';
}
