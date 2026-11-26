import { sharedCalculationCore } from "../document/temporal.js";

// Boundary adapter: no independent JS graph walk. The shared C++ kernel preserves the
// owner's input order, junction stops and dash-chain continuity for Web/WASM.
if (typeof sharedCalculationCore?.boundaryConnectChains !== 'function') {
  throw Object.assign(new Error('Shared C++ boundary-chain calculation is unavailable.'),
    { code: 'PL-CORE-WASM-CAPABILITY' });
}

export function connectBoundarySegments(segments) {
  return sharedCalculationCore.boundaryConnectChains(segments);
}
