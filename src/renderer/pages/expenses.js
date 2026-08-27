import { el, mount, field, debounce } from '../utils/dom.js';
import { money, moneyInput, parseMoney, dateTime, todayKey, paymentLabel } from '../utils/format.js';
import { tryCall } from '../services/api.js';
import { toast } from '../components/toast.js';
import { openModal, promptModal, confirmModal } from '../components/modal.js';
import { dataTable, pager } from '../components/table.js';

/**
 * Expenses. These are financial records: they are voided with a reason rather
 * than deleted, so the audit trail and past profit figures stay explainable.
 */

async function render(ctx) {
  const state = {
    search: '', categoryId: '', includeVoided: false,
    from: '', to: '', page: 1, pageSize: 25,
    data: { rows: [], total: 0, pages: 1, page: 1, pageSize: 25, totals: {} },
    categories: []
  };
  const container = el('div');
  const tableHost = el('div.card');
  const summaryHost = el('div.grid.cols-3.mb-16');

  const categoriesResult = await tryCall('expenses', 'categories');
  state.categories = categoriesResult.ok ? categoriesResult.data : [];

  function rangeParams() {
    if (!state.from && !state.to) return {};
    const from = state.from || '2000-01-01';
    const to = state.to || todayKey();
    return {
      from: new Date(`${from}T00:00:00.000Z`).toISOString(),
      to: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86400000).toISOString()
    };
  }

  async function load() {
    const result = await tryCall('expenses', 'list', {
      search: state.search, categoryId: state.categoryId || null,
      includeVoided: state.includeVoided, ...rangeParams(),
      page: state.page, pageSize: state.pageSize
    });
    if (!result.ok) return;
    state.data = result.data;
    paint();
  }

  function paint() {
    mount(summaryHost, [
      el('div.stat.amber', [
        el('div.label', 'Total in this view'),
        el('div.value', money((state.data.totals || {}).amount_pesewas || 0)),
        el('div.hint', `${state.data.total} entr${state.data.total === 1 ? 'y' : 'ies'}`)
      ]),
      el('div.stat', [
        el('div.label', 'Categories in use'), el('div.value.sm', String(state.categories.filter((c) => c.expense_count > 0).length))
      ]),
      el('div.stat', [
        el('div.label', 'Average expense'),
        el('div.value.sm', money(state.data.total > 0 ? Math.round(((state.data.totals || {}).amount_pesewas || 0) / state.data.total) : 0))
      ])
    ]);

    mount(tableHost, [
      dataTable({
        columns: [
          { label: 'Reference', render: (row) => el('span.mono.text-sm', row.reference_no) },
          { label: 'Date', render: (row) => el('span.text-sm', dateTime(row.spent_at)) },
          { label: 'Category', render: (row) => el('span.badge-pill.blue', row.category_name) },
          { label: 'Description', render: (row) => el('div', [
            el('div', row.description),
            row.notes ? el('div.text-sm.muted', row.notes) : null,
            row.status === 'voided' ? el('div.text-sm', { style: { color: 'var(--red)' } }, `Voided: ${row.voided_reason}`) : null
          ]) },
          { label: 'Method', render: (row) => el('span.text-sm', paymentLabel(row.payment_method)) },
          { label: 'By', render: (row) => el('span.text-sm', row.user_name || '') },
          { label: 'Amount', align: 'right', render: (row) => el('strong.money', {
            style: row.status === 'voided' ? { textDecoration: 'line-through', opacity: '.5' } : {}
          }, money(row.amount_pesewas)) },
          { label: '', align: 'right', render: (row) => el('div.actions', [
            ctx.can('expenses.manage') && row.status === 'active'
              ? el('button.btn.sm', { type: 'button', onclick: () => form(row) }, 'Edit')
              : null,
            ctx.can('expenses.manage') && row.status === 'active'
              ? el('button.btn.sm.danger', { type: 'button', onclick: () => voidExpense(row) }, 'Void')
              : null
          ]) }
        ],
        rows: state.data.rows,
        rowClass: (row) => (row.status === 'voided' ? 'muted' : ''),
        empty: {
          title: 'No expenses recorded',
          message: 'Recording expenses is what makes the net profit figure meaningful.',
          action: ctx.can('expenses.manage')
            ? el('button.btn.primary', { type: 'button', onclick: () => form(null) }, '+ Record expense')
            : null
        }
      }),
      pager({ ...state.data, onPage: (page) => { state.page = page; load(); } })
    ]);
  }

  function form(expense) {
    const values = {
      categoryId: expense ? String(expense.expense_category_id) : (state.categories[0] ? String(state.categories[0].id) : ''),
      description: expense ? expense.description : '',
      amount: expense ? moneyInput(expense.amount_pesewas) : '',
      paymentMethod: expense ? expense.payment_method : 'cash',
      spentAt: expense ? expense.spent_at.slice(0, 10) : todayKey(),
      notes: expense ? (expense.notes || '') : ''
    };
    const bind = (key) => (event) => { values[key] = event.target.value; };
    const errorNode = el('div.callout.danger.hidden');

    const categorySelect = el('select', { onchange: bind('categoryId') },
      state.categories.map((c) => el('option', {
        value: String(c.id), selected: values.categoryId === String(c.id)
      }, c.name)));

    const save = async (button) => {
      button.disabled = true;
      const result = await tryCall('expenses', expense ? 'update' : 'create', {
        id: expense ? expense.id : undefined,
        categoryId: Number(values.categoryId),
        description: values.description,
        amount: values.amount,
        paymentMethod: values.paymentMethod,
        spentAt: expense ? undefined : new Date(`${values.spentAt}T12:00:00.000Z`).toISOString(),
        notes: values.notes
      }, { silent: true });
      button.disabled = false;
      if (!result.ok) {
        errorNode.textContent = result.error.message;
        errorNode.classList.remove('hidden');
        return;
      }
      toast.success(expense ? 'Expense updated.' : `Expense ${result.data.reference_no} recorded.`);
      instance.close(null);
      load();
    };

    const instance = openModal({
      title: expense ? `Edit ${expense.reference_no}` : 'Record an expense',
      body: el('div', [
        errorNode,
        el('div.form-grid', [
          field('Category *', el('div.row', [
            categorySelect,
            ctx.can('expenses.manage')
              ? el('button.btn.sm', { type: 'button', title: 'Add a category', onclick: () => addCategory(categorySelect) }, '+')
              : null
          ])),
          field('Amount (₵) *', el('input.amount', { type: 'text', value: values.amount, placeholder: '0.00', oninput: bind('amount') })),
          el('div.full', field('Description *', el('input', {
            type: 'text', value: values.description, 'data-autofocus': '',
            placeholder: 'e.g. Electricity bill for August', oninput: bind('description')
          }))),
          field('Payment method', el('select', { onchange: bind('paymentMethod') }, [
            el('option', { value: 'cash', selected: values.paymentMethod === 'cash' }, 'Cash'),
            el('option', { value: 'momo', selected: values.paymentMethod === 'momo' }, 'Mobile Money'),
            el('option', { value: 'card', selected: values.paymentMethod === 'card' }, 'Card')
          ])),
          expense ? null : field('Date', el('input', { type: 'date', value: values.spentAt, oninput: bind('spentAt') })),
          el('div.full', field('Notes', el('textarea', { value: values.notes, oninput: bind('notes') })))
        ])
      ]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.primary', { type: 'button', onclick: (event) => save(event.currentTarget) }, 'Save')
      ])
    });
  }

  async function addCategory(selectNode) {
    const name = await promptModal({
      title: 'New expense category', label: 'Category name',
      placeholder: 'e.g. Security', confirmLabel: 'Add', minLength: 2
    });
    if (!name) return;
    const result = await tryCall('expenses', 'createCategory', { name });
    if (!result.ok) return;
    state.categories = result.data;
    const added = state.categories.find((c) => c.name === name);
    if (selectNode && added) {
      selectNode.appendChild(el('option', { value: String(added.id) }, added.name));
      selectNode.value = String(added.id);
      selectNode.dispatchEvent(new Event('change'));
    }
    toast.success(`Category "${name}" added.`);
  }

  async function voidExpense(expense) {
    const reason = await promptModal({
      title: `Void ${expense.reference_no}`,
      label: `Why is this ${money(expense.amount_pesewas)} expense being voided?`,
      placeholder: 'e.g. Entered twice by mistake',
      confirmLabel: 'Void expense', multiline: true
    });
    if (!reason) return;
    const result = await tryCall('expenses', 'void', { id: expense.id, reason });
    if (!result.ok) return;
    toast.success('Expense voided. The record is kept for the audit trail.');
    load();
  }

  function manageCategories() {
    const listHost = el('div');

    const paintList = () => {
      mount(listHost, dataTable({
        columns: [
          { label: 'Category', render: (row) => el('div.strong', row.name) },
          { label: 'Type', render: (row) => el('span.badge-pill', row.is_system ? 'Built-in' : 'Custom') },
          { label: 'Expenses', align: 'right', render: (row) => String(row.expense_count) },
          { label: '', align: 'right', render: (row) => (row.is_system || row.expense_count > 0
            ? null
            : el('button.btn.sm.danger', {
              type: 'button',
              onclick: async () => {
                const result = await tryCall('expenses', 'deleteCategory', { id: row.id });
                if (!result.ok) return;
                state.categories = result.data;
                paintList();
                toast.success('Category removed.');
              }
            }, 'Delete')) }
        ],
        rows: state.categories
      }));
    };
    paintList();

    const instance = openModal({
      title: 'Expense categories',
      size: 'wide',
      body: el('div', [
        el('div.callout.info', 'Built-in categories and any category already used by an expense cannot be removed.'),
        el('div.mt-16', listHost)
      ]),
      footer: () => el('div.row', [
        el('button.btn.primary', {
          type: 'button',
          onclick: async () => { await addCategory(null); paintList(); }
        }, '+ Add category'),
        el('span.grow'),
        el('button.btn', { type: 'button', onclick: () => { instance.close(null); load(); } }, 'Done')
      ])
    });
  }

  mount(container,
    el('div.filters', [
      el('div.field.wide', [el('label', 'Search'), el('input', {
        type: 'search', placeholder: 'Description, reference or category…',
        oninput: debounce((event) => { state.search = event.target.value; state.page = 1; load(); }, 250)
      })]),
      el('div.field', [el('label', 'Category'), el('select', {
        onchange: (event) => { state.categoryId = event.target.value; state.page = 1; load(); }
      }, [
        el('option', { value: '' }, 'All categories'),
        ...state.categories.map((c) => el('option', { value: String(c.id) }, c.name))
      ])]),
      el('div.field', [el('label', 'From'), el('input', {
        type: 'date', onchange: (event) => { state.from = event.target.value; state.page = 1; load(); }
      })]),
      el('div.field', [el('label', 'To'), el('input', {
        type: 'date', onchange: (event) => { state.to = event.target.value; state.page = 1; load(); }
      })]),
      el('div.field', [el('label', 'Voided'), el('select', {
        onchange: (event) => { state.includeVoided = event.target.value === 'yes'; state.page = 1; load(); }
      }, [
        el('option', { value: 'no' }, 'Hide voided'),
        el('option', { value: 'yes' }, 'Show voided')
      ])]),
      el('span.grow'),
      ctx.can('expenses.manage')
        ? el('button.btn', { type: 'button', onclick: manageCategories }, 'Categories')
        : null,
      ctx.can('expenses.manage')
        ? el('button.btn.primary', { type: 'button', onclick: () => form(null) }, '+ Record expense')
        : null
    ]),
    summaryHost, tableHost);

  await load();
  return container;
}

export const expensesPage = {
  title: 'Expenses',
  subtitle: 'What the shop spends',
  permission: 'expenses.view',
  render
};
