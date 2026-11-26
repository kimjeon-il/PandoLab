import { INTERACTION_ROLE_PRIORITY, SELECTION_PAINT_ORDER } from '../ui/layer-presentation.js';
const THEMES = new Set(['light', 'dark']);
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function color(value, fallback) {
  const normalized = String(value || '').trim();
  return COLOR_PATTERN.test(normalized) ? normalized.toLowerCase() : fallback;
}

function unitInterval(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : fallback;
}

const STROKE_SHAPE = Object.freeze({ cap: 'round', join: 'round', dash: Object.freeze([0, 0]), casing: null,
  blendMode: 'normal', antiAlias: true });
const BASE_STROKES = Object.freeze({
  country: Object.freeze({ width: 0.72, cap: 'butt', coverage: 'union' }),
  'country-internal': Object.freeze({ width: 1.1, cap: 'butt', join: 'miter', dash: Object.freeze([3, 2]) }),
  subunit: Object.freeze({ width: 2 }),
  'subunit-internal': Object.freeze({ width: 1.1, dash: Object.freeze([3, 2]) }),
  region: Object.freeze({ width: 1.5, dash: Object.freeze([7, 3]) }),
  generic: Object.freeze({ width: 1 }),
  distribution: Object.freeze({ width: 1 }),
  river: Object.freeze({ width: 1 }),
  'hydro-boundary': Object.freeze({ width: 1 }),
});

// All widths and dash lengths returned here are CSS pixels. The current layer
// model still fixes its width multiplier to one; this adds no width preference.
export function resolveMapStrokeStyle(style, role = 'candidate') {
  if (Object.hasOwn(BASE_STROKES, role)) {
    const theme = style.theme || {};
    const layer = style.layerStyle || {};
    const country = role === 'country' || role === 'country-internal';
    const lake = role === 'hydro-boundary', river = role === 'river';
    const width = lake ? theme.lakeBoundaryWidth : river ? theme.riverWidth : country ? theme.borderWidth : layer.boundaryWidth;
    const alpha = country ? theme.borderAlpha : 1;
    return Object.freeze({ ...STROKE_SHAPE, ...BASE_STROKES[role], color: style.color || theme.border,
      width: BASE_STROKES[role].width * Math.max(0.5, Number(width) || 1),
      alpha: layer.boundaryVisible === false || (lake && theme.lakeBoundaryVisible === false) ? 0 : Number(alpha ?? 1),
      blendMode: style.blendMode || layer.blendMode || 'normal', antiAlias: style.antiAlias !== false });
  }
  if (!Object.hasOwn(INTERACTION_ROLE_PRIORITY, role)) throw new Error(`Unknown stroke role: ${role}`);
  const priority = INTERACTION_ROLE_PRIORITY[role];
  const selection = style.selection;
  const antiAlias = style.antiAlias !== false;
  if (priority === 1) return Object.freeze({ ...STROKE_SHAPE, color: selection.color, width: 1, alpha: 0.45, fillAlpha: 0, antiAlias });
  if (priority === 2) return Object.freeze({ ...STROKE_SHAPE, ...style.hover, coverage: 'union', antiAlias });
  const source = priority >= 4 ? selection.primary : selection.secondary;
  return Object.freeze({ ...STROKE_SHAPE, color: selection.color,
    width: source.innerWidth,
    alpha: source.innerAlpha,
    fillAlpha: source.fillAlpha,
    coverage: role === 'primary' || role === 'secondary' ? 'union' : 'normal',
    antiAlias });
}

export function resolveMapInteractionStyle({
  theme = 'dark',
  selectionColor = null,
  outlineVisible = true,
  fillStrength = 0.35,
  antiAlias = true,
  tokens = {},
} = {}) {
  const resolvedTheme = THEMES.has(theme) ? theme : 'dark';
  const dark = resolvedTheme === 'dark';
  const resolvedFillStrength = unitInterval(fillStrength, 0.35);
  const resolvedOutlineVisible = outlineVisible !== false;
  const maxFill = dark ? { primary: 0.30, secondary: 0.18 } : { primary: 0.24, secondary: 0.14 };
  const fill = {
    primary: maxFill.primary * resolvedFillStrength,
    secondary: maxFill.secondary * resolvedFillStrength,
  };
  const themeAccentFallback = dark ? '#cda95d' : '#315e9d';
  const resolvedSelectionColor = color(selectionColor, color(tokens.accent, themeAccentFallback));
  const hoverFillAlpha = (dark ? 0.10 : 0.08) * resolvedFillStrength;
  return Object.freeze({
    theme: resolvedTheme,
    antiAlias: antiAlias !== false,
    hover: Object.freeze({ color: resolvedSelectionColor, width: 1.5, alpha: 0.85, fillAlpha: hoverFillAlpha }),
    selection: Object.freeze({
      color: resolvedSelectionColor,
      outlineVisible: resolvedOutlineVisible,
      fillStrength: resolvedFillStrength,
      primary: Object.freeze({
        innerWidth: resolvedOutlineVisible ? 2.5 : 0,
        innerAlpha: resolvedOutlineVisible ? 1 : 0,
        fillAlpha: fill.primary,
      }),
      secondary: Object.freeze({
        innerWidth: resolvedOutlineVisible ? 1.5 : 0,
        innerAlpha: resolvedOutlineVisible ? 0.72 : 0,
        fillAlpha: fill.secondary,
      }),
    }),
    drawOrder: Object.freeze(SELECTION_PAINT_ORDER.map(role => ['primary', 'secondary'].includes(role) ? `${role}-inner` : role)),
  });
}
