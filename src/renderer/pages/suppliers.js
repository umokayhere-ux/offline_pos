import { el, mount, field, debounce } from '../utils/dom.js';
import { money, moneyInput, parseMoney, dateTime, date, paymentLabel } from '../utils/format.js';
import { tryCall } from '../services/api.js';
import { toast } from '../components/toast.js';
import { openModal, confirmModal } from '../components/modal.js';
import { dataTable, pager } from '../components/table.js';

async function render(ctx) {
  const state = {
    search: '', withBalanceOnly: false, status: 'active', page: 1, pageSize: 25,
    data: { rows: [], total: 0, pages: 1, page: 1, pageSize: 25 }
  };
  const container = el('div');
  const tableHost = el('div.card');

  async function load() {
    const result = await tryCall('suppliers', 'list', {
      search: state.search, withBalanceOnly: state.withBalanceOnly,
      status: state.status, page: state.page, pageSize: state.pageSize
    });
    if (!result.ok) return;
    state.data = result.data;
    paint();
  }

  function paint() {
    mount(tableHost, [
      dataTable({
        columns: [
          { label: 'Supplier', render: (row) => el('div', [
            el('div.strong', row.name),
            el('div.text-sm.muted', [row.company, row.phone].filter(Boolean).join(' · ') || 'No contact details')
          ]) },
          { label: 'Email', render: (row) => el('span.text-sm', row.email || '—') },
          { label: 'Balance owed', align: 'right', render: (row) => (row.balance_pesewas > 0
            ? el('span.badge-pill.amber', money(row.balance_pesewas))
            : el('span.badge-pill.green', 'Settled')) },
          { label: '', align: 'right', render: (row) => el('div.actions', [
            el('button.btn.sm', { type: 'button', onclick: () => profile(row) }, 'View'),
            ctx.can('suppliers.manage') && row.balance_pesewas > 0
              ? el('button.btn.sm.primary', { type: 'button', onclick: () => payDialog(row) }, 'Pay')
              : null,
            ctx.can('suppliers.manage') ? el('button.btn.sm', { type: 'button', onclick: () => form(row) }, 'Edit') : null,
            ctx.can('suppliers.manage') ? el('button.btn.sm.danger', { type: 'button', onclick: () => remove(row) }, 'Delete') : null
          ]) }
        ],
        rows: state.data.rows,
        onRowClick: (row) => profile(row),
        empty: {
          title: 'No suppliers yet',
          message: 'Add the businesses you buy stock from to track purchases and what you owe.',
          action: ctx.can('suppliers.manage')
            ? el('button.btn.primary', { type: 'button', onclick: () => form(null) }, '+ Add supplier')
            : null
        }
      }),
      pager({ ...state.data, onPage: (page) => { state.page = page; load(); } })
    ]);
  }

  function form(supplier) {
    const values = {
      name: supplier ? supplier.name : '',
      company: supplier ? (supplier.company || '') : '',
      phone: supplier ? (supplier.phone || '') : '',
      email: supplier ? (supplier.email || '') : '',
      address: supplier ? (supplier.address || '') : '',
      notes: supplier ? (supplier.notes || '') : ''
    };
    const bind = (key) => (event) => { values[key] = event.target.value; };
    const errorNode = el('div.callout.danger.hidden');

    const save = async (button) => {
      button.disabled = true;
      const result = await tryCall('suppliers', supplier ? 'update' : 'create',
        { id: supplier ? supplier.id : undefined, ...values }, { silent: true });
      button.disabled = false;
      if (!result.ok) {
        errorNode.textContent = result.error.message;
        errorNode.classList.remove('hidden');
        return;
      }
      toast.success(supplier ? 'Supplier updated.' : `${result.data.name} added.`);
      instance.close(null);
      load();
    };

    const instance = openModal({
      title: supplier ? `Edit ${supplier.name}` : 'Add a supplier',
      body: el('div', [
        errorNode,
        el('div.form-grid', [
          field('Contact name *', el('input', { type: 'text', value: values.name, 'data-autofocus': '', oninput: bind('name') })),
          field('Company', el('input', { type: 'text', value: values.company, oninput: bind('company') })),
          field('Phone', el('input', { type: 'tel', value: values.phone, oninput: bind('phone') })),
          field('Email', el('input', { type: 'email', value: values.email, oninput: bind('email') })),
          el('div.full', field('Address', el('input', { type: 'text', value: values.address, oninput: bind('address') }))),
          el('div.full', field('Notes', el('textarea', { value: values.notes, oninput: bind('notes') })))
        ])
      ]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.primary', { type: 'button', onclick: (event) => save(event.currentTarget) }, 'Save')
      ])
    });
  }

  function payDialog(supplier, purchaseId = null) {
    const amountInput = el('input.amount', { type: 'text', 'data-autofocus': '', value: moneyInput(supplier.balance_pesewas) });
    const methodSelect = el('select', {}, [
      el('option', { value: 'cash' }, 'Cash'),
      el('option', { value: 'momo' }, 'Mobile Money'),
      el('option', { value: 'card' }, 'Card')
    ]);
    const noteInput = el('input', { type: 'text', placeholder: 'Optional reference' });
    const errorNode = el('div.error-text.hidden');

    const save = async (button) => {
      const amount = parseMoney(amountInput.value);
      if (amount === null || amount <= 0) {
        errorNode.textContent = 'Enter a valid amount.';
        errorNode.classList.remove('hidden');
        return;
      }
      button.disabled = true;
      const result = await tryCall('suppliers', 'recordPayment', {
        supplierId: supplier.id, purchaseId, amount: moneyInput(amount),
        method: methodSelect.value, note: noteInput.value
      }, { silent: true });
      button.disabled = false;
      if (!result.ok) {
        errorNode.textContent = result.error.message;
        errorNode.classList.remove('hidden');
        return;
      }
      toast.success(`Payment ${result.data.reference} recorded. Balance now ${money(result.data.balance)}.`);
      instance.close(null);
      load();
    };

    const instance = openModal({
      title: `Pay ${supplier.name}`,
      size: 'narrow',
      body: el('div', [
        errorNode,
        el('div.callout.info', `Outstanding balance: ${money(supplier.balance_pesewas)}`),
        el('div.mt-16', field('Amount (₵) *', amountInput)),
        field('Payment method', methodSelect),
        field('Note', noteInput)
      ]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.primary', { type: 'button', onclick: (event) => save(event.currentTarget) }, 'Record payment')
      ])
    });
  }

  async function remove(supplier) {
    const ok = await confirmModal({
      title: 'Delete supplier',
      message: `Delete ${supplier.name}?`,
      detail: 'Suppliers with purchase history are archived rather than deleted.',
      confirmLabel: 'Delete', tone: 'danger'
    });
    if (!ok) return;
    const result = await tryCall('suppliers', 'delete', { id: supplier.id });
    if (result.ok) { toast.success(result.data.message); load(); }
  }

  async function profile(supplier) {
    const result = await tryCall('suppliers', 'profile', { id: supplier.id });
    if (!result.ok) return;
    const { supplier: person, purchases, payments, totals } = result.data;

    const instance = openModal({
      title: person.name,
      size: 'xwide',
      body: el('div', [
        el('div.grid.cols-4', [
          el('div.stat', [el('div.label', 'Total purchased'), el('div.value.sm', money(totals.purchased_pesewas))]),
          el('div.stat', [el('div.label', 'Total paid'), el('div.value.sm', money(totals.paid_pesewas))]),
          el('div.stat', { class: person.balance_pesewas > 0 ? 'amber' : 'green' }, [
            el('div.label', 'Balance owed'), el('div.value.sm', money(person.balance_pesewas))
          ]),
          el('div.stat', [el('div.label', 'Purchases'), el('div.value.sm', String(totals.purchase_count))])
        ]),
        el('h3.mt-24.mb-8', 'Purchases'),
        dataTable({
          columns: [
            { label: 'Reference', render: (row) => el('span.mono.text-sm', row.reference_no) },
            { label: 'Date', render: (row) => el('span.text-sm', dateTime(row.purchased_at)) },
            { label: 'Total', align: 'right', render: (row) => money(row.total_pesewas) },
            { label: 'Paid', align: 'right', render: (row) => money(row.paid_pesewas) },
            { label: 'Balance', align: 'right', render: (row) => (row.balance_pesewas > 0
              ? el('span.badge-pill.amber', money(row.balance_pesewas)) : el('span.badge-pill.green', 'Paid')) }
          ],
          rows: purchases,
          empty: { title: 'No purchases recorded from this supplier', message: '' }
        }),
        el('h3.mt-24.mb-8', 'Payments made'),
        dataTable({
          columns: [
            { label: 'Reference', render: (row) => el('span.mono.text-sm', row.reference_no) },
            { label: 'Date', render: (row) => el('span.text-sm', dateTime(row.paid_at)) },
            { label: 'Method', render: (row) => paymentLabel(row.method) },
            { label: 'Recorded by', render: (row) => el('span.text-sm', row.user_name || '') },
            { label: 'Amount', align: 'right', render: (row) => el('strong.money', money(row.amount_pesewas)) }
          ],
          rows: payments,
          empty: { title: 'No payments recorded yet', message: '' }
        })
      ]),
      footer: () => el('div.row', [
        ctx.can('purchases.manage')
          ? el('button.btn', { type: 'button', onclick: () => { instance.close(null); ctx.navigate('purchases', { supplierId: person.id }); } }, 'Record a purchase')
          : null,
        el('span.grow'),
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Close'),
        ctx.can('suppliers.manage') && person.balance_pesewas > 0
          ? el('button.btn.primary', { type: 'button', onclick: () => { instance.close(null); payDialog(person); } }, 'Record a payment')
          : null
      ])
    });
  }

  mount(container,
    el('div.filters', [
      el('div.field.wide', [el('label', 'Search'), el('input', {
        type: 'search', placeholder: 'Name, company or phone…',
        oninput: debounce((event) => { state.search = event.target.value; state.page = 1; load(); }, 250)
      })]),
      el('div.field', [el('label', 'Show'), el('select', {
        onchange: (event) => { state.withBalanceOnly = event.target.value === 'owing'; state.page = 1; load(); }
      }, [
        el('option', { value: 'all' }, 'All suppliers'),
        el('option', { value: 'owing' }, 'Only suppliers we owe')
      ])]),
      el('span.grow'),
      ctx.can('suppliers.manage')
        ? el('button.btn.primary', { type: 'button', onclick: () => form(null) }, '+ Add supplier')
        : null
    ]),
    tableHost);

  await load();
  return container;
}

export const suppliersPage = {
  title: 'Suppliers',
  subtitle: 'Who you buy from and what you owe',
  permission: 'suppliers.view',
  render
};
