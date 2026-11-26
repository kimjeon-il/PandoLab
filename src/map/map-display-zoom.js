// Display thresholds use the Viewer camera zoom. Source stages still own the
// tile layout and transport, independently of the display thresholds.
const hydroStageZooms = new Map([[6, 2], [6.7, 3], [7, 4], [7.5, 5]]);
export const HYDRO_DISPLAY_ZOOMS = Object.freeze([...hydroStageZooms.values()]);
export const PLACE_DISPLAY_ZOOM_FLOOR = 3.5;
const referenceWorldPixels = zoom => 512 * 2 ** zoom;
export const referenceZoomPixelsPerDegree = zoom => referenceWorldPixels(zoom) / 360;
const lakeAreaImportanceKm2 = [10000, 1000, 100, 0];
const lakeMinimumAreaPx2 = 16;
const lakeMinimumWidthPx = 1.25;

export function hydroDisplayStages(stages) {
  return stages.map(stage => {
    const minZoom = hydroStageZooms.get(stage.minZoom);
    if (minZoom === undefined) throw new RangeError('Unsupported hydro source stage ' + stage.minZoom);
    return {...stage, minZoom};
  });
}

export function placeDisplayMinZoom(minZoom) {
  return Math.max(PLACE_DISPLAY_ZOOM_FLOOR, minZoom);
}

export function hydroLakeDisplayMinZoom(areaKm2, widthKm) {
  if (!Number.isFinite(areaKm2) || !Number.isFinite(widthKm) || areaKm2 < 0 || widthKm < 0)
    throw new RangeError('Invalid lake display dimensions');
  const importanceZoom = HYDRO_DISPLAY_ZOOMS[lakeAreaImportanceKm2.findIndex(minimum => areaKm2 >= minimum)];
  const finestZoom = HYDRO_DISPLAY_ZOOMS.at(-1);
  // Reference screen size near the globe center. Keep a finest-stage display
  // for lakes that still measure below the readability target at that stage.
  const readableZoom = HYDRO_DISPLAY_ZOOMS.find(zoom => {
    const scale = referenceWorldPixels(zoom) / 40030;
    return areaKm2 * scale ** 2 >= lakeMinimumAreaPx2 && widthKm * scale >= lakeMinimumWidthPx;
  }) ?? finestZoom;
  return Math.max(importanceZoom, readableZoom);
}

export function isWithinDisplayZoom(zoom, minZoom, maxZoom = Infinity) {
  return zoom >= minZoom && zoom < maxZoom;
}
