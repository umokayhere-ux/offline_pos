import { el, mount, field } from '../utils/dom.js';
import { qty } from '../utils/format.js';
import { tryCall } from '../services/api.js';
import { toast } from '../components/toast.js';
import { openModal } from '../components/modal.js';

/**
 * Settings.
 *
 * The shop/company details entered here are the single source used by the
 * sidebar, the login screen, every receipt and every printed report — change the
 * shop name once and it changes everywhere.
 */

const TABS = [
  { id: 'shop', label: 'Shop & company', permission: 'settings.manage' },
  { id: 'receipt', label: 'Receipt', permission: 'settings.manage' },
  { id: 'printer', label: 'Printer', permission: 'settings.manage' },
  { id: 'inventory', label: 'Inventory & POS', permission: 'settings.manage' },
  { id: 'security', label: 'Security', permission: null },
  { id: 'about', label: 'About', permission: null }
];

async function render(ctx) {
  const state = {
    tab: 'shop',
    settings: {},
    receipt: {},
    printers: [],
    info: {}
  };

  const container = el('div');
  const bodyHost = el('div');

  async function reload() {
    const [settings, receipt, info] = await Promise.all([
      tryCall('settings', 'all'),
      tryCall('settings', 'receipt'),
      tryCall('app', 'info', undefined, { silent: true })
    ]);
    if (settings.ok) state.settings = settings.data;
    if (receipt.ok) state.receipt = receipt.data;
    if (info.ok) state.info = info.data;
  }

  async function saveSettings(values, message = 'Settings saved.') {
    const result = await tryCall('settings', 'update', values);
    if (!result.ok) return false;
    state.settings = result.data;
    await ctx.reloadSettings();
    ctx.refreshShell();
    toast.success(message);
    return true;
  }

  // -------------------------------- Shop -----------------------------------

  function shopTab() {
    const values = {
      'shop.name': state.settings['shop.name'] || '',
      'shop.address': state.settings['shop.address'] || '',
      'shop.phone': state.settings['shop.phone'] || '',
      'shop.email': state.settings['shop.email'] || '',
      'shop.tin': state.settings['shop.tin'] || '',
      'shop.motto': state.settings['shop.motto'] || ''
    };
    const bind = (key) => (event) => { values[key] = event.target.value; };

    const logoPreview = el('div', { style: { display: 'flex', alignItems: 'center', gap: '14px' } }, [
      state.info.logoDataUrl
        ? el('img', { src: state.info.logoDataUrl, alt: 'Shop logo', style: { width: '78px', height: '78px', objectFit: 'contain', border: '1px solid var(--border)', borderRadius: '10px', padding: '6px', background: '#fff' } })
        : el('div', { style: { width: '78px', height: '78px', display: 'grid', placeItems: 'center', border: '1px dashed var(--border-strong)', borderRadius: '10px', color: 'var(--text-faint)' } }, 'No logo'),
      el('div', [
        el('button.btn', {
          type: 'button',
          onclick: async () => {
            const result = await tryCall('settings', 'chooseLogo');
            if (!result.ok || result.data.cancelled) return;
            toast.success('Logo updated. It will appear on receipts and in the sidebar.');
            await reload();
            await ctx.reloadSettings();
            paint();
          }
        }, 'Choose a logo…'),
        el('div.help.mt-8', 'PNG or JPG. A copy is stored with your data, so moving the original file will not break it.'),
        state.settings['shop.logo_path']
          ? el('button.btn.sm.ghost.mt-8', {
            type: 'button',
            onclick: async () => {
              if (await saveSettings({ 'shop.logo_path': '' }, 'Logo removed.')) { await reload(); paint(); }
            }
          }, 'Remove logo')
          : null
      ])
    ]);

    return el('div.card', [
      el('div.card-head', [el('h2', 'Shop & company details')]),
      el('div.card-body', [
        el('div.callout.info.mb-16', 'These details appear on every receipt, on printed reports, on the sign-in screen and in the sidebar.'),
        el('div.form-grid', [
          el('div.full', field('Shop / company name *', el('input', {
            type: 'text', value: values['shop.name'], oninput: bind('shop.name')
          }), { help: 'This is what customers see at the top of their receipt.' })),
          el('div.full', field('Address / location', el('input', {
            type: 'text', value: values['shop.address'],
            placeholder: 'e.g. Shop 12, Kaneshie Market, Accra', oninput: bind('shop.address')
          }))),
          field('Phone number', el('input', {
            type: 'tel', value: values['shop.phone'], placeholder: '024 000 0000', oninput: bind('shop.phone')
          })),
          field('Email', el('input', { type: 'email', value: values['shop.email'], oninput: bind('shop.email') })),
          field('TIN / business number', el('input', { type: 'text', value: values['shop.tin'], oninput: bind('shop.tin') })),
          field('Slogan', el('input', {
            type: 'text', value: values['shop.motto'], placeholder: 'Quality you can trust', oninput: bind('shop.motto')
          })),
          el('div.full', el('div.field', [el('label', 'Shop logo'), logoPreview]))
        ]),
        el('div.row.mt-16', [
          el('span.grow'),
          el('button.btn.primary', {
            type: 'button',
            onclick: async (event) => {
              event.currentTarget.disabled = true;
              await saveSettings(values, 'Shop details saved. They now apply across the whole system.');
              event.currentTarget.disabled = false;
              await reload();
              paint();
            }
          }, 'Save shop details')
        ])
      ])
    ]);
  }

  // ------------------------------- Receipt ---------------------------------

  function receiptTab() {
    const values = { ...state.receipt };
    const bind = (key) => (event) => { values[key] = event.target.value; };
    const bindCheck = (key) => (event) => { values[key] = event.target.checked; };

    return el('div.card', [
      el('div.card-head', [el('h2', 'Receipt layout')]),
      el('div.card-body', [
        el('div.form-grid', [
          field('Paper width', el('select', { onchange: bind('paperWidth') }, [
            el('option', { value: '80mm', selected: values.paperWidth === '80mm' }, '80mm thermal (most common)'),
            el('option', { value: '58mm', selected: values.paperWidth === '58mm' }, '58mm thermal (small)'),
            el('option', { value: 'A4', selected: values.paperWidth === 'A4' }, 'A4 paper')
          ])),
          el('div'),
          el('div.full', field('Header note', el('input', {
            type: 'text', value: values.headerNote, placeholder: 'e.g. Wholesale & retail',
            oninput: bind('headerNote')
          }))),
          el('div.full', field('Footer message', el('input', {
            type: 'text', value: values.footerMessage, oninput: bind('footerMessage')
          }))),
          el('div.full', el('div.col.gap-4', [
            el('label.checkbox', [el('input', { type: 'checkbox', checked: values.showLogo, onchange: bindCheck('showLogo') }), 'Print the shop logo']),
            el('label.checkbox', [el('input', { type: 'checkbox', checked: values.showCashier, onchange: bindCheck('showCashier') }), 'Show who served the customer']),
            el('label.checkbox', [el('input', { type: 'checkbox', checked: values.showCustomer, onchange: bindCheck('showCustomer') }), 'Show the customer name']),
            el('label.checkbox', [el('input', { type: 'checkbox', checked: values.autoPrint, onchange: bindCheck('autoPrint') }), 'Print automatically when a sale is completed'])
          ]))
        ]),
        el('div.row.mt-16', [
          el('button.btn', {
            type: 'button',
            onclick: async () => {
              const result = await tryCall('print', 'test', { paperWidth: values.paperWidth });
              if (result.ok && result.data.printed) toast.success('Test receipt sent to the printer.');
            }
          }, '🖨 Print a test receipt'),
          el('span.grow'),
          el('button.btn.primary', {
            type: 'button',
            onclick: async (event) => {
              event.currentTarget.disabled = true;
              const result = await tryCall('settings', 'updateReceipt', { ...values, printerName: state.receipt.printerName });
              event.currentTarget.disabled = false;
              if (!result.ok) return;
              state.receipt = result.data;
              toast.success('Receipt settings saved.');
            }
          }, 'Save receipt settings')
        ])
      ])
    ]);
  }

  // ------------------------------- Printer ---------------------------------

  function printerTab() {
    let printerName = state.receipt.printerName || '';

    const selectNode = el('select', { onchange: (event) => { printerName = event.target.value; } }, [
      el('option', { value: '' }, 'Ask each time (show the print dialog)'),
      ...state.printers.map((printer) => el('option', {
        value: printer.name, selected: printerName === printer.name
      }, `${printer.displayName || printer.name}${printer.isDefault ? ' (Windows default)' : ''}`))
    ]);

    return el('div.card', [
      el('div.card-head', [el('h2', 'Printer')]),
      el('div.card-body', [
        el('div.callout.info.mb-16', 'Any printer installed in Windows appears here, including USB thermal receipt printers. There is no separate driver to install for this application.'),
        field('Receipt printer', selectNode, {
          help: state.printers.length === 0
            ? 'No printers were found. Install your printer in Windows first, then reopen this screen.'
            : `${state.printers.length} printer(s) found.`
        }),
        el('div.row.mt-16', [
          el('button.btn', {
            type: 'button',
            onclick: async () => {
              const result = await tryCall('print', 'test', { printerName });
              if (result.ok && result.data.printed) toast.success('Test receipt sent.');
              else if (result.ok && result.data.cancelled) toast.info('Print cancelled.');
            }
          }, '🖨 Print a test receipt'),
          el('button.btn', {
            type: 'button',
            onclick: async () => {
              const result = await tryCall('print', 'listPrinters');
              if (!result.ok) return;
              state.printers = result.data;
              toast.success(`${state.printers.length} printer(s) found.`);
              paint();
            }
          }, '⟳ Refresh printer list'),
          el('span.grow'),
          el('button.btn.primary', {
            type: 'button',
            onclick: async (event) => {
              event.currentTarget.disabled = true;
              const result = await tryCall('settings', 'updateReceipt', { ...state.receipt, printerName });
              event.currentTarget.disabled = false;
              if (!result.ok) return;
              state.receipt = result.data;
              toast.success('Printer saved.');
            }
          }, 'Save printer')
        ])
      ])
    ]);
  }

  // --------------------------- Inventory and POS ---------------------------

  function inventoryTab() {
    const values = {
      'inventory.quantity_precision': String(state.settings['inventory.quantity_precision'] ?? 3),
      'inventory.low_stock_default_milli': String((state.settings['inventory.low_stock_default_milli'] || 0) / 1000),
      'inventory.allow_negative_stock': !!state.settings['inventory.allow_negative_stock'],
      'pos.scan_behaviour': state.settings['pos.scan_behaviour'] || 'increment',
      'pos.require_customer_for_credit': state.settings['pos.require_customer_for_credit'] !== false
    };

    return el('div.card', [
      el('div.card-head', [el('h2', 'Inventory and till behaviour')]),
      el('div.card-body', [
        el('div.form-grid', [
          field('Quantity decimal places', el('select', {
            onchange: (event) => { values['inventory.quantity_precision'] = event.target.value; }
          }, [
            el('option', { value: '0', selected: values['inventory.quantity_precision'] === '0' }, '0 — whole items only'),
            el('option', { value: '2', selected: values['inventory.quantity_precision'] === '2' }, '2 — e.g. 0.50 kg'),
            el('option', { value: '3', selected: values['inventory.quantity_precision'] === '3' }, '3 — e.g. 0.500 kg')
          ]), { help: 'How quantities are displayed. Use decimals if you sell by weight, volume or length.' }),

          field('Default reorder level for new products', el('input', {
            type: 'number', min: '0', step: '1', value: values['inventory.low_stock_default_milli'],
            oninput: (event) => { values['inventory.low_stock_default_milli'] = event.target.value; }
          })),

          field('When the same barcode is scanned again', el('select', {
            onchange: (event) => { values['pos.scan_behaviour'] = event.target.value; }
          }, [
            el('option', { value: 'increment', selected: values['pos.scan_behaviour'] === 'increment' }, 'Increase the quantity on the existing line'),
            el('option', { value: 'prompt', selected: values['pos.scan_behaviour'] === 'prompt' }, 'Highlight the line, do not change the quantity')
          ])),

          el('div.full', el('div.col.gap-4.mt-8', [
            el('label.checkbox', [
              el('input', {
                type: 'checkbox', checked: values['inventory.allow_negative_stock'],
                onchange: (event) => { values['inventory.allow_negative_stock'] = event.target.checked; }
              }),
              'Allow selling products that are out of stock'
            ]),
            el('div.help', 'Leave this off unless you knowingly sell ahead of delivery. It is the main protection against stock figures drifting.'),
            el('label.checkbox.mt-8', [
              el('input', {
                type: 'checkbox', checked: values['pos.require_customer_for_credit'],
                onchange: (event) => { values['pos.require_customer_for_credit'] = event.target.checked; }
              }),
              'Require a named customer for credit sales'
            ]),
            el('div.help', 'A debt with nobody attached to it can never be collected.')
          ]))
        ]),
        el('div.row.mt-16', [
          el('span.grow'),
          el('button.btn.primary', {
            type: 'button',
            onclick: async (event) => {
              event.currentTarget.disabled = true;
              await saveSettings({
                'inventory.quantity_precision': values['inventory.quantity_precision'],
                'inventory.low_stock_default_milli': String(Math.round(Number(values['inventory.low_stock_default_milli'] || 0) * 1000)),
                'inventory.allow_negative_stock': values['inventory.allow_negative_stock'],
                'pos.scan_behaviour': values['pos.scan_behaviour'],
                'pos.require_customer_for_credit': values['pos.require_customer_for_credit']
              }, 'Inventory settings saved.');
              event.currentTarget.disabled = false;
              await reload();
              paint();
            }
          }, 'Save')
        ])
      ])
    ]);
  }

  // ------------------------------- Security --------------------------------

  function securityTab() {
    const currentInput = el('input', { type: 'password', autocomplete: 'off' });
    const newInput = el('input', { type: 'password', autocomplete: 'off' });
    const confirmInput = el('input', { type: 'password', autocomplete: 'off' });
    const errorNode = el('div.error-text.hidden');

    let timeout = String(state.settings['security.session_timeout_minutes'] ?? 30);
    let minLength = String(state.settings['security.min_password_length'] ?? 6);

    const changePassword = async (button) => {
      errorNode.classList.add('hidden');
      if (newInput.value !== confirmInput.value) {
        errorNode.textContent = 'The two new passwords do not match.';
        errorNode.classList.remove('hidden');
        return;
      }
      button.disabled = true;
      const result = await tryCall('auth', 'changePassword', {
        currentPassword: currentInput.value, newPassword: newInput.value
      }, { silent: true });
      button.disabled = false;
      if (!result.ok) {
        errorNode.textContent = result.error.message;
        errorNode.classList.remove('hidden');
        return;
      }
      currentInput.value = ''; newInput.value = ''; confirmInput.value = '';
      toast.success('Your password has been changed.');
    };

    return el('div', [
      el('div.card', [
        el('div.card-head', [el('h2', 'Change your password')]),
        el('div.card-body', [
          errorNode,
          el('div.form-grid', [
            el('div.full', field('Current password', currentInput)),
            field('New password', newInput),
            field('Confirm new password', confirmInput)
          ]),
          el('div.row.mt-8', [
            el('span.grow'),
            el('button.btn.primary', { type: 'button', onclick: (event) => changePassword(event.currentTarget) }, 'Change password')
          ])
        ])
      ]),

      ctx.can('settings.manage') ? el('div.card.mt-16', [
        el('div.card-head', [el('h2', 'Security policy')]),
        el('div.card-body', [
          el('div.form-grid', [
            field('Sign out after inactivity (minutes)', el('input', {
              type: 'number', min: '1', max: '480', value: timeout,
              oninput: (event) => { timeout = event.target.value; }
            }), { help: 'Protects the till when a cashier walks away.' }),
            field('Minimum password length', el('input', {
              type: 'number', min: '4', max: '64', value: minLength,
              oninput: (event) => { minLength = event.target.value; }
            }))
          ]),
          el('div.row.mt-8', [
            el('span.grow'),
            el('button.btn.primary', {
              type: 'button',
              onclick: async (event) => {
                event.currentTarget.disabled = true;
                await saveSettings({
                  'security.session_timeout_minutes': timeout,
                  'security.min_password_length': minLength
                }, 'Security policy saved.');
                event.currentTarget.disabled = false;
                await reload();
              }
            }, 'Save policy')
          ])
        ])
      ]) : null
    ]);
  }

  // -------------------------------- About ----------------------------------

  function aboutTab() {
    return el('div', [
      el('div.card', [
        el('div.card-head', [el('h2', 'About this application')]),
        el('div.card-body', [
          el('div.detail-list', [
            el('div.item', [el('span.k', 'Application'), el('span.v', 'iTtEk POS')]),
            el('div.item', [el('span.k', 'Version'), el('span.v', state.info.version || '—')]),
            el('div.item', [el('span.k', 'Shop'), el('span.v', state.settings['shop.name'] || '—')]),
            el('div.item', [el('span.k', 'Currency'), el('span.v', 'Ghana Cedi (GHS) — ₵')]),
            el('div.item', [el('span.k', 'Timezone'), el('span.v', state.settings['app.timezone'] || 'Africa/Accra')]),
            el('div.item', [el('span.k', 'Internet required'), el('span.v', 'No — everything runs on this computer')]),
            el('div.item', [el('span.k', 'Quantity precision'), el('span.v', `${state.settings['inventory.quantity_precision'] ?? 3} decimal places`)])
          ]),
          el('div.callout.info.mt-16', [
            el('div.strong', 'How your money is stored'),
            el('div', 'Every amount is held as a whole number of pesewas, and every calculation uses exact decimal arithmetic. Nothing in this application relies on floating-point maths, so totals, profit and change never drift by a pesewa.')
          ]),
          el('div.callout.warn.mt-16', [
            el('div.strong', 'Keep a backup'),
            el('div', 'Your entire shop lives in one database file on this computer. Take a backup regularly and keep a copy on a USB stick.')
          ])
        ])
      ]),
      el('div.card.mt-16', [
        el('div.card-head', [el('h3', 'Keyboard shortcuts')]),
        el('div.card-body', el('div.detail-list', [
          ['F2', 'Search for a product at the till'],
          ['F3', 'Choose a customer'],
          ['F4', 'Hold the current sale'],
          ['F5', 'Jump to the payment box'],
          ['F6', 'View held sales'],
          ['F8', 'Clear the cart'],
          ['Esc', 'Close the open dialog'],
          ['Ctrl + 1…4', 'Dashboard, Till, Products, Reports']
        ].map(([key, description]) => el('div.item', [
          el('span.k.mono', key), el('span.v', description)
        ]))))
      ])
    ]);
  }

  // ------------------------------- Rendering -------------------------------

  const tabsNode = el('div.btn-group');

  function paint() {
    mount(tabsNode, TABS
      .filter((tab) => !tab.permission || ctx.can(tab.permission))
      .map((tab) => el('button.btn', {
        type: 'button',
        class: tab.id === state.tab ? 'active' : '',
        onclick: () => { state.tab = tab.id; paint(); }
      }, tab.label)));

    const views = {
      shop: shopTab, receipt: receiptTab, printer: printerTab,
      inventory: inventoryTab, security: securityTab, about: aboutTab
    };
    mount(bodyHost, (views[state.tab] || aboutTab)());
  }

  await reload();
  const printers = await tryCall('print', 'listPrinters', undefined, { silent: true });
  state.printers = printers.ok ? printers.data : [];

  mount(container, el('div.mb-16', tabsNode), bodyHost);
  paint();
  return container;
}

export const settingsPage = {
  title: 'Settings',
  subtitle: 'Shop details, receipts, printer and security',
  permission: null,
  render
};
