const DEFAULT_VIEWPORT_BUCKET = 256;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeLongitude(value) {
  const normalized = ((finiteNumber(value) + 180) % 360 + 360) % 360 - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
}

export function hydroViewportSizeClass(width, height, bucketSize = DEFAULT_VIEWPORT_BUCKET) {
  const bucket = Math.max(1, Math.floor(finiteNumber(bucketSize, DEFAULT_VIEWPORT_BUCKET)));
  const widthClass = Math.max(1, Math.ceil(Math.max(1, finiteNumber(width, 1)) / bucket));
  const heightClass = Math.max(1, Math.ceil(Math.max(1, finiteNumber(height, 1)) / bucket));
  return `${widthClass}x${heightClass}`;
}

function activeHydroStages(manifest, threshold) {
  const limit = finiteNumber(threshold);
  return (manifest?.stages || [])
    .filter(stage => finiteNumber(stage?.minZoom, Infinity) <= limit + 1e-9)
    .map(stage => ({
      id: finiteNumber(stage.id),
      minZoom: finiteNumber(stage.minZoom),
      columns: Math.max(1, Math.floor(finiteNumber(stage.columns, 1))),
      rows: Math.max(1, Math.floor(finiteNumber(stage.rows, 1))),
    }));
}

// Enumerate only longitude cells that could overlap the requested window.
// Guard candidates by one cell for floating-point boundary parity, then apply
// the original wrapped-distance predicate in ascending source-column order.
function longitudeIndices(columns, centerLongitude, halfLongitude) {
  if (halfLongitude >= 180 - 1e-9) return Array.from({ length: columns }, (_, index) => index);
  const tileLongitude = 360 / columns;
  const center = normalizeLongitude(centerLongitude);
  const limit = halfLongitude + tileLongitude / 2 + 1e-9;
  if (limit >= 180) return Array.from({ length: columns }, (_, index) => index);
  const indices = [];
  let previous = -1;
  for (let wrap = -1; wrap <= 1; wrap += 1) {
    const shifted = center + wrap * 360;
    const start = Math.max(0, Math.ceil((shifted - limit + 180) / tileLongitude - 0.5) - 1);
    const end = Math.min(columns - 1, Math.floor((shifted + limit + 180) / tileLongitude - 0.5) + 1);
    for (let x = start; x <= end; x += 1) {
      if (x <= previous) continue;
      previous = x;
      const tileCenter = -180 + (x + 0.5) * tileLongitude;
      if (Math.abs(normalizeLongitude(tileCenter - center)) <= limit) indices.push(x);
    }
  }
  return indices;
}

// As with longitude, preserve the original inclusion test but avoid scanning
// rows that cannot intersect the latitude window.
function latitudeRange(rows, centerLatitude, halfLatitude) {
  const tileLatitude = 180 / rows;
  const center = Math.max(-90, Math.min(90, centerLatitude));
  const limit = halfLatitude + tileLatitude / 2 + 1e-9;
  const candidateStart = Math.max(0, Math.ceil((90 - center - limit) / tileLatitude - 0.5) - 1);
  const candidateEnd = Math.min(rows - 1, Math.floor((90 - center + limit) / tileLatitude - 0.5) + 1);
  let start = rows;
  let end = -1;
  for (let y = candidateStart; y <= candidateEnd; y += 1) {
    const tileCenter = 90 - (y + 0.5) * tileLatitude;
    if (Math.abs(tileCenter - center) <= limit) {
      start = Math.min(start, y);
      end = Math.max(end, y);
    }
  }
  return end >= start ? [start, end] : [0, -1];
}

function stageWindow(stage, bounds) {
  const [west, south, east, north] = bounds;
  const span = east-west>=360?360:((east-west)%360+360)%360||360;
  const centerLongitude = normalizeLongitude(west+span/2);
  const centerLatitude = (south+north)/2;
  const halfLongitude = span/2;
  const halfLatitude = (north-south)/2;
  const xIndices = longitudeIndices(stage.columns, centerLongitude, halfLongitude);
  const [yStart, yEnd] = latitudeRange(stage.rows, centerLatitude, halfLatitude);
  return Object.freeze({
    stage: stage.id,
    columns: stage.columns,
    rows: stage.rows,
    xIndices: Object.freeze(xIndices),
    yStart,
    yEnd,
  });
}

export function createHydroTileWindow({
  manifest,
  projection = 'globe',
  threshold = 0,
  width = 1,
  height = 1,
  bounds,
  viewportBucketSize = DEFAULT_VIEWPORT_BUCKET,
} = {}) {
  if (projection!=='globe')throw new TypeError('Hydro tile selection requires a globe projection.');
  if (!Array.isArray(bounds)||bounds.length!==4||!bounds.every(Number.isFinite)||bounds[1]>bounds[3])throw new TypeError('Viewport geographic bounds must be finite and ordered');
  const normalizedWidth = Math.max(1, finiteNumber(width, 1));
  const normalizedHeight = Math.max(1, finiteNumber(height, 1));
  const stages = activeHydroStages(manifest, threshold);
  const windows = stages.map(stage => stageWindow(stage, bounds));
  const viewportSizeClass = hydroViewportSizeClass(normalizedWidth, normalizedHeight, viewportBucketSize);
  const thresholdBand = stages.map(stage => `${stage.id}@${stage.minZoom}`).join(',') || 'none';
  const windowKey = windows.map(window => (
    `${window.stage}:${window.columns}x${window.rows}:x${window.xIndices.join(',')}:y${window.yStart}-${window.yEnd}`
  )).join('|');
  return Object.freeze({
    projection: 'globe',
    thresholdBand,
    viewportSizeClass,
    windows: Object.freeze(windows),
    signature: `globe;${thresholdBand};${viewportSizeClass};${windowKey}`,
  });
}

export function hydroTileSpecsForWindow(tileWindow) {
  const specs = [];
  for (const window of tileWindow?.windows || []) {
    if (window.yEnd < window.yStart) continue;
    for (let y = window.yStart; y <= window.yEnd; y += 1) {
      for (const x of window.xIndices) specs.push({ stage: window.stage, x, y });
    }
  }
  return specs;
}
