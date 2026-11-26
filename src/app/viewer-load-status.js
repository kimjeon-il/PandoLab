/** Present loading feedback without owning document or renderer readiness. */
export function presentViewerLoadStatus(element, message, {error = false, retry = null} = {}) {
  // The normal live region stays in the accessibility tree. Only errors use
  // the top notice stack; retries remain ordinary, focusable shared buttons.
  element.className = error ? 'ui-floating-surface viewer-map-error' : 'ui-visually-hidden';
  element.setAttribute('role', error ? 'alert' : 'status');
  element.setAttribute('aria-live', error ? 'assertive' : 'polite');
  element.setAttribute('aria-atomic', 'true');
  element.hidden = false;
  element.textContent = message;
  if (retry) {
    const button = element.ownerDocument.createElement('button');
    button.type = 'button';
    button.className = 'ui-button btn';
    button.textContent = '다시 시도';
    button.addEventListener('click', retry);
    element.appendChild(button);
  }
}
