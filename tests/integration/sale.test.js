'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('../helpers/testDb');

const Money = require('../../src/shared/money');
const products = require('../../src/main/services/product.service');
const categories = require('../../src/main/services/category.service');
const customers = require('../../src/main/services/customer.service');
const sales = require('../../src/main/services/sale.service');
const inventory = require('../../src/main/services/inventory.service');

let ctx;
let user;
let rice;
let soap;

test.beforeEach(() => {
  ctx = createTestDb();
  user = ctx.owner;
  const category = categories.create({ name: 'Groceries' }, { user });
  rice = products.create({
    name: 'Perfumed Rice 5kg', barcode: '6001234567890', categoryId: category.id,
    costPrice: '35.00', sellingPrice: '50.00', stock: '20', minStock: '5', unit: 'Box'
  }, { user });
  soap = products.create({
    name: 'Key Soap', barcode: '6009876543210', categoryId: category.id,
    costPrice: '4.50', sellingPrice: '7.00', stock: '100', minStock: '10', unit: 'Piece'
  }, { user });
});

test.afterEach(() => ctx.cleanup());

test('a cash sale decrements stock, records a payment and logs a movement', () => {
  const result = sales.complete({
    items: [{ productId: rice.id, quantity: '2' }, { productId: soap.id, quantity: '3' }],
    paymentMethod: 'cash',
    amountReceived: '150.00'
  }, { user });

  // 2 x 50.00 + 3 x 7.00 = 121.00; ₵150 tendered -> ₵29.00 change
  assert.equal(Money.format(result.sale.total_pesewas), '₵121.00');
  assert.equal(Money.format(result.sale.change_pesewas), '₵29.00');
  assert.equal(result.sale.debt_pesewas, 0);
  assert.match(result.sale.invoice_no, /^INV-\d{8}-0001$/);

  assert.equal(products.get(rice.id).stock_milli, 18000);
  assert.equal(products.get(soap.id).stock_milli, 97000);

  assert.equal(result.payments.length, 1);
  assert.equal(Money.format(result.payments[0].amount_pesewas), '₵121.00');

  const moves = inventory.movements({ productId: rice.id }).rows;
  assert.equal(moves[0].reason, 'sale');
  assert.equal(moves[0].change_milli, -2000);
  assert.equal(moves[0].after_milli, 18000);
});

test('cost price is snapshotted, so raising the cost later cannot rewrite history', () => {
  const result = sales.complete({
    items: [{ productId: rice.id, quantity: '5' }], paymentMethod: 'cash', amountReceived: '250.00'
  }, { user });
  assert.equal(Money.format(result.sale.cogs_pesewas), '₵175.00'); // 5 x 35.00

  products.update(rice.id, {
    name: rice.name, barcode: rice.barcode, costPrice: '40.00',
    sellingPrice: '50.00', minStock: '5', unit: 'Box'
  }, { user });

  const reread = sales.getSale(result.sale.id);
  assert.equal(Money.format(reread.sale.cogs_pesewas), '₵175.00');
  assert.equal(Money.format(reread.items[0].cost_price_pesewas), '₵35.00');
});

test('fractional quantities are sold and stocked exactly', () => {
  const sugar = products.create({
    name: 'Sugar', costPrice: '8.00', sellingPrice: '12.00', stock: '10', unit: 'Kg', minStock: '1'
  }, { user });

  const result = sales.complete({
    items: [{ productId: sugar.id, quantity: '0.75' }], paymentMethod: 'cash', amountReceived: '10.00'
  }, { user });

  assert.equal(Money.format(result.sale.total_pesewas), '₵9.00');   // 12.00 x 0.75
  assert.equal(Money.format(result.sale.cogs_pesewas), '₵6.00');    // 8.00 x 0.75
  assert.equal(Money.format(result.sale.change_pesewas), '₵1.00');
  assert.equal(products.get(sugar.id).stock_milli, 9250);
});

test('a percentage discount is stored, allocated to lines and reconciles exactly', () => {
  const result = sales.complete({
    items: [{ productId: rice.id, quantity: '1' }, { productId: soap.id, quantity: '1' }],
    discount: { type: 'percent', value: 10 },
    paymentMethod: 'cash', amountReceived: '60.00'
  }, { user });

  assert.equal(Money.format(result.sale.subtotal_pesewas), '₵57.00');
  assert.equal(Money.format(result.sale.sale_discount_pesewas), '₵5.70');
  assert.equal(Money.format(result.sale.total_pesewas), '₵51.30');

  const lineSum = Money.sum(result.items.map((i) => i.line_total_pesewas));
  assert.equal(lineSum, result.sale.total_pesewas, 'stored line totals must reconcile to the sale total');
});

test('an underpaid cash sale is rejected and changes nothing', () => {
  assert.throws(
    () => sales.complete({
      items: [{ productId: rice.id, quantity: '1' }], paymentMethod: 'cash', amountReceived: '20.00'
    }, { user }),
    /less than the total/
  );
  assert.equal(products.get(rice.id).stock_milli, 20000, 'stock must be untouched');
  assert.equal(sales.list().total, 0, 'no sale may have been written');
});

test('selling more than is in stock is refused and rolls back completely', () => {
  assert.throws(
    () => sales.complete({
      items: [{ productId: soap.id, quantity: '2' }, { productId: rice.id, quantity: '999' }],
      paymentMethod: 'cash', amountReceived: '99999.00'
    }, { user }),
    /Not enough stock/
  );
  assert.equal(products.get(soap.id).stock_milli, 100000, 'the first line must have rolled back too');
  assert.equal(sales.list().total, 0);
});

test('two cart lines of the same product are checked against the joint quantity', () => {
  assert.throws(
    () => sales.complete({
      items: [{ productId: rice.id, quantity: '15' }, { productId: rice.id, quantity: '10' }],
      paymentMethod: 'cash', amountReceived: '5000.00'
    }, { user }),
    /Not enough stock/
  );
});

test('a credit sale opens a debt account and raises the customer balance', () => {
  const customer = customers.create({ name: 'Ama Mensah', phone: '0244000111' }, { user });
  const result = sales.complete({
    items: [{ productId: rice.id, quantity: '10' }],   // ₵500.00
    customerId: customer.id, paymentMethod: 'credit', amountReceived: '200.00'
  }, { user });

  assert.equal(Money.format(result.sale.total_pesewas), '₵500.00');
  assert.equal(Money.format(result.sale.paid_pesewas), '₵200.00');
  assert.equal(Money.format(result.sale.debt_pesewas), '₵300.00');
  assert.equal(Money.format(customers.get(customer.id).balance_pesewas), '₵300.00');

  const debts = require('../../src/main/services/debt.service').list({ customerId: customer.id });
  assert.equal(debts.rows.length, 1);
  assert.equal(Money.format(debts.rows[0].outstanding_pesewas), '₵300.00');
});

test('a credit sale without a customer is refused', () => {
  assert.throws(() => sales.complete({
    items: [{ productId: rice.id, quantity: '1' }], paymentMethod: 'credit', amountReceived: '0'
  }, { user }), /Enter the customer name/);
});

// --- Customers typed at the till ------------------------------------------
// The shop serves different people every day, so the cashier types a name and
// phone rather than choosing from a list.

test('a customer typed at the till is recorded against the sale', () => {
  const result = sales.complete({
    items: [{ productId: rice.id, quantity: '1' }],
    customerName: 'Ama Mensah', customerPhone: '0244000111',
    paymentMethod: 'cash', amountReceived: '50.00'
  }, { user });

  assert.equal(result.sale.customer_name, 'Ama Mensah');
  assert.equal(result.sale.customer_phone, '0244000111');
  assert.equal(customers.list({ search: 'Ama' }).total, 1, 'the customer record was created once');
});

test('the same phone number reuses one account across days', () => {
  sales.complete({
    items: [{ productId: soap.id, quantity: '1' }],
    customerName: 'Kofi', customerPhone: '0201234567',
    paymentMethod: 'cash', amountReceived: '7.00'
  }, { user });
  const second = sales.complete({
    items: [{ productId: soap.id, quantity: '1' }],
    customerName: 'Kofi Boateng', customerPhone: '0201234567',
    paymentMethod: 'cash', amountReceived: '7.00'
  }, { user });

  assert.equal(customers.list({ search: 'Kofi' }).total, 1, 'one account, not two');
  assert.equal(second.sale.customer_name, 'Kofi Boateng', 'the fuller name is kept');
});

test('a name with no phone records this sale without merging strangers', () => {
  sales.complete({
    items: [{ productId: soap.id, quantity: '1' }], customerName: 'Yaa',
    paymentMethod: 'cash', amountReceived: '7.00'
  }, { user });
  sales.complete({
    items: [{ productId: soap.id, quantity: '1' }], customerName: 'Yaa',
    paymentMethod: 'cash', amountReceived: '7.00'
  }, { user });

  assert.equal(customers.list({ search: 'Yaa' }).total, 2,
    'two people can share a first name; without a phone they stay separate');
});

test('a sale with no customer typed stays an anonymous walk-in', () => {
  const result = sales.complete({
    items: [{ productId: soap.id, quantity: '1' }],
    customerName: '', customerPhone: '',
    paymentMethod: 'cash', amountReceived: '7.00'
  }, { user });

  assert.equal(result.sale.customer_id, null);
  assert.equal(customers.list().total, 0, 'no empty customer record is created');
});

test('a credit sale to a typed customer opens a debt against that account', () => {
  const result = sales.complete({
    items: [{ productId: rice.id, quantity: '10' }],       // ₵500.00
    customerName: 'Esi Owusu', customerPhone: '0555333444',
    paymentMethod: 'credit', amountReceived: '200.00'
  }, { user });

  assert.equal(Money.format(result.sale.debt_pesewas), '₵300.00');
  const customer = customers.list({ search: 'Esi' }).rows[0];
  assert.equal(Money.format(customer.balance_pesewas), '₵300.00');
});

test('a failed sale leaves no stray customer behind', () => {
  assert.throws(() => sales.complete({
    items: [{ productId: rice.id, quantity: '9999' }],     // more than is in stock
    customerName: 'Never Created', customerPhone: '0209999999',
    paymentMethod: 'cash', amountReceived: '999999.00'
  }, { user }), /Not enough stock/);

  assert.equal(customers.list({ search: 'Never Created' }).total, 0);
});

test('Mobile Money must be tendered for the exact total', () => {
  assert.throws(() => sales.complete({
    items: [{ productId: rice.id, quantity: '1' }], paymentMethod: 'momo', amountReceived: '60.00'
  }, { user }), /exact total/);

  const ok = sales.complete({
    items: [{ productId: rice.id, quantity: '1' }], paymentMethod: 'momo', amountReceived: '50.00'
  }, { user });
  assert.equal(ok.sale.change_pesewas, 0);
});

test('a double-clicked Complete Sale charges the customer once', () => {
  const payload = {
    items: [{ productId: soap.id, quantity: '2' }],
    paymentMethod: 'cash', amountReceived: '20.00', clientRef: 'pos-abc-123'
  };
  const first = sales.complete(payload, { user });
  const second = sales.complete(payload, { user });

  assert.equal(second.duplicate, true);
  assert.equal(second.sale.id, first.sale.id);
  assert.equal(sales.list().total, 1);
  assert.equal(products.get(soap.id).stock_milli, 98000, 'stock must only move once');
});

test('invoice numbers are sequential and unique within a day', () => {
  const numbers = new Set();
  for (let i = 0; i < 5; i += 1) {
    const r = sales.complete({
      items: [{ productId: soap.id, quantity: '1' }], paymentMethod: 'cash', amountReceived: '7.00'
    }, { user });
    numbers.add(r.sale.invoice_no);
  }
  assert.equal(numbers.size, 5);
  assert.ok([...numbers].every((n) => /^INV-\d{8}-\d{4}$/.test(n)));
});

test('held sales round-trip through hold, list, resume and delete', () => {
  const cart = { items: [{ productId: rice.id, quantity: '2' }], discount: { type: 'none' } };
  sales.hold({ label: 'Kofi at the door', cart }, { user });

  let held = sales.listHeld({ user });
  assert.equal(held.length, 1);
  assert.equal(Money.format(held[0].total_pesewas), '₵100.00');

  const resumed = sales.resumeHeld(held[0].id, { user });
  assert.equal(resumed.cart.items[0].productId, rice.id);
  assert.equal(sales.listHeld({ user }).length, 0, 'resuming removes the hold');

  sales.hold({ label: 'Second', cart }, { user });
  held = sales.listHeld({ user });
  sales.deleteHeld(held[0].id, { user });
  assert.equal(sales.listHeld({ user }).length, 0);
});

test('the POS price preview matches what the sale actually commits', () => {
  const cart = {
    items: [
      { productId: rice.id, quantity: '1.5' },
      { productId: soap.id, quantity: '4', discount: { type: 'percent', value: 5 } }
    ],
    discount: { type: 'amount', value: Money.parse('3.00') }
  };
  const preview = sales.priceCart(cart);
  const committed = sales.complete({ ...cart, paymentMethod: 'cash', amountReceived: '200.00' }, { user });
  assert.equal(preview.total, committed.sale.total_pesewas);
  assert.equal(preview.cost, committed.sale.cogs_pesewas);
});

test('barcode lookup finds the product the scanner sent', () => {
  assert.equal(products.findByBarcode('6001234567890').id, rice.id);
  assert.equal(products.findByBarcode('0000000000000'), null);
});

test('duplicate barcodes are refused with a clear message', () => {
  assert.throws(
    () => products.create({ name: 'Copycat', barcode: '6001234567890', sellingPrice: '1.00' }, { user }),
    /already assigned to "Perfumed Rice 5kg"/
  );
});

test('generated barcodes are unique and carry a valid EAN-13 check digit', () => {
  const seen = new Set();
  for (let i = 0; i < 20; i += 1) {
    const code = products.generateBarcode();
    assert.equal(code.length, 13);
    assert.equal(products.ean13CheckDigit(code.slice(0, 12)), code[12]);
    assert.ok(!seen.has(code));
    seen.add(code);
  }
});
