import {hydroLakeDisplayMinZoom,HYDRO_DISPLAY_ZOOMS} from '../../src/map/map-display-zoom.js';
import {geometryAreasKm2,lineDistancesKm} from './geometry-metrics.js';

export function measureHydroLakeDisplayZoom(geometry) {
  const ringsByBody = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const areas = geometryAreasKm2(ringsByBody.map(coordinates => ({type:'Polygon',coordinates})));
  return ringsByBody.reduce((zoom, rings, index) => {
    const area = areas[index];
    const perimeter = lineDistancesKm(rings).reduce((sum,length) => sum + length, 0);
    // Twice area / perimeter approximates the width of a long water body.
    const width = perimeter > 0 ? 2 * area / perimeter : 0;
    return Math.min(zoom, hydroLakeDisplayMinZoom(area, width));
  }, HYDRO_DISPLAY_ZOOMS.at(-1));
}
