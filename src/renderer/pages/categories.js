import { el, mount, field, debounce } from '../utils/dom.js';
import { tryCall } from '../services/api.js';
import { toast } from '../components/toast.js';
import { openModal, confirmModal } from '../components/modal.js';
import { dataTable } from '../components/table.js';

async function render(ctx) {
  const state = { search: '', rows: [] };
  const container = el('div');
  const tableHost = el('div.card');

  async function load() {
    const result = await tryCall('categories', 'list', { search: state.search });
    if (!result.ok) return;
    state.rows = result.data;
    paint();
  }

  function paint() {
    mount(tableHost, dataTable({
      columns: [
        { label: 'Category', render: (row) => el('div', [
          el('div.strong', row.name),
          row.description ? el('div.text-sm.muted', row.description) : null
        ]) },
        { label: 'Products', align: 'right', render: (row) => el('span.badge-pill', String(row.product_count)) },
        { label: '', align: 'right', render: (row) => el('div.actions', [
          ctx.can('categories.manage') ? el('button.btn.sm', { type: 'button', onclick: () => form(row) }, 'Edit') : null,
          ctx.can('categories.manage') ? el('button.btn.sm.danger', { type: 'button', onclick: () => remove(row) }, 'Delete') : null
        ]) }
      ],
      rows: state.rows,
      empty: {
        title: 'No categories yet',
        message: 'Categories make it faster to find products at the till.',
        action: ctx.can('categories.manage')
          ? el('button.btn.primary', { type: 'button', onclick: () => form(null) }, '+ Add category')
          : null
      }
    }));
  }

  function form(category) {
    const nameInput = el('input', { type: 'text', value: category ? category.name : '', 'data-autofocus': '' });
    const descInput = el('input', { type: 'text', value: category ? (category.description || '') : '' });
    const errorNode = el('div.error-text.hidden');

    const save = async (button) => {
      button.disabled = true;
      const result = await tryCall('categories', category ? 'update' : 'create', {
        id: category ? category.id : undefined,
        name: nameInput.value, description: descInput.value
      }, { silent: true });
      button.disabled = false;
      if (!result.ok) {
        errorNode.textContent = result.error.message;
        errorNode.classList.remove('hidden');
        return;
      }
      toast.success(category ? 'Category updated.' : 'Category added.');
      instance.close(null);
      load();
    };

    const instance = openModal({
      title: category ? `Edit ${category.name}` : 'Add a category',
      size: 'narrow',
      body: el('div', [errorNode, field('Name *', nameInput), field('Description', descInput)]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.primary', { type: 'button', onclick: (event) => save(event.currentTarget) }, 'Save')
      ])
    });
  }

  /** Deleting a category that still holds products asks where they should go. */
  async function remove(category) {
    if (category.product_count === 0) {
      const ok = await confirmModal({
        title: 'Delete category',
        message: `Delete "${category.name}"?`,
        confirmLabel: 'Delete', tone: 'danger'
      });
      if (!ok) return;
      const result = await tryCall('categories', 'delete', { id: category.id });
      if (result.ok) { toast.success('Category deleted.'); load(); }
      return;
    }

    let target = '';
    const others = state.rows.filter((row) => row.id !== category.id);
    const instance = openModal({
      title: `Delete ${category.name}`,
      body: el('div', [
        el('div.callout.warn', `${category.product_count} product${category.product_count === 1 ? '' : 's'} still belong to this category. Choose what should happen to them.`),
        el('div.mt-16', field('Move the products to', el('select', {
          onchange: (event) => { target = event.target.value; }
        }, [
          el('option', { value: '' }, 'Leave them uncategorised'),
          ...others.map((row) => el('option', { value: String(row.id) }, row.name))
        ])))
      ]),
      footer: () => el('div.row', [
        el('button.btn', { type: 'button', onclick: () => instance.close(null) }, 'Cancel'),
        el('button.btn.danger', {
          type: 'button',
          onclick: async (event) => {
            event.currentTarget.disabled = true;
            const result = await tryCall('categories', 'delete', {
              id: category.id, reassignTo: target ? Number(target) : null, force: !target
            });
            if (result.ok) {
              toast.success(`Category deleted. ${result.data.productsMoved} product${result.data.productsMoved === 1 ? '' : 's'} moved.`);
              instance.close(null);
              load();
            } else {
              event.currentTarget.disabled = false;
            }
          }
        }, 'Delete category')
      ])
    });
  }

  mount(container,
    el('div.filters', [
      el('div.field.wide', [el('label', 'Search'), el('input', {
        type: 'search', placeholder: 'Category name…',
        oninput: debounce((event) => { state.search = event.target.value; load(); }, 250)
      })]),
      el('span.grow'),
      ctx.can('categories.manage')
        ? el('button.btn.primary', { type: 'button', onclick: () => form(null) }, '+ Add category')
        : null
    ]),
    tableHost);

  await load();
  return container;
}

export const categoriesPage = {
  title: 'Categories',
  subtitle: 'Group your products',
  permission: 'products.view',
  render
};
