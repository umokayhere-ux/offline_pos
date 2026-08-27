import { el, mount, field, debounce, downloadText } from '../utils/dom.js';
import { money, moneyInput, parseMoney, qty, qtyExact, parseQty, stockBadge, dateTime } from '../utils/format.js';
import { api, tryCall, constants } from '../services/api.js';
import { toast } from '../components/toast.js';
import { openModal, confirmModal, promptModal } from '../components/modal.js';
import { dataTable, pager } from '../components/table.js';

/** Product catalogue: search, filter, create, edit, stock adjustment, labels, CSV. */

async function render(ctx) {
  const state = {
    search: '', categoryId: '', stockState: ctx.params.stockState || '', status: 'active',
    sort: 'name', direction: 'asc', page: 1, pageSize: 25,
    data: { rows: [], total: 0, pages: 1 },
    categories: [],
    suppliers: []
  };

  const container = el('div');
  const tableHost = el('div.card');

  const [categoriesResult, suppliersResult] = await Promise.all([
    tryCall('categories', 'list', undefined, { silent: true }),
    ctx.can('suppliers.view')
      ? tryCall('suppliers', 'list', { pageSize: 500 }, { silent: true })
      : Promise.resolve({ ok: true, data: { rows: [] } })
  ]);
  state.categories = categoriesResult.ok ? categoriesResult.data : [];
  state.suppliers = suppliersResult.ok ? suppliersResult.data.rows : [];

  async function load() {
    mount(tableHost, el('div.loading-block', [el('span.spinner'), 'Loading products…']));
    const result = await tryCall('products', 'list', {
      search: state.search, categoryId: state.categoryId || null,
      stockState: state.stockState, status: state.status,
      sort: state.sort, direction: state.direction,
      page: state.page, pageSize: state.pageSize
    });
    if (!result.ok) return;
    state.data = result.data;
    paintTable();
  }

  function paintTable() {
    mount(tableHost, [
      dataTable({
        columns: [
          {
            label: 'Product', sortKey: 'name',
            render: (row) => el('div', [
              el('div.strong', row.name),
              el('div.text-sm.muted', [
                row.barcode ? el('span.mono', row.barcode) : el('span.faint', 'No barcode'),
                row.sku ? ` · ${row.sku}` : ''
              ])
            ])
          },
          { label: 'Category', sortKey: 'category', render: (row) => row.category_name || el('span.faint', '—') },
          {
            label: 'Stock', sortKey: 'stock', align: 'right',
            render: (row) => {
              const badge = stockBadge(row);
              return el('div', [
                el('div.strong', `${qty(row.stock_milli)} ${row.unit}`),
                el(`span.badge-pill.${badge.tone}`, badge.label)
              ]);
            }
          },
          { label: 'Cost', sortKey: 'cost', align: 'right', render: (row) => el('span.money', money(row.cost_price_pesewas)) },
          { label: 'Price', sortKey: 'price', align: 'right', render: (row) => el('strong.money', money(row.selling_price_pesewas)) },
          {
            label: 'Margin', align: 'right',
            render: (row) => {
              const margin = row.selling_price_pesewas - row.cost_price_pesewas;
              return el('span.money', { class: margin < 0 ? 'badge-pill red' : '' }, money(margin));
            }
          },
          {
            label: '', align: 'right',
            render: (row) => el('div.actions', [
              ctx.can('inventory.adjust')
                ? el('button.btn.sm', { type: 'button', title: 'Adjust stock', onclick: () => adjustStock(row) }, '± Stock')
                : null,
              ctx.can('products.manage')
                ? el('button.btn.sm', { type: 'button', onclick: () => productForm(row) }, 'Edit')
                : null,
              ctx.can('products.manage')
                ? el('button.btn.sm.danger', { type: 'button', onclick: () => removeProduct(row) }, 'Delete')
                : null
            ])
          }
        ],
        rows: state.data.rows,
        sort: { key: state.sort, direction: state.direction },
        onSort: (key, direction) => { state.sort = key; state.direction = direction; state.page = 1; load(); },
        onRowClick: (row) => productDetail(row),
        empty: {
          title: state.search || state.stockState ? 'No products match your search' : 'No products yet',
          message: state.search || state.stockState
            ? 'Try a different search, or clear the filters.'
            : 'Add your first product, or import your catalogue from a CSV file.',
          action: ctx.can('products.manage')
            ? el('button.btn.primary', { type: 'button', onclick: () => productForm(null) }, '+ Add product')
            : null
        }
      }),
      pager({
        page: state.data.page, pages: state.data.pages, total: state.data.total,
        pageSize: state.data.pageSize, onPage: (page) => { state.page = page; load(); }
      })
    ]);
  }

  // ------------------------------ Product form -----------------------------

  function productForm(product) {
    const isEdit = !!product;
    const values = {
      name: product ? product.name : '',
      barcode: product ? (product.barcode || '') : '',
      sku: product ? (product.sku || '') : '',
      categoryId: product ? (product.category_id || '') : '',
      supplierId: product ? (product.supplier_id || '') : '',
      costPrice: product ? moneyInput(product.cost_price_pesewas) : '',
      sellingPrice: product ? moneyInput(product.selling_price_pesewas) : '',
      wholesalePrice: product && product.wholesale_price_pesewas !== null ? moneyInput(product.wholesale_price_pesewas) : '',
      stock: product ? qtyExact(product.stock_milli) : '0',
      minStock: product ? qtyExact(product.min_stock_milli) : String((ctx.settings['inventory.low_stock_default_milli'] || 0) / 1000),
      unit: product ? product.unit : 'Piece',
      description: product ? (product.description || '') : '',
      status: product ? product.status : 'active',
      allowNegativeStock: product ? !!product.allow_negative_stock : false
    };

    const errorNode = el('div.callout.danger.hidden');
    const bind = (key) => (event) => { values[key] = event.target.value; };

    const barcodeInput = el('input', { type: 'text', value: values.barcode, oninput: bind('barcode'), placeholder: 'Scan or type' });
    const marginNote = el('div.text-sm.muted');

    const updateMargin = () => {
      const cost = parseMoney(values.costPrice || '0');
      const price = parseMoney(values.sellingPrice || '0');
      if (cost === null || price === null) { marginNote.textContent = ''; return; }
      const margin = price - cost;
      const pct = price > 0 ? ((margin / price) * 100).toFixed(1) : '0.0';
      marginNote.textContent = `Profit per unit: ${money(margin)} (${pct}% margin)`;
      marginNote.className = margin < 0 ? 'text-sm' : 'text-sm muted';
      marginNote.style.color = margin < 0 ? 'var(--red)' : '';
    };

    const costInput = el('input.amount', { type: 'text', value: values.costPrice, placeholder: '0.00', oninput: (e) => { bind('costPrice')(e); updateMargin(); } });
    const priceInput = el('input.amount', { type: 'text', value: values.sellingPrice, placeholder: '0.00', oninput: (e) => { bind('sellingPrice')(e); updateMargin(); } });

    const body = el('div', [
      errorNode,
      el('div.form-grid', [
        el('div.full', field('Product name *', el('input', { type: 'text', value: values.name, 'data-autofocus': '', oninput: bind('name') }))),
        field('Barcode', el('div.row', [
          barcodeInput,
          ctx.can('products.manage')
            ? el('button.btn.sm', {
              type: 'button', title: 'Generate an in-store barcode',
              onclick: async () => {
                const result = await tryCall('products', 'generateBarcode');
                if (result.ok) { barcodeInput.value = result.data.barcode; values.barcode = result.data.barcode; }
              }
            }, 'Generate')
            : null
        ]), { help: 'Leave empty if this product has no barcode.' }),
        field('SKU', el('input', { type: 'text', value: values.sku, oninput: bind('sku') })),
        field('Category', el('select', { onchange: bind('categoryId') }, [
          el('option', { value: '' }, 'Uncategorised'),
          ...state.categories.map((c) => el('option', { value: String(c.id), selected: String(values.categoryId) === String(c.id) }, c.name))
        ])),
        field('Supplier', el('select', { onchange: bind('supplierId') }, [
          el('option', { value: '' }, 'No supplier'),
          ...state.suppliers.map((s) => el('option', { value: String(s.id), selected: String(values.supplierId) === String(s.id) }, s.name))
        ])),
        field('Cost price (₵) *', costInput),
        field('Selling price (₵) *', priceInput),
        el('div.full', marginNote),
        field('Wholesale price (₵)', el('input.amount', { type: 'text', value: values.wholesalePrice, placeholder: 'Optional', oninput: bind('wholesalePrice') })),
        field('Unit', el('select', { onchange: bind('unit') },
          constants.units.map((unit) => el('option', { value: unit, selected: values.unit === unit }, unit)))),
        isEdit
          ? field('Stock on hand', el('input', { type: 'text', value: values.stock, disabled: true }), {
            help: 'Stock only changes through sales, purchases, refunds and adjustments — so every movement is recorded.'
          })
          : field('Opening stock', el('input.qty', { type: 'text', value: values.stock, oninput: bind('stock') })),
        field('Reorder level', el('input.qty', { type: 'text', value: values.minStock, oninput: bind('minStock') }), {
          help: 'You will be warned when stock reaches this level.'
        }),
        el('div.full', field('Description', el('textarea', { value: values.description, oninput: bind('description') }))),
        el('div.full', el('label.checkbox', [
          el('input', {
            type: 'checkbox', checked: values.allowNegativeStock,
            onchange: (event) => { values.allowNegativeStock = event.target.checked; }
          }),
          'Allow selling this product when it is out of stock'
        ])),
        isEdit
          ? el('div.full', field('Status', el('select', { onchange: bind('status') }, [
            el('option', { value: 'active', selected: values.status === 'active' }, 'Active — available at the till'),
            el('option', { value: 'archived', selected: values.status === 'archived' }, 'Archived — hidden from the till')
          ])))
          : null
      ])
    ]);

    updateMargin();

    const save = async (button) => {
      errorNode.classList.add('hidden');
      button.disabled = true;
      const payload = { ...values, id: product ? product.id : undefined };
      const result = await tryCall('products', isEdit ? 'update' : 'create', payload, { silent: true });
      button.disabled = false;

      if (!result.ok) {
        errorNode.textContent = result.error.message;
        errorNode.classList.remove('hidden');
        return;
      }
      toast.success(isEdit ? `"${result.data.name}" updated.` : `"${result.data.name}" added.`);
      instance.close(null);
      load();
      ctx.refreshBadges();
    };

    const instance = openModal({
      title: isEdit ? `Edit ${product.name}` : 'Add a product',
      size: 'wide',
      closeOnBackdrop: false,
      body,
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.primary', { type: 'button', onclick: (event) => save(event.currentTarget) }, isEdit ? 'Save changes' : 'Add product')
      ])
    });
  }

  // ---------------------------- Stock adjustment ---------------------------

  function adjustStock(product) {
    const modeButtons = { current: 'set' };
    const valueInput = el('input.qty', { type: 'text', 'data-autofocus': '', value: qtyExact(product.stock_milli) });
    const reasonInput = el('input', { type: 'text', placeholder: 'e.g. Damaged products, stock count correction' });
    const errorNode = el('div.error-text.hidden');
    const preview = el('div.callout.info');

    const updatePreview = () => {
      const entered = parseQty(valueInput.value);
      if (entered === null) { preview.textContent = 'Enter a valid quantity.'; return; }
      const target = modeButtons.current === 'set' ? entered : product.stock_milli + entered;
      preview.textContent = `Stock will change from ${qty(product.stock_milli)} to ${qty(target)} ${product.unit}.`;
    };
    valueInput.addEventListener('input', updatePreview);
    updatePreview();

    const modes = el('div.btn-group', [
      el('button.btn.active', {
        type: 'button',
        onclick: (event) => {
          modeButtons.current = 'set';
          modes.querySelectorAll('.btn').forEach((b) => b.classList.remove('active'));
          event.currentTarget.classList.add('active');
          valueInput.value = qtyExact(product.stock_milli);
          updatePreview();
        }
      }, 'Set new quantity'),
      el('button.btn', {
        type: 'button',
        onclick: (event) => {
          modeButtons.current = 'add';
          modes.querySelectorAll('.btn').forEach((b) => b.classList.remove('active'));
          event.currentTarget.classList.add('active');
          valueInput.value = '0';
          updatePreview();
        }
      }, 'Add / remove')
    ]);

    const save = async (button) => {
      const entered = parseQty(valueInput.value.replace('-', ''));
      const negative = valueInput.value.trim().startsWith('-');
      if (entered === null) {
        errorNode.textContent = 'Enter a valid quantity.';
        errorNode.classList.remove('hidden');
        return;
      }
      if (reasonInput.value.trim().length < 3) {
        errorNode.textContent = 'Give a reason for this adjustment — it is kept in the audit trail.';
        errorNode.classList.remove('hidden');
        return;
      }

      button.disabled = true;
      const payload = modeButtons.current === 'set'
        ? { productId: product.id, newQuantityMilli: entered, reason: reasonInput.value }
        : { productId: product.id, changeMilli: negative ? -entered : entered, reason: reasonInput.value };
      const result = await tryCall('inventory', 'adjust', payload, { silent: true });
      button.disabled = false;

      if (!result.ok) {
        errorNode.textContent = result.error.message;
        errorNode.classList.remove('hidden');
        return;
      }
      toast.success(`Stock adjusted from ${qty(result.data.before)} to ${qty(result.data.after)}.`);
      instance.close(null);
      load();
      ctx.refreshBadges();
    };

    const instance = openModal({
      title: `Adjust stock — ${product.name}`,
      body: el('div', [
        errorNode,
        el('div.detail-list.mb-16', [
          el('div.item', [el('span.k', 'Current stock'), el('span.v', `${qty(product.stock_milli)} ${product.unit}`)]),
          el('div.item', [el('span.k', 'Reorder level'), el('span.v', qty(product.min_stock_milli))])
        ]),
        el('div.field', [el('label', 'Adjustment type'), modes]),
        field('Quantity', valueInput, { help: 'When adding or removing, use a minus sign to reduce stock (e.g. -3).' }),
        field('Reason *', reasonInput),
        preview
      ]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.primary', { type: 'button', onclick: (event) => save(event.currentTarget) }, 'Save adjustment')
      ])
    });
  }

  async function removeProduct(product) {
    const confirmed = await confirmModal({
      title: 'Delete product',
      message: `Delete "${product.name}"?`,
      detail: 'If this product has ever been sold or purchased it will be archived instead, so your sales history and profit figures stay intact.',
      confirmLabel: 'Delete', tone: 'danger'
    });
    if (!confirmed) return;
    const result = await tryCall('products', 'delete', { id: product.id });
    if (!result.ok) return;
    toast.success(result.data.message);
    load();
  }

  // ----------------------------- Detail view -------------------------------

  async function productDetail(product) {
    const [full, movements] = await Promise.all([
      tryCall('products', 'get', { id: product.id }, { silent: true }),
      tryCall('inventory', 'movements', { productId: product.id, pageSize: 25 }, { silent: true })
    ]);
    if (!full.ok) return;
    const item = full.data;
    const badge = stockBadge(item);

    const barcodePreview = el('div.center');
    if (item.barcode) {
      const svg = await tryCall('products', 'previewBarcode', { value: item.barcode }, { silent: true });
      if (svg.ok) mount(barcodePreview, el('div', { html: svg.data.svg }));
    }

    const instance = openModal({
      title: item.name,
      size: 'wide',
      body: el('div', [
        el('div.grid.cols-2', [
          el('div.detail-list', [
            el('div.item', [el('span.k', 'Barcode'), el('span.v.mono', item.barcode || '—')]),
            el('div.item', [el('span.k', 'SKU'), el('span.v', item.sku || '—')]),
            el('div.item', [el('span.k', 'Category'), el('span.v', item.category_name || 'Uncategorised')]),
            el('div.item', [el('span.k', 'Supplier'), el('span.v', item.supplier_name || '—')]),
            el('div.item', [el('span.k', 'Unit'), el('span.v', item.unit)])
          ]),
          el('div.detail-list', [
            el('div.item', [el('span.k', 'Stock'), el('span.v', [`${qty(item.stock_milli)} ${item.unit} `, el(`span.badge-pill.${badge.tone}`, badge.label)])]),
            el('div.item', [el('span.k', 'Reorder level'), el('span.v', qty(item.min_stock_milli))]),
            el('div.item', [el('span.k', 'Cost price'), el('span.v.money', money(item.cost_price_pesewas))]),
            el('div.item', [el('span.k', 'Selling price'), el('span.v.money', money(item.selling_price_pesewas))]),
            el('div.item', [el('span.k', 'Stock value'), el('span.v.money', money(Math.round(item.stock_milli * item.cost_price_pesewas / 1000)))])
          ])
        ]),
        item.description ? el('p.mt-16.muted', item.description) : null,
        item.barcode ? el('div.mt-16', [el('h3.mb-8', 'Barcode'), barcodePreview]) : null,
        el('h3.mt-24.mb-8', 'Recent stock movements'),
        dataTable({
          columns: [
            { label: 'When', render: (row) => el('span.text-sm', dateTime(row.created_at)) },
            { label: 'Reason', render: (row) => el('span.badge-pill', row.reason) },
            { label: 'Change', align: 'right', render: (row) => el('strong', { class: row.change_milli < 0 ? 'badge-pill red' : 'badge-pill green' }, `${row.change_milli > 0 ? '+' : ''}${qty(row.change_milli)}`) },
            { label: 'After', align: 'right', render: (row) => qty(row.after_milli) },
            { label: 'By', render: (row) => el('span.text-sm', row.user_name || 'System') },
            { label: 'Note', render: (row) => el('span.text-sm.muted', row.note || '') }
          ],
          rows: movements.ok ? movements.data.rows : [],
          empty: { title: 'No movements recorded yet', message: '' }
        })
      ]),
      footer: () => el('div.row', [
        ctx.can('products.manage') && item.barcode
          ? el('button.btn', { type: 'button', onclick: () => printLabels(item) }, '🏷 Print labels')
          : null,
        el('span.grow'),
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Close'),
        ctx.can('products.manage')
          ? el('button.btn.primary', { type: 'button', onclick: () => { instance.close(null); productForm(item); } }, 'Edit')
          : null
      ])
    });
  }

  function printLabels(product) {
    const copiesInput = el('input', { type: 'number', min: '1', max: '200', value: '12', 'data-autofocus': '' });
    const instance = openModal({
      title: `Print labels — ${product.name}`,
      size: 'narrow',
      body: el('div', [
        field('How many labels?', copiesInput, { help: 'Labels are laid out on A4 sheets, 45mm × 30mm each.' })
      ]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.primary', {
          type: 'button',
          onclick: async (event) => {
            event.currentTarget.disabled = true;
            const result = await tryCall('products', 'printLabels', {
              entries: [{ productId: product.id, copies: Number(copiesInput.value) || 1 }]
            });
            if (result.ok && result.data.printed) toast.success('Labels sent to the printer.');
            instance.close(null);
          }
        }, '🖨 Print')
      ])
    });
  }

  // ------------------------------ Import / export --------------------------

  async function exportCsv() {
    const result = await tryCall('products', 'export', { search: state.search, status: state.status });
    if (!result.ok) return;
    const saved = await tryCall('file', 'saveAs', { defaultName: `products_${new Date().toISOString().slice(0, 10)}.csv`, content: result.data });
    if (saved.ok && !saved.data.cancelled) toast.success(`Saved to ${saved.data.path}`);
  }

  async function importCsv() {
    const picked = await tryCall('file', 'openCsv');
    if (!picked.ok || picked.data.cancelled) return;

    const analysis = await tryCall('products', 'importAnalyse', { csv: picked.data.content });
    if (!analysis.ok) return;
    const { summary, valid, invalid } = analysis.data;

    const instance = openModal({
      title: `Import products — ${picked.data.name}`,
      size: 'xwide',
      body: el('div', [
        el('div.grid.cols-3', [
          el('div.stat.green', [el('div.label', 'Ready to import'), el('div.value', String(summary.validCount))]),
          el('div.stat.red', [el('div.label', 'With problems'), el('div.value', String(summary.invalidCount))]),
          el('div.stat', [el('div.label', 'New categories'), el('div.value.sm', summary.newCategories.length ? summary.newCategories.join(', ') : 'None')])
        ]),
        invalid.length > 0
          ? el('div.mt-16', [
            el('h3.mb-8', 'These rows will be skipped'),
            dataTable({
              columns: [
                { label: 'Line', render: (row) => row.line },
                { label: 'Product', render: (row) => row.name || el('span.faint', '(blank)') },
                { label: 'Problem', render: (row) => el('div', row.errors.map((e) => el('div.text-sm', { style: { color: 'var(--red)' } }, e))) }
              ],
              rows: invalid.slice(0, 100)
            })
          ])
          : null,
        valid.length > 0
          ? el('div.mt-16', [
            el('h3.mb-8', `Preview of what will be imported (${valid.length})`),
            dataTable({
              columns: [
                { label: 'Product', render: (row) => row.name },
                { label: 'Barcode', render: (row) => el('span.mono.text-sm', row.barcode || '—') },
                { label: 'Category', render: (row) => row.categoryName || '—' },
                { label: 'Cost', align: 'right', render: (row) => money(row.costPricePesewas) },
                { label: 'Price', align: 'right', render: (row) => money(row.sellingPricePesewas) },
                { label: 'Stock', align: 'right', render: (row) => qty(row.stockMilli) }
              ],
              rows: valid.slice(0, 100)
            })
          ])
          : null
      ]),
      footer: () => el('div.row', [
        el('button.btn', {
          type: 'button',
          onclick: async () => {
            const template = await tryCall('products', 'importTemplate');
            if (template.ok) downloadText('product_import_template.csv', template.data);
          }
        }, 'Download template'),
        el('span.grow'),
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.primary', {
          type: 'button',
          disabled: summary.validCount === 0,
          onclick: async (event) => {
            event.currentTarget.disabled = true;
            const result = await tryCall('products', 'import', { csv: picked.data.content, createMissingCategories: true });
            if (result.ok) {
              toast.success(`${result.data.imported} product${result.data.imported === 1 ? '' : 's'} imported${result.data.skipped ? `, ${result.data.skipped} skipped` : ''}.`);
              instance.close(null);
              load();
            } else {
              event.currentTarget.disabled = false;
            }
          }
        }, `Import ${summary.validCount} product${summary.validCount === 1 ? '' : 's'}`)
      ])
    });
  }

  // -------------------------------- Filters --------------------------------

  const searchInput = el('input', {
    type: 'search', value: state.search, placeholder: 'Name, barcode, SKU or category…',
    oninput: debounce((event) => { state.search = event.target.value; state.page = 1; load(); }, 250)
  });

  const filters = el('div.filters', [
    el('div.field.wide', [el('label', 'Search'), searchInput]),
    el('div.field', [el('label', 'Category'), el('select', {
      onchange: (event) => { state.categoryId = event.target.value; state.page = 1; load(); }
    }, [
      el('option', { value: '' }, 'All categories'),
      ...state.categories.map((c) => el('option', { value: String(c.id) }, `${c.name} (${c.product_count})`))
    ])]),
    el('div.field', [el('label', 'Stock'), el('select', {
      onchange: (event) => { state.stockState = event.target.value; state.page = 1; load(); }
    }, [
      el('option', { value: '', selected: state.stockState === '' }, 'All stock levels'),
      el('option', { value: 'low', selected: state.stockState === 'low' }, 'Low stock'),
      el('option', { value: 'out', selected: state.stockState === 'out' }, 'Out of stock'),
      el('option', { value: 'ok', selected: state.stockState === 'ok' }, 'Healthy stock')
    ])]),
    el('div.field', [el('label', 'Status'), el('select', {
      onchange: (event) => { state.status = event.target.value; state.page = 1; load(); }
    }, [
      el('option', { value: 'active' }, 'Active'),
      el('option', { value: 'archived' }, 'Archived'),
      el('option', { value: 'all' }, 'All')
    ])]),
    el('span.grow'),
    ctx.can('products.view') ? el('button.btn', { type: 'button', onclick: exportCsv }, '⬇ Export CSV') : null,
    ctx.can('products.manage') ? el('button.btn', { type: 'button', onclick: importCsv }, '⬆ Import CSV') : null,
    ctx.can('products.manage') ? el('button.btn.primary', { type: 'button', onclick: () => productForm(null) }, '+ Add product') : null
  ]);

  mount(container, filters, tableHost);
  await load();
  return container;
}

export const productsPage = {
  title: 'Products',
  subtitle: 'Your catalogue and stock levels',
  permission: 'products.view',
  render
};
