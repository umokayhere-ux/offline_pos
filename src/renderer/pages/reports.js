import { el, mount, downloadText } from '../utils/dom.js';
import { money, qty, percent, dateTime, date, todayKey, paymentLabel } from '../utils/format.js';
import { tryCall } from '../services/api.js';
import { toast } from '../components/toast.js';
import { dataTable } from '../components/table.js';
import { icon } from '../components/icons.js';
import { barChart, lineChart, donutChart, rankedBars } from '../components/charts.js';

/**
 * Reports. Every figure here comes from the same reporting service the dashboard
 * uses, so the two can never disagree. Each report can be exported to CSV or
 * printed through the system print dialog (which is also how a PDF is produced
 * on Windows, via "Microsoft Print to PDF").
 */

const REPORTS = [
  { id: 'sales', label: 'Sales' },
  { id: 'profit', label: 'Profit & Loss' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'expenses', label: 'Expenses' },
  { id: 'debts', label: 'Debts' },
  { id: 'customers', label: 'Customers' },
  { id: 'suppliers', label: 'Suppliers' },
  { id: 'refunds', label: 'Refunds' },
  { id: 'cashiers', label: 'Staff performance' }
];

const PRESETS = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'Last 7 days' },
  { id: 'this_month', label: 'This month' },
  { id: 'month', label: 'Last 30 days' },
  { id: 'year', label: 'This year' },
  { id: 'custom', label: 'Custom range' }
];

async function render(ctx) {
  const state = {
    report: 'sales',
    preset: 'this_month',
    from: todayKey(),
    to: todayKey(),
    rows: [],
    exportKind: 'sales'
  };

  const container = el('div');
  const bodyHost = el('div');
  const customRange = el('div.row.gap-4', { class: 'hidden' }, [
    el('div.field', [el('label', 'From'), el('input', {
      type: 'date', value: state.from, onchange: (event) => { state.from = event.target.value; load(); }
    })]),
    el('div.field', [el('label', 'To'), el('input', {
      type: 'date', value: state.to, onchange: (event) => { state.to = event.target.value; load(); }
    })])
  ]);

  function rangeArgs() {
    if (state.preset === 'custom') return { from: state.from, to: state.to };
    return { preset: state.preset };
  }

  function summaryCards(summary) {
    return el('div.grid.cols-4', [
      el('div.stat', [
        el('div.label', 'Revenue'), el('div.value', money(summary.revenue)),
        el('div.hint', `${summary.saleCount} sale${summary.saleCount === 1 ? '' : 's'}`)
      ]),
      el('div.stat', [
        el('div.label', 'Gross profit'), el('div.value', money(summary.grossProfit)),
        el('div.hint', `Margin ${percent(summary.grossMarginPercent)}`)
      ]),
      el('div.stat', [
        el('div.label', 'Expenses'), el('div.value', money(summary.expenses)),
        el('div.hint', `${summary.expenseCount} entr${summary.expenseCount === 1 ? 'y' : 'ies'}`)
      ]),
      el('div.stat', [
        el('div.label', 'Net profit'),
        el('div.value', { class: summary.netProfit < 0 ? 'negative' : '' }, money(summary.netProfit)),
        el('div.hint', `Margin ${percent(summary.netMarginPercent)}`)
      ])
    ]);
  }

  async function load() {
    customRange.classList.toggle('hidden', state.preset !== 'custom');
    mount(bodyHost, el('div.loading-block', [el('span.spinner'), 'Building report…']));

    const args = rangeArgs();
    let node = null;

    if (state.report === 'sales') {
      const result = await tryCall('reports', 'sales', args);
      if (!result.ok) return;
      const data = result.data;
      state.rows = data.rows;
      state.exportKind = 'sales';

      node = el('div', [
        summaryCards(data.summary),
        el('div.grid.cols-2.mt-16', [
          el('div.card', [
            el('div.card-head', el('h3', 'Daily takings')),
            el('div.card-body', barChart(data.series, [
              { key: 'revenuePesewas', label: 'Revenue', colour: '#1d4ed8' },
              { key: 'grossProfitPesewas', label: 'Gross profit', colour: '#7ea6f7' }
            ]))
          ]),
          el('div.card', [
            el('div.card-head', el('h3', 'By payment method')),
            el('div.card-body', donutChart(data.byPaymentMethod.map((row) => ({
              label: paymentLabel(row.payment_method), value: row.total_pesewas
            }))))
          ])
        ]),
        el('div.card.mt-16', [
          el('div.card-head', el('h3', `Sales in this period (${data.rows.length})`)),
          el('div.card-body.flush', dataTable({
            columns: [
              { label: 'Invoice', render: (row) => el('span.mono.text-sm', row.invoice_no) },
              { label: 'Date', render: (row) => el('span.text-sm', dateTime(row.sold_at)) },
              { label: 'Customer', render: (row) => row.customer_name || 'Walk-in' },
              { label: 'Cashier', render: (row) => el('span.text-sm', row.cashier_name || '') },
              { label: 'Method', render: (row) => paymentLabel(row.payment_method) },
              { label: 'Refunded', align: 'right', render: (row) => (row.refunded_pesewas ? money(row.refunded_pesewas) : '—') },
              { label: 'Total', align: 'right', render: (row) => el('strong.money', money(row.total_pesewas)) }
            ],
            rows: data.rows,
            empty: { title: 'No sales in this period', message: '' }
          }))
        ])
      ]);
    }

    if (state.report === 'profit') {
      const result = await tryCall('reports', 'profit', args);
      if (!result.ok) return;
      const data = result.data;
      state.rows = data.topProducts;
      state.exportKind = null;

      const s = data.summary;
      node = el('div', [
        summaryCards(s),
        el('div.grid.cols-2.mt-16', [
          el('div.card', [
            el('div.card-head', el('h3', 'Profit and loss')),
            el('div.card-body', el('div.detail-list', [
              el('div.item', [el('span.k', 'Gross sales'), el('span.v.money', money(s.grossSales))]),
              el('div.item', [el('span.k', 'Less refunds'), el('span.v.money', `-${money(s.refunds)}`)]),
              el('div.item', [el('span.k.strong', 'Net revenue'), el('span.v.money.strong', money(s.revenue))]),
              el('div.item', [el('span.k', 'Cost of goods sold'), el('span.v.money', `-${money(s.cogs)}`)]),
              el('div.item', [el('span.k.strong', 'Gross profit'), el('span.v.money.strong', money(s.grossProfit))]),
              el('div.item', [el('span.k', 'Operating expenses'), el('span.v.money', `-${money(s.expenses)}`)]),
              el('div.item', [el('span.k.strong', 'NET PROFIT'), el('span.v.money.strong', money(s.netProfit))]),
              el('div.item', [el('span.k', 'Gross margin'), el('span.v', percent(s.grossMarginPercent))]),
              el('div.item', [el('span.k', 'Net margin'), el('span.v', percent(s.netMarginPercent))]),
              el('div.item', [el('span.k', 'Average sale'), el('span.v.money', money(s.averageSalePesewas))])
            ]))
          ]),
          el('div.card', [
            el('div.card-head', el('h3', 'Trend')),
            el('div.card-body', lineChart(data.series, [
              { key: 'grossProfitPesewas', label: 'Gross profit', colour: '#7ea6f7' },
              { key: 'netProfitPesewas', label: 'Net profit', colour: '#bcd2fb' }
            ]))
          ])
        ]),
        el('div.grid.cols-2.mt-16', [
          el('div.card', [
            el('div.card-head', el('h3', 'Most profitable products')),
            el('div.card-body', rankedBars(data.topProducts.slice(0, 10).map((row) => ({
              label: row.product_name, value: row.profit_pesewas,
              hint: `${qty(row.quantity_milli)} ${row.unit} · revenue ${money(row.revenue_pesewas)}`
            }))))
          ]),
          el('div.card', [
            el('div.card-head', el('h3', 'Where the money went')),
            el('div.card-body', donutChart(data.expensesByCategory.map((row) => ({
              label: row.category, value: row.total_pesewas
            }))))
          ])
        ])
      ]);
    }

    if (state.report === 'inventory') {
      const result = await tryCall('reports', 'inventory', {});
      if (!result.ok) return;
      const data = result.data;
      state.rows = data.rows;
      state.exportKind = 'inventory';

      node = el('div', [
        el('div.grid.cols-5', [
          el('div.stat', [el('div.label', 'Products'), el('div.value.sm', String(data.totals.totalProducts))]),
          el('div.stat', [el('div.label', 'Low stock'), el('div.value.sm', String(data.totals.lowStock))]),
          el('div.stat', [el('div.label', 'Out of stock'), el('div.value.sm', String(data.totals.outOfStock))]),
          el('div.stat', [el('div.label', 'Stock value (cost)'), el('div.value.sm', money(data.totals.stockValuePesewas))]),
          el('div.stat', [el('div.label', 'If all sold'), el('div.value.sm', money(data.totals.retailValuePesewas)),
            el('div.hint', `Potential profit ${money(data.totals.potentialProfitPesewas)}`)])
        ]),
        el('div.card.mt-16', [
          el('div.card-head', el('h3', 'Stock on hand')),
          el('div.card-body.flush', dataTable({
            columns: [
              { label: 'Product', render: (row) => el('div', [
                el('div.strong', row.name),
                el('div.text-sm.muted.mono', row.barcode || '')
              ]) },
              { label: 'Category', render: (row) => row.category_name || '—' },
              { label: 'Stock', align: 'right', render: (row) => `${qty(row.stock_milli)} ${row.unit}` },
              { label: 'Reorder at', align: 'right', render: (row) => qty(row.min_stock_milli) },
              { label: 'Cost', align: 'right', render: (row) => money(row.cost_price_pesewas) },
              { label: 'Price', align: 'right', render: (row) => money(row.selling_price_pesewas) },
              { label: 'Stock value', align: 'right', render: (row) => el('strong.money', money(row.stock_value_pesewas)) }
            ],
            rows: data.rows,
            empty: { title: 'No products yet', message: '' }
          }))
        ])
      ]);
    }

    if (state.report === 'expenses') {
      const [listResult, summaryResult] = await Promise.all([
        tryCall('expenses', 'list', { ...periodToTimestamps(args), pageSize: 1000 }),
        tryCall('reports', 'summary', args)
      ]);
      if (!listResult.ok || !summaryResult.ok) return;
      state.rows = listResult.data.rows;
      state.exportKind = 'expenses';

      const byCategory = new Map();
      for (const row of listResult.data.rows) {
        byCategory.set(row.category_name, (byCategory.get(row.category_name) || 0) + row.amount_pesewas);
      }

      node = el('div', [
        el('div.grid.cols-3', [
          el('div.stat', [el('div.label', 'Total expenses'), el('div.value', money(summaryResult.data.expenses))]),
          el('div.stat', [el('div.label', 'Entries'), el('div.value.sm', String(listResult.data.total))]),
          el('div.stat', [el('div.label', 'Share of revenue'), el('div.value.sm',
            percent(summaryResult.data.revenue > 0 ? (summaryResult.data.expenses / summaryResult.data.revenue) * 100 : 0))])
        ]),
        el('div.card.mt-16', [
          el('div.card-head', el('h3', 'By category')),
          el('div.card-body', donutChart([...byCategory.entries()].map(([label, value]) => ({ label, value }))))
        ]),
        el('div.card.mt-16', [
          el('div.card-head', el('h3', 'Expenses in this period')),
          el('div.card-body.flush', dataTable({
            columns: [
              { label: 'Reference', render: (row) => el('span.mono.text-sm', row.reference_no) },
              { label: 'Date', render: (row) => el('span.text-sm', dateTime(row.spent_at)) },
              { label: 'Category', render: (row) => row.category_name },
              { label: 'Description', render: (row) => row.description },
              { label: 'By', render: (row) => el('span.text-sm', row.user_name || '') },
              { label: 'Amount', align: 'right', render: (row) => el('strong.money', money(row.amount_pesewas)) }
            ],
            rows: listResult.data.rows,
            empty: { title: 'No expenses in this period', message: '' }
          }))
        ])
      ]);
    }

    if (state.report === 'debts') {
      const result = await tryCall('reports', 'debts', args);
      if (!result.ok) return;
      const data = result.data;
      state.rows = data.rows;
      state.exportKind = 'debts';

      node = el('div', [
        el('div.grid.cols-4', [
          el('div.stat', [el('div.label', 'Total outstanding'), el('div.value', money(data.totals.outstandingPesewas))]),
          el('div.stat', [el('div.label', 'Collected in period'), el('div.value.sm', money(data.totals.collectedPesewas)),
            el('div.hint', `${data.totals.collectedCount} payment${data.totals.collectedCount === 1 ? '' : 's'}`)]),
          el('div.stat', [el('div.label', 'Credit issued in period'), el('div.value.sm', money(data.totals.issuedPesewas))]),
          el('div.stat', [el('div.label', 'Open accounts'), el('div.value.sm', String(data.rows.length))])
        ]),
        el('div.card.mt-16', [
          el('div.card-head', el('h3', 'Open debt accounts')),
          el('div.card-body.flush', dataTable({
            columns: [
              { label: 'Customer', render: (row) => el('div', [
                el('div.strong', row.customer_name),
                el('div.text-sm.muted', row.customer_phone || '')
              ]) },
              { label: 'Invoice', render: (row) => el('span.mono.text-sm', row.invoice_no || '—') },
              { label: 'Opened', render: (row) => date(row.opened_at) },
              { label: 'Original', align: 'right', render: (row) => money(row.original_pesewas) },
              { label: 'Paid', align: 'right', render: (row) => money(row.paid_pesewas) },
              { label: 'Outstanding', align: 'right', render: (row) => el('strong.money', money(row.outstanding_pesewas)) }
            ],
            rows: data.rows,
            empty: { title: 'No outstanding debts', message: 'Every customer account is settled.' }
          }))
        ])
      ]);
    }

    if (state.report === 'customers') {
      const result = await tryCall('reports', 'customers', args);
      if (!result.ok) return;
      state.rows = result.data.rows;
      state.exportKind = 'customers';

      node = el('div.card', [
        el('div.card-head', el('h3', 'Customers')),
        el('div.card-body.flush', dataTable({
          columns: [
            { label: 'Customer', render: (row) => el('div.strong', row.name) },
            { label: 'Phone', render: (row) => el('span.text-sm', row.phone || '—') },
            { label: 'Purchases', align: 'right', render: (row) => String(row.purchase_count) },
            { label: 'Spent in period', align: 'right', render: (row) => el('strong.money', money(row.spent_pesewas)) },
            { label: 'Owes', align: 'right', render: (row) => (row.balance_pesewas > 0
              ? el('span.badge-pill.danger', money(row.balance_pesewas)) : '—') },
            { label: 'Last purchase', render: (row) => el('span.text-sm', row.last_purchase_at ? date(row.last_purchase_at) : '—') }
          ],
          rows: result.data.rows,
          empty: { title: 'No customers yet', message: '' }
        }))
      ]);
    }

    if (state.report === 'suppliers') {
      const result = await tryCall('reports', 'suppliers');
      if (!result.ok) return;
      state.rows = result.data.rows;
      state.exportKind = 'suppliers';

      node = el('div', [
        el('div.grid.cols-3', [
          el('div.stat', [el('div.label', 'Total purchased'), el('div.value.sm', money(result.data.totals.purchased_pesewas))]),
          el('div.stat', [el('div.label', 'Total paid'), el('div.value.sm', money(result.data.totals.paid_pesewas))]),
          el('div.stat', [el('div.label', 'Still owed'), el('div.value.sm', money(result.data.totals.balance_pesewas))])
        ]),
        el('div.card.mt-16', [
          el('div.card-head', el('h3', 'Suppliers')),
          el('div.card-body.flush', dataTable({
            columns: [
              { label: 'Supplier', render: (row) => el('div', [el('div.strong', row.name), el('div.text-sm.muted', row.company || '')]) },
              { label: 'Phone', render: (row) => el('span.text-sm', row.phone || '—') },
              { label: 'Purchases', align: 'right', render: (row) => String(row.purchase_count) },
              { label: 'Purchased', align: 'right', render: (row) => money(row.purchased_pesewas) },
              { label: 'Paid', align: 'right', render: (row) => money(row.paid_pesewas) },
              { label: 'Balance', align: 'right', render: (row) => el('strong.money', money(row.balance_pesewas)) }
            ],
            rows: result.data.rows,
            empty: { title: 'No suppliers yet', message: '' }
          }))
        ])
      ]);
    }

    if (state.report === 'refunds') {
      const result = await tryCall('refunds', 'list', { ...periodToTimestamps(args), pageSize: 1000 });
      if (!result.ok) return;
      state.rows = result.data.rows;
      state.exportKind = 'refunds';

      node = el('div', [
        el('div.grid.cols-2', [
          el('div.stat', [el('div.label', 'Total refunded'), el('div.value', money((result.data.totals || {}).amount_pesewas || 0))]),
          el('div.stat', [el('div.label', 'Refunds'), el('div.value.sm', String(result.data.total))])
        ]),
        el('div.card.mt-16', [
          el('div.card-head', el('h3', 'Refunds in this period')),
          el('div.card-body.flush', dataTable({
            columns: [
              { label: 'Reference', render: (row) => el('span.mono.text-sm', row.reference_no) },
              { label: 'Invoice', render: (row) => el('span.mono.text-sm', row.invoice_no) },
              { label: 'Date', render: (row) => el('span.text-sm', dateTime(row.refunded_at)) },
              { label: 'Reason', render: (row) => row.reason },
              { label: 'Restocked', render: (row) => (row.restock ? 'Yes' : 'No') },
              { label: 'Amount', align: 'right', render: (row) => el('strong.money', money(row.amount_pesewas)) }
            ],
            rows: result.data.rows,
            empty: { title: 'No refunds in this period', message: '' }
          }))
        ])
      ]);
    }

    if (state.report === 'cashiers') {
      const result = await tryCall('reports', 'cashiers', args);
      if (!result.ok) return;
      state.rows = result.data.rows;
      state.exportKind = 'cashiers';

      node = el('div', [
        el('div.card', [
          el('div.card-head', el('h3', 'Sales by staff member')),
          el('div.card-body', rankedBars(result.data.rows
            .filter((row) => row.sale_count > 0)
            .map((row) => ({
              label: row.full_name, value: row.revenue_pesewas,
              hint: `${row.sale_count} sales · gross profit ${money(row.gross_profit_pesewas)}`
            }))))
        ]),
        el('div.card.mt-16', [
          el('div.card-body.flush', dataTable({
            columns: [
              { label: 'Staff', render: (row) => el('div', [el('div.strong', row.full_name), el('div.text-sm.muted', row.role_label)]) },
              { label: 'Sales', align: 'right', render: (row) => String(row.sale_count) },
              { label: 'Revenue', align: 'right', render: (row) => el('strong.money', money(row.revenue_pesewas)) },
              { label: 'Refunded', align: 'right', render: (row) => money(row.refunded_pesewas) },
              { label: 'Gross profit', align: 'right', render: (row) => money(row.gross_profit_pesewas) },
              { label: 'Credit issued', align: 'right', render: (row) => money(row.credit_pesewas) }
            ],
            rows: result.data.rows,
            empty: { title: 'No staff activity in this period', message: '' }
          }))
        ])
      ]);
    }

    mount(bodyHost, node || el('div.empty-state', 'Select a report.'));
  }

  function periodToTimestamps(args) {
    if (args.from && args.to) {
      return {
        from: new Date(`${args.from}T00:00:00.000Z`).toISOString(),
        to: new Date(new Date(`${args.to}T00:00:00.000Z`).getTime() + 86400000).toISOString()
      };
    }
    const today = todayKey();
    const days = { today: 0, yesterday: 1, week: 6, month: 29, this_month: null, year: null }[args.preset];
    if (args.preset === 'this_month') {
      return {
        from: new Date(`${today.slice(0, 7)}-01T00:00:00.000Z`).toISOString(),
        to: new Date(new Date(`${today}T00:00:00.000Z`).getTime() + 86400000).toISOString()
      };
    }
    if (args.preset === 'year') {
      return {
        from: new Date(`${today.slice(0, 4)}-01-01T00:00:00.000Z`).toISOString(),
        to: new Date(new Date(`${today}T00:00:00.000Z`).getTime() + 86400000).toISOString()
      };
    }
    const end = new Date(`${today}T00:00:00.000Z`).getTime() + (args.preset === 'yesterday' ? 0 : 86400000);
    return {
      from: new Date(new Date(`${today}T00:00:00.000Z`).getTime() - days * 86400000).toISOString(),
      to: new Date(end).toISOString()
    };
  }

  async function exportCsv() {
    if (!state.exportKind) {
      toast.warn('Use the Sales or Inventory report to export this data as a spreadsheet.');
      return;
    }
    const result = await tryCall('reports', 'export', { kind: state.exportKind, rows: state.rows });
    if (!result.ok) return;
    const name = `${state.report}_report_${todayKey()}.csv`;
    const saved = await tryCall('file', 'saveAs', { defaultName: name, content: result.data });
    if (saved.ok && !saved.data.cancelled) toast.success(`Saved to ${saved.data.path}`);
    else if (!saved.ok) downloadText(name, result.data);
  }

  function printReport() {
    const shop = ctx.shop || {};
    const title = REPORTS.find((r) => r.id === state.report).label;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
      <style>
        @page { size: A4; margin: 14mm; }
        body { font-family: "Segoe UI", Arial, sans-serif; font-size: 11px; color: #000; }
        h1 { font-size: 18px; margin: 0 0 2px; }
        .meta { color: #555; font-size: 11px; margin-bottom: 14px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
        th { text-align: left; border-bottom: 1.5px solid #000; padding: 5px 4px; font-size: 10px; text-transform: uppercase; }
        td { padding: 4px; border-bottom: 1px solid #ddd; }
        .right { text-align: right; }
        .stat-row { display: flex; gap: 14px; margin-bottom: 14px; flex-wrap: wrap; }
        .stat-box { border: 1px solid #999; border-radius: 6px; padding: 8px 12px; min-width: 130px; }
        .stat-box .l { font-size: 9px; text-transform: uppercase; color: #555; }
        .stat-box .v { font-size: 16px; font-weight: 700; }
        svg, .chart-legend { display: none; }
      </style></head><body>
      <h1>${escapeHtml(shop.name || 'iTtEk POS')}</h1>
      <div class="meta">${escapeHtml(title)} report · ${escapeHtml(shop.address || '')} ${shop.phone ? `· ${escapeHtml(shop.phone)}` : ''}<br>
      Generated ${escapeHtml(dateTime(new Date().toISOString()))} · All amounts in Ghana Cedis (GHS)</div>
      ${bodyHost.innerHTML.replace(/<button[^>]*>.*?<\/button>/g, '')}
      </body></html>`;

    tryCall('print', 'document', { html });
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  const reportTabs = el('div.btn-group', REPORTS.map((report) => el('button.btn', {
    type: 'button',
    class: report.id === state.report ? 'active' : '',
    onclick: (event) => {
      state.report = report.id;
      reportTabs.querySelectorAll('.btn').forEach((b) => b.classList.remove('active'));
      event.currentTarget.classList.add('active');
      load();
    }
  }, report.label)));

  mount(container,
    el('div.card.mb-16', el('div.card-body', [
      el('div.row.wrap', [reportTabs]),
      el('div.row.wrap.mt-16', [
        el('div.field', { style: { marginBottom: 0 } }, [el('label', 'Period'), el('select', {
          onchange: (event) => { state.preset = event.target.value; load(); }
        }, PRESETS.map((preset) => el('option', {
          value: preset.id, selected: preset.id === state.preset
        }, preset.label)))]),
        customRange,
        el('span.grow'),
        el('button.btn', { type: 'button', onclick: exportCsv }, [icon('download', { size: 15 }), 'Export CSV']),
        el('button.btn', { type: 'button', onclick: printReport }, [icon('print', { size: 15 }), 'Print / Save as PDF'])
      ]),
      el('div.text-sm.muted.mt-8', 'To save a report as PDF, choose “Microsoft Print to PDF” in the print dialog.')
    ])),
    bodyHost);

  await load();
  return container;
}

export const reportsPage = {
  title: 'Reports',
  subtitle: 'Sales, profit, stock and staff',
  permission: 'reports.view',
  render
};
