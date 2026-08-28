import { el, clear } from '../utils/dom.js';
import { icon } from './icons.js';

/**
 * Modal dialogs. Escape closes, focus moves into the dialog, and the backdrop
 * only closes when the modal opts in — a half-typed sale must not vanish on a
 * stray click.
 */

const open = [];

export function openModal({
  title,
  body,
  footer = null,
  size = '',
  closeOnBackdrop = true,
  onClose = null
}) {
  const backdrop = el('div.modal-backdrop');
  const modal = el(`div.modal${size ? `.${size}` : ''}`);

  const close = (result) => {
    const index = open.indexOf(instance);
    if (index >= 0) open.splice(index, 1);
    backdrop.remove();
    if (onClose) onClose(result);
    const previous = open[open.length - 1];
    if (previous) previous.focusFirst();
  };

  const instance = {
    close,
    setBody(node) { clear(bodyNode); bodyNode.appendChild(node); },
    setFooter(node) { clear(footNode); if (node) footNode.appendChild(node); },
    setBusy(busy) {
      modal.querySelectorAll('button, input, select, textarea').forEach((control) => {
        control.disabled = busy;
      });
    },
    focusFirst() {
      const target = modal.querySelector('[data-autofocus]')
        || modal.querySelector('input:not([type=hidden]), select, textarea, button.primary');
      if (target) target.focus();
    },
    element: modal
  };

  const head = el('div.modal-head', [
    el('h2', title),
    el('button.btn.ghost.icon-only', { type: 'button', title: 'Close', onclick: () => close(null) }, icon('close', { size: 17 }))
  ]);
  const bodyNode = el('div.modal-body');
  bodyNode.appendChild(typeof body === 'function' ? body(instance) : body);
  const footNode = el('div.modal-foot');
  if (footer) footNode.appendChild(typeof footer === 'function' ? footer(instance) : footer);

  modal.append(head, bodyNode);
  if (footer) modal.appendChild(footNode);
  backdrop.appendChild(modal);

  backdrop.addEventListener('mousedown', (event) => {
    if (closeOnBackdrop && event.target === backdrop) close(null);
  });

  document.body.appendChild(backdrop);
  open.push(instance);
  setTimeout(() => instance.focusFirst(), 20);
  return instance;
}

export function closeTopModal() {
  const top = open[open.length - 1];
  if (top) { top.close(null); return true; }
  return false;
}

export function hasOpenModal() {
  return open.length > 0;
}

/** A yes/no dialog rendered in-app (used for reversible actions). */
export function confirmModal({
  title = 'Please confirm',
  message,
  detail = null,
  confirmLabel = 'Confirm',
  tone = 'primary'
}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };

    const instance = openModal({
      title,
      size: 'narrow',
      body: el('div', [
        el('p', message),
        detail ? el('div.callout.warn', detail) : null
      ]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(false) }, 'Cancel'),
        el(`button.btn.${tone}`, { type: 'button', 'data-autofocus': '', onclick: () => instance.close(true) }, confirmLabel)
      ]),
      onClose: (result) => finish(result === true)
    });
  });
}

/** A single-value prompt, used for reasons that must accompany an action. */
export function promptModal({
  title,
  label,
  placeholder = '',
  confirmLabel = 'Save',
  multiline = false,
  required = true,
  minLength = 3
}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };

    const control = multiline
      ? el('textarea', { placeholder, 'data-autofocus': '' })
      : el('input', { type: 'text', placeholder, 'data-autofocus': '' });
    const errorNode = el('div.error-text.hidden');

    const submit = () => {
      const value = control.value.trim();
      if (required && value.length < minLength) {
        errorNode.textContent = `Please enter at least ${minLength} characters.`;
        errorNode.classList.remove('hidden');
        control.focus();
        return;
      }
      instance.close(value);
    };

    control.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !multiline) { event.preventDefault(); submit(); }
    });

    const instance = openModal({
      title,
      size: 'narrow',
      body: el('div', [el('div.field', [el('label', label), control, errorNode])]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.primary', { type: 'button', onclick: submit }, confirmLabel)
      ]),
      onClose: (result) => finish(typeof result === 'string' ? result : null)
    });
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && open.length > 0) {
    event.preventDefault();
    closeTopModal();
  }
});
