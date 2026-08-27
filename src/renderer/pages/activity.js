import { el, mount, debounce, downloadText } from '../utils/dom.js';
import { dateTime, todayKey } from '../utils/format.js';
import { tryCall } from '../services/api.js';
import { toast } from '../components/toast.js';
import { dataTable, pager } from '../components/table.js';

/**
 * Audit trail. The database itself refuses UPDATE and DELETE on these rows, so
 * what is shown here is what actually happened.
 */

const ACTION_TONES = [
  [/refund|void|written_off|deleted|disable/, 'red'],
  [/sale\.completed|payment|backup\.created/, 'green'],
  [/created|added/, 'blue'],
  [/updated|adjusted|permissions/, 'amber']
];

function toneFor(action) {
  for (const [pattern, tone] of ACTION_TONES) if (pattern.test(action)) return tone;
  return '';
}

function describe(row) {
  if (!row.details) return '';
  try {
    const details = JSON.parse(row.details);
    return Object.entries(details)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
      .join(' · ');
  } catch {
    return row.details;
  }
}

async function render(ctx) {
  const state = {
    search: '', action: '', from: '', to: '', page: 1, pageSize: 50,
    data: { rows: [], total: 0, pages: 1, page: 1, pageSize: 50 },
    actions: []
  };
  const container = el('div');
  const tableHost = el('div.card');

  const actionsResult = await tryCall('activity', 'actions', undefined, { silent: true });
  state.actions = actionsResult.ok ? actionsResult.data : [];

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
    const result = await tryCall('activity', 'list', {
      search: state.search, action: state.action, ...rangeParams(),
      page: state.page, pageSize: state.pageSize
    });
    if (!result.ok) return;
    state.data = result.data;
    paint();
  }

  function paint() {
    mount(tableHost, [
      dataTable({
        columns: [
          { label: 'When', width: '170px', render: (row) => el('span.text-sm', dateTime(row.created_at)) },
          { label: 'User', render: (row) => el('div', [
            el('div.strong', row.user_full_name || row.username || 'System'),
            row.username ? el('div.text-sm.muted', `@${row.username}`) : null
          ]) },
          { label: 'Action', render: (row) => el(`span.badge-pill${toneFor(row.action) ? `.${toneFor(row.action)}` : ''}`, row.action) },
          { label: 'Record', render: (row) => el('span.text-sm.muted',
            row.entity_type ? `${row.entity_type}${row.entity_id ? ` #${row.entity_id}` : ''}` : '') },
          { label: 'Details', render: (row) => el('span.text-sm', describe(row)) }
        ],
        rows: state.data.rows,
        empty: { title: 'No activity recorded for this filter', message: '' }
      }),
      pager({ ...state.data, onPage: (page) => { state.page = page; load(); } })
    ]);
  }

  async function exportCsv() {
    const result = await tryCall('reports', 'export', { kind: 'activity', rows: state.data.rows });
    if (!result.ok) {
      toast.warn('You need reporting access to export the activity log.');
      return;
    }
    const name = `activity_log_${todayKey()}.csv`;
    const saved = await tryCall('file', 'saveAs', { defaultName: name, content: result.data });
    if (saved.ok && !saved.data.cancelled) toast.success(`Saved to ${saved.data.path}`);
    else if (!saved.ok) downloadText(name, result.data);
  }

  mount(container,
    el('div.callout.info.mb-16', 'This log cannot be edited or deleted — not by staff, and not by the owner. It is the record of who did what.'),
    el('div.filters', [
      el('div.field.wide', [el('label', 'Search'), el('input', {
        type: 'search', placeholder: 'User, action or detail…',
        oninput: debounce((event) => { state.search = event.target.value; state.page = 1; load(); }, 250)
      })]),
      el('div.field', [el('label', 'Action'), el('select', {
        onchange: (event) => { state.action = event.target.value; state.page = 1; load(); }
      }, [
        el('option', { value: '' }, 'All actions'),
        ...state.actions.map((action) => el('option', { value: action }, action))
      ])]),
      el('div.field', [el('label', 'From'), el('input', {
        type: 'date', onchange: (event) => { state.from = event.target.value; state.page = 1; load(); }
      })]),
      el('div.field', [el('label', 'To'), el('input', {
        type: 'date', onchange: (event) => { state.to = event.target.value; state.page = 1; load(); }
      })]),
      el('span.grow'),
      el('button.btn', { type: 'button', onclick: exportCsv }, '⬇ Export this page')
    ]),
    tableHost);

  await load();
  return container;
}

export const activityPage = {
  title: 'Activity Log',
  subtitle: 'Who did what, and when',
  permission: 'activity.view',
  render
};
