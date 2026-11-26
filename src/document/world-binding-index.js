import { compareTemporalKeys, temporalFollowingDay } from './temporal.js';

// Exact Core calendar keys. Inclusive start, exclusive end.
// Overlapping or absent bindings retain the original first-match rule.
export function sourceBindingCertificate(candidates, date, intervalFor) {
  const dateKey = date.endKey;
  let selected = null;
  let start = null;
  let end = null;

  function includeBoundary(boundary) {
    if (!boundary) return;
    if (compareTemporalKeys(boundary, dateKey) <= 0) {
      if (!start || compareTemporalKeys(start, boundary) < 0) start = boundary;
    } else if (!end || compareTemporalKeys(boundary, end) < 0) {
      end = boundary;
    }
  }

  for (const row of candidates) {
    const interval = intervalFor(row);
    const firstDay = interval.start?.startKey ?? null;
    const lastDay = interval.end?.endKey ?? null;
    includeBoundary(firstDay);
    if (lastDay) {
      row.followingEnd ??= temporalFollowingDay(lastDay);
      includeBoundary(row.followingEnd);
    }
    if (!selected) {
      const hasStarted = !firstDay || compareTemporalKeys(firstDay, dateKey) <= 0;
      if (hasStarted && (!lastDay || compareTemporalKeys(dateKey, lastDay) <= 0)) selected = row;
    }
  }
  return {selected, range: {start, end}};
}

function intersectStart(left, right) {
  if (!left) return right;
  if (!right) return left;
  return compareTemporalKeys(left, right) < 0 ? right : left;
}

function intersectEnd(left, right) {
  if (!left) return right;
  if (!right) return left;
  return compareTemporalKeys(left, right) < 0 ? left : right;
}

function containsDate(node, dateKey) {
  return (!node.start || compareTemporalKeys(node.start, dateKey) <= 0)
    && (!node.end || compareTemporalKeys(dateKey, node.end) < 0);
}

const midpoint = (start, end) => start + Math.floor((end - start) / 2);

function combine(left, right) {
  return {start: intersectStart(left.start, right.start),
    end: intersectEnd(left.end, right.end), left, right};
}

function build(ranges, start, end) {
  if (end - start === 1) return ranges[start];
  const middle = midpoint(start, end);
  return combine(build(ranges, start, middle), build(ranges, middle, end));
}

// Immutable balanced tree. Valid subtrees are skipped as a group.
function bindingView(root, size) {
  function changed(date, limit = Infinity) {
    const indices = [];
    const dateKey = date.endKey;
    function visit(node, start, end) {
      if (!node || containsDate(node, dateKey) || indices.length > limit) return;
      if (end - start === 1) {
        indices.push(start);
        return;
      }
      const middle = midpoint(start, end);
      visit(node.left, start, middle);
      visit(node.right, middle, end);
    }
    visit(root, 0, size);
    return indices;
  }

  function fork(updates) {
    if (!updates.size) return bindingView(root, size);
    const sortedUpdates = [...updates].sort(([left], [right]) => left - right);

    function splitUpdates(first, last, middle) {
      while (first < last) {
        const index = midpoint(first, last);
        if (sortedUpdates[index][0] < middle) first = index + 1;
        else last = index;
      }
      return first;
    }

    function patch(node, start, end, first, last) {
      if (first === last) return node;
      if (end - start === 1) return sortedUpdates[first][1];
      const middle = midpoint(start, end);
      const split = splitUpdates(first, last, middle);
      return combine(
        patch(node.left, start, middle, first, split),
        patch(node.right, middle, end, split, last),
      );
    }

    return bindingView(patch(root, 0, size, 0, sortedUpdates.length), size);
  }

  return Object.freeze({
    allows: date => !root || containsDate(root, date.endKey),
    changed,
    fork,
  });
}

export function createWorldBindingIndex(ranges) {
  return bindingView(ranges.length ? build(ranges, 0, ranges.length) : null, ranges.length);
}
