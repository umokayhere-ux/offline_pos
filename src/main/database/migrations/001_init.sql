-- ---------------------------------------------------------------------------
-- iTtEk POS — initial schema
--
-- Conventions:
--   *_pesewas  INTEGER  money, minor units of the Ghana Cedi (₵10.50 = 1050)
--   *_milli    INTEGER  quantity scaled by 1000 (0.5 = 500)
--   created_at / updated_at  TEXT  ISO-8601 UTC, e.g. 2026-08-27T10:30:00.000Z
-- Money is never stored as REAL. Quantity is never stored as REAL.
-- ---------------------------------------------------------------------------

CREATE TABLE roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at  TEXT NOT NULL
);

CREATE TABLE permissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL
);

CREATE TABLE role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT NOT NULL UNIQUE,
  full_name      TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  role_id        INTEGER NOT NULL REFERENCES roles(id),
  phone          TEXT,
  email          TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at  TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_users_role ON users(role_id);

CREATE TABLE categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE suppliers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  company          TEXT,
  phone            TEXT,
  email            TEXT,
  address          TEXT,
  notes            TEXT,
  balance_pesewas  INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_suppliers_name ON suppliers(name);
CREATE INDEX idx_suppliers_phone ON suppliers(phone);

CREATE TABLE customers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  phone            TEXT,
  email            TEXT,
  address          TEXT,
  notes            TEXT,
  balance_pesewas  INTEGER NOT NULL DEFAULT 0,  -- outstanding debt owed to the shop
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_customers_name ON customers(name);
CREATE UNIQUE INDEX idx_customers_phone ON customers(phone) WHERE phone IS NOT NULL AND phone <> '';

CREATE TABLE products (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  name                     TEXT NOT NULL,
  sku                      TEXT,
  barcode                  TEXT,
  category_id              INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  supplier_id              INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  cost_price_pesewas       INTEGER NOT NULL DEFAULT 0 CHECK (cost_price_pesewas >= 0),
  selling_price_pesewas    INTEGER NOT NULL DEFAULT 0 CHECK (selling_price_pesewas >= 0),
  wholesale_price_pesewas  INTEGER CHECK (wholesale_price_pesewas IS NULL OR wholesale_price_pesewas >= 0),
  stock_milli              INTEGER NOT NULL DEFAULT 0,
  min_stock_milli          INTEGER NOT NULL DEFAULT 0 CHECK (min_stock_milli >= 0),
  unit                     TEXT NOT NULL DEFAULT 'Piece',
  allow_negative_stock     INTEGER NOT NULL DEFAULT 0 CHECK (allow_negative_stock IN (0, 1)),
  image_path               TEXT,
  description              TEXT,
  status                   TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_products_barcode ON products(barcode) WHERE barcode IS NOT NULL AND barcode <> '';
CREATE UNIQUE INDEX idx_products_sku ON products(sku) WHERE sku IS NOT NULL AND sku <> '';
CREATE INDEX idx_products_name ON products(name);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_supplier ON products(supplier_id);
CREATE INDEX idx_products_status ON products(status);

-- --------------------------- Sales ----------------------------------------

CREATE TABLE sales (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no              TEXT NOT NULL UNIQUE,
  customer_id             INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  user_id                 INTEGER NOT NULL REFERENCES users(id),
  sold_at                 TEXT NOT NULL,
  subtotal_pesewas        INTEGER NOT NULL,
  line_discount_pesewas   INTEGER NOT NULL DEFAULT 0,
  sale_discount_pesewas   INTEGER NOT NULL DEFAULT 0,
  discount_type           TEXT NOT NULL DEFAULT 'none' CHECK (discount_type IN ('none', 'amount', 'percent')),
  discount_value          TEXT,
  charges_pesewas         INTEGER NOT NULL DEFAULT 0,
  total_pesewas           INTEGER NOT NULL,
  cogs_pesewas            INTEGER NOT NULL DEFAULT 0,
  paid_pesewas            INTEGER NOT NULL DEFAULT 0,
  change_pesewas          INTEGER NOT NULL DEFAULT 0,
  debt_pesewas            INTEGER NOT NULL DEFAULT 0,
  refunded_pesewas        INTEGER NOT NULL DEFAULT 0,
  refunded_cogs_pesewas   INTEGER NOT NULL DEFAULT 0,
  payment_method          TEXT NOT NULL CHECK (payment_method IN ('cash', 'momo', 'card', 'credit', 'mixed')),
  status                  TEXT NOT NULL DEFAULT 'completed'
                          CHECK (status IN ('completed', 'partially_refunded', 'refunded')),
  is_demo                 INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  client_ref              TEXT,   -- idempotency key: blocks a double-clicked sale
  note                    TEXT,
  created_at              TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_sales_client_ref ON sales(client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX idx_sales_sold_at ON sales(sold_at);
CREATE INDEX idx_sales_customer ON sales(customer_id);
CREATE INDEX idx_sales_user ON sales(user_id);
CREATE INDEX idx_sales_status ON sales(status);
CREATE INDEX idx_sales_demo ON sales(is_demo);

CREATE TABLE sale_items (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id                 INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id              INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name            TEXT NOT NULL,   -- snapshot, survives a product rename
  barcode                 TEXT,
  unit                    TEXT NOT NULL DEFAULT 'Piece',
  quantity_milli          INTEGER NOT NULL CHECK (quantity_milli > 0),
  unit_price_pesewas      INTEGER NOT NULL CHECK (unit_price_pesewas >= 0),
  cost_price_pesewas      INTEGER NOT NULL DEFAULT 0,  -- cost AT THE TIME OF SALE
  discount_pesewas        INTEGER NOT NULL DEFAULT 0,
  line_total_pesewas      INTEGER NOT NULL,            -- net of line and allocated sale discount
  refunded_qty_milli      INTEGER NOT NULL DEFAULT 0,
  refunded_pesewas        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX idx_sale_items_product ON sale_items(product_id);

CREATE TABLE payments (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id            INTEGER REFERENCES sales(id) ON DELETE CASCADE,
  customer_id        INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  debt_payment_id    INTEGER,
  amount_pesewas     INTEGER NOT NULL,
  method             TEXT NOT NULL CHECK (method IN ('cash', 'momo', 'card', 'credit')),
  reference          TEXT,
  paid_at            TEXT NOT NULL,
  user_id            INTEGER NOT NULL REFERENCES users(id),
  note               TEXT
);
CREATE INDEX idx_payments_sale ON payments(sale_id);
CREATE INDEX idx_payments_paid_at ON payments(paid_at);

-- --------------------------- Debts ----------------------------------------

CREATE TABLE debt_accounts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id           INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  sale_id               INTEGER REFERENCES sales(id) ON DELETE SET NULL,
  invoice_no            TEXT,
  original_pesewas      INTEGER NOT NULL,
  paid_pesewas          INTEGER NOT NULL DEFAULT 0,
  outstanding_pesewas   INTEGER NOT NULL,
  status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'written_off')),
  opened_at             TEXT NOT NULL,
  settled_at            TEXT,
  user_id               INTEGER NOT NULL REFERENCES users(id),
  note                  TEXT
);
CREATE INDEX idx_debt_customer ON debt_accounts(customer_id);
CREATE INDEX idx_debt_status ON debt_accounts(status);

CREATE TABLE debt_payments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  debt_account_id  INTEGER NOT NULL REFERENCES debt_accounts(id) ON DELETE CASCADE,
  customer_id      INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  reference_no     TEXT NOT NULL UNIQUE,
  amount_pesewas   INTEGER NOT NULL CHECK (amount_pesewas > 0),
  method           TEXT NOT NULL CHECK (method IN ('cash', 'momo', 'card')),
  paid_at          TEXT NOT NULL,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  note             TEXT
);
CREATE INDEX idx_debt_payments_account ON debt_payments(debt_account_id);
CREATE INDEX idx_debt_payments_paid_at ON debt_payments(paid_at);

-- --------------------------- Refunds --------------------------------------

CREATE TABLE refunds (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_no        TEXT NOT NULL UNIQUE,
  sale_id             INTEGER NOT NULL REFERENCES sales(id),
  customer_id         INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  user_id             INTEGER NOT NULL REFERENCES users(id),
  refunded_at         TEXT NOT NULL,
  amount_pesewas      INTEGER NOT NULL CHECK (amount_pesewas > 0),
  cogs_pesewas        INTEGER NOT NULL DEFAULT 0,
  method              TEXT NOT NULL CHECK (method IN ('cash', 'momo', 'card', 'credit')),
  restock             INTEGER NOT NULL DEFAULT 1 CHECK (restock IN (0, 1)),
  reason              TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_refunds_sale ON refunds(sale_id);
CREATE INDEX idx_refunds_at ON refunds(refunded_at);

CREATE TABLE refund_items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  refund_id           INTEGER NOT NULL REFERENCES refunds(id) ON DELETE CASCADE,
  sale_item_id        INTEGER NOT NULL REFERENCES sale_items(id),
  product_id          INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name        TEXT NOT NULL,
  quantity_milli      INTEGER NOT NULL CHECK (quantity_milli > 0),
  amount_pesewas      INTEGER NOT NULL,
  cost_price_pesewas  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_refund_items_refund ON refund_items(refund_id);

-- --------------------------- Purchases ------------------------------------

CREATE TABLE purchases (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_no        TEXT NOT NULL UNIQUE,
  supplier_id         INTEGER NOT NULL REFERENCES suppliers(id),
  user_id             INTEGER NOT NULL REFERENCES users(id),
  purchased_at        TEXT NOT NULL,
  total_pesewas       INTEGER NOT NULL CHECK (total_pesewas >= 0),
  paid_pesewas        INTEGER NOT NULL DEFAULT 0,
  balance_pesewas     INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'cancelled')),
  note                TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_purchases_supplier ON purchases(supplier_id);
CREATE INDEX idx_purchases_at ON purchases(purchased_at);

CREATE TABLE purchase_items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id         INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id          INTEGER NOT NULL REFERENCES products(id),
  product_name        TEXT NOT NULL,
  quantity_milli      INTEGER NOT NULL CHECK (quantity_milli > 0),
  cost_price_pesewas  INTEGER NOT NULL CHECK (cost_price_pesewas >= 0),
  line_total_pesewas  INTEGER NOT NULL
);
CREATE INDEX idx_purchase_items_purchase ON purchase_items(purchase_id);

CREATE TABLE supplier_payments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_no     TEXT NOT NULL UNIQUE,
  supplier_id      INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  purchase_id      INTEGER REFERENCES purchases(id) ON DELETE SET NULL,
  amount_pesewas   INTEGER NOT NULL CHECK (amount_pesewas > 0),
  method           TEXT NOT NULL CHECK (method IN ('cash', 'momo', 'card')),
  paid_at          TEXT NOT NULL,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  note             TEXT
);
CREATE INDEX idx_supplier_payments_supplier ON supplier_payments(supplier_id);

-- --------------------------- Expenses -------------------------------------

CREATE TABLE expense_categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at  TEXT NOT NULL
);

CREATE TABLE expenses (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_no          TEXT NOT NULL UNIQUE,
  expense_category_id   INTEGER NOT NULL REFERENCES expense_categories(id),
  description           TEXT NOT NULL,
  amount_pesewas        INTEGER NOT NULL CHECK (amount_pesewas > 0),
  spent_at              TEXT NOT NULL,
  payment_method        TEXT NOT NULL CHECK (payment_method IN ('cash', 'momo', 'card')),
  user_id               INTEGER NOT NULL REFERENCES users(id),
  notes                 TEXT,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  voided_reason         TEXT,
  created_at            TEXT NOT NULL
);
CREATE INDEX idx_expenses_spent_at ON expenses(spent_at);
CREATE INDEX idx_expenses_category ON expenses(expense_category_id);

-- --------------------------- Inventory ------------------------------------

CREATE TABLE stock_movements (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id        INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  change_milli      INTEGER NOT NULL,          -- signed: negative for a sale
  before_milli      INTEGER NOT NULL,
  after_milli       INTEGER NOT NULL,
  reason            TEXT NOT NULL CHECK (reason IN ('sale', 'refund', 'purchase', 'adjustment', 'opening', 'import')),
  reference_type    TEXT,
  reference_id      INTEGER,
  note              TEXT,
  user_id           INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_stock_movements_product ON stock_movements(product_id);
CREATE INDEX idx_stock_movements_at ON stock_movements(created_at);

CREATE TABLE held_sales (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT NOT NULL,
  customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  payload       TEXT NOT NULL,     -- JSON snapshot of the cart
  total_pesewas INTEGER NOT NULL DEFAULT 0,
  item_count    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_held_sales_user ON held_sales(user_id);

-- --------------------------- System ---------------------------------------

CREATE TABLE activity_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username     TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    INTEGER,
  details      TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_activity_created ON activity_logs(created_at);
CREATE INDEX idx_activity_user ON activity_logs(user_id);
CREATE INDEX idx_activity_action ON activity_logs(action);

-- Activity logs are an audit trail: block UPDATE and DELETE at the database level.
CREATE TRIGGER trg_activity_logs_no_update
BEFORE UPDATE ON activity_logs
BEGIN
  SELECT RAISE(ABORT, 'Activity logs cannot be modified');
END;

CREATE TRIGGER trg_activity_logs_no_delete
BEFORE DELETE ON activity_logs
BEGIN
  SELECT RAISE(ABORT, 'Activity logs cannot be deleted');
END;

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE receipt_settings (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  paper_width     TEXT NOT NULL DEFAULT '80mm' CHECK (paper_width IN ('58mm', '80mm', 'A4')),
  show_logo       INTEGER NOT NULL DEFAULT 1 CHECK (show_logo IN (0, 1)),
  show_cashier    INTEGER NOT NULL DEFAULT 1 CHECK (show_cashier IN (0, 1)),
  show_customer   INTEGER NOT NULL DEFAULT 1 CHECK (show_customer IN (0, 1)),
  header_note     TEXT,
  footer_message  TEXT NOT NULL DEFAULT 'Thank you for shopping with us!',
  printer_name    TEXT,
  auto_print      INTEGER NOT NULL DEFAULT 0 CHECK (auto_print IN (0, 1)),
  updated_at      TEXT NOT NULL
);

CREATE TABLE backup_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  filename      TEXT NOT NULL,
  path          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  kind          TEXT NOT NULL CHECK (kind IN ('manual', 'automatic', 'pre_restore')),
  status        TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'failed', 'restored')),
  message       TEXT,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_backup_logs_created ON backup_logs(created_at);

-- Per-day counters backing collision-free document numbers (INV-20260827-0001).
CREATE TABLE document_sequences (
  prefix      TEXT NOT NULL,
  day         TEXT NOT NULL,
  last_number INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (prefix, day)
);
