// The map's default selection color follows the browser's platform accent.
// Viewer controls use the shared light and dark CSS palette.
const FALLBACK_ACCENTS = Object.freeze({ light: '#316fd3', dark: '#70a6ff' });

export function parseSystemAccentColor(value) {
  const text = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
  const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(text);
  if (!match || (match[4] !== undefined && Number(match[4]) !== 1)) return null;
  const values = match.slice(1, 4).map(Number);
  if (values.some(channel => !Number.isFinite(channel) || channel < 0 || channel > 255)) return null;
  return '#' + values.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('');
}

// AccentColor is a CSS system color, not a privileged API for reading OS preferences.
export function readSystemAccentColor(documentRef) {
  const probe = documentRef.createElement('span');
  probe.style.color = 'AccentColor';
  if (!probe.style.color) return null;
  probe.style.colorScheme = documentRef.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  probe.style.display = 'none';
  try {
    (documentRef.body || documentRef.documentElement).appendChild(probe);
    return parseSystemAccentColor(documentRef.defaultView.getComputedStyle(probe).color);
  } catch (_) {
    return null;
  } finally {
    probe.remove();
  }
}

export function resolveMapAccent(documentRef, theme) {
  return readSystemAccentColor(documentRef) || FALLBACK_ACCENTS[theme === 'dark' ? 'dark' : 'light'];
}
