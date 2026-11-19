const SVG_NS = 'http://www.w3.org/2000/svg';

/** Viewer semantic icons used by shared controls and map actions. */
const ICON_REGISTRY = Object.freeze({
  territory: 'icon-territory',
  distribution: 'icon-language',
  place: 'icon-place',
  river: 'icon-river',
  lake: 'icon-lake',
  map: 'icon-map',
  focus: 'icon-focus-target',
  chevronDown: 'icon-chevron-down',
  check: 'icon-check',
});

/** Create a sprite-backed icon without duplicating inline SVG markup. */
function createSvgIcon(documentRef, symbolId, className = 'ui-icon') {
  const icon = documentRef.createElementNS(SVG_NS, 'svg');
  icon.setAttribute('class', className);
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const use = documentRef.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${symbolId}`);
  icon.appendChild(use);
  return icon;
}

export function createSemanticIcon(documentRef, semanticName, className = 'ui-icon') {
  const symbolId = ICON_REGISTRY[semanticName];
  if (!symbolId) throw new Error(`Unknown semantic icon: ${semanticName}`);
  return createSvgIcon(documentRef, symbolId, className);
}
