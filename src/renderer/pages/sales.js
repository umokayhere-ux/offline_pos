import { el, mount, field, debounce } from '../utils/dom.js';
import { money, qty, dateTime, todayKey, paymentLabel } from '../utils/format.js';
import { tryCall } from '../services/api.js';
import { toast } from '../components/toast.js';
import { openModal } from '../components/modal.js';
import { dataTable, pager } from '../components/table.js';

/** Sales history. Sales are never edited or deleted — corrections are refunds. */

async function render(ctx) {
  const state = {
    search: '', from: '', to: '', paymentMethod: '', status: '',
    page: 1, pageSize: 25,
    data: { rows: [], total: 0, pages: 1, page: 1, pageSize: 25, totals: {} }
  };
  const container = el('div');
  const tableHost = el('div.card');
  const summaryHost = el('div.grid.cols-4.mb-16');

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
    const result = await tryCall('sales', 'list', {
      search: state.search, paymentMethod: state.paymentMethod, status: state.status,
      ...rangeParams(), page: state.page, pageSize: state.pageSize
    });
    if (!result.ok) return;
    state.data = result.data;
    paint();
  }

  function paint() {
    const totals = state.data.totals || {};
    const revenue = (totals.total_pesewas || 0) - (totals.refunded_pesewas || 0);
    mount(summaryHost, [
      el('div.stat.accent', [el('div.label', 'Gross sales'), el('div.value.sm', money(totals.total_pesewas || 0))]),
      el('div.stat.red', [el('div.label', 'Refunded'), el('div.value.sm', money(totals.refunded_pesewas || 0))]),
      el('div.stat.green', [el('div.label', 'Net revenue'), el('div.value.sm', money(revenue))]),
      el('div.stat.blue', [
        el('div.label', 'Gross profit'),
        el('div.value.sm', money(revenue - (totals.cogs_pesewas || 0)))
      ])
    ]);

    mount(tableHost, [
      dataTable({
        columns: [
          { label: 'Invoice', render: (row) => el('span.mono.text-sm', row.invoice_no) },
          { label: 'Date', render: (row) => el('span.text-sm', dateTime(row.sold_at)) },
          { label: 'Customer', render: (row) => row.customer_name || el('span.faint', 'Walk-in') },
          { label: 'Served by', render: (row) => el('span.text-sm', row.cashier_name || '') },
          { label: 'Items', align: 'right', render: (row) => String(row.item_count) },
          { label: 'Method', render: (row) => el('span.badge-pill', paymentLabel(row.payment_method)) },
          { label: 'Status', render: (row) => (row.status === 'completed'
            ? el('span.badge-pill.green', 'Completed')
            : el('span.badge-pill.amber', row.status === 'refunded' ? 'Refunded' : 'Part refunded')) },
          { label: 'Total', align: 'right', render: (row) => el('strong.money', money(row.total_pesewas)) },
          { label: 'Owed', align: 'right', render: (row) => (row.debt_pesewas > 0
            ? el('span.badge-pill.red', money(row.debt_pesewas)) : '—') }
        ],
        rows: state.data.rows,
        onRowClick: (row) => detail(row.id),
        empty: {
          title: 'No sales found',
          message: 'Sales completed at the till appear here.',
          action: ctx.can('pos.use')
            ? el('button.btn.primary', { type: 'button', onclick: () => ctx.navigate('pos') }, 'Open the till')
            : null
        }
      }),
      pager({ ...state.data, onPage: (page) => { state.page = page; load(); } })
    ]);
  }

  async function detail(saleId) {
    const result = await tryCall('sales', 'get', { id: saleId });
    if (!result.ok) return;
    const { sale, items, payments, refunds } = result.data;

    const instance = openModal({
      title: sale.invoice_no,
      size: 'xwide',
      body: el('div', [
        el('div.grid.cols-2', [
          el('div.detail-list', [
            el('div.item', [el('span.k', 'Date'), el('span.v', dateTime(sale.sold_at))]),
            el('div.item', [el('span.k', 'Customer'), el('span.v', sale.customer_name || 'Walk-in')]),
            el('div.item', [el('span.k', 'Served by'), el('span.v', sale.cashier_name || '')]),
            el('div.item', [el('span.k', 'Payment'), el('span.v', paymentLabel(sale.payment_method))])
          ]),
          el('div.detail-list', [
            el('div.item', [el('span.k', 'Subtotal'), el('span.v.money', money(sale.subtotal_pesewas))]),
            el('div.item', [el('span.k', 'Discount'), el('span.v.money', money(sale.line_discount_pesewas + sale.sale_discount_pesewas))]),
            el('div.item', [el('span.k.strong', 'Total'), el('span.v.money.strong', money(sale.total_pesewas))]),
            el('div.item', [el('span.k', 'Cost of goods'), el('span.v.money', money(sale.cogs_pesewas))]),
            el('div.item', [el('span.k', 'Gross profit'), el('span.v.money', money(sale.total_pesewas - sale.refunded_pesewas - (sale.cogs_pesewas - sale.refunded_cogs_pesewas)))]),
            sale.change_pesewas > 0 ? el('div.item', [el('span.k', 'Change given'), el('span.v.money', money(sale.change_pesewas))]) : null,
            sale.debt_pesewas > 0 ? el('div.item', [el('span.k', 'Recorded as debt'), el('span.v.money', money(sale.debt_pesewas))]) : null,
            sale.refunded_pesewas > 0 ? el('div.item', [el('span.k', 'Refunded'), el('span.v.money', money(sale.refunded_pesewas))]) : null
          ])
        ]),

        el('h3.mt-24.mb-8', 'Items'),
        dataTable({
          columns: [
            { label: 'Product', render: (row) => el('div', [
              el('div.strong', row.product_name),
              row.barcode ? el('div.text-sm.muted.mono', row.barcode) : null
            ]) },
            { label: 'Quantity', align: 'right', render: (row) => `${qty(row.quantity_milli)} ${row.unit}` },
            { label: 'Unit price', align: 'right', render: (row) => money(row.unit_price_pesewas) },
            { label: 'Cost then', align: 'right', render: (row) => el('span.text-sm.muted', money(row.cost_price_pesewas)) },
            { label: 'Discount', align: 'right', render: (row) => (row.discount_pesewas ? `-${money(row.discount_pesewas)}` : '—') },
            { label: 'Refunded', align: 'right', render: (row) => (row.refunded_qty_milli > 0
              ? el('span.badge-pill.amber', `${qty(row.refunded_qty_milli)} · ${money(row.refunded_pesewas)}`) : '—') },
            { label: 'Line total', align: 'right', render: (row) => el('strong.money', money(row.line_total_pesewas)) }
          ],
          rows: items
        }),

        payments.length > 0 ? el('h3.mt-24.mb-8', 'Payments') : null,
        payments.length > 0 ? dataTable({
          columns: [
            { label: 'Date', render: (row) => el('span.text-sm', dateTime(row.paid_at)) },
            { label: 'Method', render: (row) => paymentLabel(row.method) },
            { label: 'Taken by', render: (row) => el('span.text-sm', row.user_name || '') },
            { label: 'Note', render: (row) => el('span.text-sm.muted', row.note || '') },
            { label: 'Amount', align: 'right', render: (row) => el('strong.money', money(row.amount_pesewas)) }
          ],
          rows: payments
        }) : null,

        refunds.length > 0 ? el('h3.mt-24.mb-8', 'Refunds against this sale') : null,
        refunds.length > 0 ? dataTable({
          columns: [
            { label: 'Reference', render: (row) => el('span.mono.text-sm', row.reference_no) },
            { label: 'Date', render: (row) => el('span.text-sm', dateTime(row.refunded_at)) },
            { label: 'Reason', render: (row) => row.reason },
            { label: 'Restocked', render: (row) => (row.restock ? 'Yes' : 'No') },
            { label: 'Amount', align: 'right', render: (row) => el('strong.money', money(row.amount_pesewas)) }
          ],
          rows: refunds
        }) : null
      ]),
      footer: () => el('div.row', [
        ctx.can('refunds.manage') && sale.status !== 'refunded'
          ? el('button.btn', {
            type: 'button',
            onclick: () => { instance.close(null); ctx.navigate('refunds', { saleId: sale.id }); }
          }, '↩ Refund items')
          : null,
        el('span.grow'),
        el('button.btn', {
          type: 'button',
          onclick: async () => {
            const preview = await tryCall('print', 'previewReceipt', { saleId: sale.id });
            if (!preview.ok) return;
            const frame = el('iframe.receipt-preview', { srcdoc: preview.data.html, sandbox: 'allow-same-origin', title: 'Receipt' });
            const previewModal = openModal({
              title: `Receipt — ${sale.invoice_no}`,
              body: el('div', frame),
              footer: () => el('div.row', [
                el('button.btn', { type: 'button', onclick: () => previewModal.close(null) }, 'Close'),
                el('button.btn.primary', {
                  type: 'button',
                  onclick: async () => { await tryCall('print', 'receipt', { saleId: sale.id }); previewModal.close(null); }
                }, '🖨 Print')
              ])
            });
          }
        }, 'Preview receipt'),
        el('button.btn.primary', {
          type: 'button',
          onclick: async (event) => {
            event.currentTarget.disabled = true;
            const result = await tryCall('print', 'receipt', { saleId: sale.id });
            event.currentTarget.disabled = false;
            if (result.ok && result.data.printed) toast.success('Receipt sent to the printer.');
          }
        }, '🖨 Print receipt'),
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Close')
      ])
    });
  }

  mount(container,
    el('div.filters', [
      el('div.field.wide', [el('label', 'Search'), el('input', {
        type: 'search', placeholder: 'Invoice number, customer name or phone…',
        oninput: debounce((event) => { state.search = event.target.value; state.page = 1; load(); }, 250)
      })]),
      el('div.field', [el('label', 'From'), el('input', {
        type: 'date', onchange: (event) => { state.from = event.target.value; state.page = 1; load(); }
      })]),
      el('div.field', [el('label', 'To'), el('input', {
        type: 'date', onchange: (event) => { state.to = event.target.value; state.page = 1; load(); }
      })]),
      el('div.field', [el('label', 'Payment'), el('select', {
        onchange: (event) => { state.paymentMethod = event.target.value; state.page = 1; load(); }
      }, [
        el('option', { value: '' }, 'All methods'),
        el('option', { value: 'cash' }, 'Cash'),
        el('option', { value: 'momo' }, 'Mobile Money'),
        el('option', { value: 'card' }, 'Card'),
        el('option', { value: 'credit' }, 'Credit / Debt')
      ])]),
      el('div.field', [el('label', 'Status'), el('select', {
        onchange: (event) => { state.status = event.target.value; state.page = 1; load(); }
      }, [
        el('option', { value: '' }, 'All'),
        el('option', { value: 'completed' }, 'Completed'),
        el('option', { value: 'partially_refunded' }, 'Partly refunded'),
        el('option', { value: 'refunded' }, 'Fully refunded')
      ])])
    ]),
    summaryHost, tableHost);

  await load();
  if (ctx.params.openSaleId) detail(ctx.params.openSaleId);
  return container;
}

export const salesPage = {
  title: 'Sales',
  subtitle: 'Every completed transaction',
  permission: null,
  render
};
