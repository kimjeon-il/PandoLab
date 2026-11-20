export const LABEL_PRIORITIES = Object.freeze({ country: 100, capital: 90, majorCity: 70, administrative: 60, place: 40 });

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
