'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('../helpers/testDb');

const Money = require('../../src/shared/money');
const users = require('../../src/main/services/user.service');
const products = require('../../src/main/services/product.service');
const sales = require('../../src/main/services/sale.service');
const expenses = require('../../src/main/services/expense.service');
const reports = require('../../src/main/services/report.service');
const { getDb } = require('../../src/main/database/connection');
const { DEFAULT_ROLE_PERMISSIONS } = require('../../src/shared/constants');

/**
 * A sales attendant sees their own work for today and nothing else: not another
 * cashier's sales, not yesterday's, and not the shop's profit. They also cannot
 * reach Settings, so they cannot change their own password — an owner resets it
 * on the Users screen.
 */

let ctx;
let owner;
let attendant;
let widget;

test.beforeEach(() => {
  ctx = createTestDb();
  owner = ctx.owner;
  attendant = users.create(
    { username: 'ama', fullName: 'Ama Mensah', password: 'ama12345', role: 'attendant' },
    { user: owner }
  );
  widget = products.create(
    { name: 'Widget', costPrice: '12.00', sellingPrice: '20.00', stock: '500', minStock: '5' },
    { user: owner }
  );
});

test.afterEach(() => ctx.cleanup());

function sell(byUser, quantity) {
  return sales.complete({
    items: [{ productId: widget.id, quantity: String(quantity) }],
    paymentMethod: 'cash', amountReceived: String(quantity * 20)
  }, { user: byUser });
}

/** Backdate a sale so "today only" can be tested. */
function backdate(saleId, isoDate) {
  getDb().prepare('UPDATE sales SET sold_at = ? WHERE id = ?').run(isoDate, saleId);
}

test('an attendant lists only their own sales, and only for today', () => {
  const mine = sell(attendant, 2);
  sell(owner, 5);                                   // another cashier's sale
  const yesterday = sell(attendant, 1);
  backdate(yesterday.sale.id, '2020-01-01T10:00:00.000Z');

  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).toISOString();
  const end = new Date(new Date(start).getTime() + 86400000).toISOString();

  const scoped = sales.list({ userId: attendant.id, from: start, to: end });
  assert.equal(scoped.total, 1, 'own sales, today only');
  assert.equal(scoped.rows[0].invoice_no, mine.sale.invoice_no);

  assert.equal(sales.list().total, 3, 'the owner still sees everything');
});

test('the staff dashboard shows only that person\'s takings', () => {
  sell(attendant, 3);      // ₵60.00
  sell(owner, 10);         // ₵200.00 — must not appear

  const view = reports.staffDashboard(attendant.id);
  assert.equal(view.scoped, true);
  assert.equal(Money.format(view.today.revenue), '₵60.00');
  assert.equal(view.today.saleCount, 1);
  assert.equal(view.recentSales.length, 1);
});

test('the staff dashboard never reveals profit or cost prices', () => {
  sell(attendant, 3);
  const view = reports.staffDashboard(attendant.id);

  const serialised = JSON.stringify(view);
  assert.equal(view.today.grossProfit, undefined);
  assert.equal(view.today.netProfit, undefined);
  assert.equal(view.today.cogs, undefined);
  assert.doesNotMatch(serialised, /cogs|grossProfit|netProfit/i);
  assert.equal(view.outstanding, undefined, 'no shop-wide debts or supplier balances');
  assert.equal(view.stock.stockValuePesewas, undefined, 'no stock valuation');
});

test('an attendant sees only their own expenses for today', () => {
  const category = expenses.categories()[0];
  expenses.create({ categoryId: category.id, description: 'Trotro fare', amount: '15.00' }, { user: attendant });
  expenses.create({ categoryId: category.id, description: 'Owner purchase', amount: '900.00' }, { user: owner });

  const scoped = expenses.list({ userId: attendant.id });
  assert.equal(scoped.total, 1);
  assert.equal(Money.format(scoped.totals.amount_pesewas), '₵15.00');
  assert.equal(expenses.list().total, 2, 'the owner still sees both');
});

test('an attendant holds none of the permissions that open Settings', () => {
  const granted = users.get(attendant.id).permissions;
  assert.ok(!granted.includes('settings.manage'), 'cannot open Settings, so cannot change their own password');
  assert.ok(!granted.includes('users.manage'));
  assert.ok(!granted.includes('reports.view'), 'cannot see shop-wide profit');
  assert.ok(!granted.includes('backup.manage'));
  assert.ok(granted.includes('pos.use'), 'but can still work the till');
});

test('the shipped attendant role matches what the application enforces', () => {
  // The seeded role and the declared default must not drift apart.
  assert.deepEqual(
    [...users.get(attendant.id).permissions].sort(),
    [...DEFAULT_ROLE_PERMISSIONS.attendant].sort()
  );
});

test('an owner can still reset an attendant password', () => {
  assert.equal(users.setPassword(attendant.id, 'newpass123', { user: owner }), true);
  assert.doesNotThrow(() => users.authenticate('ama', 'newpass123'));
});
