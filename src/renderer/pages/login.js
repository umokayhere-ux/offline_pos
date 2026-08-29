import { el } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { call } from '../services/api.js';

/**
 * Sign-in screen.
 *
 * One centred card on white: the shop's logo and name, two fields, one button.
 * Nothing else — this is the first thing a cashier sees at the start of a
 * shift, and anything extra on it is just something to read past.
 */
export function renderLogin({ onSignedIn, shopName = 'iTtEk POS', logoDataUrl = '' }) {
  const errorNode = el('div.auth-error.hidden');
  const username = el('input', {
    type: 'text', autocomplete: 'off', 'data-autofocus': '',
    autocapitalize: 'off', spellcheck: false
  });
  const password = el('input', { type: 'password', autocomplete: 'off' });
  const submitBtn = el('button.btn.primary.block.lg', { type: 'submit' }, 'Sign in');

  const showError = (message) => {
    errorNode.replaceChildren(icon('warning', { size: 17 }), el('span', message));
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
        ? el('img.auth-logo', { src: logoDataUrl, alt: '' })
        : el('div.auth-logo', 'iT'),
      el('h1', shopName),
      el('p.sub', 'Sign in to open the till'),
      form
    ])
  ]);
}
