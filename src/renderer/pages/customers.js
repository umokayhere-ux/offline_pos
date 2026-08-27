import { el, mount, field, debounce } from '../utils/dom.js';
import { money, dateTime, date, paymentLabel } from '../utils/format.js';
import { tryCall } from '../services/api.js';
import { toast } from '../components/toast.js';
import { openModal, confirmModal } from '../components/modal.js';
import { dataTable, pager } from '../components/table.js';

async function render(ctx) {
  const state = {
    search: '', withDebtOnly: false, status: 'active', page: 1, pageSize: 25,
    data: { rows: [], total: 0, pages: 1, pageSize: 25, page: 1 }
  };
  const container = el('div');
  const tableHost = el('div.card');

  async function load() {
    const result = await tryCall('customers', 'list', {
      search: state.search, withDebtOnly: state.withDebtOnly,
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
          { label: 'Customer', render: (row) => el('div', [
            el('div.strong', row.name),
            el('div.text-sm.muted', row.phone || 'No phone number')
          ]) },
          { label: 'Address', render: (row) => el('span.text-sm', row.address || '—') },
          { label: 'Outstanding debt', align: 'right', render: (row) => (row.balance_pesewas > 0
            ? el('span.badge-pill.red', money(row.balance_pesewas))
            : el('span.badge-pill.green', 'Clear')) },
          { label: 'Customer since', align: 'right', render: (row) => el('span.text-sm', date(row.created_at)) },
          { label: '', align: 'right', render: (row) => el('div.actions', [
            el('button.btn.sm', { type: 'button', onclick: () => profile(row) }, 'View'),
            ctx.can('customers.manage') ? el('button.btn.sm', { type: 'button', onclick: () => form(row) }, 'Edit') : null,
            ctx.can('customers.manage') ? el('button.btn.sm.danger', { type: 'button', onclick: () => remove(row) }, 'Delete') : null
          ]) }
        ],
        rows: state.data.rows,
        onRowClick: (row) => profile(row),
        empty: {
          title: state.search ? 'No customers match your search' : 'No customers yet',
          message: 'Add customers to attach sales to an account and to sell on credit.',
          action: ctx.can('customers.manage')
            ? el('button.btn.primary', { type: 'button', onclick: () => form(null) }, '+ Add customer')
            : null
        }
      }),
      pager({ ...state.data, onPage: (page) => { state.page = page; load(); } })
    ]);
  }

  function form(customer) {
    const values = {
      name: customer ? customer.name : '',
      phone: customer ? (customer.phone || '') : '',
      email: customer ? (customer.email || '') : '',
      address: customer ? (customer.address || '') : '',
      notes: customer ? (customer.notes || '') : ''
    };
    const bind = (key) => (event) => { values[key] = event.target.value; };
    const errorNode = el('div.callout.danger.hidden');

    const save = async (button) => {
      button.disabled = true;
      const result = await tryCall('customers', customer ? 'update' : 'create',
        { id: customer ? customer.id : undefined, ...values }, { silent: true });
      button.disabled = false;
      if (!result.ok) {
        errorNode.textContent = result.error.message;
        errorNode.classList.remove('hidden');
        return;
      }
      toast.success(customer ? 'Customer updated.' : `${result.data.name} added.`);
      instance.close(null);
      load();
    };

    const instance = openModal({
      title: customer ? `Edit ${customer.name}` : 'Add a customer',
      body: el('div', [
        errorNode,
        el('div.form-grid', [
          field('Name *', el('input', { type: 'text', value: values.name, 'data-autofocus': '', oninput: bind('name') })),
          field('Phone number', el('input', { type: 'tel', value: values.phone, oninput: bind('phone') })),
          field('Email', el('input', { type: 'email', value: values.email, oninput: bind('email') })),
          field('Address', el('input', { type: 'text', value: values.address, oninput: bind('address') })),
          el('div.full', field('Notes', el('textarea', { value: values.notes, oninput: bind('notes') })))
        ])
      ]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.primary', { type: 'button', onclick: (event) => save(event.currentTarget) }, 'Save')
      ])
    });
  }

  async function remove(customer) {
    const ok = await confirmModal({
      title: 'Delete customer',
      message: `Delete ${customer.name}?`,
      detail: 'Customers with purchase history are archived rather than deleted, so their sales stay traceable.',
      confirmLabel: 'Delete', tone: 'danger'
    });
    if (!ok) return;
    const result = await tryCall('customers', 'delete', { id: customer.id });
    if (result.ok) { toast.success(result.data.message); load(); }
  }

  async function profile(customer) {
    const result = await tryCall('customers', 'profile', { id: customer.id });
    if (!result.ok) return;
    const { customer: person, sales, debts, payments, totals } = result.data;

    const instance = openModal({
      title: person.name,
      size: 'xwide',
      body: el('div', [
        el('div.grid.cols-4', [
          el('div.stat', [el('div.label', 'Lifetime purchases'), el('div.value.sm', money(totals.lifetime_pesewas))]),
          el('div.stat', [el('div.label', 'Number of sales'), el('div.value.sm', String(totals.purchase_count))]),
          el('div.stat', { class: person.balance_pesewas > 0 ? 'red' : 'green' }, [
            el('div.label', 'Outstanding debt'), el('div.value.sm', money(person.balance_pesewas))
          ]),
          el('div.stat', [el('div.label', 'Phone'), el('div.value.sm', person.phone || '—')])
        ]),

        el('h3.mt-24.mb-8', 'Purchase history'),
        dataTable({
          columns: [
            { label: 'Invoice', render: (row) => el('span.mono.text-sm', row.invoice_no) },
            { label: 'Date', render: (row) => el('span.text-sm', dateTime(row.sold_at)) },
            { label: 'Served by', render: (row) => el('span.text-sm', row.cashier || '') },
            { label: 'Method', render: (row) => el('span.badge-pill', paymentLabel(row.payment_method)) },
            { label: 'Total', align: 'right', render: (row) => el('strong.money', money(row.total_pesewas)) },
            { label: 'Still owed', align: 'right', render: (row) => (row.debt_pesewas > 0 ? el('span.badge-pill.red', money(row.debt_pesewas)) : '—') }
          ],
          rows: sales,
          empty: { title: 'No purchases yet', message: '' }
        }),

        debts.length > 0 ? el('h3.mt-24.mb-8', 'Debt accounts') : null,
        debts.length > 0 ? dataTable({
          columns: [
            { label: 'Invoice', render: (row) => el('span.mono.text-sm', row.invoice_no || '—') },
            { label: 'Opened', render: (row) => el('span.text-sm', date(row.opened_at)) },
            { label: 'Original', align: 'right', render: (row) => money(row.original_pesewas) },
            { label: 'Paid', align: 'right', render: (row) => money(row.paid_pesewas) },
            { label: 'Outstanding', align: 'right', render: (row) => el('strong.money', money(row.outstanding_pesewas)) },
            { label: 'Status', render: (row) => el('span.badge-pill', {
              class: row.status === 'settled' ? 'green' : (row.status === 'written_off' ? 'amber' : 'red')
            }, row.status.replace('_', ' ')) }
          ],
          rows: debts
        }) : null,

        payments.length > 0 ? el('h3.mt-24.mb-8', 'Debt payments received') : null,
        payments.length > 0 ? dataTable({
          columns: [
            { label: 'Reference', render: (row) => el('span.mono.text-sm', row.reference_no) },
            { label: 'Date', render: (row) => el('span.text-sm', dateTime(row.paid_at)) },
            { label: 'Method', render: (row) => paymentLabel(row.method) },
            { label: 'Received by', render: (row) => el('span.text-sm', row.user_name || '') },
            { label: 'Amount', align: 'right', render: (row) => el('strong.money', money(row.amount_pesewas)) }
          ],
          rows: payments
        }) : null
      ]),
      footer: () => el('div.row', [
        person.balance_pesewas > 0 && ctx.can('debts.view')
          ? el('button.btn', { type: 'button', onclick: () => { instance.close(null); ctx.navigate('debts', { customerId: person.id }); } }, 'Manage debts')
          : null,
        el('span.grow'),
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Close'),
        ctx.can('customers.manage')
          ? el('button.btn.primary', { type: 'button', onclick: () => { instance.close(null); form(person); } }, 'Edit')
          : null
      ])
    });
  }

  mount(container,
    el('div.filters', [
      el('div.field.wide', [el('label', 'Search'), el('input', {
        type: 'search', placeholder: 'Name or phone number…',
        oninput: debounce((event) => { state.search = event.target.value; state.page = 1; load(); }, 250)
      })]),
      el('div.field', [el('label', 'Show'), el('select', {
        onchange: (event) => { state.withDebtOnly = event.target.value === 'debt'; state.page = 1; load(); }
      }, [
        el('option', { value: 'all' }, 'All customers'),
        el('option', { value: 'debt' }, 'Only customers who owe money')
      ])]),
      el('div.field', [el('label', 'Status'), el('select', {
        onchange: (event) => { state.status = event.target.value; state.page = 1; load(); }
      }, [
        el('option', { value: 'active' }, 'Active'),
        el('option', { value: 'archived' }, 'Archived'),
        el('option', { value: 'all' }, 'All')
      ])]),
      el('span.grow'),
      ctx.can('customers.manage')
        ? el('button.btn.primary', { type: 'button', onclick: () => form(null) }, '+ Add customer')
        : null
    ]),
    tableHost);

  await load();
  return container;
}

export const customersPage = {
  title: 'Customers',
  subtitle: 'Accounts, purchase history and debts',
  permission: 'customers.view',
  render
};
