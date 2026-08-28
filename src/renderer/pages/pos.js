import { el, mount, clear, debounce, field } from '../utils/dom.js';
import { money, moneyInput, parseMoney, qty, qtyExact, parseQty, paymentLabel, dateTime } from '../utils/format.js';
import { api, tryCall } from '../services/api.js';
import { toast } from '../components/toast.js';
import { openModal, confirmModal, hasOpenModal } from '../components/modal.js';
import { icon } from '../components/icons.js';

/**
 * Point of Sale.
 *
 * Cart state lives here; every monetary figure on screen is calculated by the
 * MAIN process (pos.priceCart) using exactly the same code that will commit the
 * sale, so the total the customer is quoted is the total that gets recorded.
 */

const QUICK_CASH = [500, 1000, 2000, 5000, 10000, 20000]; // pesewas

function newCartState() {
  return {
    items: [],          // { productId, product, quantityMilli, unitPricePesewas, discount }
    discount: { type: 'none', value: 0 },
    customer: null,
    paymentMethod: 'cash',
    tenderedPesewas: null,
    totals: null,
    committing: false,
    lastSale: null
  };
}

async function render(ctx) {
  const state = newCartState();
  let scanInput = null;
  const container = el('div.pos');

  // --------------------------- Pricing -------------------------------------

  async function reprice() {
    if (state.items.length === 0) {
      state.totals = null;
      draw();
      return;
    }
    const result = await tryCall('pos', 'priceCart', {
      items: state.items.map((item) => ({
        productId: item.productId,
        quantity: qtyExact(item.quantityMilli),
        unitPrice: moneyInput(item.unitPricePesewas),
        discount: item.discount
      })),
      discount: state.discount
    });

    if (!result.ok) { state.totals = null; draw(); return; }
    state.totals = result.data;
    draw();
  }

  // ----------------------------- Cart --------------------------------------

  function addProduct(product, quantityMilli = 1000) {
    if (product.status !== 'active') {
      toast.error(`"${product.name}" is archived and cannot be sold.`);
      return;
    }
    const existing = state.items.find((item) => item.productId === product.id);
    const scanBehaviour = ctx.settings['pos.scan_behaviour'] || 'increment';

    if (existing && scanBehaviour === 'increment') {
      existing.quantityMilli += quantityMilli;
      existing.flash = true;
    } else if (existing) {
      existing.flash = true;
    } else {
      state.items.push({
        productId: product.id,
        product,
        quantityMilli,
        unitPricePesewas: product.selling_price_pesewas,
        discount: { type: 'none', value: 0 },
        flash: true
      });
    }

    if (product.stock_milli <= 0) {
      toast.warn(`"${product.name}" shows no stock. The sale will be blocked unless you allow negative stock in Settings.`);
    }
    reprice();
  }

  function removeItem(index) {
    state.items.splice(index, 1);
    reprice();
  }

  function setQuantity(index, milli) {
    if (milli === null || milli <= 0) {
      removeItem(index);
      return;
    }
    state.items[index].quantityMilli = milli;
    reprice();
  }

  function clearCart({ silent = false } = {}) {
    state.items = [];
    state.discount = { type: 'none', value: 0 };
    state.customer = null;
    state.tenderedPesewas = null;
    state.paymentMethod = 'cash';
    state.totals = null;
    if (!silent) toast.info('Cart cleared.');
    draw();
  }

  // --------------------------- Barcode scan --------------------------------

  async function handleScan(rawValue) {
    const code = String(rawValue || '').trim();
    if (!code) return;

    const result = await tryCall('pos', 'scanBarcode', { barcode: code }, { silent: true });
    if (result.ok && result.data.found) {
      addProduct(result.data.product);
      return;
    }
    unknownBarcodeDialog(code);
  }

  function unknownBarcodeDialog(code) {
    const instance = openModal({
      title: 'Product not found',
      size: 'narrow',
      body: el('div', [
        el('p', 'No product in your catalogue carries this barcode:'),
        el('div.callout.warn.mono', code),
        el('p.mt-16.muted.text-sm', 'What would you like to do?')
      ]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn', {
          type: 'button',
          onclick: () => { instance.close(null); openProductSearch(code); }
        }, 'Search manually'),
        ctx.can('products.manage')
          ? el('button.btn.primary', {
            type: 'button',
            onclick: () => { instance.close(null); quickAddProduct(code); }
          }, 'Add new product')
          : null
      ])
    });
  }

  /** Create a product on the spot without leaving the till. */
  function quickAddProduct(barcode) {
    const nameInput = el('input', { type: 'text', 'data-autofocus': '', placeholder: 'Product name' });
    const priceInput = el('input.amount', { type: 'text', placeholder: '0.00' });
    const costInput = el('input.amount', { type: 'text', placeholder: '0.00' });
    const stockInput = el('input.qty', { type: 'text', value: '0' });
    const errorNode = el('div.error-text.hidden');

    const save = async (button) => {
      const price = parseMoney(priceInput.value);
      const cost = parseMoney(costInput.value || '0');
      if (nameInput.value.trim().length < 2) return showError('Enter a product name.');
      if (price === null) return showError('Enter a valid selling price.');
      if (cost === null) return showError('Enter a valid cost price.');

      button.disabled = true;
      const result = await tryCall('products', 'create', {
        name: nameInput.value.trim(),
        barcode,
        sellingPrice: moneyInput(price),
        costPrice: moneyInput(cost),
        stock: stockInput.value || '0',
        minStock: '0'
      });
      button.disabled = false;
      if (!result.ok) return;

      toast.success(`"${result.data.name}" added to your catalogue.`);
      instance.close(null);
      addProduct(result.data);
      return undefined;
    };

    const showError = (message) => {
      errorNode.textContent = message;
      errorNode.classList.remove('hidden');
      return undefined;
    };

    const instance = openModal({
      title: 'Add a new product',
      body: el('div', [
        errorNode,
        el('div.callout.info', ['Barcode: ', el('strong.mono', barcode)]),
        el('div.mt-16', field('Product name', nameInput)),
        el('div.form-grid', [
          field('Selling price (₵)', priceInput),
          field('Cost price (₵)', costInput),
          field('Opening stock', stockInput)
        ])
      ]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.primary', { type: 'button', onclick: (event) => save(event.currentTarget) }, 'Add and sell')
      ])
    });
  }

  // --------------------------- Product search ------------------------------

  function openProductSearch(initialTerm = '') {
    const searchInput = el('input', {
      type: 'search', 'data-autofocus': '', value: initialTerm,
      placeholder: 'Type a product name, barcode or SKU…'
    });
    const resultsNode = el('div.search-results');
    let results = [];
    let highlighted = 0;

    const paint = () => {
      mount(resultsNode, results.length === 0
        ? el('div.empty-state', 'No matching products.')
        : results.map((product, index) => el('div.search-result', {
          class: index === highlighted ? 'highlight' : '',
          onclick: () => { instance.close(null); addProduct(product); }
        }, [
          el('div', [
            el('div.r-name', product.name),
            el('div.r-meta', [
              product.barcode ? `${product.barcode} · ` : '',
              product.category_name || 'Uncategorised',
              ` · ${qty(product.stock_milli)} ${product.unit} in stock`
            ].join(''))
          ]),
          el('div.r-price', [
            el('div.p', money(product.selling_price_pesewas)),
            el('div.s', {
              class: product.stock_milli <= 0 ? 'badge-pill danger' : (product.stock_milli <= product.min_stock_milli ? 'badge-pill warn' : 'muted')
            }, product.stock_milli <= 0 ? 'Out of stock' : (product.stock_milli <= product.min_stock_milli ? 'Low' : 'In stock'))
          ])
        ])));
    };

    const search = debounce(async () => {
      const result = await tryCall('products', 'quickSearch', { term: searchInput.value, limit: 25 }, { silent: true });
      results = result.ok ? result.data : [];
      highlighted = 0;
      paint();
    }, 160);

    searchInput.addEventListener('input', search);
    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); highlighted = Math.min(results.length - 1, highlighted + 1); paint(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); highlighted = Math.max(0, highlighted - 1); paint(); }
      else if (event.key === 'Enter') {
        event.preventDefault();
        const product = results[highlighted];
        if (product) { instance.close(null); addProduct(product); }
      }
    });

    const instance = openModal({
      title: 'Find a product',
      size: 'wide',
      body: el('div', [
        el('div.field', searchInput),
        el('div.text-sm.muted.mb-8', 'Use ↑ ↓ to move and Enter to add to the cart.'),
        resultsNode
      ]),
      onClose: () => { if (scanInput) scanInput.focus(); }
    });

    search();
  }

  // --------------------------- Customer picker -----------------------------

  function openCustomerPicker() {
    const searchInput = el('input', { type: 'search', 'data-autofocus': '', placeholder: 'Name or phone number…' });
    const resultsNode = el('div.search-results');

    const paint = (customers) => {
      mount(resultsNode, [
        el('div.search-result', {
          onclick: () => { state.customer = null; instance.close(null); draw(); }
        }, [el('div', [el('div.r-name', 'Walk-in customer'), el('div.r-meta', 'No account attached to this sale')])]),
        ...customers.map((customer) => el('div.search-result', {
          onclick: () => { state.customer = customer; instance.close(null); draw(); }
        }, [
          el('div', [
            el('div.r-name', customer.name),
            el('div.r-meta', customer.phone || 'No phone number')
          ]),
          el('div.r-price', customer.balance_pesewas > 0
            ? el('span.badge-pill.danger', `Owes ${money(customer.balance_pesewas)}`)
            : el('span.badge-pill.ok', 'No debt'))
        ]))
      ]);
    };

    const search = debounce(async () => {
      const result = await tryCall('customers', 'quickSearch', { term: searchInput.value, limit: 25 }, { silent: true });
      paint(result.ok ? result.data : []);
    }, 160);

    searchInput.addEventListener('input', search);

    const instance = openModal({
      title: 'Choose a customer',
      size: 'wide',
      body: el('div', [
        el('div.row', [
          el('div.grow', searchInput),
          ctx.can('customers.manage')
            ? el('button.btn', { type: 'button', onclick: () => { instance.close(null); newCustomerDialog(); } }, '+ New customer')
            : null
        ]),
        el('div.mt-16', resultsNode)
      ]),
      onClose: () => { if (scanInput) scanInput.focus(); }
    });

    search();
  }

  function newCustomerDialog() {
    const nameInput = el('input', { type: 'text', 'data-autofocus': '', placeholder: 'Customer name' });
    const phoneInput = el('input', { type: 'tel', placeholder: '024 000 0000' });
    const errorNode = el('div.error-text.hidden');

    const save = async (button) => {
      button.disabled = true;
      const result = await tryCall('customers', 'create', {
        name: nameInput.value, phone: phoneInput.value
      }, { silent: true });
      button.disabled = false;
      if (!result.ok) {
        errorNode.textContent = result.error.message;
        errorNode.classList.remove('hidden');
        return;
      }
      state.customer = result.data;
      toast.success(`${result.data.name} added.`);
      instance.close(null);
      draw();
    };

    const instance = openModal({
      title: 'New customer',
      size: 'narrow',
      body: el('div', [errorNode, field('Name', nameInput), field('Phone number', phoneInput)]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.primary', { type: 'button', onclick: (event) => save(event.currentTarget) }, 'Save')
      ])
    });
  }

  // ------------------------------ Discount ---------------------------------

  function openDiscountDialog() {
    if (!ctx.can('pos.discount')) {
      toast.warn('You do not have permission to apply discounts.');
      return;
    }
    let mode = state.discount.type === 'percent' ? 'percent' : 'amount';
    const valueInput = el('input.amount', {
      type: 'text',
      value: state.discount.type === 'percent'
        ? String(state.discount.value)
        : (state.discount.type === 'amount' ? moneyInput(state.discount.value) : '')
    });
    const errorNode = el('div.error-text.hidden');

    const modeButtons = el('div.btn-group', [
      el('button.btn', { type: 'button', class: mode === 'amount' ? 'active' : '', onclick: (e) => switchMode('amount', e) }, 'Fixed amount (₵)'),
      el('button.btn', { type: 'button', class: mode === 'percent' ? 'active' : '', onclick: (e) => switchMode('percent', e) }, 'Percentage (%)')
    ]);

    function switchMode(next, event) {
      mode = next;
      modeButtons.querySelectorAll('.btn').forEach((b) => b.classList.remove('active'));
      event.currentTarget.classList.add('active');
    }

    const apply = () => {
      const raw = valueInput.value.trim();
      if (raw === '') {
        state.discount = { type: 'none', value: 0 };
      } else if (mode === 'percent') {
        const pct = Number(raw);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
          errorNode.textContent = 'Enter a percentage between 0 and 100.';
          errorNode.classList.remove('hidden');
          return;
        }
        state.discount = { type: 'percent', value: raw };
      } else {
        const amount = parseMoney(raw);
        if (amount === null) {
          errorNode.textContent = 'Enter a valid amount, for example 5.00.';
          errorNode.classList.remove('hidden');
          return;
        }
        state.discount = { type: 'amount', value: amount };
      }
      instance.close(null);
      reprice();
    };

    const instance = openModal({
      title: 'Sale discount',
      size: 'narrow',
      body: el('div', [
        errorNode,
        el('div.field', [el('label', 'Discount type'), modeButtons]),
        field('Value', valueInput, { help: 'Leave empty to remove the discount.' })
      ]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.primary', { type: 'button', onclick: apply }, 'Apply discount')
      ]),
      onClose: () => { if (scanInput) scanInput.focus(); }
    });
    setTimeout(() => valueInput.focus(), 30);
  }

  function lineDiscountDialog(index) {
    if (!ctx.can('pos.discount')) {
      toast.warn('You do not have permission to apply discounts.');
      return;
    }
    const item = state.items[index];
    const valueInput = el('input.amount', {
      type: 'text', 'data-autofocus': '',
      value: item.discount.type === 'amount' ? moneyInput(item.discount.value) : ''
    });

    const instance = openModal({
      title: `Discount — ${item.product.name}`,
      size: 'narrow',
      body: el('div', [
        field('Discount amount (₵)', valueInput, { help: 'Applies to this line only. Leave empty to remove.' })
      ]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.primary', {
          type: 'button',
          onclick: () => {
            const raw = valueInput.value.trim();
            if (raw === '') item.discount = { type: 'none', value: 0 };
            else {
              const amount = parseMoney(raw);
              if (amount === null) { toast.error('Enter a valid amount.'); return; }
              item.discount = { type: 'amount', value: amount };
            }
            instance.close(null);
            reprice();
          }
        }, 'Apply')
      ]),
      onClose: () => { if (scanInput) scanInput.focus(); }
    });
  }

  // ------------------------------ Held sales -------------------------------

  async function holdSale() {
    if (state.items.length === 0) { toast.warn('There is nothing in the cart to hold.'); return; }
    const label = state.customer ? state.customer.name : `Counter ${new Date().toLocaleTimeString('en-GB')}`;
    const result = await tryCall('pos', 'hold', {
      label,
      customerId: state.customer ? state.customer.id : null,
      cart: {
        items: state.items.map((item) => ({
          productId: item.productId,
          quantity: qtyExact(item.quantityMilli),
          unitPrice: moneyInput(item.unitPricePesewas),
          discount: item.discount
        })),
        discount: state.discount
      }
    });
    if (!result.ok) return;
    toast.success(`Sale held as "${label}".`);
    clearCart({ silent: true });
  }

  async function openHeldSales() {
    const result = await tryCall('pos', 'listHeld');
    if (!result.ok) return;
    const held = result.data;

    const instance = openModal({
      title: 'Held sales',
      size: 'wide',
      body: held.length === 0
        ? el('div.empty-state', [el('div.title', 'No held sales'), el('div', 'Press F4 while serving to hold a cart.')])
        : el('div.search-results', held.map((row) => el('div.search-result', [
          el('div', [
            el('div.r-name', row.label),
            el('div.r-meta', `${row.item_count} item${row.item_count === 1 ? '' : 's'} · ${dateTime(row.created_at)}${row.customer_name ? ` · ${row.customer_name}` : ''}`)
          ]),
          el('div.r-price', [el('div.p', money(row.total_pesewas))]),
          el('div.row.gap-4', { style: { marginLeft: '12px' } }, [
            el('button.btn.sm.primary', {
              type: 'button',
              onclick: async () => {
                if (state.items.length > 0) {
                  const ok = await confirmModal({
                    title: 'Replace the current cart?',
                    message: 'Resuming this held sale will replace what is in the cart now.',
                    confirmLabel: 'Replace'
                  });
                  if (!ok) return;
                }
                const resumed = await tryCall('pos', 'resumeHeld', { id: row.id });
                if (!resumed.ok) return;
                await loadCart(resumed.data.cart, resumed.data.customerId);
                instance.close(null);
                toast.success('Held sale resumed.');
              }
            }, 'Resume'),
            el('button.btn.sm.danger', {
              type: 'button',
              onclick: async () => {
                const ok = await confirmModal({
                  title: 'Delete held sale',
                  message: `Delete "${row.label}"?`,
                  confirmLabel: 'Delete', tone: 'danger'
                });
                if (!ok) return;
                await tryCall('pos', 'deleteHeld', { id: row.id });
                instance.close(null);
                openHeldSales();
              }
            }, 'Delete')
          ])
        ]))),
      onClose: () => { if (scanInput) scanInput.focus(); }
    });
  }

  async function loadCart(cart, customerId) {
    state.items = [];
    for (const item of (cart.items || [])) {
      const result = await tryCall('products', 'get', { id: item.productId }, { silent: true });
      if (!result.ok) continue;
      state.items.push({
        productId: item.productId,
        product: result.data,
        quantityMilli: parseQty(String(item.quantity)) ?? 1000,
        unitPricePesewas: parseMoney(String(item.unitPrice)) ?? result.data.selling_price_pesewas,
        discount: item.discount || { type: 'none', value: 0 }
      });
    }
    state.discount = cart.discount || { type: 'none', value: 0 };
    if (customerId) {
      const customer = await tryCall('customers', 'get', { id: customerId }, { silent: true });
      state.customer = customer.ok ? customer.data : null;
    }
    reprice();
  }

  // ------------------------------- Payment ---------------------------------

  function tenderState() {
    const total = state.totals ? state.totals.total : 0;
    const tendered = state.tenderedPesewas === null ? 0 : state.tenderedPesewas;
    if (state.paymentMethod === 'credit') {
      return { total, tendered, change: 0, shortfall: Math.max(0, total - tendered), isCredit: true };
    }
    return {
      total,
      tendered,
      change: Math.max(0, tendered - total),
      shortfall: Math.max(0, total - tendered),
      isCredit: false
    };
  }

  function canComplete() {
    if (state.items.length === 0 || !state.totals || state.committing) return false;
    const { total, tendered, shortfall, isCredit } = tenderState();
    if (total <= 0) return false;
    if (isCredit) return !!state.customer;
    if (state.paymentMethod === 'cash') return tendered >= total;
    return tendered === total || state.tenderedPesewas === null;
  }

  async function completeSale(button) {
    if (state.committing) return;
    const { total } = tenderState();

    if (state.paymentMethod === 'credit' && !state.customer) {
      toast.error('Select the customer this credit sale belongs to.');
      return;
    }

    state.committing = true;
    button.disabled = true;
    button.textContent = 'Completing…';

    const payload = {
      items: state.items.map((item) => ({
        productId: item.productId,
        quantity: qtyExact(item.quantityMilli),
        unitPrice: moneyInput(item.unitPricePesewas),
        discount: item.discount
      })),
      discount: state.discount,
      customerId: state.customer ? state.customer.id : null,
      paymentMethod: state.paymentMethod,
      amountReceived: moneyInput(state.tenderedPesewas === null ? total : state.tenderedPesewas),
      clientRef: `pos-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    };

    const result = await tryCall('pos', 'completeSale', payload);
    state.committing = false;

    if (!result.ok) {
      button.disabled = false;
      button.textContent = 'Complete Sale';
      draw();
      return;
    }

    const sale = result.data;
    state.lastSale = sale;
    toast.success(`${sale.sale.invoice_no} completed — ${money(sale.sale.total_pesewas)}`);
    clearCart({ silent: true });
    ctx.refreshBadges();

    const receiptSettings = await tryCall('settings', 'receipt', undefined, { silent: true });
    if (receiptSettings.ok && receiptSettings.data.autoPrint) {
      tryCall('print', 'receipt', { saleId: sale.sale.id, silent: true }, { silent: true });
    }
    showSaleComplete(sale);
  }

  function showSaleComplete(sale) {
    const change = sale.sale.change_pesewas;
    const debt = sale.sale.debt_pesewas;

    const instance = openModal({
      title: 'Sale completed',
      size: 'narrow',
      body: el('div', [
        el('div.callout.success', [
          el('div.strong', sale.sale.invoice_no),
          el('div', `Total ${money(sale.sale.total_pesewas)} · ${paymentLabel(sale.sale.payment_method)}`)
        ]),
        change > 0
          ? el('div.change-box.mt-16', [el('span.strong', 'CHANGE DUE'), el('span.v', money(change))])
          : null,
        debt > 0
          ? el('div.callout.warn.mt-16', `Balance owed: ${money(debt)}${sale.sale.customer_name ? ` by ${sale.sale.customer_name}` : ''}`)
          : null
      ]),
      footer: () => el('div.row', [
        el('button.btn', {
          type: 'button',
          onclick: async () => {
            const preview = await tryCall('print', 'previewReceipt', { saleId: sale.sale.id });
            if (preview.ok) showReceiptPreview(preview.data.html, sale.sale.id);
          }
        }, 'Preview receipt'),
        el('button.btn.primary', {
          type: 'button', 'data-autofocus': '',
          onclick: async (event) => {
            event.currentTarget.disabled = true;
            await tryCall('print', 'receipt', { saleId: sale.sale.id });
            instance.close(null);
          }
        }, [icon('print', { size: 16 }), 'Print receipt']),
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Next customer')
      ]),
      onClose: () => { if (scanInput) scanInput.focus(); }
    });
  }

  function showReceiptPreview(html, saleId) {
    const frame = el('iframe.receipt-preview', {
      srcdoc: html, sandbox: 'allow-same-origin', title: 'Receipt preview'
    });
    const instance = openModal({
      title: 'Receipt preview',
      body: el('div', frame),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Close'),
        el('button.btn.primary', {
          type: 'button',
          onclick: async () => { await tryCall('print', 'receipt', { saleId }); instance.close(null); }
        }, [icon('print', { size: 16 }), 'Print'])
      ])
    });
  }

  // -------------------------------- Drawing --------------------------------

  function cartTable() {
    if (state.items.length === 0) {
      return el('div.pos-empty', [
        el('div.big', icon('pos', { size: 46, stroke: 1.3 })),
        el('div.strong', 'Scan a barcode to begin'),
        el('div.muted', 'The scan box is always focused — just scan.'),
        el('div.muted.mt-8', [
          'Or press ', el('kbd', 'F2'), ' to search for a product by name.'
        ])
      ]);
    }

    const rows = state.items.map((item, index) => {
      const lineTotals = state.totals && state.totals.lines[index] ? state.totals.lines[index] : null;
      const qtyInput = el('input.qty', {
        type: 'text',
        value: qtyExact(item.quantityMilli),
        onchange: (event) => {
          const parsed = parseQty(event.target.value);
          if (parsed === null) { toast.error('Enter a valid quantity.'); event.target.value = qtyExact(item.quantityMilli); return; }
          setQuantity(index, parsed);
        }
      });

      const priceInput = el('input.price-input', {
        type: 'text',
        value: moneyInput(item.unitPricePesewas),
        disabled: !ctx.can('pos.discount'),
        onchange: (event) => {
          const parsed = parseMoney(event.target.value);
          if (parsed === null) { toast.error('Enter a valid price.'); event.target.value = moneyInput(item.unitPricePesewas); return; }
          item.unitPricePesewas = parsed;
          reprice();
        }
      });

      const row = el('tr', { class: item.flash ? 'flash' : '' }, [
        el('td', [
          el('div.name', item.product.name),
          el('div.sub', [
            item.product.barcode ? `${item.product.barcode} · ` : '',
            `${qty(item.product.stock_milli)} ${item.product.unit} in stock`
          ].join(''))
        ]),
        el('td', el('div.qty-control', [
          el('button', { type: 'button', title: 'Decrease', onclick: () => setQuantity(index, item.quantityMilli - 1000) }, icon('minus', { size: 15 })),
          qtyInput,
          el('button', { type: 'button', title: 'Increase', onclick: () => setQuantity(index, item.quantityMilli + 1000) }, icon('plus', { size: 15 }))
        ])),
        el('td.right', priceInput),
        el('td.right', el('button.btn.sm.ghost', {
          type: 'button', title: 'Line discount', onclick: () => lineDiscountDialog(index)
        }, lineTotals && lineTotals.totals.discount ? `-${money(lineTotals.totals.discount)}` : '—')),
        el('td.right', el('span.line-total', lineTotals ? money(lineTotals.netLineTotal) : '…')),
        el('td.right', el('button.remove-btn', { type: 'button', title: 'Remove', onclick: () => removeItem(index) }, icon('trash', { size: 16 })))
      ]);
      item.flash = false;
      return row;
    });

    return el('table', [
      el('thead', el('tr', [
        el('th', 'Item'),
        el('th', { style: { width: '150px' } }, 'Quantity'),
        el('th.right', { style: { width: '110px' } }, 'Unit price'),
        el('th.right', { style: { width: '100px' } }, 'Discount'),
        el('th.right', { style: { width: '110px' } }, 'Line total'),
        el('th', { style: { width: '44px' } }, '')
      ])),
      el('tbody', rows)
    ]);
  }

  function panel() {
    const totals = state.totals;
    const { total, tendered, change, shortfall, isCredit } = tenderState();

    const tenderInput = el('input.amount', {
      type: 'text',
      value: state.tenderedPesewas === null ? '' : moneyInput(state.tenderedPesewas),
      placeholder: moneyInput(total),
      oninput: (event) => {
        const parsed = parseMoney(event.target.value);
        state.tenderedPesewas = event.target.value.trim() === '' ? null : parsed;
        updateChangeBox();
      },
      onkeydown: (event) => {
        if (event.key === 'Enter' && canComplete()) {
          const button = container.querySelector('.complete-btn');
          if (button) completeSale(button);
        }
      }
    });

    const changeBox = el('div.change-box');
    function updateChangeBox() {
      const t = tenderState();
      changeBox.className = `change-box${t.shortfall > 0 ? ' short' : ''}`;
      mount(changeBox, [
        el('span.strong', t.isCredit ? 'BALANCE TO DEBT' : (t.shortfall > 0 ? 'STILL DUE' : 'CHANGE')),
        el('span.v', money(t.isCredit ? t.shortfall : (t.shortfall > 0 ? t.shortfall : t.change)))
      ]);
      const completeBtn = container.querySelector('.complete-btn');
      if (completeBtn) completeBtn.disabled = !canComplete();
    }
    updateChangeBox();

    const methodButton = (method, iconName) => el('button.method-btn', {
      type: 'button',
      class: state.paymentMethod === method ? 'active' : '',
      onclick: () => {
        state.paymentMethod = method;
        if (method !== 'cash') state.tenderedPesewas = method === 'credit' ? 0 : null;
        draw();
      }
    }, [el('span.m-icon', icon(iconName, { size: 18 })), el('span', paymentLabel(method))]);

    return el('aside.pos-panel', [
      el('div.panel-section', el('div.customer-row', [
        icon('user', { size: 17, className: 'muted' }),
        el('span.customer-name', state.customer ? state.customer.name : 'Walk-in customer'),
        state.customer && state.customer.balance_pesewas > 0
          ? el('span.customer-debt', `Owes ${money(state.customer.balance_pesewas)}`)
          : null,
        el('button.btn.sm', { type: 'button', onclick: openCustomerPicker }, state.customer ? 'Change' : 'Select'),
        state.customer
          ? el('button.btn.sm.ghost.icon-only', { type: 'button', title: 'Remove customer', onclick: () => { state.customer = null; draw(); } }, icon('close', { size: 15 }))
          : null
      ])),

      el('div.panel-scroll', [
        el('div.panel-section', el('div.totals-list', [
          el('div.line', [el('span.k', 'Items'), el('span.v', String(state.items.length))]),
          el('div.line', [el('span.k', 'Subtotal'), el('span.v', money(totals ? totals.subtotal : 0))]),
          el('div.line.discount', [
            el('span.k', [
              'Discount ',
              el('button.btn.sm.ghost', { type: 'button', onclick: openDiscountDialog }, 'edit')
            ]),
            el('span.v', totals && totals.totalDiscount ? `-${money(totals.totalDiscount)}` : money(0))
          ]),
          el('div.grand', [el('span.k', 'Total'), el('span.v', money(total))])
        ])),

        el('div.panel-section', [
          el('div.field', [el('label', 'Payment method')]),
          el('div.method-grid', [
            methodButton('cash', 'cash'),
            methodButton('momo', 'momo'),
            methodButton('card', 'card'),
            methodButton('credit', 'credit')
          ])
        ]),

        el('div.panel-section', [
          el('div.field.tender-input', [
            el('label', isCredit ? 'Deposit paid now (₵)' : 'Amount received (₵)'),
            tenderInput
          ]),
          state.paymentMethod === 'cash'
            ? el('div.quick-cash', [
              el('button', { type: 'button', onclick: () => { state.tenderedPesewas = total; draw(); } }, 'Exact'),
              ...QUICK_CASH.map((amount) => el('button', {
                type: 'button',
                onclick: () => { state.tenderedPesewas = (state.tenderedPesewas || 0) + amount; draw(); }
              }, `+${money(amount, { symbol: false })}`))
            ])
            : null,
          changeBox,
          isCredit && !state.customer
            ? el('div.callout.warn.mt-8', 'Select a customer before completing a credit sale.')
            : null
        ])
      ]),

      el('div.pos-actions', [
        el('button.btn.primary.block.complete-btn', {
          type: 'button',
          disabled: !canComplete(),
          onclick: (event) => completeSale(event.currentTarget)
        }, 'Complete Sale'),
        el('div.secondary-row', [
          el('button.btn.sm', { type: 'button', onclick: holdSale }, 'Hold (F4)'),
          el('button.btn.sm', { type: 'button', onclick: openHeldSales }, 'Held (F6)'),
          el('button.btn.sm.danger', {
            type: 'button',
            disabled: state.items.length === 0,
            onclick: async () => {
              const ok = await confirmModal({
                title: 'Clear the cart',
                message: 'Remove every item from this sale?',
                confirmLabel: 'Clear', tone: 'danger'
              });
              if (ok) clearCart();
            }
          }, 'Clear (F8)')
        ])
      ])
    ]);
  }

  function draw() {
    const focusWasScan = document.activeElement === scanInput;
    const previousScanValue = scanInput ? scanInput.value : '';

    scanInput = el('input', {
      type: 'text',
      placeholder: 'Scan barcode or type a code and press Enter…',
      autocomplete: 'off',
      value: previousScanValue,
      onkeydown: (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const value = event.target.value;
        event.target.value = '';
        handleScan(value);
      }
    });

    mount(container,
      el('div.pos-main', [
        el('div.pos-scan', [
          el('div.scan-field', [el('span.scan-icon', icon('barcode', { size: 18 })), scanInput]),
          el('button.btn', { type: 'button', onclick: () => openProductSearch() }, [icon('search', { size: 15 }), 'Search (F2)']),
          el('button.btn', { type: 'button', onclick: openCustomerPicker }, [icon('user', { size: 15 }), 'Customer (F3)']),
          state.lastSale
            ? el('button.btn', {
              type: 'button',
              title: 'Reprint the last receipt',
              onclick: () => tryCall('print', 'receipt', { saleId: state.lastSale.sale.id })
            }, [icon('print', { size: 15 }), 'Last receipt'])
            : null
        ]),
        el('div.pos-cart', cartTable()),
        el('div.shortcut-bar', [
          el('span.sc', [el('b', 'F2'), 'Search']),
          el('span.sc', [el('b', 'F3'), 'Customer']),
          el('span.sc', [el('b', 'F4'), 'Hold']),
          el('span.sc', [el('b', 'F5'), 'Payment']),
          el('span.sc', [el('b', 'F6'), 'Held sales']),
          el('span.sc', [el('b', 'F8'), 'Clear']),
          el('span.sc', [el('b', 'Esc'), 'Close dialog'])
        ])
      ]),
      panel()
    );

    if (focusWasScan || !hasOpenModal()) setTimeout(() => scanInput && scanInput.focus(), 0);
  }

  // ------------------------------ Shortcuts --------------------------------

  const onKeyDown = (event) => {
    if (hasOpenModal() && event.key !== 'Escape') return;
    switch (event.key) {
      case 'F2': event.preventDefault(); openProductSearch(); break;
      case 'F3': event.preventDefault(); openCustomerPicker(); break;
      case 'F4': event.preventDefault(); holdSale(); break;
      case 'F5': {
        event.preventDefault();
        const tender = container.querySelector('.tender-input input');
        if (tender) { tender.focus(); tender.select(); }
        break;
      }
      case 'F6': event.preventDefault(); openHeldSales(); break;
      case 'F8': {
        event.preventDefault();
        if (state.items.length > 0) {
          confirmModal({
            title: 'Clear the cart',
            message: 'Remove every item from this sale?',
            confirmLabel: 'Clear', tone: 'danger'
          }).then((ok) => { if (ok) clearCart(); });
        }
        break;
      }
      default: break;
    }
  };
  window.addEventListener('keydown', onKeyDown);

  draw();

  return {
    node: container,
    cleanup: () => window.removeEventListener('keydown', onKeyDown)
  };
}

export const posPage = {
  title: 'Point of Sale',
  subtitle: 'Scan, sell and take payment',
  permission: 'pos.use',
  flush: true,
  render
};
