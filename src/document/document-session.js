import { createProductModePolicy } from '../app/product-mode-policy.js';
import { createCoreDocumentClient } from './core-document-client.js';
import { createCoreDocumentReadModel } from './core-document-read-model.js';

/** One C++ owner and its accepted immutable projection for the read-only Viewer. */
export function createDocumentSession({ productMode = 'viewer', readOnly = true, initialProject, onTransition = () => {}, createWorker } = {}) {
  createProductModePolicy(productMode, {readOnly});
  const documentModel = createCoreDocumentReadModel(initialProject);
  const commandOwner = createCoreDocumentClient({ ...(createWorker ? { createWorker } : {}),
    onTransition(result, operation, payload, verifiedResources) {
      documentModel.acceptTransition(result, operation, verifiedResources);
      onTransition(result, operation, payload);
    } });
  return Object.freeze({ productMode, readOnly, documentModel, commandOwner });
}
