import { el, mount } from '../utils/dom.js';
import { dateTime, relative } from '../utils/format.js';
import { tryCall } from '../services/api.js';
import { toast } from '../components/toast.js';
import { openModal, confirmModal } from '../components/modal.js';
import { icon } from '../components/icons.js';
import { dataTable } from '../components/table.js';

/**
 * Backup and restore.
 *
 * Restoring is deliberately slow and loud: the file is validated, the user
 * confirms twice, and a safety copy of the live database is taken before
 * anything is replaced.
 */

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function render(ctx) {
  const state = { history: [], settings: ctx.settings };
  const container = el('div');
  const tableHost = el('div.card.mt-16');
  const statusHost = el('div.grid.cols-3');

  async function load() {
    const [history, settings] = await Promise.all([
      tryCall('backup', 'history'),
      tryCall('settings', 'all', undefined, { silent: true })
    ]);
    if (history.ok) state.history = history.data;
    if (settings.ok) state.settings = settings.data;
    paint();
  }

  function paint() {
    const lastRun = state.settings['backup.last_run_at'];
    mount(statusHost, [
      el('div.stat', [
        el('div.label', 'Last backup'),
        el('div.value.sm', lastRun ? relative(lastRun) : 'Never'),
        el('div.hint', lastRun ? dateTime(lastRun) : 'Take your first backup now')
      ]),
      el('div.stat', [
        el('div.label', 'Backup folder'),
        el('div.value.sm', { style: { fontSize: '13px', wordBreak: 'break-all' } },
          state.settings['backup.directory'] || 'Application data folder'),
        el('div.hint', 'Where new backups are written')
      ]),
      el('div.stat', [
        el('div.label', 'Automatic backups'),
        el('div.value.sm', { style: { textTransform: 'capitalize' } }, state.settings['backup.frequency'] || 'daily'),
        el('div.hint', 'Runs shortly after the application starts')
      ])
    ]);

    mount(tableHost, [
      el('div.card-head', [el('h2', 'Backup history')]),
      el('div.card-body.flush', dataTable({
        columns: [
          { label: 'File', render: (row) => el('div', [
            el('div.strong.mono.text-sm', row.filename),
            el('div.text-sm.muted', { style: { wordBreak: 'break-all' } }, row.path)
          ]) },
          { label: 'Taken', render: (row) => el('span.text-sm', dateTime(row.created_at)) },
          { label: 'Type', render: (row) => el('span.badge-pill', {
            class: row.kind === 'automatic' ? 'brand' : (row.kind === 'pre_restore' ? 'warn' : '')
          }, row.kind.replace('_', ' ')) },
          { label: 'Size', align: 'right', render: (row) => formatSize(row.size_bytes) },
          { label: 'By', render: (row) => el('span.text-sm', row.user_name || 'System') },
          { label: 'Status', render: (row) => (row.exists
            ? el('span.badge-pill.ok', 'Available')
            : el('span.badge-pill.danger', 'File missing')) },
          { label: '', align: 'right', render: (row) => el('div.actions', [
            row.exists ? el('button.btn.sm', { type: 'button', onclick: () => restoreFrom(row.path) }, 'Restore') : null,
            el('button.btn.sm.danger', { type: 'button', onclick: () => remove(row) }, 'Delete')
          ]) }
        ],
        rows: state.history,
        empty: {
          title: 'No backups yet',
          message: 'A backup is a complete copy of your shop data. Keep one on a USB stick as well as on this PC.',
          action: el('button.btn.primary', { type: 'button', onclick: createBackup }, [icon('save', { size: 15 }), 'Create a backup now'])
        }
      }))
    ]);
  }

  async function createBackup(event) {
    if (event && event.currentTarget) event.currentTarget.disabled = true;
    const result = await tryCall('backup', 'create');
    if (event && event.currentTarget) event.currentTarget.disabled = false;
    if (!result.ok) return;
    toast.success(`Backup saved as ${result.data.filename} (${formatSize(result.data.size_bytes)}).`);
    load();
  }

  async function chooseFolder() {
    const result = await tryCall('backup', 'chooseDirectory');
    if (!result.ok || result.data.cancelled) return;
    toast.success(`Backups will now be written to ${result.data.path}`);
    await ctx.reloadSettings();
    load();
  }

  /** Restore from a file the user picks with the system file dialog. */
  async function restoreFromFile() {
    const picked = await tryCall('backup', 'chooseFile');
    if (!picked.ok || picked.data.cancelled) return;
    if (!picked.data.check.valid) {
      toast.error(picked.data.check.reason);
      return;
    }
    showRestoreDialog(picked.data.path, picked.data.check);
  }

  async function restoreFrom(path) {
    const check = await tryCall('backup', 'validate', { path });
    if (!check.ok) return;
    if (!check.data.valid) { toast.error(check.data.reason); return; }
    showRestoreDialog(path, check.data);
  }

  function showRestoreDialog(path, check) {
    const confirmInput = el('input', { type: 'text', 'data-autofocus': '', placeholder: 'Type RESTORE to continue' });
    const errorNode = el('div.error-text.hidden');

    const instance = openModal({
      title: 'Restore from backup',
      closeOnBackdrop: false,
      body: el('div', [
        el('div.callout.danger', [
          el('div.strong', 'This replaces everything currently in the system.'),
          el('div', 'Any sale, expense or stock change recorded since this backup was taken will be lost.')
        ]),
        el('div.detail-list.mt-16', [
          el('div.item', [el('span.k', 'File'), el('span.v.mono.text-sm', { style: { wordBreak: 'break-all' } }, path)]),
          el('div.item', [el('span.k', 'Shop in backup'), el('span.v', check.stats.shopName || '—')]),
          el('div.item', [el('span.k', 'Products'), el('span.v', String(check.stats.products))]),
          el('div.item', [el('span.k', 'Sales'), el('span.v', String(check.stats.sales))]),
          el('div.item', [el('span.k', 'Customers'), el('span.v', String(check.stats.customers))]),
          el('div.item', [el('span.k', 'User accounts'), el('span.v', String(check.stats.users))]),
          el('div.item', [el('span.k', 'File date'), el('span.v', dateTime(check.modifiedAt))])
        ]),
        el('div.callout.info.mt-16', 'A safety copy of your current database is taken automatically before the restore, so this can be undone.'),
        el('div.mt-16', [
          el('label', { style: { fontSize: '12.5px', fontWeight: '600' } }, 'Type RESTORE to confirm'),
          confirmInput,
          errorNode
        ])
      ]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.danger', {
          type: 'button',
          onclick: async (event) => {
            if (confirmInput.value.trim().toUpperCase() !== 'RESTORE') {
              errorNode.textContent = 'Type RESTORE exactly to confirm.';
              errorNode.classList.remove('hidden');
              return;
            }
            event.currentTarget.disabled = true;
            const result = await tryCall('backup', 'restore', { path, confirmed: true });
            if (!result.ok) { event.currentTarget.disabled = false; return; }
            instance.close(null);
            if (result.data.cancelled) return;
            toast.success('Database restored. Please sign in again.');
            setTimeout(() => window.location.reload(), 1200);
          }
        }, 'Restore now')
      ])
    });
  }

  async function remove(row) {
    const ok = await confirmModal({
      title: 'Delete backup file',
      message: `Delete ${row.filename}?`,
      detail: 'The backup file is removed from disk. Your live data is not affected.',
      confirmLabel: 'Delete', tone: 'danger'
    });
    if (!ok) return;
    const result = await tryCall('backup', 'delete', { id: row.id });
    if (result.ok) { toast.success('Backup file deleted.'); load(); }
  }

  async function setFrequency(value) {
    const result = await tryCall('settings', 'update', { 'backup.frequency': value });
    if (!result.ok) return;
    await ctx.reloadSettings();
    toast.success('Automatic backup schedule saved.');
    load();
  }

  mount(container,
    el('div.card.mb-16', el('div.card-body', [
      el('div.row.wrap', [
        el('button.btn.primary', { type: 'button', onclick: createBackup }, [icon('save', { size: 15 }), 'Create backup now']),
        el('button.btn', { type: 'button', onclick: restoreFromFile }, [icon('restore', { size: 15 }), 'Restore from a file']),
        el('button.btn', { type: 'button', onclick: chooseFolder }, [icon('folder', { size: 15 }), 'Choose backup folder']),
        el('span.grow'),
        el('div.field', { style: { marginBottom: 0 } }, [
          el('label', 'Automatic backups'),
          el('select', { onchange: (event) => setFrequency(event.target.value) }, [
            el('option', { value: 'daily', selected: (state.settings['backup.frequency'] || 'daily') === 'daily' }, 'Daily'),
            el('option', { value: 'weekly', selected: state.settings['backup.frequency'] === 'weekly' }, 'Weekly'),
            el('option', { value: 'off', selected: state.settings['backup.frequency'] === 'off' }, 'Off')
          ])
        ])
      ]),
      el('div.callout.info.mt-16', 'Copy your backups onto a USB stick regularly. A backup stored only on this computer will not survive the computer failing.')
    ])),
    statusHost, tableHost);

  await load();
  return container;
}

export const backupPage = {
  title: 'Backup & Restore',
  subtitle: 'Protect your shop data',
  permission: 'backup.manage',
  render
};
