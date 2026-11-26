import { resourceKey } from '../runtime/resource-dependency-policy.js';

/** Admission receipts and detached temporal resources share the domain command queue. */
export function createProjectAdmission({
  commandOwner, documentModel, publishCommand, readBuiltinSelectionCatalogs,
  readGeneration, isReplacing, isDisposed, assertActive, currentProject, enqueueCommand, reportDiagnostic,
}) {
  const admittedSelectionCatalogs = new Map();
  const selectionCatalogKey = refs => JSON.stringify(refs.map(resourceKey).sort());

  const readmitBuiltinSelectionCatalogs = async ({replacingProject = false} = {}) => {
    if (typeof readBuiltinSelectionCatalogs!=='function')throw new TypeError('The immutable platform builtin identity catalogs are required for document admission.');
    const catalogs = readBuiltinSelectionCatalogs();
    if (!Array.isArray(catalogs))throw new TypeError('Builtin selection catalogs must be explicit domain/ref records.');
    // A replacement may not inherit the previous project's transient water
    // and place references. Its own providers re-admit them after acceptance.
    admittedSelectionCatalogs.clear();
    for (const {domain, refs} of catalogs) {
      const current = replacingProject?[]:refs;
      await commandOwner.selectionCatalogLoad(domain, current);
      admittedSelectionCatalogs.set(domain, selectionCatalogKey(current));
    }
  };

  // Startup promotion replaces data inside the current render generation. It
  // shares the application dispatch queue with commands and whole history;
  // only C++ admits the complete document or allocates a static feature source.
  const admit = (project, { features, territorialSource, baselineId, preserveCursor = false, reason = 'project-admission', expectedGeneration = readGeneration() } = {}) => {
    return enqueueCommand(async () => {
      assertActive();
      if (readGeneration()!==expectedGeneration || isReplacing())
        throw Object.assign(new Error('Document admission belongs to another project generation.'), { code: 'PL-CORE-STALE' });
      if (typeof commandOwner?.load!=='function' || typeof commandOwner.initialize!=='function'
        || typeof documentModel?.snapshot!=='function' || typeof publishCommand!=='function')
        throw new TypeError('Document admission requires the canonical C++ owner and accepted read-model publisher.');
      const core = currentProject(project);
      const outcome = features===undefined && territorialSource===undefined && baselineId===undefined && !preserveCursor
        ? await commandOwner.load(JSON.stringify(core))
        : await commandOwner.initialize({ project: core, preserveCursor, ...(features===undefined ? {} : { features }),
          ...(territorialSource===undefined ? {} : { territorialSource }), ...(baselineId===undefined ? {} : { baselineId }) });
      await readmitBuiltinSelectionCatalogs();
      if (readGeneration()!==expectedGeneration || isReplacing())
        throw Object.assign(new Error('Document admission completed after project replacement.'), { code: 'PL-CORE-STALE' });
      await publishCommand(outcome, { expectedGeneration, reason });
      return documentModel.snapshot();
    });
  };

  const admitStorageBaseline = (baseline, { expectedGeneration = readGeneration() } = {}) => {
    return enqueueCommand(async () => {
      assertActive();
      if (readGeneration()!==expectedGeneration)
        throw Object.assign(new Error('Storage baseline admission crossed a project replacement.'), { code: 'PL-CORE-STALE' });
      if (typeof commandOwner?.storageBaselineLoad!=='function' || typeof publishCommand!=='function')
        throw new TypeError('The canonical C++ storage baseline admission is required.');
      const result = await commandOwner.storageBaselineLoad(baseline);
      admittedSelectionCatalogs.clear();
      if (readGeneration()!==expectedGeneration)
        throw Object.assign(new Error('Storage baseline admission completed after project replacement.'), { code: 'PL-CORE-STALE' });
      await publishCommand(result, { expectedGeneration, reason: 'storage-baseline' });
      return result.state;
    });
  };
  // Detached native source and candidate creation share the Core
  // command queue but do not mutate the active document or generation.
  // No baseline admission occurs until the existing replacement transaction
  // has captured a reversible Core capsule.
  const prepareTemporalBuiltin = (facts, setup, {dataRevision, manifestSha256, transferSource = false,
    expectedGeneration = readGeneration(), isCurrent = () => true} = {}) => {
    return enqueueCommand(async() => {
      assertActive();
      const current = () => !isDisposed()&&!isReplacing()&&readGeneration()===expectedGeneration&&isCurrent();
      const stale = () => Object.assign(new Error('Temporal candidate belongs to an older project request.'),
        {code:'PL-CORE-STALE', name:'AbortError', cancelled:true});
      if (!current())throw stale();
      if (typeof commandOwner?.temporalSourcePrepare!=='function'
        ||typeof commandOwner?.temporalCandidatePrepare!=='function')
        throw new TypeError('Core temporal source/candidate owner is required.');
      let source;
      const sourceEpoch = commandOwner.state()?.epoch;
      try {
        source = await commandOwner.temporalSourcePrepare(facts, {dataRevision, manifestSha256, isCurrent:current, transferSource});
        if (!current())throw stale();
        // Only independent-document opening allocates another document identity.
        // Existing projects navigate dates by commandOwner.setTimelineCursor.
        const documentId = globalThis.crypto.randomUUID();
        const candidate = await commandOwner.temporalCandidatePrepare({
          sourceId:source.sourceId, targetMonth:facts.sourceMonth,
          sourceFingerprint:source.fingerprint, setup, documentId,
        }, {isCurrent:current});
        if (!current())throw stale();
        if (candidate?.sourceId!==source.sourceId||candidate?.targetMonth!==facts.sourceMonth
          ||candidate?.sourceFingerprint!==facts.fingerprint
          ||!Number.isSafeInteger(candidate?.candidateId)||candidate.candidateId<1
          ||candidate.expectedEpoch!==commandOwner.state()?.epoch)
          throw Object.assign(new Error('Core temporal candidate receipt is not current.'),
            {code:'PL-CORE-RESPONSE'});
        return Object.freeze({kind:'temporal-candidate', setup,
          expectedGeneration, expectedEpoch:candidate.expectedEpoch,
          sourceId:source.sourceId, candidateId:candidate.candidateId,
          targetMonth:candidate.targetMonth, sourceFingerprint:candidate.sourceFingerprint,
          worldSha256:candidate.worldSha256});
      } catch (error) {
        if (source&&commandOwner.state()?.epoch===sourceEpoch)
          try {await commandOwner.temporalSourceRelease(source.sourceId);}
          catch (releaseError) {try {reportDiagnostic({stage:'temporal-source-release', error:releaseError});}catch (_) {}}
        throw error;
      }
    });
  };
  const discardTemporalBuiltin = async prepared => {
    if (prepared?.kind!=='temporal-candidate'||isDisposed()
      ||commandOwner?.state?.()?.epoch!==prepared.expectedEpoch)return false;
    try {await commandOwner.temporalCandidateDiscard(prepared.candidateId);}
    catch (error) {try {reportDiagnostic({stage:'temporal-candidate-discard', error});}catch (_) {}}
    try {await commandOwner.temporalSourceRelease(prepared.sourceId);}
    catch (error) {try {reportDiagnostic({stage:'temporal-source-release', error});}catch (_) {}}
    return true;
  };
  const admitPresentationCatalog = catalog => {
    const expectedGeneration = readGeneration();
    return enqueueCommand(async () => {
      assertActive();
      if (readGeneration()!==expectedGeneration) throw Object.assign(new Error('Presentation admission crossed a project replacement.'), { code: 'PL-CORE-STALE' });
      if (typeof commandOwner?.presentationCatalogLoad!=='function' || typeof publishCommand!=='function')
        throw new TypeError('Canonical C++ presentation catalog admission is required.');
      const outcome = await commandOwner.presentationCatalogLoad(catalog);
      await publishCommand(outcome, { expectedGeneration, reason: 'presentation-catalog' });
      return outcome;
    });
  };
  const admitSelectionCatalog = (domain, refsProducerOrArray, { expectedEpoch, expectedGeneration = readGeneration() } = {}) => {
    return enqueueCommand(async () => {
      assertActive();
      if (readGeneration()!==expectedGeneration)throw Object.assign(new Error('Builtin selection admission crossed a project replacement.'), { code: 'PL-CORE-STALE' });
      if (typeof commandOwner?.selectionCatalogLoad!=='function' || typeof publishCommand!=='function')
        throw new TypeError('Canonical C++ builtin identity admission is required.');
      const refs = typeof refsProducerOrArray==='function' ? refsProducerOrArray():refsProducerOrArray;
      const key = selectionCatalogKey(refs);
      if (expectedEpoch===undefined&&admittedSelectionCatalogs.get(domain)===key)return false;
      const result = await commandOwner.selectionCatalogLoad(domain, refs, expectedEpoch);
      await publishCommand(result, { expectedGeneration, reason: 'selection-catalog' });
      if (readGeneration()===expectedGeneration)admittedSelectionCatalogs.set(domain, key);
      return result;
    });
  };
  return Object.freeze({admit, admitStorageBaseline, prepareTemporalBuiltin, discardTemporalBuiltin,
    admitPresentationCatalog, admitSelectionCatalog, readmitBuiltinSelectionCatalogs,
    clearSelectionCatalogs:() => admittedSelectionCatalogs.clear()});
}
