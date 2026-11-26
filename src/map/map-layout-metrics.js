const DEFAULT_SAFE_INSETS = Object.freeze({ left: 0, right: 0, top: 0, bottom: 26 });

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizedInsets(value = DEFAULT_SAFE_INSETS, minimumBottom = 0) {
  return Object.freeze({
    left: Math.max(0, finiteNumber(value.left)),
    right: Math.max(0, finiteNumber(value.right)),
    top: Math.max(0, finiteNumber(value.top)),
    bottom: Math.max(minimumBottom, finiteNumber(value.bottom)),
  });
}

export function createMapLayoutMetricsSnapshot({
  width = 900,
  height = 650,
  dpr = 1,
  safeInsets = DEFAULT_SAFE_INSETS,
  fitInsets = safeInsets,
  mobile = false,
  revision = 0,
  reason = 'initial',
  projectBounds = null,
} = {}) {
  const resolvedWidth = Math.max(1, finiteNumber(width, 900));
  const resolvedHeight = Math.max(1, finiteNumber(height, 650));
  const safe = normalizedInsets(safeInsets, 26);
  const fit = normalizedInsets(fitInsets, safe.bottom);
  const contentWidth = Math.max(1, resolvedWidth - safe.left - safe.right);
  const contentHeight = Math.max(1, resolvedHeight - safe.top - safe.bottom);
  const scaleContentHeight = mobile
    ? Math.max(1, resolvedHeight - safe.top - 96)
    : contentHeight;
  const projectionSignature = [
    resolvedWidth.toFixed(3),
    resolvedHeight.toFixed(3),
    Math.max(0.25, finiteNumber(dpr, 1)).toFixed(3),
    safe.left,
    safe.right,
    safe.top,
    safe.bottom,
    mobile ? 1 : 0,
  ].join(':');

  let globeBaseScale = Math.max(60, Math.min(contentWidth, scaleContentHeight) * 0.455);
  if (projectBounds) {
    const {west, east, south, north} = projectBounds;
    if (![west, east, south, north].every(Number.isFinite) || south >= north || west === east)
      throw new TypeError('Project reference bounds must be finite and nonempty.');
    const radians = Math.PI / 180, span = (east - west + 360) % 360 || 360;
    if (span < 180) {
      const mid = (south+north)*radians/2, half = span*radians/2;
      const cosine = Math.min(...[south, north].map(lat => Math.sin(mid)*Math.sin(lat*radians)
        + Math.cos(mid)*Math.cos(lat*radians)*Math.cos(half)));
      const angle = Math.acos(Math.max(-1, Math.min(1, cosine)));
      if (angle < Math.PI/2) globeBaseScale = Math.min(contentWidth,contentHeight)*.88
        /(2*Math.max(1e-8,Math.sin(angle)));
    }
  }

  return Object.freeze({
    revision: Math.max(0, Math.trunc(finiteNumber(revision))),
    reason: String(reason || 'layout'),
    width: resolvedWidth,
    height: resolvedHeight,
    dpr: Math.max(0.25, finiteNumber(dpr, 1)),
    mobile: mobile === true,
    safe,
    fitInsets: fit,
    contentWidth,
    contentHeight,
    centerX: safe.left + contentWidth / 2,
    centerY: safe.top + contentHeight / 2,
    globeBaseScale,
    projectBoundsKey: JSON.stringify(projectBounds),
    projectionSignature: `${projectionSignature}:${globeBaseScale}`,
    fitSignature: [fit.left, fit.right, fit.top, fit.bottom].join(':'),
  });
}

export { DEFAULT_SAFE_INSETS };
