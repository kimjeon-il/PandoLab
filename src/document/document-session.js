import { createCoreDocumentClient } from "./core-document-client.js";
import { createCoreDocumentReadModel } from "./core-document-read-model.js";

/** One C++ owner and its accepted immutable projection for the read-only Viewer. */
export function createDocumentSession({ productMode, readOnly = true, initialProject, onTransition = () => {}, createWorker } = {}) {
  const documentModel = createCoreDocumentReadModel(initialProject);
  const commandOwner = createCoreDocumentClient({ productMode, readOnly, ...(createWorker ? { createWorker } : {}),
    onTransition(result, operation, payload, verifiedResources) {
      documentModel.acceptTransition(result, operation, verifiedResources);
      onTransition(result, operation, payload);
    } });
  return Object.freeze({ productMode, readOnly, documentModel, commandOwner });
}
