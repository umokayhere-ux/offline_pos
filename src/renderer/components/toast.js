import { el } from '../utils/dom.js';
import { icon } from './icons.js';

let stack = null;

function container() {
  if (!stack) {
    stack = el('div.toast-stack');
    document.body.appendChild(stack);
  }
  return stack;
}

function show(message, tone = '', timeout = 4000) {
  const node = el(`div.toast${tone ? `.${tone}` : ''}`, [
    el('div.toast-body', message),
    el('button.toast-close', { type: 'button', title: 'Dismiss', onclick: () => node.remove() }, icon('close', { size: 15 }))
  ]);
  container().appendChild(node);
  if (timeout > 0) setTimeout(() => node.remove(), timeout);
  return node;
}

export const toast = {
  info: (message) => show(message, '', 4000),
  success: (message) => show(message, 'success', 3500),
  warn: (message) => show(message, 'warn', 6000),
  error: (message) => show(message, 'error', 8000)
};
