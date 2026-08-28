import { el, mount, field, debounce } from '../utils/dom.js';
import { money, moneyInput, parseMoney, qty, parseQty, dateTime, todayKey } from '../utils/format.js';
import { tryCall } from '../services/api.js';
import { toast } from '../components/toast.js';
import { openModal } from '../components/modal.js';
import { icon } from '../components/icons.js';
import { dataTable, pager } from '../components/table.js';

/** Purchases / restocking. Recording one raises stock and the supplier balance. */

async function render(ctx) {
  const state = {
    search: '', supplierId: ctx.params.supplierId || '', unpaidOnly: false,
    page: 1, pageSize: 25,
    data: { rows: [], total: 0, pages: 1, page: 1, pageSize: 25, totals: {} },
    suppliers: []
  };
  const container = el('div');
  const tableHost = el('div.card');

  const suppliersResult = await tryCall('suppliers', 'list', { pageSize: 500 }, { silent: true });
  state.suppliers = suppliersResult.ok ? suppliersResult.data.rows : [];

  async function load() {
    const result = await tryCall('purchases', 'list', {
      search: state.search, supplierId: state.supplierId || null,
      unpaidOnly: state.unpaidOnly, page: state.page, pageSize: state.pageSize
    });
    if (!result.ok) return;
    state.data = result.data;
    paint();
  }

  function paint() {
    mount(tableHost, [
      dataTable({
        columns: [
          { label: 'Reference', render: (row) => el('span.mono.text-sm', row.reference_no) },
          { label: 'Date', render: (row) => el('span.text-sm', dateTime(row.purchased_at)) },
          { label: 'Supplier', render: (row) => el('div.strong', row.supplier_name) },
          { label: 'Items', align: 'right', render: (row) => String(row.item_count) },
          { label: 'Total', align: 'right', render: (row) => el('strong.money', money(row.total_pesewas)) },
          { label: 'Paid', align: 'right', render: (row) => el('span.money', money(row.paid_pesewas)) },
          { label: 'Balance', align: 'right', render: (row) => (row.balance_pesewas > 0
            ? el('span.badge-pill.warn', money(row.balance_pesewas))
            : el('span.badge-pill.ok', 'Paid')) },
          { label: 'Recorded by', render: (row) => el('span.text-sm', row.user_name || '') }
        ],
        rows: state.data.rows,
        onRowClick: (row) => detail(row),
        empty: {
          title: 'No purchases recorded yet',
          message: 'Record a purchase when stock arrives — it raises your stock levels and updates what you owe the supplier.',
          action: ctx.can('purchases.manage')
            ? el('button.btn.primary', { type: 'button', onclick: () => purchaseForm() }, '+ Record purchase')
            : null
        },
        footer: state.data.rows.length > 0 ? el('tr', [
          el('td', { colspan: '4' }, 'Totals for this page'),
          el('td.right.money', money(state.data.totals.total_pesewas || 0)),
          el('td.right.money', money(state.data.totals.paid_pesewas || 0)),
          el('td.right.money', money(state.data.totals.balance_pesewas || 0)),
          el('td', '')
        ]) : null
      }),
      pager({ ...state.data, onPage: (page) => { state.page = page; load(); } })
    ]);
  }

  async function detail(purchase) {
    const result = await tryCall('purchases', 'get', { id: purchase.id });
    if (!result.ok) return;
    const { purchase: head, items, payments } = result.data;

    const instance = openModal({
      title: head.reference_no,
      size: 'wide',
      body: el('div', [
        el('div.detail-list', [
          el('div.item', [el('span.k', 'Supplier'), el('span.v', head.supplier_name)]),
          el('div.item', [el('span.k', 'Date'), el('span.v', dateTime(head.purchased_at))]),
          el('div.item', [el('span.k', 'Recorded by'), el('span.v', head.user_name || '')]),
          el('div.item', [el('span.k', 'Total'), el('span.v.money', money(head.total_pesewas))]),
          el('div.item', [el('span.k', 'Paid'), el('span.v.money', money(head.paid_pesewas))]),
          el('div.item', [el('span.k', 'Balance'), el('span.v.money', money(head.balance_pesewas))])
        ]),
        head.note ? el('div.callout.info.mt-16', head.note) : null,
        el('h3.mt-24.mb-8', 'Items received'),
        dataTable({
          columns: [
            { label: 'Product', render: (row) => row.product_name },
            { label: 'Quantity', align: 'right', render: (row) => qty(row.quantity_milli) },
            { label: 'Unit cost', align: 'right', render: (row) => money(row.cost_price_pesewas) },
            { label: 'Line total', align: 'right', render: (row) => el('strong.money', money(row.line_total_pesewas)) }
          ],
          rows: items
        }),
        payments.length > 0 ? el('h3.mt-24.mb-8', 'Payments against this purchase') : null,
        payments.length > 0 ? dataTable({
          columns: [
            { label: 'Reference', render: (row) => el('span.mono.text-sm', row.reference_no) },
            { label: 'Date', render: (row) => el('span.text-sm', dateTime(row.paid_at)) },
            { label: 'Method', render: (row) => row.method },
            { label: 'Amount', align: 'right', render: (row) => el('strong.money', money(row.amount_pesewas)) }
          ],
          rows: payments
        }) : null
      ]),
      footer: () => el('div.row', [
        el('span.grow'),
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Close')
      ])
    });
  }

  /** New purchase: pick a supplier, add lines, record what was paid. */
  function purchaseForm() {
    const lines = [];
    let supplierId = state.supplierId || '';
    let paymentMethod = 'cash';
    let amountPaid = '';
    let note = '';

    const linesHost = el('div');
    const totalNode = el('div.stat');
    const errorNode = el('div.callout.danger.hidden');
    const paidInput = el('input.amount', { type: 'text', placeholder: '0.00', oninput: (e) => { amountPaid = e.target.value; repaint(); } });

    function computedTotal() {
      return lines.reduce((sum, line) => {
        const quantity = parseQty(line.quantity);
        const cost = parseMoney(line.costPrice);
        if (quantity === null || cost === null) return sum;
        return sum + Math.round((cost * quantity) / 1000);
      }, 0);
    }

    function repaint() {
      const total = computedTotal();
      const paid = parseMoney(amountPaid || '0') ?? 0;
      mount(totalNode, [
        el('div.label', 'Purchase total'),
        el('div.value', money(total)),
        el('div.hint', `Paid ${money(Math.min(paid, total))} · Balance ${money(Math.max(0, total - paid))}`)
      ]);
      paintLines();
    }

    function paintLines() {
      mount(linesHost, lines.length === 0
        ? el('div.empty-state', 'Add the products that arrived.')
        : el('table.data', [
          el('thead', el('tr', [
            el('th', 'Product'), el('th', 'Quantity'), el('th.right', 'Unit cost (₵)'),
            el('th.right', 'Line total'), el('th', '')
          ])),
          el('tbody', lines.map((line, index) => {
            const quantity = parseQty(line.quantity);
            const cost = parseMoney(line.costPrice);
            const lineTotal = quantity !== null && cost !== null ? Math.round((cost * quantity) / 1000) : null;
            return el('tr', [
              el('td', [
                el('div.strong', line.product.name),
                el('div.text-sm.muted', `Currently ${qty(line.product.stock_milli)} ${line.product.unit} in stock`)
              ]),
              el('td', el('input.qty', {
                type: 'text', value: line.quantity,
                oninput: (event) => { line.quantity = event.target.value; repaint(); }
              })),
              el('td.right', el('input.amount', {
                type: 'text', value: line.costPrice,
                oninput: (event) => { line.costPrice = event.target.value; repaint(); }
              })),
              el('td.right', el('strong.money', lineTotal === null ? '—' : money(lineTotal))),
              el('td.right', el('button.btn.sm.danger', {
                type: 'button', onclick: () => { lines.splice(index, 1); repaint(); }
              }, icon('trash', { size: 15 })))
            ]);
          }))
        ]));
    }

    function addProductPicker() {
      const searchInput = el('input', { type: 'search', 'data-autofocus': '', placeholder: 'Search products…' });
      const resultsNode = el('div.search-results');

      const search = debounce(async () => {
        const result = await tryCall('products', 'quickSearch', { term: searchInput.value, limit: 25 }, { silent: true });
        mount(resultsNode, (result.ok ? result.data : []).map((product) => el('div.search-result', {
          onclick: () => {
            lines.push({
              product, productId: product.id, quantity: '1',
              costPrice: moneyInput(product.cost_price_pesewas)
            });
            picker.close(null);
            repaint();
          }
        }, [
          el('div', [
            el('div.r-name', product.name),
            el('div.r-meta', `${qty(product.stock_milli)} ${product.unit} in stock · last cost ${money(product.cost_price_pesewas)}`)
          ])
        ])));
      }, 160);

      searchInput.addEventListener('input', search);
      const picker = openModal({
        title: 'Add a product to this purchase',
        size: 'wide',
        body: el('div', [el('div.field', searchInput), resultsNode])
      });
      search();
    }

    const save = async (button) => {
      errorNode.classList.add('hidden');
      if (!supplierId) {
        errorNode.textContent = 'Choose the supplier this stock came from.';
        errorNode.classList.remove('hidden');
        return;
      }
      if (lines.length === 0) {
        errorNode.textContent = 'Add at least one product.';
        errorNode.classList.remove('hidden');
        return;
      }

      button.disabled = true;
      const result = await tryCall('purchases', 'create', {
        supplierId: Number(supplierId),
        items: lines.map((line) => ({
          productId: line.productId, quantity: line.quantity,
          costPrice: line.costPrice, updateCostPrice: true
        })),
        amountPaid: amountPaid || '0',
        paymentMethod,
        note
      }, { silent: true });
      button.disabled = false;

      if (!result.ok) {
        errorNode.textContent = result.error.message;
        errorNode.classList.remove('hidden');
        return;
      }
      toast.success(`${result.data.purchase.reference_no} recorded. Stock updated.`);
      instance.close(null);
      load();
      ctx.refreshBadges();
    };

    const instance = openModal({
      title: 'Record a purchase',
      size: 'xwide',
      closeOnBackdrop: false,
      body: el('div', [
        errorNode,
        el('div.form-grid', [
          field('Supplier *', el('select', { onchange: (event) => { supplierId = event.target.value; } }, [
            el('option', { value: '' }, 'Choose a supplier…'),
            ...state.suppliers.map((s) => el('option', {
              value: String(s.id), selected: String(supplierId) === String(s.id)
            }, s.name))
          ])),
          field('Note', el('input', { type: 'text', placeholder: 'Delivery note number, driver…', oninput: (e) => { note = e.target.value; } }))
        ]),
        el('div.row.mt-8', [
          el('h3', 'Items'),
          el('span.grow'),
          el('button.btn.sm.primary', { type: 'button', onclick: addProductPicker }, '+ Add product')
        ]),
        el('div.mt-8', linesHost),
        el('div.grid.cols-3.mt-16', [
          totalNode,
          field('Amount paid now (₵)', paidInput),
          field('Payment method', el('select', { onchange: (event) => { paymentMethod = event.target.value; } }, [
            el('option', { value: 'cash' }, 'Cash'),
            el('option', { value: 'momo' }, 'Mobile Money'),
            el('option', { value: 'card' }, 'Card')
          ]))
        ]),
        el('div.callout.info.mt-8', 'Anything left unpaid is added to the supplier\'s outstanding balance. Cost prices on these products are updated so future profit figures use the new cost.')
      ]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.primary', { type: 'button', onclick: (event) => save(event.currentTarget) }, 'Record purchase')
      ])
    });

    repaint();
  }

  mount(container,
    el('div.filters', [
      el('div.field.wide', [el('label', 'Search'), el('input', {
        type: 'search', placeholder: 'Reference or supplier…',
        oninput: debounce((event) => { state.search = event.target.value; state.page = 1; load(); }, 250)
      })]),
      el('div.field', [el('label', 'Supplier'), el('select', {
        onchange: (event) => { state.supplierId = event.target.value; state.page = 1; load(); }
      }, [
        el('option', { value: '' }, 'All suppliers'),
        ...state.suppliers.map((s) => el('option', {
          value: String(s.id), selected: String(state.supplierId) === String(s.id)
        }, s.name))
      ])]),
      el('div.field', [el('label', 'Show'), el('select', {
        onchange: (event) => { state.unpaidOnly = event.target.value === 'unpaid'; state.page = 1; load(); }
      }, [
        el('option', { value: 'all' }, 'All purchases'),
        el('option', { value: 'unpaid' }, 'Only with a balance')
      ])]),
      el('span.grow'),
      ctx.can('purchases.manage')
        ? el('button.btn.primary', { type: 'button', onclick: purchaseForm }, '+ Record purchase')
        : null
    ]),
    tableHost);

  await load();
  return container;
}

export const purchasesPage = {
  title: 'Purchases',
  subtitle: 'Stock received from suppliers',
  permission: 'purchases.view',
  render
};
