import {referenceZoomPixelsPerDegree} from '../map/map-display-zoom.js';

export const LABEL_PRIORITIES = Object.freeze({ country: 100, capital: 90, majorCity: 70, administrative: 60, place: 40 });

export const MAP_LABEL_SIZE_STOPS = Object.freeze([
  Object.freeze({zoom:4,flag:26,name:28,cityDiameter:5,cityName:12}),
  Object.freeze({zoom:6,flag:34,name:38,cityDiameter:7,cityName:16}),
  Object.freeze({zoom:9,flag:46,name:50,cityDiameter:10,cityName:20}),
]);

export function territorialLabelSize(componentBounds, [longitude, latitude], zoom) {
  let nearest, distance = Infinity, area = 0;
  for (const bounds of componentBounds) {
    const [west, south, east, north] = bounds;
    const midpoint = (west + east) / 2;
    const localLongitude = longitude + 360 * Math.round((midpoint - longitude) / 360);
    const dx = Math.max(west - localLongitude, localLongitude - east, 0);
    const dy = Math.max(south - latitude, latitude - north, 0);
    const nextDistance = Math.hypot(dx, dy);
    const nextArea = (east - west) * (north - south);
    if (nextDistance < distance || (nextDistance === distance && nextArea > area)) {
      nearest = bounds;
      distance = nextDistance;
      area = nextArea;
    }
  }

  let shortSide = 0;
  if (nearest) {
    const [west, south, east, north] = nearest;
    // Use the zoom scale at the label's latitude, independent of pan, clipping
    // and foreshortening. The globe still projects the actual symbol anchor.
    const latitudeScale = Math.cos(Math.min(Math.abs(latitude), 85) * Math.PI / 180);
    const degrees = Math.min(east - west, (north - south) / latitudeScale);
    shortSide = degrees * referenceZoomPixelsPerDegree(zoom);
  }
  const standardFraction = Math.min(1, Math.max(0, (shortSide - 22) / (147 - 22)));
  const largeFraction = Math.min(1, Math.max(0, (shortSide - 147) / (440 - 147)));
  // Subpixel precision avoids replacing tiles for imperceptible zoom changes.
  const standardGrowth = Math.round(60 * standardFraction);
  const upperIndex = zoom <= MAP_LABEL_SIZE_STOPS[1].zoom ? 1 : 2;
  const upper = MAP_LABEL_SIZE_STOPS[upperIndex], lower = MAP_LABEL_SIZE_STOPS[upperIndex - 1];
  const t = Math.min(1, Math.max(0, (zoom - lower.zoom) / (upper.zoom - lower.zoom)));
  const nameCap = lower.name + t * (upper.name - lower.name);
  const flagCap = lower.flag + t * (upper.flag - lower.flag);
  return {
    name: (130 + standardGrowth + Math.round((nameCap - 19) * 10 * largeFraction)) / 10,
    flag: (120 + standardGrowth + Math.round((flagCap - 18) * 10 * largeFraction)) / 10,
  };
}

export function bufferedPlaceBounds(bounds, currentBounds) {
  const [west, south, east, north] = bounds;
  if (currentBounds) {
    const [left, bottom, right, top] = currentBounds;
    const turns = Math.round(((left + right) - (west + east)) / 720);
    if (south >= bottom && north <= top && (right - left >= 360 ||
        (west + turns * 360 >= left && east + turns * 360 <= right))) return currentBounds;
  }
  // Keep a modest margin so a small pan and its return share the same query.
  const longitudeMargin = Math.min(180 - (east - west) / 2, (east - west) * .15);
  const latitudeMargin = (north - south) * .15;
  return [west - longitudeMargin, Math.max(-90, south - latitudeMargin),
    east + longitudeMargin, Math.min(90, north + latitudeMargin)];
}

/** Conservative camera-bound check shared by the place Worker and Viewer.
 * MapLibre owns exact globe occlusion and symbol collision decisions.
 */
export function coordinateInGeographicBounds(coordinate,bounds){
  const lon=Number(coordinate?.[0]),lat=Number(coordinate?.[1]);
  if(!Number.isFinite(lon)||!Number.isFinite(lat)||Math.abs(lat)>90)return false;
  if(!Array.isArray(bounds)||bounds.length!==4||!bounds.every(Number.isFinite))return true;
  const [west,south,east,north]=bounds;
  if(lat<south||lat>north)return false;
  const span=east-west>=360?360:((east-west)%360+360)%360||360;
  return ((lon-west)%360+360)%360<=span;
}

export function selectPlaceLabelCandidates(candidates,limit){
  return [...candidates].sort((a,b)=>Number(!!b.selected)-Number(!!a.selected)||Number(!!b.viewportVisible)-Number(!!a.viewportVisible)||b.priority-a.priority||a.key.localeCompare(b.key)).slice(0,limit);
}

const AUTOMATIC_LABEL_POLICIES = Object.freeze({
  country: Object.freeze({ priority: LABEL_PRIORITIES.country, minZoom: -2, maxZoom: Infinity, collisionGroup: 'country' }),
  capital: Object.freeze({ priority: LABEL_PRIORITIES.capital, minZoom: 0, maxZoom: Infinity, collisionGroup: 'place' }),
  city: Object.freeze({ priority: LABEL_PRIORITIES.majorCity, minZoom: 1.25, maxZoom: Infinity, collisionGroup: 'place' }),
  region: Object.freeze({ priority: LABEL_PRIORITIES.administrative, minZoom: 1, maxZoom: Infinity, collisionGroup: 'place' }),
  town: Object.freeze({ priority: LABEL_PRIORITIES.place, minZoom: 2.5, maxZoom: Infinity, collisionGroup: 'place' }),
  mountain: Object.freeze({ priority: LABEL_PRIORITIES.place, minZoom: 2, maxZoom: Infinity, collisionGroup: 'place' }),
  water: Object.freeze({ priority: LABEL_PRIORITIES.place, minZoom: 1.5, maxZoom: Infinity, collisionGroup: 'place' }),
  custom: Object.freeze({ priority: LABEL_PRIORITIES.place, minZoom: 1.5, maxZoom: Infinity, collisionGroup: 'place' }),
});

export function normalizeLabelSettings(raw = {}) {
  const manualPosition = Array.isArray(raw.manualPosition) && raw.manualPosition.length >= 2
    ? [Number(raw.manualPosition[0]), Number(raw.manualPosition[1])]
    : null;
  return {
    priority: raw.priority != null && raw.priority !== '' && Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : null,
    minZoom: raw.minZoom != null && raw.minZoom !== '' && Number.isFinite(Number(raw.minZoom)) ? Number(raw.minZoom) : 0,
    maxZoom: raw.maxZoom != null && raw.maxZoom !== '' && Number.isFinite(Number(raw.maxZoom)) ? Number(raw.maxZoom) : Infinity,
    manualPosition,
    pinned: raw.pinned === true,
    collisionGroup: String(raw.collisionGroup || 'map'),
  };
}

export function automaticLabelSettings(kind, raw = {}) {
  const normalized = normalizeLabelSettings(raw);
  const policy = AUTOMATIC_LABEL_POLICIES[String(kind || 'custom')] || AUTOMATIC_LABEL_POLICIES.custom;
  return {
    ...normalized,
    priority: policy.priority,
    minZoom: policy.minZoom,
    maxZoom: policy.maxZoom,
    collisionGroup: policy.collisionGroup,
    pinned: normalized.pinned === true || !!normalized.manualPosition,
  };
}

export function labelKey(sourceType, sourceId) {
  return `${String(sourceType)}:${String(sourceId)}`;
}
