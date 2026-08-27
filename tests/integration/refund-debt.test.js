'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('../helpers/testDb');

const Money = require('../../src/shared/money');
const products = require('../../src/main/services/product.service');
const customers = require('../../src/main/services/customer.service');
const sales = require('../../src/main/services/sale.service');
const refunds = require('../../src/main/services/refund.service');
const debts = require('../../src/main/services/debt.service');

let ctx; let user; let shirt;

test.beforeEach(() => {
  ctx = createTestDb();
  user = ctx.owner;
  shirt = products.create({
    name: 'Cotton Shirt', costPrice: '30.00', sellingPrice: '50.00', stock: '20', minStock: '2'
  }, { user });
});
test.afterEach(() => ctx.cleanup());

function sellShirts(qty, extra = {}) {
  return sales.complete({
    items: [{ productId: shirt.id, quantity: String(qty) }],
    paymentMethod: 'cash', amountReceived: String(qty * 50),
    ...extra
  }, { user });
}

test('a full refund restocks, reverses revenue and never deletes the sale', () => {
  const sale = sellShirts(2); // ₵100.00
  const result = refunds.create({
    saleId: sale.sale.id,
    items: [{ saleItemId: sale.items[0].id, quantity: '2' }],
    reason: 'Wrong size', method: 'cash', restock: true
  }, { user });

  assert.equal(Money.format(result.refund.amount_pesewas), '₵100.00');
  assert.equal(Money.format(result.refund.cogs_pesewas), '₵60.00');
  assert.match(result.refund.reference_no, /^REF-\d{8}-0001$/);

  const reread = sales.getSale(sale.sale.id);
  assert.equal(reread.sale.status, 'refunded');
  assert.equal(Money.format(reread.sale.total_pesewas), '₵100.00', 'the original sale total is preserved');
  assert.equal(Money.format(reread.sale.refunded_pesewas), '₵100.00');
  assert.equal(products.get(shirt.id).stock_milli, 20000, 'goods returned to stock');
});

test('a partial refund leaves the rest of the sale intact', () => {
  const sale = sellShirts(3); // ₵150.00
  refunds.create({
    saleId: sale.sale.id,
    items: [{ saleItemId: sale.items[0].id, quantity: '1' }],
    reason: 'Customer changed their mind'
  }, { user });

  const reread = sales.getSale(sale.sale.id);
  assert.equal(reread.sale.status, 'partially_refunded');
  assert.equal(Money.format(reread.sale.refunded_pesewas), '₵50.00');
  assert.equal(reread.items[0].refunded_qty_milli, 1000);
  assert.equal(products.get(shirt.id).stock_milli, 18000); // 20 - 3 + 1
});

test('refunding more than remains is refused', () => {
  const sale = sellShirts(2);
  refunds.create({
    saleId: sale.sale.id, items: [{ saleItemId: sale.items[0].id, quantity: '1' }], reason: 'Faulty'
  }, { user });

  assert.throws(() => refunds.create({
    saleId: sale.sale.id, items: [{ saleItemId: sale.items[0].id, quantity: '2' }], reason: 'Again'
  }, { user }), /at most 1/);
});

test('a refund without a reason is refused', () => {
  const sale = sellShirts(1);
  assert.throws(() => refunds.create({
    saleId: sale.sale.id, items: [{ saleItemId: sale.items[0].id, quantity: '1' }], reason: ''
  }, { user }), /reason/);
});

test('a refund can be recorded without returning goods to stock', () => {
  const sale = sellShirts(1);
  refunds.create({
    saleId: sale.sale.id, items: [{ saleItemId: sale.items[0].id, quantity: '1' }],
    reason: 'Damaged in transit', restock: false
  }, { user });
  assert.equal(products.get(shirt.id).stock_milli, 19000, 'damaged goods stay out of stock');
});

test('a refund on a credit sale reduces the debt before any cash moves', () => {
  const customer = customers.create({ name: 'Yaw Boateng', phone: '0200111222' }, { user });
  const sale = sales.complete({
    items: [{ productId: shirt.id, quantity: '4' }],   // ₵200.00
    customerId: customer.id, paymentMethod: 'credit', amountReceived: '50.00'
  }, { user });
  assert.equal(Money.format(customers.get(customer.id).balance_pesewas), '₵150.00');

  refunds.create({
    saleId: sale.sale.id, items: [{ saleItemId: sale.items[0].id, quantity: '2' }],
    reason: 'Returned two shirts', method: 'credit'
  }, { user });

  assert.equal(Money.format(customers.get(customer.id).balance_pesewas), '₵50.00');
  const account = debts.list({ customerId: customer.id, status: 'all' }).rows[0];
  assert.equal(Money.format(account.outstanding_pesewas), '₵50.00');
});

test('a debt is paid down in instalments and each payment is preserved', () => {
  const customer = customers.create({ name: 'Esi Owusu', phone: '0555333444' }, { user });
  sales.complete({
    items: [{ productId: shirt.id, quantity: '10' }],  // ₵500.00
    customerId: customer.id, paymentMethod: 'credit', amountReceived: '0'
  }, { user });

  const account = debts.list({ customerId: customer.id }).rows[0];
  const first = debts.recordPayment({ debtAccountId: account.id, amount: '200.00', method: 'cash' }, { user });
  assert.equal(Money.format(first.outstandingPesewas), '₵300.00');
  assert.equal(first.settled, false);
  assert.match(first.reference, /^DPY-\d{8}-0001$/);

  const second = debts.recordPayment({ debtAccountId: account.id, amount: '100.00', method: 'momo' }, { user });
  assert.equal(Money.format(second.outstandingPesewas), '₵200.00');
  assert.equal(Money.format(customers.get(customer.id).balance_pesewas), '₵200.00');

  const detail = debts.get(account.id);
  assert.equal(detail.payments.length, 2, 'historical payments are never overwritten');
  assert.equal(Money.format(detail.payments[0].amount_pesewas), '₵200.00');

  const final = debts.recordPayment({ debtAccountId: account.id, amount: '200.00' }, { user });
  assert.equal(final.settled, true);
  assert.equal(customers.get(customer.id).balance_pesewas, 0);
  assert.equal(debts.get(account.id).account.status, 'settled');
});

test('overpaying a debt is refused', () => {
  const customer = customers.create({ name: 'Kojo', phone: '0244999888' }, { user });
  sales.complete({
    items: [{ productId: shirt.id, quantity: '2' }],
    customerId: customer.id, paymentMethod: 'credit', amountReceived: '0'
  }, { user });
  const account = debts.list({ customerId: customer.id }).rows[0];
  assert.throws(() => debts.recordPayment({ debtAccountId: account.id, amount: '150.00' }, { user }), /more than the outstanding/);
  assert.throws(() => debts.recordPayment({ debtAccountId: account.id, amount: '0' }, { user }), /greater than zero/);
});

test('a settled debt cannot receive further payments', () => {
  const customer = customers.create({ name: 'Adjoa', phone: '0277000999' }, { user });
  sales.complete({
    items: [{ productId: shirt.id, quantity: '1' }],
    customerId: customer.id, paymentMethod: 'credit', amountReceived: '0'
  }, { user });
  const account = debts.list({ customerId: customer.id }).rows[0];
  debts.recordPayment({ debtAccountId: account.id, amount: '50.00' }, { user });
  assert.throws(() => debts.recordPayment({ debtAccountId: account.id, amount: '10.00' }, { user }), /already been settled/);
});

test('writing off a debt clears the balance and records the reason', () => {
  const customer = customers.create({ name: 'Kwesi', phone: '0201234567' }, { user });
  sales.complete({
    items: [{ productId: shirt.id, quantity: '2' }],
    customerId: customer.id, paymentMethod: 'credit', amountReceived: '0'
  }, { user });
  const account = debts.list({ customerId: customer.id }).rows[0];
  const result = debts.writeOff(account.id, 'Customer relocated, uncollectable', { user });

  assert.equal(Money.format(result.writtenOffPesewas), '₵100.00');
  assert.equal(customers.get(customer.id).balance_pesewas, 0);
  assert.equal(debts.get(account.id).account.status, 'written_off');
});

test('a customer who still owes money cannot be deleted', () => {
  const customer = customers.create({ name: 'Debtor', phone: '0209999999' }, { user });
  sales.complete({
    items: [{ productId: shirt.id, quantity: '1' }],
    customerId: customer.id, paymentMethod: 'credit', amountReceived: '0'
  }, { user });
  assert.throws(() => customers.remove(customer.id, { user }), /still owes ₵50\.00/);
});
