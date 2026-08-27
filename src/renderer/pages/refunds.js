import { el, mount, field, debounce } from '../utils/dom.js';
import { money, qty, parseQty, dateTime, todayKey } from '../utils/format.js';
import { tryCall } from '../services/api.js';
import { toast } from '../components/toast.js';
import { openModal } from '../components/modal.js';
import { dataTable, pager } from '../components/table.js';

/**
 * Refunds are reversal transactions: the original sale is never deleted or
 * rewritten, so gross sales, refunds and net revenue stay separately reportable.
 */

async function render(ctx) {
  const state = {
    search: '', from: '', to: '', page: 1, pageSize: 25,
    data: { rows: [], total: 0, pages: 1, page: 1, pageSize: 25, totals: {} }
  };
  const container = el('div');
  const tableHost = el('div.card');

  function rangeParams() {
    if (!state.from && !state.to) return {};
    const from = state.from || '2000-01-01';
    const to = state.to || todayKey();
    return {
      from: new Date(`${from}T00:00:00.000Z`).toISOString(),
      to: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86400000).toISOString()
    };
  }

  async function load() {
    const result = await tryCall('refunds', 'list', {
      search: state.search, ...rangeParams(), page: state.page, pageSize: state.pageSize
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
          { label: 'Original invoice', render: (row) => el('span.mono.text-sm', row.invoice_no) },
          { label: 'Date', render: (row) => el('span.text-sm', dateTime(row.refunded_at)) },
          { label: 'Customer', render: (row) => row.customer_name || el('span.faint', 'Walk-in') },
          { label: 'Reason', render: (row) => el('span.text-sm', row.reason) },
          { label: 'Restocked', render: (row) => (row.restock
            ? el('span.badge-pill.green', 'Yes') : el('span.badge-pill.amber', 'No')) },
          { label: 'Staff', render: (row) => el('span.text-sm', row.user_name || '') },
          { label: 'Amount', align: 'right', render: (row) => el('strong.money', money(row.amount_pesewas)) }
        ],
        rows: state.data.rows,
        onRowClick: (row) => detail(row.id),
        empty: {
          title: 'No refunds recorded',
          message: 'To refund a sale, find it by invoice number and choose the items being returned.',
          action: ctx.can('refunds.manage')
            ? el('button.btn.primary', { type: 'button', onclick: () => findSaleDialog() }, 'Start a refund')
            : null
        },
        footer: state.data.rows.length > 0 ? el('tr', [
          el('td', { colspan: '7' }, 'Total refunded in this view'),
          el('td.right.money', money((state.data.totals || {}).amount_pesewas || 0))
        ]) : null
      }),
      pager({ ...state.data, onPage: (page) => { state.page = page; load(); } })
    ]);
  }

  async function detail(refundId) {
    const result = await tryCall('refunds', 'get', { id: refundId });
    if (!result.ok) return;
    const { refund, items } = result.data;

    const instance = openModal({
      title: refund.reference_no,
      size: 'wide',
      body: el('div', [
        el('div.detail-list', [
          el('div.item', [el('span.k', 'Original invoice'), el('span.v.mono', refund.invoice_no)]),
          el('div.item', [el('span.k', 'Date'), el('span.v', dateTime(refund.refunded_at))]),
          el('div.item', [el('span.k', 'Customer'), el('span.v', refund.customer_name || 'Walk-in')]),
          el('div.item', [el('span.k', 'Handled by'), el('span.v', refund.user_name || '')]),
          el('div.item', [el('span.k', 'Refund method'), el('span.v', refund.method)]),
          el('div.item', [el('span.k', 'Returned to stock'), el('span.v', refund.restock ? 'Yes' : 'No')]),
          el('div.item', [el('span.k', 'Reason'), el('span.v', refund.reason)]),
          el('div.item', [el('span.k.strong', 'Amount refunded'), el('span.v.money.strong', money(refund.amount_pesewas))])
        ]),
        el('h3.mt-24.mb-8', 'Items returned'),
        dataTable({
          columns: [
            { label: 'Product', render: (row) => row.product_name },
            { label: 'Quantity', align: 'right', render: (row) => qty(row.quantity_milli) },
            { label: 'Cost then', align: 'right', render: (row) => el('span.text-sm.muted', money(row.cost_price_pesewas)) },
            { label: 'Refunded', align: 'right', render: (row) => el('strong.money', money(row.amount_pesewas)) }
          ],
          rows: items
        })
      ]),
      footer: () => el('div.row', [
        el('span.grow'),
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Close')
      ])
    });
  }

  /** Step 1 — find the sale being refunded. */
  function findSaleDialog() {
    const invoiceInput = el('input', { type: 'text', 'data-autofocus': '', placeholder: 'e.g. INV-20260827-0001' });
    const errorNode = el('div.error-text.hidden');

    const find = async (button) => {
      const value = invoiceInput.value.trim();
      if (!value) return;
      button.disabled = true;
      const result = await tryCall('sales', 'findByInvoice', { invoiceNo: value }, { silent: true });
      button.disabled = false;
      if (!result.ok) {
        errorNode.textContent = result.error.message;
        errorNode.classList.remove('hidden');
        return;
      }
      instance.close(null);
      refundDialog(result.data.sale.id);
    };

    invoiceInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        find(instance.element.querySelector('.btn.primary'));
      }
    });

    const instance = openModal({
      title: 'Start a refund',
      size: 'narrow',
      body: el('div', [
        errorNode,
        field('Invoice number', invoiceInput, { help: 'It is printed at the top of the customer receipt.' }),
        el('div.callout.info', 'You can also open a sale from the Sales screen and choose “Refund items”.')
      ]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.primary', { type: 'button', onclick: (event) => find(event.currentTarget) }, 'Find sale')
      ])
    });
  }

  /** Step 2 — choose the lines and quantities being returned. */
  async function refundDialog(saleId) {
    const result = await tryCall('refunds', 'refundableLines', { saleId });
    if (!result.ok) return;
    const { sale, lines } = result.data;

    const refundable = lines.filter((line) => line.remainingQtyMilli > 0);
    if (refundable.length === 0) {
      toast.warn('Everything on this sale has already been refunded.');
      return;
    }

    const selections = new Map();
    const totalNode = el('div.stat.red');
    const errorNode = el('div.callout.danger.hidden');
    let restock = true;
    let method = sale.payment_method === 'credit' ? 'credit' : 'cash';
    let reason = '';

    const estimateFor = (line, quantityMilli) => Math.round(
      quantityMilli === line.quantityMilli
        ? line.lineTotalPesewas
        : (line.lineTotalPesewas * quantityMilli) / line.quantityMilli
    );

    const updateTotal = () => {
      let total = 0;
      for (const [id, quantity] of selections) {
        const line = refundable.find((l) => l.saleItemId === id);
        if (line) total += Math.min(estimateFor(line, quantity), line.remainingPesewas);
      }
      mount(totalNode, [
        el('div.label', 'Refund total'),
        el('div.value', money(total)),
        el('div.hint', `${selections.size} line${selections.size === 1 ? '' : 's'} selected`)
      ]);
    };

    const rows = refundable.map((line) => {
      const qtyInput = el('input.qty', {
        type: 'text', value: '', placeholder: qty(line.remainingQtyMilli), disabled: true,
        oninput: (event) => {
          const parsed = parseQty(event.target.value);
          if (parsed === null || parsed <= 0) { selections.delete(line.saleItemId); updateTotal(); return; }
          if (parsed > line.remainingQtyMilli) {
            event.target.value = qty(line.remainingQtyMilli);
            selections.set(line.saleItemId, line.remainingQtyMilli);
          } else {
            selections.set(line.saleItemId, parsed);
          }
          updateTotal();
        }
      });

      const checkbox = el('input', {
        type: 'checkbox',
        onchange: (event) => {
          qtyInput.disabled = !event.target.checked;
          if (event.target.checked) {
            qtyInput.value = qty(line.remainingQtyMilli);
            selections.set(line.saleItemId, line.remainingQtyMilli);
          } else {
            qtyInput.value = '';
            selections.delete(line.saleItemId);
          }
          updateTotal();
        }
      });

      return el('tr', [
        el('td', checkbox),
        el('td', [
          el('div.strong', line.productName),
          el('div.text-sm.muted', `Sold ${qty(line.quantityMilli)} ${line.unit} at ${money(line.unitPricePesewas)}`)
        ]),
        el('td.right', qty(line.remainingQtyMilli)),
        el('td', qtyInput),
        el('td.right', el('span.money', money(line.remainingPesewas)))
      ]);
    });

    updateTotal();

    const save = async (button) => {
      errorNode.classList.add('hidden');
      if (selections.size === 0) {
        errorNode.textContent = 'Choose at least one item to refund.';
        errorNode.classList.remove('hidden');
        return;
      }
      if (reason.trim().length < 3) {
        errorNode.textContent = 'Give a reason for this refund — it is kept with the record.';
        errorNode.classList.remove('hidden');
        return;
      }

      button.disabled = true;
      const response = await tryCall('refunds', 'create', {
        saleId,
        items: [...selections.entries()].map(([saleItemId, quantityMilli]) => ({
          saleItemId, quantity: qty(quantityMilli)
        })),
        reason, method, restock
      }, { silent: true });
      button.disabled = false;

      if (!response.ok) {
        errorNode.textContent = response.error.message;
        errorNode.classList.remove('hidden');
        return;
      }
      toast.success(`Refund ${response.data.refund.reference_no} recorded — ${money(response.data.refund.amount_pesewas)}.`);
      instance.close(null);
      load();
      ctx.refreshBadges();
    };

    const instance = openModal({
      title: `Refund against ${sale.invoice_no}`,
      size: 'xwide',
      closeOnBackdrop: false,
      body: el('div', [
        errorNode,
        el('div.callout.info', `Original sale: ${money(sale.total_pesewas)} on ${dateTime(sale.sold_at)}${sale.refunded_pesewas ? ` · already refunded ${money(sale.refunded_pesewas)}` : ''}`),
        el('table.data.mt-16', [
          el('thead', el('tr', [
            el('th', ''), el('th', 'Item'), el('th.right', 'Refundable'),
            el('th', 'Quantity to refund'), el('th.right', 'Value remaining')
          ])),
          el('tbody', rows)
        ]),
        el('div.grid.cols-3.mt-16', [
          totalNode,
          field('Refund method', el('select', { onchange: (event) => { method = event.target.value; } }, [
            el('option', { value: 'cash', selected: method === 'cash' }, 'Cash back'),
            el('option', { value: 'momo', selected: method === 'momo' }, 'Mobile Money'),
            el('option', { value: 'card', selected: method === 'card' }, 'Card'),
            el('option', { value: 'credit', selected: method === 'credit' }, 'Reduce the customer\'s debt')
          ])),
          el('div.field', [
            el('label', 'Stock'),
            el('label.checkbox', [
              el('input', { type: 'checkbox', checked: true, onchange: (event) => { restock = event.target.checked; } }),
              'Return the goods to stock'
            ]),
            el('div.help', 'Leave unticked for damaged goods that cannot be resold.')
          ])
        ]),
        field('Reason *', el('input', {
          type: 'text', placeholder: 'e.g. Wrong size, customer changed their mind',
          oninput: (event) => { reason = event.target.value; }
        }))
      ]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.danger', { type: 'button', onclick: (event) => save(event.currentTarget) }, 'Process refund')
      ])
    });
  }

  mount(container,
    el('div.filters', [
      el('div.field.wide', [el('label', 'Search'), el('input', {
        type: 'search', placeholder: 'Refund reference, invoice or customer…',
        oninput: debounce((event) => { state.search = event.target.value; state.page = 1; load(); }, 250)
      })]),
      el('div.field', [el('label', 'From'), el('input', {
        type: 'date', onchange: (event) => { state.from = event.target.value; state.page = 1; load(); }
      })]),
      el('div.field', [el('label', 'To'), el('input', {
        type: 'date', onchange: (event) => { state.to = event.target.value; state.page = 1; load(); }
      })]),
      el('span.grow'),
      ctx.can('refunds.manage')
        ? el('button.btn.primary', { type: 'button', onclick: () => findSaleDialog() }, '↩ Start a refund')
        : null
    ]),
    tableHost);

  await load();
  if (ctx.params.saleId) refundDialog(ctx.params.saleId);
  return container;
}

export const refundsPage = {
  title: 'Refunds',
  subtitle: 'Returns and reversals',
  permission: 'refunds.view',
  render
};
