import { icon } from '../components/icons.js';

// Tiny DOM helpers. Everything the UI renders goes through `el`/`text`, so user
// data is inserted as text nodes and can never be interpreted as markup.

/**
 * Create an element.
 *   el('div.card', { onclick }, [ el('h2', 'Title') ])
 * The tag may carry CSS-selector style classes and an id: 'button.btn.primary#save'.
 */
export function el(selector, propsOrChildren, maybeChildren) {
  const [tagPart, ...rest] = String(selector).split(/(?=[.#])/);
  const node = document.createElement(tagPart || 'div');

  for (const token of rest) {
    if (token.startsWith('.')) node.classList.add(token.slice(1));
    else if (token.startsWith('#')) node.id = token.slice(1);
  }

  let props = propsOrChildren;
  let children = maybeChildren;
  if (Array.isArray(propsOrChildren) || typeof propsOrChildren === 'string'
      || propsOrChildren instanceof Node || typeof propsOrChildren === 'number') {
    children = propsOrChildren;
    props = null;
  }

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = `${node.className} ${value}`.trim();
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key === 'html') node.innerHTML = value;  // only ever used with trusted, generated SVG
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2), (event) => {
          // The DOM clears event.currentTarget once dispatch finishes, which
          // breaks the common pattern of disabling a button, awaiting an IPC
          // call and then re-enabling it. Pin it to the element it was bound to.
          try {
            Object.defineProperty(event, 'currentTarget', { value: node, configurable: true });
          } catch { /* some synthetic events refuse redefinition; harmless */ }
          return value.call(node, event);
        });
      }
      else if (key in node && key !== 'list') node[key] = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
  }

  append(node, children);
  return node;
}

export function append(parent, children) {
  if (children === null || children === undefined || children === false) return parent;
  if (Array.isArray(children)) {
    for (const child of children) append(parent, child);
    return parent;
  }
  parent.appendChild(children instanceof Node ? children : document.createTextNode(String(children)));
  return parent;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(container, ...nodes) {
  clear(container);
  append(container, nodes);
  return container;
}

export const frag = (children) => append(document.createDocumentFragment(), children);

/** A labelled form field. */
export function field(label, control, { help = null, error = null } = {}) {
  return el('div.field', { class: error ? 'error' : '' }, [
    label ? el('label', label) : null,
    control,
    help ? el('div.help', help) : null,
    error ? el('div.error-text', error) : null
  ]);
}

export function input(props = {}) {
  return el('input', { type: 'text', ...props });
}

export function select(options, props = {}) {
  const node = el('select', props);
  for (const option of options) {
    node.appendChild(el('option', { value: option.value, selected: option.selected }, option.label));
  }
  return node;
}

export function button(label, props = {}) {
  return el('button.btn', { type: 'button', ...props }, label);
}

export function badge(label, tone = '') {
  return el(`span.badge-pill${tone ? `.${tone}` : ''}`, label);
}

export function emptyState(title, message, action = null) {
  return el('div.empty-state', [
    el('div.icon-wrap', icon('inbox', { size: 30, stroke: 1.4 })),
    el('div.title', title),
    message ? el('div', message) : null,
    action ? el('div.mt-16', action) : null
  ]);
}

export function loading(message = 'Loading…') {
  return el('div.loading-block', [el('span.spinner'), el('span', message)]);
}

export function debounce(fn, delay = 220) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/** Trigger a browser download of generated text (used for CSV fallbacks). */
export function downloadText(filename, content, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
