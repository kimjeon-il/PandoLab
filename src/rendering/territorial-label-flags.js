export function territorialLabelFlag(feature, { zoom, enabled, flagUrl, isVisible }) {
  if (!enabled || zoom < 1.8 || !isVisible(feature)) return null;
  const url = flagUrl(feature);
  return url ? { url, width: 18, height: 12, gap: 5 } : null;
}
