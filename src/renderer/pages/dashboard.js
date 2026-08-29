import { el } from '../utils/dom.js';
import { money, qty, dateTime, percent, paymentLabel } from '../utils/format.js';
import { api } from '../services/api.js';
import { dataTable } from '../components/table.js';
import { barChart, lineChart, donutChart, rankedBars } from '../components/charts.js';

/**
 * Dashboard. Every figure comes from reports.dashboard(), which derives it from
 * the transaction tables — there are no stored running totals anywhere in this
 * application, so these cards cannot drift from the reports.
 */

function stat(label, value, { hint = '', small = false, onClick = null } = {}) {
  return el('div.stat', {
    class: onClick ? 'clickable' : '',
    onclick: onClick
  }, [
    el('div.label', label),
    el('div.value', { class: `${small ? 'sm' : ''} ${typeof value === 'string' && value.startsWith('-') ? 'negative' : ''}`.trim() }, value),
    hint ? el('div.hint', hint) : null
  ]);
}

async function render(ctx) {
  const data = await api.dashboard.load();
  if (data.scoped) return { node: staffView(data, ctx), subtitle: 'Your own work for today' };

  const { today, month, stock, outstanding } = data;

  const topCards = el('div.grid.cols-4', [
    stat("Today's sales", money(today.revenue), {
      hint: `${today.saleCount} sale${today.saleCount === 1 ? '' : 's'}${today.refunds ? ` · ${money(today.refunds)} refunded` : ''}`,
      onClick: () => ctx.navigate('sales')
    }),
    stat("Today's gross profit", money(today.grossProfit), {
      hint: `Margin ${percent(today.grossMarginPercent)}`
    }),
    stat("Today's expenses", money(today.expenses), {
      hint: `${today.expenseCount} entr${today.expenseCount === 1 ? 'y' : 'ies'}`,
      onClick: ctx.can('expenses.view') ? () => ctx.navigate('expenses') : null
    }),
    stat("Today's net profit", money(today.netProfit), {
      hint: 'Gross profit less expenses'
    })
  ]);

  const secondCards = el('div.grid.cols-5.mt-16', [
    stat('Products', String(stock.totalProducts), {
      small: true, hint: `Stock worth ${money(stock.stockValuePesewas)}`,
      onClick: ctx.can('products.view') ? () => ctx.navigate('products') : null
    }),
    stat('Low stock', String(stock.lowStock), {
      small: true, hint: 'At or below reorder level',
      onClick: ctx.can('products.view') ? () => ctx.navigate('products', { stockState: 'low' }) : null
    }),
    stat('Out of stock', String(stock.outOfStock), {
      small: true, hint: 'Nothing left on the shelf',
      onClick: ctx.can('products.view') ? () => ctx.navigate('products', { stockState: 'out' }) : null
    }),
    stat('Customer debts', money(outstanding.customerDebtPesewas), {
      small: true,
      hint: `${outstanding.openDebtCount} open account${outstanding.openDebtCount === 1 ? '' : 's'}`,
      onClick: ctx.can('debts.view') ? () => ctx.navigate('debts') : null
    }),
    stat('Owed to suppliers', money(outstanding.supplierBalancePesewas), {
      small: true, hint: `${outstanding.supplierWithBalanceCount} supplier${outstanding.supplierWithBalanceCount === 1 ? '' : 's'}`,
      onClick: ctx.can('suppliers.view') ? () => ctx.navigate('suppliers') : null
    })
  ]);

  const salesChart = el('div.card', [
    el('div.card-head', [
      el('h2', 'Last 7 days'),
      el('span.grow'),
      el('span.text-sm.muted', `${money(data.weekSeries.reduce((s, d) => s + d.revenuePesewas, 0))} total`)
    ]),
    el('div.card-body', barChart(data.weekSeries, [
      { key: 'revenuePesewas', label: 'Revenue', colour: '#1d4ed8' },
      { key: 'grossProfitPesewas', label: 'Gross profit', colour: '#7ea6f7' },
      { key: 'expensesPesewas', label: 'Expenses', colour: '#172554' }
    ]))
  ]);

  const trendChart = el('div.card', [
    el('div.card-head', [el('h2', 'Profit trend — last 30 days')]),
    el('div.card-body', lineChart(data.monthSeries, [
      { key: 'revenuePesewas', label: 'Revenue', colour: '#1d4ed8' },
      { key: 'netProfitPesewas', label: 'Net profit', colour: '#bcd2fb' }
    ]))
  ]);

  const paymentsCard = el('div.card', [
    el('div.card-head', [el('h3', "Today's payment methods")]),
    el('div.card-body', donutChart((data.paymentMethods || []).map((row) => ({
      label: paymentLabel(row.payment_method), value: row.total_pesewas
    }))))
  ]);

  const expenseCard = el('div.card', [
    el('div.card-head', [el('h3', 'Expenses this month')]),
    el('div.card-body', donutChart((data.expenseCategories || []).map((row) => ({
      label: row.category, value: row.total_pesewas
    }))))
  ]);

  const topProductsCard = el('div.card', [
    el('div.card-head', [el('h3', 'Best sellers this month')]),
    el('div.card-body', rankedBars((data.topProducts || []).map((row) => ({
      label: row.product_name,
      value: row.revenue_pesewas,
      hint: `${qty(row.quantity_milli)} ${row.unit} sold · profit ${money(row.profit_pesewas)}`
    }))))
  ]);

  const lowStockCard = el('div.card', [
    el('div.card-head', [
      el('h3', 'Needs restocking'),
      el('span.grow'),
      ctx.can('products.view')
        ? el('button.btn.sm', { type: 'button', onclick: () => ctx.navigate('products', { stockState: 'low' }) }, 'View all')
        : null
    ]),
    el('div.card-body.flush', dataTable({
      columns: [
        { label: 'Product', render: (row) => el('div', [
          el('div.strong', row.name),
          el('div.text-sm.muted', row.category_name || 'Uncategorised')
        ]) },
        { label: 'In stock', align: 'right', render: (row) => el('span', {
          class: row.stock_milli <= 0 ? 'badge-pill danger' : 'badge-pill warn'
        }, `${qty(row.stock_milli)} ${row.unit}`) },
        { label: 'Reorder at', align: 'right', render: (row) => qty(row.min_stock_milli) }
      ],
      rows: data.lowStockProducts || [],
      empty: { title: 'Stock levels are healthy', message: 'Nothing is at or below its reorder level.' }
    }))
  ]);

  const recentCard = el('div.card', [
    el('div.card-head', [
      el('h3', 'Recent sales'),
      el('span.grow'),
      el('button.btn.sm', { type: 'button', onclick: () => ctx.navigate('sales') }, 'All sales')
    ]),
    el('div.card-body.flush', dataTable({
      columns: [
        { label: 'Invoice', render: (row) => el('span.mono.text-sm', row.invoice_no) },
        { label: 'Time', render: (row) => el('span.text-sm', dateTime(row.sold_at)) },
        { label: 'Customer', render: (row) => row.customer_name || el('span.faint', 'Walk-in') },
        { label: 'Served by', render: (row) => el('span.text-sm', row.cashier_name || '') },
        { label: 'Method', render: (row) => el('span.badge-pill', paymentLabel(row.payment_method)) },
        { label: 'Total', align: 'right', render: (row) => el('strong.money', money(row.total_pesewas)) }
      ],
      rows: data.recentSales || [],
      empty: { title: 'No sales yet today', message: 'Completed sales will appear here.' },
      onRowClick: (row) => ctx.navigate('sales', { openSaleId: row.id })
    }))
  ]);

  const monthCard = el('div.card', [
    el('div.card-head', [el('h3', 'This month so far')]),
    el('div.card-body', el('div.detail-list', [
      el('div.item', [el('span.k', 'Gross sales'), el('span.v.money', money(month.grossSales))]),
      el('div.item', [el('span.k', 'Refunds'), el('span.v.money', `-${money(month.refunds)}`)]),
      el('div.item', [el('span.k', 'Revenue'), el('span.v.money', money(month.revenue))]),
      el('div.item', [el('span.k', 'Cost of goods sold'), el('span.v.money', money(month.cogs))]),
      el('div.item', [el('span.k', 'Gross profit'), el('span.v.money', money(month.grossProfit))]),
      el('div.item', [el('span.k', 'Expenses'), el('span.v.money', money(month.expenses))]),
      el('div.item', [el('span.k.strong', 'Net profit'), el('span.v.money.strong', money(month.netProfit))]),
      el('div.item', [el('span.k', 'Average sale'), el('span.v.money', money(month.averageSalePesewas))])
    ]))
  ]);

  return el('div', [
    topCards,
    secondCards,
    el('div.grid.cols-2.mt-16', [salesChart, trendChart]),
    el('div.grid.cols-3.mt-16', [topProductsCard, paymentsCard, expenseCard]),
    el('div.grid.cols-2.mt-16', [recentCard, lowStockCard]),
    el('div.grid.cols-2.mt-16', [monthCard, el('div')])
  ]);
}

/**
 * What a sales attendant sees: their own takings for today and the stock
 * warnings they need. No shop-wide profit, cost prices, debts or balances —
 * the main process does not even send them.
 */
function staffView(data, ctx) {
  const { today, stock } = data;

  return el('div', [
    el('div.callout.info.mb-16', 'This is your own work for today. Sales made by other staff, and the shop totals, are not shown here.'),

    el('div.grid.cols-4', [
      stat('My sales today', money(today.revenue), {
        hint: `${today.saleCount} sale${today.saleCount === 1 ? '' : 's'}${today.refunds ? ` · ${money(today.refunds)} refunded` : ''}`,
        onClick: () => ctx.navigate('sales')
      }),
      stat('Average sale', money(today.averageSalePesewas), { hint: 'Across your sales today' }),
      stat('Sold on credit', money(today.creditPesewas), { hint: 'Recorded as customer debt' }),
      stat('My expenses today', money(today.expenses), {
        hint: `${today.expenseCount} entr${today.expenseCount === 1 ? 'y' : 'ies'}`
      })
    ]),

    el('div.grid.cols-2.mt-16', [
      el('div.card', [
        el('div.card-head', [el('h3', 'My sales today')]),
        el('div.card-body.flush', dataTable({
          columns: [
            { label: 'Invoice', render: (row) => el('span.mono.text-sm', row.invoice_no) },
            { label: 'Time', render: (row) => el('span.text-sm', dateTime(row.sold_at)) },
            { label: 'Customer', render: (row) => row.customer_name || el('span.faint', 'Walk-in') },
            { label: 'Method', render: (row) => el('span.badge-pill', paymentLabel(row.payment_method)) },
            { label: 'Total', align: 'right', render: (row) => el('strong.money', money(row.total_pesewas)) }
          ],
          rows: data.recentSales || [],
          empty: { title: 'No sales yet today', message: 'Your completed sales will appear here.' }
        }))
      ]),
      el('div.card', [
        el('div.card-head', [el('h3', 'Needs restocking')]),
        el('div.card-body.flush', dataTable({
          columns: [
            { label: 'Product', render: (row) => el('div.strong', row.name) },
            { label: 'In stock', align: 'right', render: (row) => el('span', {
              class: row.stock_milli <= 0 ? 'badge-pill danger' : 'badge-pill warn'
            }, `${qty(row.stock_milli)} ${row.unit}`) }
          ],
          rows: data.lowStockProducts || [],
          empty: { title: 'Stock levels are healthy', message: '' }
        }))
      ])
    ]),

    el('div.grid.cols-2.mt-16', [
      el('div.card', [
        el('div.card-head', [el('h3', 'How you were paid today')]),
        el('div.card-body', donutChart((data.paymentMethods || []).map((row) => ({
          label: paymentLabel(row.payment_method), value: row.total_pesewas
        }))))
      ]),
      el('div')
    ])
  ]);
}

export const dashboardPage = {
  title: 'Dashboard',
  subtitle: 'Live figures from your shop',
  permission: null,
  render
};
