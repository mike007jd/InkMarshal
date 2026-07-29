export function isUsableReturnFocusTarget(
  target: HTMLElement | null,
): target is HTMLElement {
  if (
    !target?.isConnected ||
    target === document.body ||
    target === document.documentElement ||
    target.closest('[data-slot="sheet-content"]') ||
    target.matches(':disabled')
  ) {
    return false;
  }

  for (let element: HTMLElement | null = target; element; element = element.parentElement) {
    const style = window.getComputedStyle(element);
    if (
      element.inert ||
      element.getAttribute('aria-hidden') === 'true' ||
      style.display === 'none' ||
      style.visibility === 'hidden'
    ) {
      return false;
    }
  }

  return target.getClientRects().length > 0;
}
