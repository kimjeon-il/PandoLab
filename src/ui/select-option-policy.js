export function isPlaceholderOption(option) {
  return option?.placeholder === true
    || option?.dataset?.placeholder === 'true'
    || option?.getAttribute?.('data-placeholder') === 'true';
}

export function selectableOptions(options = []) {
  return [...options].filter(option => !isPlaceholderOption(option)
    && option?.disabled !== true
    && option?.hidden !== true);
}

