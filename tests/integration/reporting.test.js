'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('../helpers/testDb');

const Money = require('../../src/shared/money');
const products = require('../../src/main/services/product.service');
const suppliers = require('../../src/main/services/supplier.service');
const purchases = require('../../src/main/services/purchase.service');
const expenses = require('../../src/main/services/expense.service');
const sales = require('../../src/main/services/sale.service');
const refunds = require('../../src/main/services/refund.service');
const reports = require('../../src/main/services/report.service');

let ctx; let user; let widget;

test.beforeEach(() => {
  ctx = createTestDb();
  user = ctx.owner;
  widget = products.create({
    name: 'Widget', costPrice: '12.00', sellingPrice: '20.00', stock: '100', minStock: '10'
  }, { user });
});
test.afterEach(() => ctx.cleanup());

test("today's profit is derived from sales, COGS, refunds and expenses", () => {
  // Sell 5 @ ₵20 costing ₵12 -> revenue ₵100, COGS ₵60, gross ₵40
  sales.complete({
    items: [{ productId: widget.id, quantity: '5' }], paymentMethod: 'cash', amountReceived: '100.00'
  }, { user });

  const category = expenses.categories().find((c) => c.name === 'Transport');
  expenses.create({ categoryId: category.id, description: 'Trotro to market', amount: '15.00' }, { user });

  const s = reports.summary({ preset: 'today' });
  assert.equal(Money.format(s.revenue), '₵100.00');
  assert.equal(Money.format(s.cogs), '₵60.00');
  assert.equal(Money.format(s.grossProfit), '₵40.00');
  assert.equal(Money.format(s.expenses), '₵15.00');
  assert.equal(Money.format(s.netProfit), '₵25.00');
  assert.equal(s.saleCount, 1);
  assert.equal(s.grossMarginPercent, '40.00');
});

test('a refund reverses both revenue and COGS in the same period', () => {
  const sale = sales.complete({
    items: [{ productId: widget.id, quantity: '5' }], paymentMethod: 'cash', amountReceived: '100.00'
  }, { user });
  refunds.create({
    saleId: sale.sale.id, items: [{ saleItemId: sale.items[0].id, quantity: '2' }], reason: 'Returned'
  }, { user });

  const s = reports.summary({ preset: 'today' });
  assert.equal(Money.format(s.grossSales), '₵100.00');
  assert.equal(Money.format(s.refunds), '₵40.00');
  assert.equal(Money.format(s.revenue), '₵60.00');
  assert.equal(Money.format(s.cogs), '₵36.00');       // 60.00 - 24.00
  assert.equal(Money.format(s.grossProfit), '₵24.00');
});

test('a voided expense stops counting against profit', () => {
  const category = expenses.categories().find((c) => c.name === 'Rent');
  const expense = expenses.create({ categoryId: category.id, description: 'Shop rent', amount: '500.00' }, { user });
  assert.equal(Money.format(reports.summary({ preset: 'today' }).expenses), '₵500.00');

  expenses.voidExpense(expense.id, 'Entered twice by mistake', { user });
  assert.equal(reports.summary({ preset: 'today' }).expenses, 0);
  assert.equal(expenses.get(expense.id).status, 'voided', 'the record itself is preserved');
});

test('the dashboard and the sales report quote the same figures', () => {
  sales.complete({ items: [{ productId: widget.id, quantity: '3' }], paymentMethod: 'cash', amountReceived: '60.00' }, { user });
  sales.complete({ items: [{ productId: widget.id, quantity: '2' }], paymentMethod: 'momo', amountReceived: '40.00' }, { user });

  const dash = reports.dashboard();
  const report = reports.salesReport({ preset: 'today' });

  assert.equal(dash.today.revenue, report.summary.revenue);
  assert.equal(dash.today.netProfit, report.summary.netProfit);
  assert.equal(Money.format(dash.today.revenue), '₵100.00');
  assert.equal(report.rows.length, 2);
  assert.equal(Money.sum(report.rows.map((r) => r.total_pesewas)), dash.today.grossSales);
});

test('sales split by payment method add up to the gross total', () => {
  sales.complete({ items: [{ productId: widget.id, quantity: '1' }], paymentMethod: 'cash', amountReceived: '20.00' }, { user });
  sales.complete({ items: [{ productId: widget.id, quantity: '1' }], paymentMethod: 'momo', amountReceived: '20.00' }, { user });
  sales.complete({ items: [{ productId: widget.id, quantity: '1' }], paymentMethod: 'card', amountReceived: '20.00' }, { user });

  const split = reports.byPaymentMethod({ preset: 'today' });
  assert.equal(split.length, 3);
  assert.equal(Money.format(Money.sum(split.map((r) => r.total_pesewas))), '₵60.00');
});

test('the daily series buckets today and totals to the period revenue', () => {
  sales.complete({ items: [{ productId: widget.id, quantity: '4' }], paymentMethod: 'cash', amountReceived: '80.00' }, { user });
  const series = reports.dailySeries({ preset: 'week' });
  assert.equal(series.length, 7);
  assert.equal(Money.sum(series.map((d) => d.revenuePesewas)), reports.summary({ preset: 'week' }).revenue);
  assert.equal(Money.format(series[series.length - 1].revenuePesewas), '₵80.00');
});

test('top products rank by net revenue and exclude refunded quantity', () => {
  const other = products.create({ name: 'Gadget', costPrice: '2.00', sellingPrice: '5.00', stock: '50' }, { user });
  sales.complete({ items: [{ productId: widget.id, quantity: '2' }], paymentMethod: 'cash', amountReceived: '40.00' }, { user });
  const sale = sales.complete({ items: [{ productId: other.id, quantity: '10' }], paymentMethod: 'cash', amountReceived: '50.00' }, { user });
  refunds.create({ saleId: sale.sale.id, items: [{ saleItemId: sale.items[0].id, quantity: '4' }], reason: 'Returned' }, { user });

  const top = reports.topProducts({ preset: 'today' });
  assert.equal(top[0].product_name, 'Widget');
  assert.equal(Money.format(top[0].revenue_pesewas), '₵40.00');
  const gadget = top.find((t) => t.product_name === 'Gadget');
  assert.equal(Money.format(gadget.revenue_pesewas), '₵30.00'); // 6 remaining x ₵5
});

test('a purchase raises stock, refreshes cost price and the supplier balance', () => {
  const supplier = suppliers.create({ name: 'Accra Wholesale', phone: '0302000000' }, { user });
  const purchase = purchases.create({
    supplierId: supplier.id,
    items: [{ productId: widget.id, quantity: '50', costPrice: '13.00' }],
    amountPaid: '400.00', paymentMethod: 'cash'
  }, { user });

  assert.equal(Money.format(purchase.purchase.total_pesewas), '₵650.00');
  assert.equal(Money.format(purchase.purchase.balance_pesewas), '₵250.00');
  assert.equal(products.get(widget.id).stock_milli, 150000);
  assert.equal(Money.format(products.get(widget.id).cost_price_pesewas), '₵13.00');
  assert.equal(Money.format(suppliers.get(supplier.id).balance_pesewas), '₵250.00');
  assert.match(purchase.purchase.reference_no, /^PUR-\d{8}-0001$/);
});

test('paying a supplier reduces the balance and is refused beyond it', () => {
  const supplier = suppliers.create({ name: 'Kumasi Depot' }, { user });
  purchases.create({
    supplierId: supplier.id, items: [{ productId: widget.id, quantity: '10', costPrice: '10.00' }], amountPaid: '0'
  }, { user });
  assert.equal(Money.format(suppliers.get(supplier.id).balance_pesewas), '₵100.00');

  suppliers.recordPayment({ supplierId: supplier.id, amount: '60.00', method: 'momo' }, { user });
  assert.equal(Money.format(suppliers.get(supplier.id).balance_pesewas), '₵40.00');
  assert.throws(() => suppliers.recordPayment({ supplierId: supplier.id, amount: '100.00' }, { user }), /more than the outstanding/);
});

test('a purchase that names a missing product writes nothing at all', () => {
  const supplier = suppliers.create({ name: 'Ghost Supplier' }, { user });
  assert.throws(() => purchases.create({
    supplierId: supplier.id,
    items: [
      { productId: widget.id, quantity: '5', costPrice: '11.00' },
      { productId: 999999, quantity: '5', costPrice: '11.00' }
    ]
  }, { user }), /no longer exists/);

  assert.equal(products.get(widget.id).stock_milli, 100000);
  assert.equal(suppliers.get(supplier.id).balance_pesewas, 0);
  assert.equal(purchases.list().total, 0);
});

test('the inventory report values stock at cost and at retail', () => {
  const report = reports.inventoryReport();
  assert.equal(Money.format(report.totals.stockValuePesewas), '₵1,200.00');   // 100 x ₵12
  assert.equal(Money.format(report.totals.retailValuePesewas), '₵2,000.00');  // 100 x ₵20
  assert.equal(Money.format(report.totals.potentialProfitPesewas), '₵800.00');
});

test('low stock and out of stock are counted from real quantities', () => {
  products.create({ name: 'Almost gone', sellingPrice: '5.00', costPrice: '2.00', stock: '3', minStock: '10' }, { user });
  products.create({ name: 'Finished', sellingPrice: '5.00', costPrice: '2.00', stock: '0', minStock: '5' }, { user });

  const dash = reports.dashboard();
  assert.equal(dash.stock.lowStock, 1);
  assert.equal(dash.stock.outOfStock, 1);
  assert.equal(dash.stock.totalProducts, 3);
  assert.ok(dash.lowStockProducts.some((p) => p.name === 'Almost gone'));
});

test('the cashier report attributes sales and profit to the user who made them', () => {
  sales.complete({ items: [{ productId: widget.id, quantity: '5' }], paymentMethod: 'cash', amountReceived: '100.00' }, { user });
  const report = reports.cashierReport({ preset: 'today' });
  const row = report.rows.find((r) => r.id === user.id);
  assert.equal(row.sale_count, 1);
  assert.equal(Money.format(row.revenue_pesewas), '₵100.00');
  assert.equal(Money.format(row.gross_profit_pesewas), '₵40.00');
});

test('an empty shop reports zeros rather than failing', () => {
  const s = reports.summary({ preset: 'today' });
  assert.equal(s.revenue, 0);
  assert.equal(s.netProfit, 0);
  assert.equal(s.grossMarginPercent, '0.00');
  assert.doesNotThrow(() => reports.dashboard());
});
