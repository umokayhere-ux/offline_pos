import { el } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { call } from '../services/api.js';

/**
 * Sign-in screen.
 *
 * A brand panel on the left and the form on white at the right — the layout a
 * shopkeeper recognises from commercial software, and one that keeps the two
 * fields large enough to hit quickly at the start of a shift. The password never
 * leaves this form except over IPC.
 */
export function renderLogin({ onSignedIn, shopName = 'iTtEk POS', logoDataUrl = '' }) {
  const errorNode = el('div.auth-error.hidden');
  const username = el('input', {
    type: 'text', autocomplete: 'off', 'data-autofocus': '',
    placeholder: 'Your username', autocapitalize: 'off', spellcheck: false
  });
  const password = el('input', { type: 'password', autocomplete: 'off', placeholder: 'Your password' });
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

  const point = (name, text) => el('div.point', [
    el('span.dot', icon(name, { size: 15 })),
    el('span', text)
  ]);

  return el('div.auth-screen', [
    el('aside.auth-brand', [
      el('div.brand-mark', [
        logoDataUrl
          ? el('img.tile', { src: logoDataUrl, alt: '' })
          : el('div.tile', 'iT'),
        el('div.name', 'iTtEk POS')
      ]),
      el('div', [
        el('div.headline', shopName),
        el('div.sub', 'Sell, track your stock and see your profit — all on this computer, with no internet needed.')
      ]),
      el('div.points', [
        point('offline', 'Works with the internet off'),
        point('cash', 'Every amount in Ghana Cedis (₵)'),
        point('lock', 'Your data stays on this machine')
      ])
    ]),

    el('div.auth-form-side', [
      el('div.auth-card', [
        logoDataUrl
          ? el('img.auth-logo', { src: logoDataUrl, alt: '' })
          : el('div.auth-logo', 'iT'),
        el('h1', 'Welcome back'),
        el('p.sub', 'Sign in to open the till.'),
        form,
        el('div.auth-foot', [
          icon('lock', { size: 14 }),
          el('span', 'Ask the shop owner if you have forgotten your password.')
        ])
      ])
    ])
  ]);
}
