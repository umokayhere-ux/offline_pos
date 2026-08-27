'use strict';

const { getDb } = require('../database/connection');
const Money = require('../../shared/money');
const Calc = require('../../shared/calculation');
const datetime = require('../../shared/datetime');
const settings = require('./settings.service');
const inventory = require('./inventory.service');

/**
 * Reporting — the single source of truth for every figure in the application.
 *
 * The dashboard and the reports screen both call into this module, so a number
 * shown on one can never disagree with the same number on the other. Nothing
 * here keeps a running total of its own: everything is derived from the
 * transaction tables at the moment it is asked for.
 *
 * Demo records (is_demo = 1) are excluded from every financial figure unless
 * explicitly requested, so demo data can never contaminate real accounts.
 */

function tz() {
  return settings.get('app.timezone', 'Africa/Accra');
}

function resolveRange(input = {}) {
  if (input.from && input.to) {
    return datetime.dayRangeToUtc(input.from, input.to, tz());
  }
  return datetime.presetRange(input.preset || 'today', tz());
}

const DEMO_CLAUSE = (includeDemo) => (includeDemo ? '' : 'AND s.is_demo = 0');

/** Gross sales, COGS and refunds for a period, straight from the ledger. */
function salesTotals(range, { includeDemo = false, userId = null } = {}) {
  const db = getDb();
  const params = { start: range.start, end: range.end };
  let userClause = '';
  if (userId) { userClause = 'AND s.user_id = @userId'; params.userId = userId; }

  const sales = db.prepare(`
    SELECT COALESCE(SUM(s.total_pesewas), 0) AS gross_pesewas,
           COALESCE(SUM(s.cogs_pesewas), 0)  AS cogs_pesewas,
           COUNT(*)                          AS sale_count,
           COALESCE(SUM(s.debt_pesewas), 0)  AS credit_pesewas
    FROM sales s
    WHERE s.sold_at >= @start AND s.sold_at < @end ${DEMO_CLAUSE(includeDemo)} ${userClause}
  `).get(params);

  // Refunds are attributed to the day they were given, not the day of the sale.
  const refunds = db.prepare(`
    SELECT COALESCE(SUM(r.amount_pesewas), 0) AS refunds_pesewas,
           COALESCE(SUM(r.cogs_pesewas), 0)   AS refunded_cogs_pesewas,
           COUNT(*)                           AS refund_count
    FROM refunds r JOIN sales s ON s.id = r.sale_id
    WHERE r.refunded_at >= @start AND r.refunded_at < @end ${DEMO_CLAUSE(includeDemo)} ${userClause}
  `).get(params);

  return { ...sales, ...refunds };
}

function expenseTotal(range) {
  return getDb().prepare(`
    SELECT COALESCE(SUM(amount_pesewas), 0) AS total, COUNT(*) AS n
    FROM expenses WHERE status = 'active' AND spent_at >= ? AND spent_at < ?
  `).get(range.start, range.end);
}

/** Revenue, COGS, gross profit, expenses and net profit for a period. */
function summary(input = {}) {
  const range = resolveRange(input);
  const sales = salesTotals(range, input);
  const expenses = expenseTotal(range);

  const figures = Calc.periodSummary({
    grossSalesPesewas: sales.gross_pesewas,
    cogsPesewas: sales.cogs_pesewas,
    refundsPesewas: sales.refunds_pesewas,
    refundedCogsPesewas: sales.refunded_cogs_pesewas,
    expensesPesewas: expenses.total
  });

  return {
    range,
    ...figures,
    saleCount: sales.sale_count,
    refundCount: sales.refund_count,
    expenseCount: expenses.n,
    creditPesewas: sales.credit_pesewas,
    grossMarginPercent: Calc.marginPercent(figures.revenue, figures.grossProfit),
    netMarginPercent: Calc.marginPercent(figures.revenue, figures.netProfit),
    averageSalePesewas: sales.sale_count > 0
      ? Math.round(figures.revenue / sales.sale_count)
      : 0
  };
}

/** Daily buckets for the sales/profit charts. */
function dailySeries(input = {}) {
  const range = resolveRange(input);
  const db = getDb();
  const zone = tz();

  const rows = db.prepare(`
    SELECT s.sold_at, s.total_pesewas, s.cogs_pesewas
    FROM sales s WHERE s.sold_at >= ? AND s.sold_at < ? AND s.is_demo = 0
  `).all(range.start, range.end);

  const refundRows = db.prepare(`
    SELECT r.refunded_at, r.amount_pesewas, r.cogs_pesewas
    FROM refunds r JOIN sales s ON s.id = r.sale_id
    WHERE r.refunded_at >= ? AND r.refunded_at < ? AND s.is_demo = 0
  `).all(range.start, range.end);

  const expenseRows = db.prepare(`
    SELECT spent_at, amount_pesewas FROM expenses
    WHERE status = 'active' AND spent_at >= ? AND spent_at < ?
  `).all(range.start, range.end);

  const buckets = new Map(
    datetime.eachDay(range.fromDay, range.toDay).map((day) => [day, {
      day, salesPesewas: 0, cogsPesewas: 0, refundsPesewas: 0, expensesPesewas: 0, saleCount: 0
    }])
  );

  for (const row of rows) {
    const bucket = buckets.get(datetime.localDayKey(row.sold_at, zone));
    if (!bucket) continue;
    bucket.salesPesewas += row.total_pesewas;
    bucket.cogsPesewas += row.cogs_pesewas;
    bucket.saleCount += 1;
  }
  for (const row of refundRows) {
    const bucket = buckets.get(datetime.localDayKey(row.refunded_at, zone));
    if (!bucket) continue;
    bucket.refundsPesewas += row.amount_pesewas;
    bucket.cogsPesewas -= row.cogs_pesewas;
  }
  for (const row of expenseRows) {
    const bucket = buckets.get(datetime.localDayKey(row.spent_at, zone));
    if (!bucket) continue;
    bucket.expensesPesewas += row.amount_pesewas;
  }

  return [...buckets.values()].map((b) => {
    const revenue = b.salesPesewas - b.refundsPesewas;
    const grossProfit = revenue - b.cogsPesewas;
    return { ...b, revenuePesewas: revenue, grossProfitPesewas: grossProfit, netProfitPesewas: grossProfit - b.expensesPesewas };
  });
}

function topProducts(input = {}, limit = 10) {
  const range = resolveRange(input);
  return getDb().prepare(`
    SELECT si.product_id, si.product_name, si.unit,
           SUM(si.quantity_milli - si.refunded_qty_milli)              AS quantity_milli,
           SUM(si.line_total_pesewas - si.refunded_pesewas)            AS revenue_pesewas,
           SUM((si.quantity_milli - si.refunded_qty_milli) * si.cost_price_pesewas / 1000) AS cogs_pesewas
    FROM sale_items si JOIN sales s ON s.id = si.sale_id
    WHERE s.sold_at >= ? AND s.sold_at < ? AND s.is_demo = 0
    GROUP BY si.product_id, si.product_name, si.unit
    HAVING quantity_milli > 0
    ORDER BY revenue_pesewas DESC
    LIMIT ?
  `).all(range.start, range.end, limit).map((r) => ({
    ...r, profit_pesewas: r.revenue_pesewas - Math.round(r.cogs_pesewas)
  }));
}

function byPaymentMethod(input = {}) {
  const range = resolveRange(input);
  return getDb().prepare(`
    SELECT s.payment_method, COUNT(*) AS n, COALESCE(SUM(s.total_pesewas), 0) AS total_pesewas
    FROM sales s WHERE s.sold_at >= ? AND s.sold_at < ? AND s.is_demo = 0
    GROUP BY s.payment_method ORDER BY total_pesewas DESC
  `).all(range.start, range.end);
}

function expensesByCategory(input = {}) {
  const range = resolveRange(input);
  return getDb().prepare(`
    SELECT ec.name AS category, COUNT(*) AS n, COALESCE(SUM(e.amount_pesewas), 0) AS total_pesewas
    FROM expenses e JOIN expense_categories ec ON ec.id = e.expense_category_id
    WHERE e.status = 'active' AND e.spent_at >= ? AND e.spent_at < ?
    GROUP BY ec.name ORDER BY total_pesewas DESC
  `).all(range.start, range.end);
}

function outstandingTotals() {
  const db = getDb();
  const debt = db.prepare(`
    SELECT COALESCE(SUM(outstanding_pesewas), 0) AS total, COUNT(*) AS n
    FROM debt_accounts WHERE status = 'open'
  `).get();
  const supplier = db.prepare(`
    SELECT COALESCE(SUM(balance_pesewas), 0) AS total,
           SUM(CASE WHEN balance_pesewas > 0 THEN 1 ELSE 0 END) AS n
    FROM suppliers
  `).get();
  const customerCount = db.prepare("SELECT COUNT(*) AS n FROM customers WHERE status = 'active'").get().n;
  return {
    customerDebtPesewas: debt.total,
    openDebtCount: debt.n,
    supplierBalancePesewas: supplier.total,
    supplierWithBalanceCount: supplier.n || 0,
    customerCount
  };
}

/** Everything the dashboard shows, in one call. */
function dashboard() {
  const today = summary({ preset: 'today' });
  const month = summary({ preset: 'this_month' });
  const stock = inventory.stockSummary();
  const outstanding = outstandingTotals();

  return {
    today,
    month,
    stock: {
      totalProducts: stock.total_products || 0,
      lowStock: stock.low_stock || 0,
      outOfStock: stock.out_of_stock || 0,
      stockValuePesewas: Math.round(stock.stock_value_pesewas || 0),
      retailValuePesewas: Math.round(stock.retail_value_pesewas || 0)
    },
    outstanding,
    lowStockProducts: inventory.lowStockProducts(8),
    weekSeries: dailySeries({ preset: 'week' }),
    monthSeries: dailySeries({ preset: 'month' }),
    topProducts: topProducts({ preset: 'month' }, 6),
    paymentMethods: byPaymentMethod({ preset: 'today' }),
    expenseCategories: expensesByCategory({ preset: 'this_month' }),
    recentSales: getDb().prepare(`
      SELECT s.id, s.invoice_no, s.sold_at, s.total_pesewas, s.payment_method, s.status,
             c.name AS customer_name, u.full_name AS cashier_name
      FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.user_id
      WHERE s.is_demo = 0 ORDER BY s.sold_at DESC LIMIT 8
    `).all(),
    generatedAt: datetime.nowIso()
  };
}

// ------------------------------- Reports -----------------------------------

function salesReport(input = {}) {
  const range = resolveRange(input);
  const db = getDb();
  const rows = db.prepare(`
    SELECT s.id, s.invoice_no, s.sold_at, s.total_pesewas, s.cogs_pesewas, s.refunded_pesewas,
           s.paid_pesewas, s.debt_pesewas, s.payment_method, s.status,
           c.name AS customer_name, u.full_name AS cashier_name,
           (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.user_id
    WHERE s.sold_at >= ? AND s.sold_at < ? AND s.is_demo = 0
    ORDER BY s.sold_at DESC
  `).all(range.start, range.end);
  return { range, rows, summary: summary(input), series: dailySeries(input), byPaymentMethod: byPaymentMethod(input) };
}

function profitReport(input = {}) {
  return {
    range: resolveRange(input),
    summary: summary(input),
    series: dailySeries(input),
    topProducts: topProducts(input, 25),
    expensesByCategory: expensesByCategory(input)
  };
}

function inventoryReport({ stockState = '' } = {}) {
  const db = getDb();
  const where = ["p.status = 'active'"];
  if (stockState === 'low') where.push('p.stock_milli > 0 AND p.stock_milli <= p.min_stock_milli');
  if (stockState === 'out') where.push('p.stock_milli <= 0');

  const rows = db.prepare(`
    SELECT p.id, p.name, p.sku, p.barcode, p.unit, p.stock_milli, p.min_stock_milli,
           p.cost_price_pesewas, p.selling_price_pesewas, c.name AS category_name,
           CAST(p.stock_milli * p.cost_price_pesewas / 1000 AS INTEGER) AS stock_value_pesewas,
           CAST(p.stock_milli * p.selling_price_pesewas / 1000 AS INTEGER) AS retail_value_pesewas
    FROM products p LEFT JOIN categories c ON c.id = p.category_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.name
  `).all();

  const totals = inventory.stockSummary();
  return {
    rows,
    totals: {
      totalProducts: totals.total_products || 0,
      lowStock: totals.low_stock || 0,
      outOfStock: totals.out_of_stock || 0,
      stockValuePesewas: Math.round(totals.stock_value_pesewas || 0),
      retailValuePesewas: Math.round(totals.retail_value_pesewas || 0),
      potentialProfitPesewas: Math.round((totals.retail_value_pesewas || 0) - (totals.stock_value_pesewas || 0))
    }
  };
}

function cashierReport(input = {}) {
  const range = resolveRange(input);
  const rows = getDb().prepare(`
    SELECT u.id, u.full_name, r.label AS role_label,
           COUNT(s.id) AS sale_count,
           COALESCE(SUM(s.total_pesewas), 0) AS gross_pesewas,
           COALESCE(SUM(s.refunded_pesewas), 0) AS refunded_pesewas,
           COALESCE(SUM(s.cogs_pesewas), 0) AS cogs_pesewas,
           COALESCE(SUM(s.debt_pesewas), 0) AS credit_pesewas
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN sales s ON s.user_id = u.id AND s.sold_at >= ? AND s.sold_at < ? AND s.is_demo = 0
    GROUP BY u.id ORDER BY gross_pesewas DESC
  `).all(range.start, range.end);

  return {
    range,
    rows: rows.map((r) => {
      const revenue = r.gross_pesewas - r.refunded_pesewas;
      return { ...r, revenue_pesewas: revenue, gross_profit_pesewas: revenue - r.cogs_pesewas };
    })
  };
}

function customerReport(input = {}) {
  const range = resolveRange(input);
  const rows = getDb().prepare(`
    SELECT c.id, c.name, c.phone, c.balance_pesewas,
           COUNT(s.id) AS purchase_count,
           COALESCE(SUM(s.total_pesewas), 0) AS spent_pesewas,
           MAX(s.sold_at) AS last_purchase_at
    FROM customers c
    LEFT JOIN sales s ON s.customer_id = c.id AND s.sold_at >= ? AND s.sold_at < ? AND s.is_demo = 0
    GROUP BY c.id ORDER BY spent_pesewas DESC, c.name
  `).all(range.start, range.end);
  return { range, rows };
}

function supplierReport() {
  const rows = getDb().prepare(`
    SELECT s.id, s.name, s.phone, s.company, s.balance_pesewas,
           COUNT(p.id) AS purchase_count,
           COALESCE(SUM(p.total_pesewas), 0) AS purchased_pesewas,
           COALESCE(SUM(p.paid_pesewas), 0) AS paid_pesewas
    FROM suppliers s LEFT JOIN purchases p ON p.supplier_id = s.id AND p.status = 'received'
    GROUP BY s.id ORDER BY s.balance_pesewas DESC, s.name
  `).all();
  const totals = rows.reduce((acc, r) => ({
    balance_pesewas: acc.balance_pesewas + r.balance_pesewas,
    purchased_pesewas: acc.purchased_pesewas + r.purchased_pesewas,
    paid_pesewas: acc.paid_pesewas + r.paid_pesewas
  }), { balance_pesewas: 0, purchased_pesewas: 0, paid_pesewas: 0 });
  return { rows, totals };
}

function debtReport(input = {}) {
  const range = resolveRange(input);
  const db = getDb();
  const open = db.prepare(`
    SELECT d.*, c.name AS customer_name, c.phone AS customer_phone
    FROM debt_accounts d JOIN customers c ON c.id = d.customer_id
    WHERE d.status = 'open' ORDER BY d.opened_at
  `).all();
  const collected = db.prepare(`
    SELECT COALESCE(SUM(amount_pesewas), 0) AS total, COUNT(*) AS n
    FROM debt_payments WHERE paid_at >= ? AND paid_at < ?
  `).get(range.start, range.end);
  const issued = db.prepare(`
    SELECT COALESCE(SUM(original_pesewas), 0) AS total, COUNT(*) AS n
    FROM debt_accounts WHERE opened_at >= ? AND opened_at < ?
  `).get(range.start, range.end);
  return {
    range,
    rows: open,
    totals: {
      outstandingPesewas: Money.sum(open.map((r) => r.outstanding_pesewas)),
      collectedPesewas: collected.total,
      collectedCount: collected.n,
      issuedPesewas: issued.total,
      issuedCount: issued.n
    }
  };
}

module.exports = {
  resolveRange, summary, dailySeries, topProducts, byPaymentMethod, expensesByCategory,
  outstandingTotals, dashboard, salesReport, profitReport, inventoryReport,
  cashierReport, customerReport, supplierReport, debtReport
};
