export const MAP_HOST_KINDS = Object.freeze({
  PANDO: 'pando',
});

export function normalizeMapProjectionKind(value) {
  if(value!=='globe')throw new TypeError('Viewer supports only the globe projection.');
  return 'globe';
}

export function normalizeMapSurfaceDragDelta(dx, dy) {
  const normalize = value => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  };
  return Object.freeze([normalize(dx), normalize(dy)]);
}
