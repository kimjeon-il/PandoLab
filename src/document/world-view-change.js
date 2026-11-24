// A receipt describes a stable-order change between exact accepted arrays.
// Store a token, not the previous array, so receipts cannot retain history.
const viewTokens = new WeakMap();
const changeReceipts = new WeakMap();

function tokenFor(rows) {
  let token = viewTokens.get(rows);
  if (!token) {
    token = {};
    viewTokens.set(rows, token);
  }
  return token;
}

export function rememberWorldViewChange(previous, next, indices) {
  if (previous === next) return;
  changeReceipts.set(next, {
    base: tokenFor(previous),
    indices: Object.freeze([...indices]),
  });
}

// [] certifies an unchanged array. null means the caller must compare fully.
export function worldViewChange(previous, next) {
  if (previous === next) return [];
  const receipt = changeReceipts.get(next);
  return receipt && receipt.base === viewTokens.get(previous) ? receipt.indices : null;
}
