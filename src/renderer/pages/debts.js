import { el, mount, field, debounce } from '../utils/dom.js';
import { money, moneyInput, parseMoney, dateTime, date, paymentLabel } from '../utils/format.js';
import { tryCall } from '../services/api.js';
import { toast } from '../components/toast.js';
import { openModal, promptModal } from '../components/modal.js';
import { dataTable, pager } from '../components/table.js';

/**
 * Customer debts. Payments are appended — a correction is another transaction,
 * never an edit — so the history a customer can be shown is always complete.
 */

async function render(ctx) {
  const state = {
    search: '', status: 'open', customerId: ctx.params.customerId || null,
    page: 1, pageSize: 25,
    data: { rows: [], total: 0, pages: 1, page: 1, pageSize: 25, totals: {} }
  };
  const container = el('div');
  const summaryHost = el('div.grid.cols-3');
  const tableHost = el('div.card.mt-16');

  async function load() {
    const result = await tryCall('debts', 'list', {
      search: state.search, status: state.status, customerId: state.customerId,
      page: state.page, pageSize: state.pageSize
    });
    if (!result.ok) return;
    state.data = result.data;
    paint();
  }

  function paint() {
    const totals = state.data.totals || {};
    mount(summaryHost, [
      el('div.stat.red', [
        el('div.label', 'Outstanding'), el('div.value', money(totals.outstanding_pesewas || 0)),
        el('div.hint', `${state.data.total} account${state.data.total === 1 ? '' : 's'} in this view`)
      ]),
      el('div.stat.green', [
        el('div.label', 'Already collected'), el('div.value', money(totals.paid_pesewas || 0))
      ]),
      el('div.stat', [
        el('div.label', 'Originally issued'), el('div.value', money(totals.original_pesewas || 0))
      ])
    ]);

    mount(tableHost, [
      dataTable({
        columns: [
          { label: 'Customer', render: (row) => el('div', [
            el('div.strong', row.customer_name),
            el('div.text-sm.muted', row.customer_phone || 'No phone number')
          ]) },
          { label: 'Invoice', render: (row) => el('span.mono.text-sm', row.invoice_no || '—') },
          { label: 'Opened', render: (row) => el('span.text-sm', date(row.opened_at)) },
          { label: 'Original', align: 'right', render: (row) => el('span.money', money(row.original_pesewas)) },
          { label: 'Paid', align: 'right', render: (row) => el('span.money', money(row.paid_pesewas)) },
          { label: 'Outstanding', align: 'right', render: (row) => el('strong.money', money(row.outstanding_pesewas)) },
          { label: 'Status', render: (row) => el('span.badge-pill', {
            class: row.status === 'settled' ? 'green' : (row.status === 'written_off' ? 'amber' : 'red')
          }, row.status.replace('_', ' ')) },
          { label: '', align: 'right', render: (row) => el('div.actions', [
            el('button.btn.sm', { type: 'button', onclick: () => detail(row) }, 'History'),
            ctx.can('debts.manage') && row.status === 'open'
              ? el('button.btn.sm.primary', { type: 'button', onclick: () => paymentDialog(row) }, 'Take payment')
              : null,
            ctx.can('debts.manage') && row.status === 'open'
              ? el('button.btn.sm.danger', { type: 'button', onclick: () => writeOff(row) }, 'Write off')
              : null
          ]) }
        ],
        rows: state.data.rows,
        onRowClick: (row) => detail(row),
        empty: {
          title: state.status === 'open' ? 'No outstanding debts' : 'Nothing to show',
          message: state.status === 'open'
            ? 'Every customer account is settled. Credit sales appear here automatically.'
            : 'Try a different status filter.'
        }
      }),
      pager({ ...state.data, onPage: (page) => { state.page = page; load(); } })
    ]);
  }

  async function detail(account) {
    const result = await tryCall('debts', 'get', { id: account.id });
    if (!result.ok) return;
    const { account: head, payments } = result.data;

    const instance = openModal({
      title: `${head.customer_name} — ${head.invoice_no || 'debt account'}`,
      size: 'wide',
      body: el('div', [
        el('div.grid.cols-3', [
          el('div.stat', [el('div.label', 'Original amount'), el('div.value.sm', money(head.original_pesewas))]),
          el('div.stat.green', [el('div.label', 'Paid so far'), el('div.value.sm', money(head.paid_pesewas))]),
          el('div.stat.red', [el('div.label', 'Outstanding'), el('div.value.sm', money(head.outstanding_pesewas))])
        ]),
        el('div.detail-list.mt-16', [
          el('div.item', [el('span.k', 'Opened'), el('span.v', dateTime(head.opened_at))]),
          head.settled_at ? el('div.item', [el('span.k', 'Closed'), el('span.v', dateTime(head.settled_at))]) : null,
          el('div.item', [el('span.k', 'Status'), el('span.v', head.status.replace('_', ' '))]),
          head.note ? el('div.item', [el('span.k', 'Note'), el('span.v', head.note)]) : null
        ]),
        el('h3.mt-24.mb-8', 'Payment history'),
        dataTable({
          columns: [
            { label: 'Reference', render: (row) => el('span.mono.text-sm', row.reference_no) },
            { label: 'Date', render: (row) => el('span.text-sm', dateTime(row.paid_at)) },
            { label: 'Method', render: (row) => paymentLabel(row.method) },
            { label: 'Received by', render: (row) => el('span.text-sm', row.user_name || '') },
            { label: 'Note', render: (row) => el('span.text-sm.muted', row.note || '') },
            { label: 'Amount', align: 'right', render: (row) => el('strong.money', money(row.amount_pesewas)) }
          ],
          rows: payments,
          empty: { title: 'No payments received yet', message: '' }
        })
      ]),
      footer: () => el('div.row', [
        el('span.grow'),
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Close'),
        ctx.can('debts.manage') && head.status === 'open'
          ? el('button.btn.primary', { type: 'button', onclick: () => { instance.close(null); paymentDialog(head); } }, 'Take payment')
          : null
      ])
    });
  }

  function paymentDialog(account) {
    const amountInput = el('input.amount', {
      type: 'text', 'data-autofocus': '', value: moneyInput(account.outstanding_pesewas)
    });
    const methodSelect = el('select', {}, [
      el('option', { value: 'cash' }, 'Cash'),
      el('option', { value: 'momo' }, 'Mobile Money'),
      el('option', { value: 'card' }, 'Card')
    ]);
    const noteInput = el('input', { type: 'text', placeholder: 'Optional note' });
    const errorNode = el('div.error-text.hidden');
    const remainingNode = el('div.callout.info');

    const updateRemaining = () => {
      const amount = parseMoney(amountInput.value);
      if (amount === null) { remainingNode.textContent = 'Enter a valid amount.'; return; }
      remainingNode.textContent = `After this payment, ${account.customer_name} will owe ${money(Math.max(0, account.outstanding_pesewas - amount))} on this account.`;
    };
    amountInput.addEventListener('input', updateRemaining);
    updateRemaining();

    const save = async (button) => {
      const amount = parseMoney(amountInput.value);
      if (amount === null || amount <= 0) {
        errorNode.textContent = 'Enter a valid amount greater than zero.';
        errorNode.classList.remove('hidden');
        return;
      }
      button.disabled = true;
      const result = await tryCall('debts', 'recordPayment', {
        debtAccountId: account.id, amount: moneyInput(amount),
        method: methodSelect.value, note: noteInput.value
      }, { silent: true });
      button.disabled = false;
      if (!result.ok) {
        errorNode.textContent = result.error.message;
        errorNode.classList.remove('hidden');
        return;
      }
      toast.success(result.data.settled
        ? `Debt settled in full. Receipt ${result.data.reference}.`
        : `${money(result.data.amountPesewas)} received. ${money(result.data.outstandingPesewas)} still outstanding.`);
      instance.close(null);
      load();
      ctx.refreshBadges();
    };

    const instance = openModal({
      title: `Take payment — ${account.customer_name}`,
      body: el('div', [
        errorNode,
        el('div.detail-list.mb-16', [
          el('div.item', [el('span.k', 'Invoice'), el('span.v', account.invoice_no || '—')]),
          el('div.item', [el('span.k', 'Outstanding'), el('span.v.money', money(account.outstanding_pesewas))])
        ]),
        field('Amount received (₵) *', amountInput),
        field('Payment method', methodSelect),
        field('Note', noteInput),
        remainingNode
      ]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.primary', { type: 'button', onclick: (event) => save(event.currentTarget) }, 'Record payment')
      ])
    });
  }

  async function writeOff(account) {
    const reason = await promptModal({
      title: `Write off ${money(account.outstanding_pesewas)}`,
      label: `Why is this debt from ${account.customer_name} being written off?`,
      placeholder: 'e.g. Customer relocated, uncollectable',
      confirmLabel: 'Write off the debt',
      multiline: true
    });
    if (!reason) return;
    const result = await tryCall('debts', 'writeOff', { id: account.id, reason });
    if (!result.ok) return;
    toast.success(`${money(result.data.writtenOffPesewas)} written off. The original sale is unchanged.`);
    load();
    ctx.refreshBadges();
  }

  mount(container,
    el('div.filters', [
      el('div.field.wide', [el('label', 'Search'), el('input', {
        type: 'search', placeholder: 'Customer name, phone or invoice…',
        oninput: debounce((event) => { state.search = event.target.value; state.page = 1; load(); }, 250)
      })]),
      el('div.field', [el('label', 'Status'), el('select', {
        onchange: (event) => { state.status = event.target.value; state.page = 1; load(); }
      }, [
        el('option', { value: 'open' }, 'Open debts'),
        el('option', { value: 'settled' }, 'Settled'),
        el('option', { value: 'written_off' }, 'Written off'),
        el('option', { value: 'all' }, 'All')
      ])]),
      state.customerId
        ? el('button.btn', { type: 'button', onclick: () => { state.customerId = null; load(); } }, 'Show all customers')
        : null
    ]),
    summaryHost, tableHost);

  await load();
  return container;
}

export const debtsPage = {
  title: 'Debts',
  subtitle: 'Money customers owe the shop',
  permission: 'debts.view',
  render
};
