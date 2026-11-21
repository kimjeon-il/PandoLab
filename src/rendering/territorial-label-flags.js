export function territorialLabelFlag(feature, { zoom, enabled, flagUrl, isVisible }) {
  if (!enabled || zoom < 1.8 || !isVisible(feature)) return null;
  const url = flagUrl(feature);
  return url ? { url } : null;
}
