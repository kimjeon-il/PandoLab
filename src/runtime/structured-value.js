// Exact comparison of JSON-like DTOs. Callers choose primitive semantics:
// rendering historically uses ===, while document admission uses Object.is.
const strictEqual = (left, right) => left === right;

export function sameStructuredValue(left, right, equal = strictEqual) {
  if (equal(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftArray = Array.isArray(left);
  if (leftArray !== Array.isArray(right)) return false;
  if (leftArray) {
    return left.length === right.length
      && left.every((value, index) => sameStructuredValue(value, right[index], equal));
  }
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && sameStructuredValue(left[key], right[key], equal));
}
