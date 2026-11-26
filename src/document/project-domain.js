import { requireProjectMonth } from './project-setup.js';
import { createProjectAdmission } from './project-admission.js';
import { createProjectReplacement } from './project-replacement.js';

const cloneValue = value => {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch (_) { /* fall through */ }
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]));
};

/**
 * Owns the canonical project boundary without exposing the mutable object
 * returned by the host application.
 */
export function createProjectDomain({
  replaceSnapshot = () => false,
  admitImportedProject = project => project,
  restoreReplacement = null,
  invalidateProject = () => {},
  reportDiagnostic = () => {},
  onProjectChanged = () => {},
  onProjectReset = () => {},
  onReplacementState = () => {},
  onReplacementCommitted = () => {},
  onReplacementError = () => {},
  commandOwner = null,
  documentModel = null,
  publishCommand = null,
  readBuiltinSelectionCatalogs,
  readPresentationCatalog = null,
} = {}) {
  let generation = 0, disposed = false;
  let commandQueue = Promise.resolve();
  const readGeneration = () => generation;
  const isDisposed = () => disposed;
  const enqueueCommand = run => {
    const operation = commandQueue.then(run);
    commandQueue = operation.catch(() => {});
    return operation;
  };
  const timelineNavigation = () => Object.freeze({
    ...replacement.activeProject(),
    month:commandOwner?.state?.()?.timelineCursor||null,
    range:snapshot().projectSetup?.timelineRange||null,
    scope:replacement.activeProjectScope(),
  });
  function currentProject(project) {
    if (project && Object.hasOwn(project,'packageAssets')) throw Object.assign(new TypeError('Unsupported retired project attachments.'), {code:'PL-PROJECT-RETIRED-ASSETS'});
    return admitImportedProject(project);
  }

  const snapshot = () => {
    if (typeof documentModel?.snapshot!=='function') throw new TypeError('The accepted C++ document read model is required.');
    return documentModel.snapshot();
  };
  const emitChanged = (reason, detail = null) => {
    const event = Object.freeze({ generation, reason: String(reason || 'project-changed'), detail: cloneValue(detail) });
    onProjectChanged(event);
    return event;
  };
  const bumpGeneration = async (reason, detail = null) => {
    generation += 1;
    admission.clearSelectionCatalogs();
    const event = { generation, reason: String(reason || 'project-reset') };
    if (detail && typeof detail === 'object') Object.assign(event, detail);
    await onProjectReset(Object.freeze(event));
    return generation;
  };
  const assertActive = () => {
    if (disposed) throw Object.assign(new Error('Project domain is disposed.'),
      { code: 'PL-CORE-CANCELLED', name: 'AbortError', cancelled: true });
  };

  const notify = (reason, detail, invalidate) => {
    for (const [stage, action] of [
      ['event', () => emitChanged(reason, detail)],
      ['render', () => { if (invalidate)invalidate(reason); }],
    ]) {
      try { action(); } catch (error) {
        try { reportDiagnostic({ stage, reason, error }); } catch (_) { /* A diagnostic cannot undo a commit. */ }
      }
    }
  };
  const admission = createProjectAdmission({
    commandOwner, documentModel, publishCommand, readBuiltinSelectionCatalogs,
    readGeneration, isReplacing:() => replacement.isReplacing(), isDisposed, assertActive,
    currentProject, enqueueCommand, reportDiagnostic,
  });
  const replacement = createProjectReplacement({
    commandOwner, documentModel, currentProject, enqueueCommand, assertActive, isDisposed, readGeneration,
    bumpGeneration, readmitBuiltinSelectionCatalogs:admission.readmitBuiltinSelectionCatalogs,
    discardTemporalBuiltin:admission.discardTemporalBuiltin, readPresentationCatalog,
    publishCommand, replaceSnapshot, restoreReplacement, notify, invalidateProject,
    onReplacementState, onReplacementCommitted, onReplacementError,
  });
  const resetRenderGeneration = reason => bumpGeneration(reason || 'render-reset');
  const dispose = () => {
    if (disposed)return;
    disposed = true; replacement.invalidateOpenRequests();
  };

  const resolveWorld = async (month, options) => {
    assertActive();
    if (typeof commandOwner?.resolveWorld!=='function' || typeof documentModel?.projectWorld!=='function')
      throw new TypeError('Project timeline requires the same C++ document query and accepted read model.');
    const result = await commandOwner.resolveWorld(month, options);
    return documentModel.projectWorld(result, commandOwner.state().epoch);
  };

  return Object.freeze({
    snapshot,
    state: () => commandOwner.state(),
    activeProject:replacement.activeProject,
    activeProjectScope:replacement.activeProjectScope,
    timelineNavigation,
    requireTimelineMonth:month => requireProjectMonth(snapshot().projectSetup, month),
    resolveWorld,
    getGeneration: () => generation,
    isReplacing:replacement.isReplacing,
    admit:admission.admit,
    admitPresentationCatalog:admission.admitPresentationCatalog,
    admitSelectionCatalog:admission.admitSelectionCatalog,
    admitStorageBaseline:admission.admitStorageBaseline,
    prepareTemporalBuiltin:admission.prepareTemporalBuiltin,
    discardTemporalBuiltin:admission.discardTemporalBuiltin,
    open:replacement.open,
    getOpenRevision:replacement.getOpenRevision,
    isOpening:replacement.isOpening,
    baselineCoverage:(baselineId, month) => commandOwner.baselineCoverage(baselineId, month),
    resetRenderGeneration,
    dispose,
  });
}
