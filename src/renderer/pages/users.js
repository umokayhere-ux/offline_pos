import { el, mount, field } from '../utils/dom.js';
import { dateTime, initials } from '../utils/format.js';
import { tryCall } from '../services/api.js';
import { toast } from '../components/toast.js';
import { openModal, confirmModal } from '../components/modal.js';
import { dataTable } from '../components/table.js';

/**
 * Staff accounts and role permissions.
 *
 * Accounts are disabled rather than deleted: their sales, refunds and audit
 * entries must stay attributable to a real person.
 */

async function render(ctx) {
  const state = { users: [], roles: [], permissions: [] };
  const container = el('div');
  const tableHost = el('div.card');
  const rolesHost = el('div.card.mt-16');

  async function load() {
    const [users, roles, permissions] = await Promise.all([
      tryCall('users', 'list'),
      tryCall('users', 'roles'),
      tryCall('users', 'permissions')
    ]);
    if (!users.ok || !roles.ok || !permissions.ok) return;
    state.users = users.data;
    state.roles = roles.data;
    state.permissions = permissions.data;
    paint();
  }

  function paint() {
    mount(tableHost, [
      el('div.card-head', [el('h2', 'Staff accounts'), el('span.grow'),
        el('button.btn.primary.sm', { type: 'button', onclick: () => userForm(null) }, '+ Add user')]),
      el('div.card-body.flush', dataTable({
        columns: [
          { label: 'Name', render: (row) => el('div.row', [
            el('div.avatar', { style: { width: '30px', height: '30px', fontSize: '12px' } }, initials(row.fullName)),
            el('div', [
              el('div.strong', row.fullName),
              el('div.text-sm.muted', `@${row.username}`)
            ])
          ]) },
          { label: 'Role', render: (row) => el('span.badge-pill.brand', row.roleLabel) },
          { label: 'Contact', render: (row) => el('span.text-sm', [row.phone, row.email].filter(Boolean).join(' · ') || '—') },
          { label: 'Last signed in', render: (row) => el('span.text-sm', row.lastLoginAt ? dateTime(row.lastLoginAt) : 'Never') },
          { label: 'Status', render: (row) => (row.status === 'active'
            ? el('span.badge-pill.ok', 'Active') : el('span.badge-pill.danger', 'Disabled')) },
          { label: '', align: 'right', render: (row) => el('div.actions', [
            el('button.btn.sm', { type: 'button', onclick: () => userForm(row) }, 'Edit'),
            el('button.btn.sm', { type: 'button', onclick: () => passwordDialog(row) }, 'Reset password'),
            row.status === 'active' && row.id !== ctx.user.id
              ? el('button.btn.sm.danger', { type: 'button', onclick: () => disable(row) }, 'Disable')
              : null
          ]) }
        ],
        rows: state.users
      }))
    ]);

    mount(rolesHost, [
      el('div.card-head', [el('h2', 'Roles and permissions')]),
      el('div.card-body', [
        el('div.callout.info.mb-16', 'The owner role always keeps full access. Tick what Managers and Sales Attendants are allowed to do — changes take effect the next time they act.'),
        el('div.grid.cols-3', state.roles.map((role) => rolePanel(role)))
      ])
    ]);
  }

  function rolePanel(role) {
    const isOwner = role.name === 'owner';
    const checkboxes = state.permissions.map((permission) => el('label.checkbox', [
      el('input', {
        type: 'checkbox',
        checked: isOwner || role.permissions.includes(permission.code),
        disabled: isOwner,
        dataset: { code: permission.code }
      }),
      el('span', permission.label)
    ]));

    const panel = el('div.card', [
      el('div.card-head', [
        el('h3', role.label),
        el('span.grow'),
        el('span.badge-pill', `${state.users.filter((u) => u.roleId === role.id).length} user(s)`)
      ]),
      el('div.card-body', { style: { maxHeight: '340px', overflowY: 'auto' } },
        isOwner
          ? el('div.callout.success', 'Full access to everything, including users, settings and backups.')
          : el('div.col.gap-4', checkboxes)),
      isOwner ? null : el('div.card-body', { style: { borderTop: '1px solid var(--border)' } }, [
        el('button.btn.primary.block.sm', {
          type: 'button',
          onclick: async (event) => {
            event.currentTarget.disabled = true;
            const selected = [...panel.querySelectorAll('input[type=checkbox]')]
              .filter((input) => input.checked)
              .map((input) => input.dataset.code);
            const result = await tryCall('users', 'setRolePermissions', { roleId: role.id, permissions: selected });
            event.currentTarget.disabled = false;
            if (!result.ok) return;
            toast.success(`Permissions for ${role.label} saved.`);
            await load();
          }
        }, 'Save permissions')
      ])
    ]);
    return panel;
  }

  function userForm(user) {
    const values = {
      fullName: user ? user.fullName : '',
      username: user ? user.username : '',
      role: user ? user.role : 'attendant',
      phone: user ? (user.phone || '') : '',
      email: user ? (user.email || '') : '',
      password: '',
      status: user ? user.status : 'active'
    };
    const bind = (key) => (event) => { values[key] = event.target.value; };
    const errorNode = el('div.callout.danger.hidden');

    const save = async (button) => {
      button.disabled = true;
      const result = await tryCall('users', user ? 'update' : 'create',
        { id: user ? user.id : undefined, ...values }, { silent: true });
      button.disabled = false;
      if (!result.ok) {
        errorNode.textContent = result.error.message;
        errorNode.classList.remove('hidden');
        return;
      }
      toast.success(user ? 'User updated.' : `${result.data.fullName} can now sign in.`);
      instance.close(null);
      load();
    };

    const instance = openModal({
      title: user ? `Edit ${user.fullName}` : 'Add a staff member',
      body: el('div', [
        errorNode,
        el('div.form-grid', [
          field('Full name *', el('input', { type: 'text', value: values.fullName, 'data-autofocus': '', oninput: bind('fullName') })),
          field('Username *', el('input', {
            type: 'text', value: values.username, disabled: !!user, autocomplete: 'off', oninput: bind('username')
          }), { help: user ? 'Usernames cannot be changed once created.' : 'Letters, numbers, dots, dashes and underscores.' }),
          user ? null : field('Password *', el('input', {
            type: 'password', autocomplete: 'off', oninput: bind('password')
          })),
          field('Role *', el('select', { onchange: bind('role') }, state.roles.map((role) => el('option', {
            value: role.name, selected: values.role === role.name
          }, role.label)))),
          field('Phone', el('input', { type: 'tel', value: values.phone, oninput: bind('phone') })),
          field('Email', el('input', { type: 'email', value: values.email, oninput: bind('email') })),
          user ? el('div.full', field('Status', el('select', { onchange: bind('status') }, [
            el('option', { value: 'active', selected: values.status === 'active' }, 'Active — can sign in'),
            el('option', { value: 'disabled', selected: values.status === 'disabled' }, 'Disabled — cannot sign in')
          ]))) : null
        ])
      ]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.primary', { type: 'button', onclick: (event) => save(event.currentTarget) }, 'Save')
      ])
    });
  }

  function passwordDialog(user) {
    const passwordInput = el('input', { type: 'password', 'data-autofocus': '', autocomplete: 'off' });
    const confirmInput = el('input', { type: 'password', autocomplete: 'off' });
    const errorNode = el('div.error-text.hidden');

    const save = async (button) => {
      if (passwordInput.value !== confirmInput.value) {
        errorNode.textContent = 'The two passwords do not match.';
        errorNode.classList.remove('hidden');
        return;
      }
      button.disabled = true;
      const result = await tryCall('users', 'setPassword', { id: user.id, password: passwordInput.value }, { silent: true });
      button.disabled = false;
      if (!result.ok) {
        errorNode.textContent = result.error.message;
        errorNode.classList.remove('hidden');
        return;
      }
      toast.success(`Password reset for ${user.fullName}.`);
      instance.close(null);
    };

    const instance = openModal({
      title: `Reset password — ${user.fullName}`,
      size: 'narrow',
      body: el('div', [
        errorNode,
        field('New password', passwordInput),
        field('Confirm password', confirmInput),
        el('div.callout.warn', 'Tell the user their new password in person. It cannot be recovered later.')
      ]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.primary', { type: 'button', onclick: (event) => save(event.currentTarget) }, 'Reset password')
      ])
    });
  }

  async function disable(user) {
    const ok = await confirmModal({
      title: 'Disable account',
      message: `Stop ${user.fullName} from signing in?`,
      detail: 'Their past sales, refunds and audit entries stay in the system — accounts are disabled, never deleted.',
      confirmLabel: 'Disable', tone: 'danger'
    });
    if (!ok) return;
    const result = await tryCall('users', 'disable', { id: user.id });
    if (result.ok) { toast.success('Account disabled.'); load(); }
  }

  mount(container, tableHost, rolesHost);
  await load();
  return container;
}

export const usersPage = {
  title: 'Users',
  subtitle: 'Staff accounts and what they may do',
  permission: 'users.manage',
  render
};
