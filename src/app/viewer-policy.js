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

export const viewerPolicy = Object.freeze({
    projection:'globe',
    readOnly:true,
    assertProjection(requested) {
      if (requested !== undefined && requested !== 'globe')
        throw Object.assign(new Error('The viewer supports only the globe projection.'), { code: 'PL-PRODUCT-PROJECTION', projection: requested });
    },
    assertOperation(operation) {
      if (!viewerOperations.has(operation))
        throw Object.assign(new Error('This operation is unavailable in the read-only viewer.'),
          { code: 'PL-PRODUCT-READONLY', operation });
    },
  });
