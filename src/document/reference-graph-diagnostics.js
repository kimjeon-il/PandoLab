import {sharedCalculationCore} from './temporal.js';

const text=value=>String(value??'').trim();

/** The compiled Core owns chain traversal and ID diagnostics. */
export function graphDiagnostics(rows, idOf, parentOf = () => '') {
  if (typeof sharedCalculationCore.referenceGraphDiagnostics !== 'function') {
    throw Object.assign(new Error('Canonical C++ reference graph validator is unavailable.'), { code: 'PL-CORE-WASM-CAPABILITY' });
  }
  const items = rows || [];
  return sharedCalculationCore.referenceGraphDiagnostics(items.map(row => text(idOf(row))), items.map(row => text(parentOf(row))));
}
