'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('../helpers/testDb');

const Money = require('../../src/shared/money');
const io = require('../../src/main/services/importexport.service');
const products = require('../../src/main/services/product.service');

let ctx; let user;

test.beforeEach(() => { ctx = createTestDb(); user = ctx.owner; });
test.afterEach(() => ctx.cleanup());

const HEADER = 'Product Name,Barcode,SKU,Category,Cost Price,Selling Price,Stock,Minimum Stock,Unit';

test('the CSV parser handles quoted fields, commas and doubled quotes', () => {
  const rows = io.parseCsv('a,b\n"one, two",three\n"say ""hi""",four\n');
  assert.deepEqual(rows[1], ['one, two', 'three']);
  assert.deepEqual(rows[2], ['say "hi"', 'four']);
});

test('a clean file imports every row with stock and categories', () => {
  const csv = [
    HEADER,
    'Rice 5kg,6001111111116,RICE5,Groceries,35.00,50.00,20,5,Box',
    'Sugar,,SUG1,Groceries,8.00,12.00,30.5,5,Kg'
  ].join('\n');

  const analysis = io.analyseProductCsv(csv);
  assert.equal(analysis.summary.validCount, 2);
  assert.equal(analysis.summary.invalidCount, 0);
  assert.deepEqual(analysis.summary.newCategories, ['Groceries']);

  const result = io.importProducts(csv, { user });
  assert.equal(result.imported, 2);

  const rice = products.list({ search: 'Rice 5kg' }).rows[0];
  assert.equal(Money.format(rice.selling_price_pesewas), '₵50.00');
  assert.equal(rice.stock_milli, 20000);
  assert.equal(rice.category_name, 'Groceries');

  const sugar = products.list({ search: 'Sugar' }).rows[0];
  assert.equal(sugar.stock_milli, 30500, 'fractional opening stock is kept exactly');
});

test('problems are reported per line before anything is written', () => {
  const csv = [
    HEADER,
    'Good Product,,GP1,Tools,5.00,9.00,10,2,Piece',
    ',,,Tools,5.00,9.00,10,2,Piece',
    'Bad Price,,BP1,Tools,abc,9.00,10,2,Piece',
    'Negative Stock,,NS1,Tools,5.00,9.00,-4,2,Piece',
    'Cost Too High,,CTH,Tools,20.00,9.00,4,2,Piece'
  ].join('\n');

  const analysis = io.analyseProductCsv(csv);
  assert.equal(analysis.summary.validCount, 1);
  assert.equal(analysis.summary.invalidCount, 4);
  assert.equal(analysis.invalid[0].line, 3);
  assert.match(analysis.invalid[0].errors[0], /Product name/);
  assert.match(analysis.invalid[1].errors[0], /Cost price/);
  assert.match(analysis.invalid[2].errors[0], /negative/);
  assert.match(analysis.invalid[3].errors[0], /higher than the selling price/);
  assert.equal(products.list().total, 0, 'analysing writes nothing');
});

test('duplicate barcodes are caught inside the file and against the catalogue', () => {
  products.create({ name: 'Existing', barcode: '6002222222222', sellingPrice: '5.00', costPrice: '2.00' }, { user });
  const csv = [
    HEADER,
    'Alpha,6003333333333,,Tools,1.00,2.00,1,1,Piece',
    'Beta,6003333333333,,Tools,1.00,2.00,1,1,Piece',
    'Gamma,6002222222222,,Tools,1.00,2.00,1,1,Piece'
  ].join('\n');

  const analysis = io.analyseProductCsv(csv);
  assert.equal(analysis.summary.validCount, 1);
  assert.match(analysis.invalid[0].errors[0], /also used on line 2/);
  assert.match(analysis.invalid[1].errors[0], /already assigned to "Existing"/);
});

test('a file whose rows all fail imports nothing and says so', () => {
  const csv = [HEADER, 'X,,,Tools,1.00,2.00,1,1,Piece'].join('\n');  // name too short
  assert.throws(() => io.importProducts(csv, { user }), /None of the rows/);
  assert.equal(products.list().total, 0);
});

test('a file with no recognisable columns is refused', () => {
  assert.throws(() => io.analyseProductCsv('foo,bar\n1,2\n'), /must at least contain/);
  assert.throws(() => io.analyseProductCsv(HEADER), /no data rows/);
});

test('valid rows still import when other rows are rejected', () => {
  const csv = [
    HEADER,
    'Keeper,,K1,Tools,2.00,5.00,10,1,Piece',
    'Rejected,,R1,Tools,abc,5.00,10,1,Piece'
  ].join('\n');
  const result = io.importProducts(csv, { user });
  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 1);
  assert.equal(products.list().total, 1);
});

test('exported products round-trip back through the importer', () => {
  products.create({
    name: 'Round Trip, Ltd', barcode: '6004444444444', sku: 'RT1',
    costPrice: '3.50', sellingPrice: '7.25', stock: '12.25', minStock: '3', unit: 'Kg'
  }, { user });

  const csv = io.exportProducts();
  assert.match(csv, /Round Trip, Ltd/);
  assert.match(csv, /7\.25/);

  const parsed = io.parseCsv(csv);
  assert.equal(parsed[1][0], 'Round Trip, Ltd', 'the comma in the name survives quoting');
  assert.equal(parsed[1][6], '12.25');
});

test('the import template is itself a valid import file', () => {
  const template = io.productImportTemplate();
  const analysis = io.analyseProductCsv(template);
  assert.equal(analysis.summary.invalidCount, 0);
  assert.equal(analysis.summary.validCount, 2);
});

test('report exports carry cedi amounts as plain numbers for a spreadsheet', () => {
  const csv = io.exportReport('expenses', [{
    reference_no: 'EXP-20260827-0001', spent_at: '2026-08-27T09:00:00.000Z',
    category_name: 'Transport', description: 'Trotro', amount_pesewas: 1550,
    payment_method: 'cash', user_name: 'Owner', status: 'active'
  }]);
  assert.match(csv, /15\.50/);
  assert.doesNotMatch(csv, /₵/, 'a spreadsheet needs a plain number, not a symbol');
  assert.match(csv, /Amount \(GHS\)/);
});
