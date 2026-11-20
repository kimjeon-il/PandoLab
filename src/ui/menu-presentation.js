const TABBABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[contenteditable="true"]',
  '[tabindex]',
].join(',');

export function createMenuPositionScheduler(callback, {
  requestFrame = callbackToRun => requestAnimationFrame(callbackToRun),
  cancelFrame = frame => cancelAnimationFrame(frame),
} = {}) {
  let frame = 0;
  return Object.freeze({
    schedule() {
      if (frame) return;
      frame = requestFrame(() => {
        frame = 0;
        callback();
      });
    },
    cancel() {
      if (!frame) return;
      cancelFrame(frame);
      frame = 0;
    },
  });
}

function isTabbable(element) {
  if (!(element instanceof HTMLElement) || element.tabIndex < 0 || element.hidden || element.closest('[hidden], .hidden, [inert]')) return false;
  if (element.matches(':disabled, [aria-disabled="true"]')) return false;
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

function documentTabOrder(documentRef) {
  return [...documentRef.querySelectorAll(TABBABLE_SELECTOR)]
    .filter(isTabbable)
    .map((element, order) => ({ element, order, tabIndex: element.tabIndex }))
    .sort((left, right) => {
      const leftPositive = left.tabIndex > 0;
      const rightPositive = right.tabIndex > 0;
      if (leftPositive !== rightPositive) return leftPositive ? -1 : 1;
      if (leftPositive && left.tabIndex !== right.tabIndex) return left.tabIndex - right.tabIndex;
      return left.order - right.order;
    })
    .map(entry => entry.element);
}

export function exitMenuOnTab(event, { menus, trigger, close }) {
  if (event.key !== 'Tab') return false;
  const menuList = (Array.isArray(menus) ? menus : [menus]).filter(Boolean);
  const documentRef = trigger?.ownerDocument || event.currentTarget?.ownerDocument || document;
  const outside = documentTabOrder(documentRef)
    .filter(element => !menuList.some(menu => element === menu || menu.contains(element)));
  const triggerIndex = outside.indexOf(trigger);
  const targetIndex = triggerIndex + (event.shiftKey ? -1 : 1);
  const target = triggerIndex >= 0 && targetIndex >= 0 && targetIndex < outside.length
    ? outside[targetIndex]
    : trigger;
  event.preventDefault();
  event.stopPropagation();
  close?.();
  queueMicrotask(() => {
    const fallback = isTabbable(trigger) ? trigger : null;
    const focusTarget = isTabbable(target) ? target : fallback;
    focusTarget?.focus({ preventScroll: true });
  });
  return true;
}
