import { el } from '../utils/dom.js';
import { call } from '../services/api.js';

/** Sign-in screen. The password never leaves this form except over IPC. */
export function renderLogin({ onSignedIn, shopName = 'iTtEk POS', logoDataUrl = '' }) {
  const errorNode = el('div.auth-error.hidden');
  const username = el('input', { type: 'text', autocomplete: 'off', 'data-autofocus': '', placeholder: 'Username' });
  const password = el('input', { type: 'password', autocomplete: 'off', placeholder: 'Password' });
  const submitBtn = el('button.btn.primary.block.lg', { type: 'submit' }, 'Sign in');

  const showError = (message) => {
    errorNode.textContent = message;
    errorNode.classList.remove('hidden');
  };

  const form = el('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      errorNode.classList.add('hidden');

      if (!username.value.trim() || !password.value) {
        showError('Enter your username and password.');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Signing in…';
      try {
        const state = await call('auth', 'login', {
          username: username.value.trim(),
          password: password.value
        });
        password.value = '';
        onSignedIn(state);
      } catch (error) {
        showError(error.message);
        password.value = '';
        password.focus();
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Sign in';
      }
    }
  }, [
    errorNode,
    el('div.field', [el('label', 'Username'), username]),
    el('div.field', [el('label', 'Password'), password]),
    submitBtn
  ]);

  return el('div.auth-screen', [
    el('div.auth-card', [
      logoDataUrl
        ? el('img.auth-logo', { src: logoDataUrl, alt: '', style: { objectFit: 'cover' } })
        : el('div.auth-logo', 'iT'),
      el('h1', shopName),
      el('p.sub', 'Sign in to open the till'),
      form,
      el('div.center.mt-24.text-sm.faint', 'Works completely offline · All amounts in Ghana Cedis (₵)')
    ])
  ]);
}
