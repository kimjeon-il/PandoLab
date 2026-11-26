// Viewer admission and view-state operations are explicit. New Core operations
// remain unavailable to the viewer until their effects have been reviewed.
const viewerOperations = new Set([
  'core.document-load', 'core.document-initialize',
  'core.document-baseline-coverage', 'core.document-load-baseline',
  'core.storage-baseline-load',
  'core.document-replacement-capture', 'core.document-replacement-rollback', 'core.document-replacement-release',
  'core.document-state', 'core.document-resolve-world', 'core.document-timeline-cursor',
  'core.document-geometry-requirements','core.document-geometry-admit',
  'core.document-selection-catalog', 'core.document-presentation-catalog',
  'core.document-selection-apply', 'core.document-selection-snapshot',
  // Scoped, epoch-checked C++ source/candidate handles; adoption additionally
  // requires the existing Core replacement capsule and stays atomic.
  'core.document-temporal-source-prepare','core.document-temporal-source-stats',
  'core.document-temporal-source-release','core.document-temporal-candidate-prepare',
  'core.document-temporal-candidate-inspect','core.document-temporal-candidate-discard',
  'core.document-temporal-candidate-adopt',
]);

export function createProductModePolicy(productMode, {readOnly = true, projection = 'globe'} = {}) {
  if (productMode !== 'viewer') throw new TypeError('Only viewer product mode is supported.');
  if (readOnly !== true) throw new TypeError('Viewer must remain read-only.');
  if (projection !== 'globe') throw new TypeError('Viewer supports only the globe projection.');
  return Object.freeze({
    productMode,
    readOnly,
    projection,
    assertProjection(requested) {
      if (requested !== undefined && requested !== 'globe')
        throw Object.assign(new Error(`The ${productMode} supports only the ${projection} projection.`), { code: 'PL-PRODUCT-PROJECTION', productMode, projection: requested });
    },
    assertOperation(operation) {
      if (!viewerOperations.has(operation))
        throw Object.assign(new Error('This operation is unavailable in the read-only viewer.'),
          { code: 'PL-PRODUCT-READONLY', productMode, operation });
    },
  });
}
