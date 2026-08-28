# iTtEk POS

An **offline** shop management and point-of-sale application for a single Windows PC.
Built for a Ghanaian retail shop: every amount is in **Ghana Cedis (₵)**, and the
application never needs an internet connection — not to start, not to sell, not to
print, not to report.

```
Electron  ·  Node.js  ·  SQLite (better-sqlite3)  ·  decimal.js
```

---

## Contents

1. [Quick start](#quick-start)
2. [Architecture](#architecture)
3. [Money: how the numbers are kept exact](#money-how-the-numbers-are-kept-exact)
4. [Database schema](#database-schema)
5. [Security](#security)
6. [Barcodes and the scanner](#barcodes-and-the-scanner)
7. [Printing](#printing)
8. [Backup and restore](#backup-and-restore)
9. [Testing](#testing)
10. [Building the Windows installer](#building-the-windows-installer)
11. [Project layout](#project-layout)
12. [What is and is not implemented](#what-is-and-is-not-implemented)

---

## Quick start

```bash
npm install          # also compiles the native database module for Electron
npm start            # launch the application
npm test             # run the full test suite (134 tests)
```

On first launch a six-step setup wizard asks for the shop details, creates the
owner account, and configures the receipt, printer and inventory preferences.
After that the dashboard opens and the shop is ready to trade.

> **Native module note.** `better-sqlite3` must be compiled against the runtime
> that loads it — Electron's Node for the app, your system Node for the tests.
> `npm start` and `npm test` each run `scripts/ensure-abi.js`, which rebuilds it
> only when the current build targets the wrong runtime. You never have to think
> about it.

---

## Architecture

```
┌────────────────────────────── Renderer process ──────────────────────────────┐
│  src/renderer/     ES modules, no framework, no bundler, no network access    │
│  pages/  components/  services/api.js  utils/                                 │
│  • never touches SQL, the filesystem or Node                                  │
│  • all money it displays is already calculated by the main process            │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    │  window.api.<domain>.<action>(payload)
┌───────────────────────────────────▼──────────────────────────────────────────┐
│  src/preload/preload.js    contextBridge · sandboxed · channel whitelist only │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    │  ipcRenderer.invoke → ipcMain.handle
┌───────────────────────────────────▼──────────────────────────────────────────┐
│  src/main/ipc/index.js   one handler per channel; each declares the           │
│                          permission it needs, checked against the session     │
│                          held in the MAIN process                             │
├──────────────────────────────────────────────────────────────────────────────┤
│  src/main/services/      business rules — sale, refund, debt, purchase,       │
│                          expense, inventory, report, user, settings           │
│  src/main/security/      scrypt password hashing, session, permissions        │
│  src/main/printers/      receipt templates + print abstraction                │
│  src/main/backup/        online backup, validation, safe restore              │
├──────────────────────────────────────────────────────────────────────────────┤
│  src/main/database/      migrations, connection (WAL, FK on), seeds           │
│  src/shared/             money, calculation, datetime, errors, constants      │
│                          (pure, dependency-light, exhaustively tested)        │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Why no Express server.** For a single-PC offline application, an HTTP server on
localhost would add an attack surface and a failure mode for nothing: Electron's
IPC already gives a typed, authenticated channel between the UI and the backend.
The layering an Express app would give you (routes → services → repositories) is
present here as ipc handlers → services → parameterised SQL.

**Layering rules that are enforced, not merely intended:**

- No SQL outside `src/main/services` — the renderer has no database handle at all.
- No business logic in HTML; pages build DOM through `utils/dom.js`, which inserts
  user data as text nodes.
- No monetary arithmetic outside `src/shared/money.js` and `src/shared/calculation.js`.
- Every multi-table write runs inside `db.transaction()`.

### Transactional integrity

Completing a sale is one atomic unit:

```
BEGIN
  insert sales                     -- invoice number drawn from document_sequences
  insert sale_items                -- with the cost price AT THIS MOMENT
  insert payments
  update products.stock_milli      ─┐ always together, never one without the other
  insert stock_movements           ─┘
  insert debt_accounts             -- only for a credit sale
  update customers.balance_pesewas
  insert activity_logs
COMMIT                             -- any failure above → ROLLBACK, nothing happened
```

The test `selling more than is in stock is refused and rolls back completely`
proves this: it puts a good line and an impossible line in the same cart and
asserts that the good line's stock was *not* deducted.

---

## Money: how the numbers are kept exact

**Money is never a JavaScript float.** It is an integer number of **pesewas**:

| Displayed | Stored |
|---|---|
| ₵10.50 | `1050` |
| ₵100.00 | `10000` |
| ₵1,250.75 | `125075` |

**Quantities are never floats either.** They are integers scaled by 1000
("milli-units"), so `0.5 kg` is `500` and `2.75` is `2750`. This is what makes
fractional sales exact: `₵10.00 × 0.5` is `1000 × 500 ÷ 1000 = 500`, not
`10 * 0.5` in binary floating point.

Everything that could produce a fraction — percentages, discounts, apportioning a
sale discount across lines, partial refunds — goes through `decimal.js` inside
`src/shared/money.js`, with **one** rounding policy: `ROUND_HALF_UP`, applied only
at the point a value must become a whole pesewa. Intermediate values keep full
precision.

`src/shared/calculation.js` is the only place business formulas live:

| Figure | Formula |
|---|---|
| Line total | `unit price × quantity − line discount` |
| Subtotal | `Σ line totals` |
| Discount | fixed amount, or `subtotal × percent ÷ 100`; never more than the amount it applies to |
| Total | `subtotal − discount + charges` |
| COGS | `Σ (cost price *at the time of sale*) × quantity` |
| Gross profit | `revenue − COGS` |
| Net profit | `gross profit − expenses` |
| Change | `received − total`, and never negative |
| Customer debt | `previous balance + credit sale − payments` |
| Supplier balance | `previous balance + purchases − payments` |

Two consequences worth stating plainly:

- **Historical cost is frozen.** `sale_items.cost_price_pesewas` is written at the
  moment of sale. Raising a product's cost tomorrow does not change yesterday's
  profit. There is a test for exactly this.
- **A sale-level discount is apportioned back onto the lines** so the stored line
  totals always sum to the sale total, to the pesewa, with the rounding remainder
  given to the largest line.

---

## Database schema

SQLite with `foreign_keys = ON`, `journal_mode = WAL` and `synchronous = FULL`
(a shop PC can lose power mid-sale). Migrations live in
`src/main/database/migrations/` and are applied inside a transaction, tracked in
`schema_migrations`.

**Money columns end in `_pesewas` and are `INTEGER`. Quantity columns end in
`_milli` and are `INTEGER`. Nothing financial is ever stored as `REAL`.**

| Group | Tables |
|---|---|
| Access | `users`, `roles`, `permissions`, `role_permissions` |
| Catalogue | `products`, `categories`, `suppliers` |
| Selling | `sales`, `sale_items`, `payments`, `held_sales` |
| Returns | `refunds`, `refund_items` |
| Credit | `customers`, `debt_accounts`, `debt_payments` |
| Buying | `purchases`, `purchase_items`, `supplier_payments` |
| Costs | `expenses`, `expense_categories` |
| Stock | `stock_movements` |
| System | `settings`, `receipt_settings`, `activity_logs`, `backup_logs`, `document_sequences`, `schema_migrations` |

Key constraints and indexes:

- Unique partial indexes on `products.barcode` and `products.sku` (so many products
  may have *no* barcode, but no two may share one), and on `customers.phone`.
- `CHECK` constraints reject a negative price, a zero-or-negative sold quantity, an
  unknown payment method, an unknown status.
- Indexes on every column the application filters or sorts by — `sales.sold_at`,
  `products.name`, `stock_movements.product_id`, `activity_logs.created_at`, and so on.
- **`activity_logs` has `BEFORE UPDATE` and `BEFORE DELETE` triggers that `RAISE(ABORT)`.**
  The audit trail cannot be edited by staff, by the owner, or by the application itself.

### Entity relationships

```
users ──< sales ──< sale_items >── products >── categories
  │         │  │                       │  │
  │         │  └──< payments           │  └──< stock_movements
  │         │                          │
  │         ├──< refunds ──< refund_items
  │         └──< debt_accounts ──< debt_payments
  │                   │
customers ────────────┘

suppliers ──< purchases ──< purchase_items >── products
     └─────< supplier_payments

expense_categories ──< expenses
```

### Document numbering

`document_sequences` holds a per-prefix, per-day counter incremented by an atomic
`INSERT … ON CONFLICT DO UPDATE … RETURNING`, inside the caller's transaction. Two
concurrent sales cannot receive the same invoice number, and a rolled-back sale
releases its number.

```
INV-20260827-0001   sale          DPY-20260827-0001   debt payment
REF-20260827-0001   refund        SPY-20260827-0001   supplier payment
PUR-20260827-0001   purchase      EXP-20260827-0001   expense
```

---

## Security

| Concern | How it is handled |
|---|---|
| Passwords | `scrypt` (N=16384, r=8, p=1) from Node's own `crypto`, per-user random salt, parameters stored with the hash. Compared with `timingSafeEqual`. |
| Brute force | Five failed attempts locks the account for five minutes; every failure is logged. |
| Sessions | Held in the **main** process only. The renderer's copy is for display; it can never assert an identity. Idle timeout is configurable and enforced server-side. |
| Authorisation | Every IPC channel declares the permission it requires; the check runs in the main process against the session, not against anything the renderer sent. |
| Renderer isolation | `contextIsolation: true`, `nodeIntegration: false`, `sandbox` on, `webviewTag: false`, DevTools only in development. |
| IPC surface | A fixed whitelist (`src/shared/channels.js`). A channel not on the list does not exist. A test asserts the preload and the handler map agree exactly. |
| Injection | Every query is parameterised. Every value rendered in the UI goes in as a text node; receipt HTML is escaped. |
| Navigation | `will-navigate` blocks anything that is not the bundled `file:` app; `setWindowOpenHandler` denies all popups. |
| Network | A CSP with **no remote origin at all** (`default-src 'self'`), plus a permission handler that denies camera, microphone and geolocation. |
| Audit | `activity_logs`, unmodifiable at the database level. |
| Error messages | `SQLITE_CONSTRAINT: UNIQUE constraint failed: products.barcode` becomes *"This barcode is already assigned to another product."* Technical detail goes to the log file, never to the counter. |

---

## Barcodes and the scanner

USB and Bluetooth barcode scanners behave as keyboards, so no driver or SDK is
needed. The POS keeps focus in the scan box; the scanner "types" the code and
sends Enter, which triggers a lookup on the indexed `products.barcode` column.

- Found → added to the cart, or the existing line's quantity is increased
  (configurable in Settings → Inventory & POS).
- Not found → a dialog offering **Add new product** (creating it with that barcode
  without leaving the till), **Search manually**, or **Cancel**.

Barcodes can also be **generated** — a 13-digit EAN-13 with a valid check digit in
the `200–299` in-store range, which is reserved for exactly this and cannot clash
with a manufacturer's code. Labels are drawn as **Code 128-B inline SVG computed in
this repository** (`src/main/services/barcode.service.js`) — no library, no CDN — and
printed as an A4 sheet of 45 × 30 mm labels.

---

## Printing

`src/main/printers/receipt.template.js` renders the receipt as HTML with an
`@page` size of 58mm, 80mm or A4. `print.service.js` loads it in an offscreen
window with no Node access and hands it to the operating system's printer driver,
so any thermal printer installed in Windows just works.

Receipts carry the shop name, logo, address, phone, invoice number, date, cashier,
customer, every line with quantity/price/discount, subtotal, discount, total,
payment method, amount received, change, any balance owed, and the footer message —
all configurable in Settings → Receipt, with a **Print test receipt** button.

---

## Backup and restore

Backups use SQLite's **online backup API**, so a copy taken while the shop is
trading is internally consistent — unlike copying the file while WAL pages are
outstanding.

Restoring is deliberately loud:

1. The candidate file is opened read-only and checked: `integrity_check`, the
   expected tables, and at least one user account (or you could not sign in).
2. A **safety copy of the current database** is taken first.
3. The user confirms in-app by typing `RESTORE`, then confirms again in a native
   OS dialog that states exactly what will be lost.
4. Only then is the file swapped in, migrated forward, and re-seeded.
5. If anything fails, the safety copy is put back automatically.

Automatic backups (off / daily / weekly) run a few seconds after start-up so they
never delay opening the till.

---

## Testing

```bash
npm test              # 134 tests
npm run test:financial  # the money suite only
```

| Suite | What it covers |
|---|---|
| `tests/financial/` | Every specified acceptance case, plus edge cases: `0.1 + 0.2`, half-up boundaries, 0.333 kg, 100% discounts, discounts larger than the line, ₵10,000,000 totals, 250-line carts summing without drift, allocation remainders. |
| `tests/unit/` | Date/timezone handling, error translation, receipt rendering, Code 128 encoding, IPC channel/permission parity, preload↔shared drift. |
| `tests/integration/` | Real SQLite databases on disk: sales, stock movements, cost snapshots, rollback on failure, double-click protection, credit sales, debt instalments, refunds (full, partial, non-restocking, against debt), purchases, supplier balances, reporting, CSV import validation, backup and restore. |

The application itself was also driven end to end through its real UI (setup
wizard → product → barcode scan → sale → credit sale → debt payment → refund →
expense → purchase → reports → backup → settings → activity log) with **no console
errors**, and the profit-and-loss report reconciled to the pesewa.

---

## Building the Windows installer

```bash
npm run build:win
```

Produces an NSIS installer in `dist/` with an application icon, a desktop shortcut
option and a Start-menu entry. **The end user does not need Node.js installed** —
Electron ships its own runtime.

**Run this on Windows.** The packaging step itself is cross-platform, but
stamping the icon and version resources into the `.exe` uses `rcedit`, which needs
Wine on a non-Windows host. Build on the shop's own platform and there is nothing
extra to install.

### Building the installer without a Windows machine

`.github/workflows/build-windows.yml` builds the installer on a GitHub-hosted
Windows runner, so you do not need a Windows PC to produce one:

- **On demand** — GitHub → **Actions** → *Build Windows installer* → **Run workflow**.
  When it finishes, the `.exe` is under **Artifacts** on the run page.
- **On a version tag** — `git tag v1.0.0 && git push origin v1.0.0` builds the
  installer and publishes it as a GitHub release.

The workflow runs the test suite first and refuses to build if anything fails.

### Portable build (no installer needed)

If you want to try the application on a Windows PC before setting up a build
machine — or run it from a USB stick — build the portable version instead. This
one **works from any operating system**, because it skips the icon-stamping step:

```bash
npm run build:win:portable   # dist/iTtEk POS-1.0.0-win.zip  (~110 MB)
npm run build:win:folder     # dist/win-unpacked/            (a plain folder)
```

Copy the folder to the Windows PC and double-click `iTtEk POS.exe`. There is
nothing to install and Node.js is not required — it is the same application, with
the same database engine, that the installer would deploy.

The trade-offs versus `npm run build:win`: it uses Electron's default icon rather
than the shop icon, carries no version metadata in the `.exe`, is unsigned (so
SmartScreen will warn on first run — choose *More info → Run anyway*), and creates
no Start-menu or desktop shortcut. Its data lives in the same place as an
installed copy (`%APPDATA%\iTtEk POS`), so you can trial it portably and install
properly later without losing anything.

---

## Project layout

```
src/
  main/
    main.js                 window, menu, CSP, lifecycle
    logger.js               rotating file log
    database/               migrations/, connection.js, seed.js
    services/               sale, refund, debt, purchase, expense, inventory,
                            product, category, customer, supplier, report, user,
                            settings, setup, activity, sequence, barcode, importexport
    repositories            (queries live with their service; all parameterised)
    ipc/index.js            channel → permission → handler
    printers/               receipt.template.js, print.service.js
    backup/backup.service.js
    security/               password.js, session.js
  preload/preload.js        contextBridge whitelist
  renderer/
    index.html  app.js      shell, router, session gate
    pages/                  16 screens
    components/             modal, toast, table, charts
    services/api.js         the only route to data
    utils/                  dom.js, format.js
  shared/                   money, calculation, datetime, errors, constants, channels
database/ → src/main/database   (migrations are versioned with the code)
tests/    financial/ unit/ integration/
assets/   icon.png, icon.ico
scripts/  ensure-abi.js
```

---

## What is and is not implemented

**Implemented and working end to end:** setup wizard · authentication with roles
and configurable permissions · POS with barcode scanning, fractional quantities,
line and sale discounts, four payment methods, held sales and keyboard shortcuts ·
products with CSV import/export and barcode generation and label printing ·
categories · inventory with mandatory-reason adjustments and a full movement
ledger · customers · credit sales, debt instalments and write-offs · refunds (full,
partial, restocking or not, against debt) · suppliers, purchases and supplier
payments · expenses with custom categories and voiding · dashboard and nine reports
from a single source of truth · receipt printing (58mm/80mm/A4) with preview and
test print · backup, validation and guarded restore · audit log · settings for shop
identity, receipt, printer, inventory, POS behaviour and security.

**Deliberately not built in this version**, and why:

- **PDF export** is offered through the system print dialog ("Microsoft Print to
  PDF") rather than a bundled PDF engine. A PDF library would add several megabytes
  and a second layout path to maintain for something Windows already does well.
  CSV export is native and covers spreadsheet use.
- **Cloud sync / multi-PC** is out of scope by design, as specified.
- **A custom shortcut editor** — the shortcuts are fixed at F2–F8 and documented in
  Settings → About. The dispatch is already table-driven, so making it editable is
  a settings screen away.
