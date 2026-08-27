import { el, field, mount } from '../utils/dom.js';
import { call } from '../services/api.js';
import { toast } from '../components/toast.js';

/**
 * First-run wizard. Nothing is written until the final step, so the shop owner
 * can move back and forth freely.
 */
export function renderSetup({ onComplete, status }) {
  const state = {
    step: 0,
    shop: {
      name: status.shop.name === 'iTtEk POS' ? '' : status.shop.name,
      address: status.shop.address, phone: status.shop.phone,
      email: status.shop.email, tin: status.shop.tin, motto: status.shop.motto,
      logoPath: status.shop.logoPath
    },
    owner: { fullName: '', username: '', password: '', confirmPassword: '', phone: '' },
    receipt: {
      paperWidth: status.receipt.paperWidth,
      showLogo: status.receipt.showLogo,
      showCashier: status.receipt.showCashier,
      showCustomer: status.receipt.showCustomer,
      footerMessage: status.receipt.footerMessage,
      printerName: status.receipt.printerName,
      autoPrint: status.receipt.autoPrint
    },
    inventory: { quantityPrecision: 3, lowStockDefaultMilli: 5000, allowNegativeStock: false },
    printers: []
  };

  const needsOwner = !status.hasUsers;

  const steps = [
    { key: 'shop', title: 'Shop information', hint: 'This appears on every receipt and report.' },
    ...(needsOwner ? [{ key: 'owner', title: 'Owner account', hint: 'The account with full access to the system.' }] : []),
    { key: 'receipt', title: 'Receipt layout', hint: 'How your customer receipts are printed.' },
    { key: 'printer', title: 'Printer', hint: 'Choose the printer at your counter.' },
    { key: 'inventory', title: 'Inventory preferences', hint: 'How stock quantities behave.' },
    { key: 'finish', title: 'Finish', hint: 'Review and start trading.' }
  ];

  const container = el('div.auth-screen');
  const bind = (object, key) => (event) => { object[key] = event.target.value; };
  const bindCheck = (object, key) => (event) => { object[key] = event.target.checked; };

  function validateStep() {
    const step = steps[state.step];
    if (step.key === 'shop' && state.shop.name.trim().length < 2) {
      return 'Enter the name of your shop.';
    }
    if (step.key === 'owner') {
      if (state.owner.username.trim().length < 3) return 'Choose a username of at least 3 characters.';
      if (state.owner.password.length < 6) return 'Choose a password of at least 6 characters.';
      if (state.owner.password !== state.owner.confirmPassword) return 'The two passwords do not match.';
      if (state.owner.fullName.trim().length < 2) return 'Enter the owner\'s full name.';
    }
    return null;
  }

  async function finish(button) {
    button.disabled = true;
    button.textContent = 'Setting up…';
    try {
      const result = await call('setup', 'complete', {
        shop: state.shop, owner: needsOwner ? state.owner : null,
        receipt: state.receipt, inventory: state.inventory
      });
      toast.success('Setup complete. Welcome to your shop.');
      onComplete(result);
    } catch (error) {
      toast.error(error.message);
      button.disabled = false;
      button.textContent = 'Finish setup';
    }
  }

  function body() {
    const step = steps[state.step];

    if (step.key === 'shop') {
      return el('div', [
        el('div.form-grid', [
          el('div.full', field('Shop name *', el('input', {
            type: 'text', value: state.shop.name, 'data-autofocus': '',
            placeholder: 'e.g. Adom Provisions', oninput: bind(state.shop, 'name')
          }))),
          el('div.full', field('Address', el('input', {
            type: 'text', value: state.shop.address, placeholder: 'e.g. Kaneshie Market, Accra',
            oninput: bind(state.shop, 'address')
          }))),
          field('Phone number', el('input', {
            type: 'tel', value: state.shop.phone, placeholder: '024 000 0000', oninput: bind(state.shop, 'phone')
          })),
          field('Email', el('input', {
            type: 'email', value: state.shop.email, oninput: bind(state.shop, 'email')
          })),
          field('TIN (optional)', el('input', {
            type: 'text', value: state.shop.tin, oninput: bind(state.shop, 'tin')
          })),
          field('Slogan (optional)', el('input', {
            type: 'text', value: state.shop.motto, placeholder: 'Quality you can trust',
            oninput: bind(state.shop, 'motto')
          }))
        ]),
        el('div.callout.info', 'You can change any of this later in Settings → Shop.')
      ]);
    }

    if (step.key === 'owner') {
      return el('div', [
        el('div.form-grid', [
          field('Full name *', el('input', {
            type: 'text', value: state.owner.fullName, 'data-autofocus': '', oninput: bind(state.owner, 'fullName')
          })),
          field('Phone', el('input', { type: 'tel', value: state.owner.phone, oninput: bind(state.owner, 'phone') })),
          field('Username *', el('input', {
            type: 'text', value: state.owner.username, autocomplete: 'off', oninput: bind(state.owner, 'username')
          })),
          el('div'),
          field('Password *', el('input', {
            type: 'password', value: state.owner.password, autocomplete: 'off', oninput: bind(state.owner, 'password')
          })),
          field('Confirm password *', el('input', {
            type: 'password', value: state.owner.confirmPassword, autocomplete: 'off',
            oninput: bind(state.owner, 'confirmPassword')
          }))
        ]),
        el('div.callout.warn', 'Keep this password safe. It cannot be recovered — an owner password can only be reset by another owner account.')
      ]);
    }

    if (step.key === 'receipt') {
      return el('div', [
        field('Receipt width', el('select', {
          onchange: bind(state.receipt, 'paperWidth')
        }, [
          el('option', { value: '80mm', selected: state.receipt.paperWidth === '80mm' }, '80mm thermal (most common)'),
          el('option', { value: '58mm', selected: state.receipt.paperWidth === '58mm' }, '58mm thermal (small)'),
          el('option', { value: 'A4', selected: state.receipt.paperWidth === 'A4' }, 'A4 paper')
        ])),
        field('Footer message', el('input', {
          type: 'text', value: state.receipt.footerMessage, oninput: bind(state.receipt, 'footerMessage')
        })),
        el('label.checkbox', [el('input', { type: 'checkbox', checked: state.receipt.showLogo, onchange: bindCheck(state.receipt, 'showLogo') }), 'Show the shop logo']),
        el('label.checkbox.mt-8', [el('input', { type: 'checkbox', checked: state.receipt.showCashier, onchange: bindCheck(state.receipt, 'showCashier') }), 'Show who served the customer']),
        el('label.checkbox.mt-8', [el('input', { type: 'checkbox', checked: state.receipt.showCustomer, onchange: bindCheck(state.receipt, 'showCustomer') }), 'Show the customer name'])
      ]);
    }

    if (step.key === 'printer') {
      const selectNode = el('select', { onchange: bind(state.receipt, 'printerName') }, [
        el('option', { value: '' }, 'Ask each time (show the print dialog)'),
        ...state.printers.map((printer) => el('option', {
          value: printer.name, selected: state.receipt.printerName === printer.name
        }, `${printer.displayName || printer.name}${printer.isDefault ? ' (default)' : ''}`))
      ]);

      return el('div', [
        field('Receipt printer', selectNode, {
          help: state.printers.length
            ? 'Any printer installed in Windows will appear here, including USB thermal printers.'
            : 'No printers were found. You can still use the system print dialog, or set this up later in Settings.'
        }),
        el('label.checkbox', [
          el('input', { type: 'checkbox', checked: state.receipt.autoPrint, onchange: bindCheck(state.receipt, 'autoPrint') }),
          'Print receipts automatically when a sale is completed'
        ]),
        el('div.callout.info.mt-16', 'You can send a test receipt from Settings → Printer once setup is finished.')
      ]);
    }

    if (step.key === 'inventory') {
      return el('div', [
        field('Quantity decimal places', el('select', {
          onchange: (event) => { state.inventory.quantityPrecision = Number(event.target.value); }
        }, [
          el('option', { value: '0', selected: state.inventory.quantityPrecision === 0 }, '0 — plain numbers (1, 2, 3)'),
          el('option', { value: '2', selected: state.inventory.quantityPrecision === 2 }, '2 — e.g. 0.50 kg'),
          el('option', { value: '3', selected: state.inventory.quantityPrecision === 3 }, '3 — e.g. 0.500 kg')
        ]), { help: 'Use decimals if you sell by weight, volume or length.' }),
        field('Default low-stock level', el('input', {
          type: 'number', min: '0', step: '1', value: String(state.inventory.lowStockDefaultMilli / 1000),
          oninput: (event) => { state.inventory.lowStockDefaultMilli = Math.round(Number(event.target.value || 0) * 1000); }
        }), { help: 'New products start with this reorder level. You can change it per product.' }),
        el('label.checkbox', [
          el('input', {
            type: 'checkbox', checked: state.inventory.allowNegativeStock,
            onchange: bindCheck(state.inventory, 'allowNegativeStock')
          }),
          'Allow selling items that are out of stock'
        ]),
        el('div.callout.warn.mt-8', 'Leave this off unless you knowingly sell ahead of delivery — it is the main protection against stock figures drifting.')
      ]);
    }

    return el('div', [
      el('div.callout.success', 'Everything is ready.'),
      el('div.detail-list.mt-16', [
        el('div.item', [el('span.k', 'Shop'), el('span.v', state.shop.name)]),
        state.shop.phone ? el('div.item', [el('span.k', 'Phone'), el('span.v', state.shop.phone)]) : null,
        needsOwner ? el('div.item', [el('span.k', 'Owner account'), el('span.v', state.owner.username)]) : null,
        el('div.item', [el('span.k', 'Receipt'), el('span.v', state.receipt.paperWidth)]),
        el('div.item', [el('span.k', 'Printer'), el('span.v', state.receipt.printerName || 'Ask each time')]),
        el('div.item', [el('span.k', 'Currency'), el('span.v', 'Ghana Cedi (₵)')])
      ]),
      el('div.text-sm.muted.mt-16', 'The next screen is your dashboard. Add your products from Products → Add product, or import them from a CSV file.')
    ]);
  }

  function render() {
    const step = steps[state.step];
    const errorNode = el('div.auth-error.hidden');

    const next = el('button.btn.primary', {
      type: 'button',
      onclick: (event) => {
        const problem = validateStep();
        if (problem) {
          errorNode.textContent = problem;
          errorNode.classList.remove('hidden');
          return;
        }
        if (step.key === 'finish') { finish(event.currentTarget); return; }
        state.step += 1;
        render();
      }
    }, step.key === 'finish' ? 'Finish setup' : 'Continue →');

    mount(container, el('div.auth-card.wide', [
      el('div.wizard-steps', steps.map((_s, index) => el('div.step', {
        class: index < state.step ? 'done' : (index === state.step ? 'current' : '')
      }))),
      el('div.text-sm.muted.mb-8', `Step ${state.step + 1} of ${steps.length}`),
      el('h1', step.title),
      el('p.sub', step.hint),
      errorNode,
      body(),
      el('div.row.mt-24', [
        state.step > 0
          ? el('button.btn', { type: 'button', onclick: () => { state.step -= 1; render(); } }, '← Back')
          : el('span'),
        el('span.grow'),
        next
      ])
    ]));

    const autofocus = container.querySelector('[data-autofocus]');
    if (autofocus) setTimeout(() => autofocus.focus(), 30);
  }

  render();

  // Load the printer list in the background; the wizard is usable without it.
  call('print', 'listPrinters')
    .then((printers) => { state.printers = printers || []; if (steps[state.step].key === 'printer') render(); })
    .catch(() => { state.printers = []; });

  return container;
}
