type FullscreenRecord = {
  placeholder: Comment;
  parent: Node;
};

const hostedElements = new WeakMap<HTMLElement, FullscreenRecord>();

export function isFullscreenHosted(element: HTMLElement): boolean {
  return hostedElements.has(element);
}

export function setFullscreenHosted(element: HTMLElement, expanded: boolean): void {
  const current = hostedElements.get(element);
  if (expanded) {
    if (current || !element.parentNode || typeof document === 'undefined') return;
    const placeholder = document.createComment('gsap-fullscreen-host');
    const parent = element.parentNode;
    parent.insertBefore(placeholder, element);
    document.body.appendChild(element);
    hostedElements.set(element, { placeholder, parent });
    element.dataset.fullscreenHosted = 'true';
    return;
  }

  if (!current) return;
  current.parent.insertBefore(element, current.placeholder);
  current.placeholder.remove();
  hostedElements.delete(element);
  delete element.dataset.fullscreenHosted;
}

export function toggleFullscreenHosted(element: HTMLElement): boolean {
  const expanded = !isFullscreenHosted(element);
  setFullscreenHosted(element, expanded);
  return expanded;
}
