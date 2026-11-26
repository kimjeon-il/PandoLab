// Canonical GIS project template compiler. No autosave or editor mutation owner.
import { TERRITORIAL_ENTITY_KINDS } from "../../src/document/territorial-units.js";
import { PROJECT_SCHEMA_VERSION, SOURCE_PROVENANCE_SCHEMA_VERSION, GENERIC_FEATURE_SCHEMA_VERSION,
  TERRITORIAL_MODEL_SCHEMA_VERSION, DISTRIBUTION_MODEL_SCHEMA_VERSION } from "../../src/runtime/version-contract.js";

function modelContracts({ genericFeatureSchemaVersion, distributionSchemaVersion, distributionModes }) {
  return {
    landObjectModel: { schemaVersion: genericFeatureSchemaVersion, coastlineAuthority: 'territorialEntities',
      purpose: 'lossless-fallback', directCreation: false, sourceProvenanceSchemaVersion: SOURCE_PROVENANCE_SCHEMA_VERSION,
      canonicalProperties: ['name','notes','color','locked','source'] },
    territorialModel: { schemaVersion: TERRITORIAL_MODEL_SCHEMA_VERSION, coastlineAuthority: 'territorialEntities',
      storage: 'territorialEntities', kinds: Object.values(TERRITORIAL_ENTITY_KINDS), coverageModes: ['partition','explicit'] },
    distributionModel: { schemaVersion: distributionSchemaVersion, sourceModes: [...distributionModes], valueKind: 'finite-number' },
  };
}
export function createProjectTemplateCompiler({ schemaVersion = PROJECT_SCHEMA_VERSION, appVersion, baseDataset,
  genericFeatureSchemaVersion = GENERIC_FEATURE_SCHEMA_VERSION, distributionSchemaVersion = DISTRIBUTION_MODEL_SCHEMA_VERSION,
  distributionModes, readSnapshot, now = () => new Date() }) {
  const contracts = { genericFeatureSchemaVersion, distributionSchemaVersion, distributionModes };
  const header = snapshot => ({ schemaVersion,documentId:snapshot.documentId,physicalSourceInfo:structuredClone(snapshot.physicalSourceInfo || {}), version: appVersion, savedAt: now().toISOString(),
    baseDataset: snapshot.fullAutosave ? 'external-territorial-entities' : baseDataset, ...modelContracts(contracts) });
  function content(snapshot, clone) {
    // The native ProjectCodec is the sole schema/domain admission owner.
    // This compiler only assembles the detached wire value.
    return { ...clone(snapshot.projectFields), territorialEntities:clone(snapshot.territorialEntities) };
  }
  function buildProject(snapshot = readSnapshot(), clone = structuredClone) {
    return { format: 'pandolab-project-state', ...header(snapshot), ...content(snapshot, clone) };
  }
  return Object.freeze({buildProject, projectHeader:header, projectContent:content});
}
