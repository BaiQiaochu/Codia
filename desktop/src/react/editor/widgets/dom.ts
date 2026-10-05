export function createWidgetElement<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {

  return document.createElement(tag);
}
