// JS owns state-field projection only. Native ProjectCodec owns schema and domain admission.
import {PROJECT_SCHEMA_VERSION} from '../runtime/version-contract.js';
export {PROJECT_SCHEMA_VERSION};
const schemaError=message=>Object.assign(new Error(message),{code:'PL-SCHEMA-001'});

export const PROJECT_STATE_FIELDS = Object.freeze([
  Object.freeze({name:'projectSetup',scope:'document',fallback:()=>{throw schemaError('프로젝트 시작 설정이 필요합니다.');}}),
  Object.freeze({ name: 'sourceInfo', scope: 'document', fallback: () => null }),
  Object.freeze({ name: 'labels', scope: 'document', fallback: () => [] }),
  Object.freeze({ name: 'genericFeatures', scope: 'document', fallback: () => [] }),
  Object.freeze({ name: 'hydroEdits', scope: 'document', fallback: () => [] }),
  Object.freeze({ name: 'timelineRecords', scope: 'document', fallback: () => { throw schemaError('timelineRecords가 필요합니다.'); } }),
  Object.freeze({ name: 'geometries', scope: 'document', fallback: () => { throw schemaError('geometries가 필요합니다.'); } }),
  Object.freeze({ name: 'distributionLayers', scope: 'document', fallback: () => [] }),
  Object.freeze({ name: 'distributionEntries', scope: 'document', fallback: () => [] }),
  Object.freeze({ name: 'labelSettings', scope: 'presentation', fallback: () => ({}) }),
  Object.freeze({ name: 'distributionSettings', scope: 'presentation', fallback: current => current || { renderMode: 'overlap', activeLayerId: '', boundaryVisible: true } }),
  Object.freeze({ name: 'layerPresentation', scope: 'presentation', fallback: () => ({}) }),
  Object.freeze({ name: 'physicalSettings', scope: 'session', fallback: current => current || {} }),
  Object.freeze({ name: 'layerVisibility', scope: 'session', fallback: current => current || {} }),
  Object.freeze({ name: 'itemVisibility', scope: 'session', fallback: () => ({}) }),
  Object.freeze({ name: 'projection', scope: 'session', fallback: () => 'globe' }),
  Object.freeze({ name: 'view', scope: 'session', fallback: current => current || {} }),
  Object.freeze({ name: 'timelineCursor', scope: 'session', fallback: current => current || '' }),
]);

const fieldsFor = scope => {
  if (scope === 'project') return PROJECT_STATE_FIELDS.filter(field => ['document', 'presentation'].includes(field.scope));
  if (scope === 'history' || scope === 'document') return PROJECT_STATE_FIELDS.filter(field => field.scope === 'document');
  if (scope === 'presentation') return PROJECT_STATE_FIELDS.filter(field => field.scope === 'presentation');
  if (scope === 'session') return PROJECT_STATE_FIELDS.filter(field => field.scope === 'session');
  throw new Error(`알 수 없는 프로젝트 상태 범위입니다: ${scope}`);
};

export function pickProjectFields(state, { scope = 'project', clone = structuredClone } = {}) {
  return Object.fromEntries(fieldsFor(scope).map(field => [field.name,
    clone(field.name === 'geometries' ? state.geometries.snapshot() : state[field.name])]));
}
