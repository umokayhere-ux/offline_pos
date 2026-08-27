import { el, emptyState } from '../utils/dom.js';

/**
 * A data table with optional sorting and paging.
 *
 * Only the current page is ever put in the DOM — a shop with 20,000 products
 * must not build 20,000 rows.
 */
export function dataTable({
  columns,
  rows,
  empty = { title: 'Nothing to show yet', message: '' },
  onRowClick = null,
  sort = null,
  onSort = null,
  footer = null,
  rowClass = null
}) {
  if (!rows || rows.length === 0) {
    return el('div', emptyState(empty.title, empty.message, empty.action || null));
  }

  const head = el('tr', columns.map((column) => {
    const sortable = !!(column.sortKey && onSort);
    const isSorted = sort && sort.key === column.sortKey;
    const arrow = isSorted ? (sort.direction === 'desc' ? ' ▼' : ' ▲') : '';
    return el('th', {
      class: `${column.align === 'right' ? 'right' : ''} ${sortable ? 'sortable' : ''}`.trim(),
      style: column.width ? { width: column.width } : null,
      onclick: sortable
        ? () => onSort(column.sortKey, isSorted && sort.direction === 'asc' ? 'desc' : 'asc')
        : null
    }, `${column.label}${arrow}`);
  }));

  const body = el('tbody', rows.map((row, index) => {
    const tr = el('tr', {
      class: `${onRowClick ? 'clickable' : ''} ${rowClass ? rowClass(row) || '' : ''}`.trim(),
      onclick: onRowClick ? (event) => {
        if (event.target.closest('button, a, input, select')) return;
        onRowClick(row, index);
      } : null
    });
    for (const column of columns) {
      const value = column.render ? column.render(row, index) : row[column.key];
      tr.appendChild(el('td', { class: column.align === 'right' ? 'right' : '' }, value));
    }
    return tr;
  }));

  return el('div.table-wrap', [
    el('table.data', [el('thead', head), body, footer ? el('tfoot', footer) : null])
  ]);
}

/** Page navigation shared by every list screen. */
export function pager({ page, pages, total, pageSize, onPage }) {
  if (!total) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return el('div.pagination', [
    el('span.muted.text-sm', `Showing ${from}–${to} of ${total}`),
    el('span.grow'),
    el('button.btn.sm', { type: 'button', disabled: page <= 1, onclick: () => onPage(1) }, '« First'),
    el('button.btn.sm', { type: 'button', disabled: page <= 1, onclick: () => onPage(page - 1) }, '‹ Previous'),
    el('span.text-sm.muted', `Page ${page} of ${pages}`),
    el('button.btn.sm', { type: 'button', disabled: page >= pages, onclick: () => onPage(page + 1) }, 'Next ›'),
    el('button.btn.sm', { type: 'button', disabled: page >= pages, onclick: () => onPage(pages) }, 'Last »')
  ]);
}
