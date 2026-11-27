import { normalizeTemporalInterval } from './temporal.js';
import { graphDiagnostics } from './reference-graph-diagnostics.js';

const DISTRIBUTION_SCHEMA_VERSION = 3;

export const DISTRIBUTION_MODES = Object.freeze({
  TERRITORIAL: 'territorial',
  GEOMETRY: 'geometry',
});

export const DISTRIBUTION_RENDER_MODES = Object.freeze({
  OVERLAP: 'overlap',
  SINGLE: 'single',
});

const LAYER_KEYS = new Set(['id', 'schemaVersion', 'name', 'unit', 'valueScale', 'color', 'locked', 'parentId', 'groups', 'validFrom', 'validTo', 'metadata']);
const text = value => String(value ?? '').trim();
const clone = value => structuredClone(value);
function assertAllowedKeys(value, allowed, label) {
  const unsupported = Object.keys(value || {}).find(key => !allowed.has(key));
  if (unsupported) throw new Error(`${label}에 지원하지 않는 필드 ${unsupported}가 있습니다.`);
}
function numericValue(value) {
  const input = typeof value === 'string' ? value.trim() : value;
  if ((typeof input !== 'string' && typeof input !== 'number') || input === ''
    || !Number.isFinite(Number(input))) {
    throw new Error('분포 값은 유한한 숫자여야 합니다.');
  }
  return Number(input);
}

function valueScale(raw) {
  if (raw == null || raw.mode === 'auto') return { mode: 'auto' };
  if (raw.mode !== 'manual') throw new Error('분포 색 농도 범위가 올바르지 않습니다.');
  const min = numericValue(raw.min), max = numericValue(raw.max);
  if (min >= max) throw new Error('분포 색 농도 범위의 최솟값은 최댓값보다 작아야 합니다.');
  return { mode: 'manual', min, max };
}

function normalizeDistributionLayer(raw) {
  if (Number(raw?.schemaVersion) !== DISTRIBUTION_SCHEMA_VERSION) throw new Error('분포 레이어 schemaVersion이 현재 형식과 일치하지 않습니다.');
  assertAllowedKeys(raw, LAYER_KEYS, '분포 레이어');
  const id = text(raw?.id);
  if (!id) throw new Error('분포 레이어 ID가 비어 있습니다.');
  const interval = normalizeTemporalInterval(raw.validFrom, raw.validTo);
  return {
    id,
    schemaVersion: DISTRIBUTION_SCHEMA_VERSION,
    name: text(raw.name) || id,
    unit: text(raw.unit),
    valueScale: valueScale(raw.valueScale),
    color: text(raw.color) || '#8c68d8',
    locked: raw.locked === true,
    parentId: text(raw.parentId),
    groups: Array.isArray(raw.groups) ? [...new Set(raw.groups.map(text).filter(Boolean))] : [],
    validFrom: interval.validFrom,
    validTo: interval.validTo,
    metadata: raw.metadata && typeof raw.metadata === 'object' ? clone(raw.metadata) : {},
  };
}

export function normalizeDistributionLayers(value) {
  const output = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const layer = normalizeDistributionLayer(raw);
    if (!layer) throw new Error('분포 레이어 형식이 올바르지 않습니다.');
    if (seen.has(layer.id)) throw new Error(`분포 레이어 ID가 중복되었습니다: ${layer.id}`);
    seen.add(layer.id);
    output.push(layer);
  }
  // The C++ reference-graph kernel is shared with document admission.
  // Keep Web input normalization and the existing first-error diagnostics.
  const layerIds = new Set(output.map(layer => layer.id));
  if (!output.some(layer => layer.parentId)) return output;
  const diagnostics = graphDiagnostics(output, layer => layer.id, layer => layer.parentId);
  for (const [index, layer] of output.entries()) {
    if (layer.parentId && (!layerIds.has(layer.parentId) || layer.parentId === layer.id)) {
      throw new Error(`${layer.id}의 상위 분포 레이어가 존재하지 않거나 올바르지 않습니다.`);
    }
    if (diagnostics[index].cycle) {
      throw new Error(`${layer.id}의 상위 분포 레이어 관계가 순환합니다.`);
    }
  }
  return output;
}

export function distributionEntriesForLayer(entries, layerId) {
  const key = text(layerId);
  return (entries || []).filter(entry => text(entry.layerId) === key);
}

export function distributionValueRange(layer, entries) {
  if (layer.valueScale?.mode === 'manual') return { min: layer.valueScale.min, max: layer.valueScale.max };
  let min = Infinity, max = -Infinity;
  for (const entry of entries || []) {
    if (!Number.isFinite(entry.value)) continue;
    min = Math.min(min, entry.value);
    max = Math.max(max, entry.value);
  }
  return min === Infinity ? null : { min, max };
}

