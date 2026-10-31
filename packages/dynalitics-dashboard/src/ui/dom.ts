// The only DOM factories of the dashboard. Visitor strings go in as text nodes or attribute
// values; nothing here parses HTML (docs/DESIGN.md section 10, rule 1).

export const SVG_NS = 'http://www.w3.org/2000/svg';

export type Attrs = Readonly<Record<string, string | number>>;

function applyAttrs(node: Element, attrs: Attrs | undefined): void {
  if (!attrs) return;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string | null,
  attrs?: Attrs,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  applyAttrs(node, attrs);
  return node;
}

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  parent?: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  applyAttrs(node, attrs);
  parent?.appendChild(node);
  return node;
}

/** Visitor-supplied text: isolated for bidi, wrappable at any length (class `v`). */
export function visitorText(
  tag: 'span' | 'td' | 'li' | 'div',
  text: string,
  className = '',
  dirAuto = false,
): HTMLElement {
  const node = el(tag, className ? `v ${className}` : 'v', text);
  if (dirAuto) node.setAttribute('dir', 'auto');
  return node;
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function append(parent: Node, ...children: readonly (Node | null | undefined)[]): void {
  for (const child of children) if (child) parent.appendChild(child);
}

export function swatch(kind: string): HTMLElement {
  return el('span', `dy-sw dy-sw-${kind}`, null, { 'aria-hidden': 'true' });
}

export function visuallyHidden(text: string): HTMLElement {
  return el('span', 'vh', text);
}
