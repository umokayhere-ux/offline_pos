/**
 * Icon set — inline SVG, drawn here, no icon font and no CDN.
 *
 * Emoji were replaced with these because emoji render differently on every
 * Windows version, cannot inherit the text colour, and look out of place on a
 * commercial till. These are stroked paths using `currentColor`, so an icon
 * always matches the colour of the text beside it.
 */

const NS = 'http://www.w3.org/2000/svg';

/** Path data (24x24 grid, stroked). */
const PATHS = {
  // Navigation
  dashboard: ['M3 3h7v9H3z', 'M14 3h7v5h-7z', 'M14 12h7v9h-7z', 'M3 16h7v5H3z'],
  pos: ['M2 3h2.5l2.2 11.2a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 2-1.6L21 7H6', 'M9.5 20.5a1 1 0 1 0 0-.1', 'M17.5 20.5a1 1 0 1 0 0-.1'],
  sales: ['M6 2h9l5 5v13a1 1 0 0 1-1.4.9L16 20l-2.3 1-2.3-1-2.3 1L7 20l-1.6.9A1 1 0 0 1 4 20V4a2 2 0 0 1 2-2z', 'M8 8h7', 'M8 12h7', 'M8 16h4'],
  refunds: ['M3 10a9 9 0 1 1 2 5.7', 'M3 5v5h5'],
  debts: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3.5 2'],
  customers: ['M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20', 'M9 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M22 20v-1.5a4 4 0 0 0-3-3.9', 'M16 3.6a4 4 0 0 1 0 7.7'],
  products: ['M21 8.5 12 3.5 3 8.5v7L12 20.5l9-5z', 'M3 8.5 12 13.5l9-5', 'M12 13.5V20.5'],
  categories: ['M20.6 13.4 12.4 21.6a2 2 0 0 1-2.8 0l-7.2-7.2a2 2 0 0 1-.6-1.4V4a2 2 0 0 1 2-2h9a2 2 0 0 1 1.4.6l6.4 6.4a2 2 0 0 1 0 2.8z', 'M7.5 7.5h.01'],
  purchases: ['M1 3h13v13H1z', 'M14 8h4l3 3v5h-7z', 'M6.5 20.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M18 20.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
  suppliers: ['M3 21V8l6-4 6 4v13', 'M15 21V11h6v10', 'M3 21h18', 'M7 12h2', 'M7 16h2', 'M18 15h1', 'M18 18h1'],
  expenses: ['M2 6h20v12H2z', 'M2 10h20', 'M6 15h4'],
  reports: ['M3 21h18', 'M6 17V9', 'M11 17V4', 'M16 17v-6', 'M21 17v-9'],
  users: ['M15.5 10.5a4 4 0 1 0-8 0 4 4 0 0 0 8 0z', 'M4 21v-1a5 5 0 0 1 5-5h5a5 5 0 0 1 5 5v1'],
  backup: ['M4 4h16v16H4z', 'M8 4v6h8V4', 'M8 16h8'],
  activity: ['M8 5h13', 'M8 12h13', 'M8 19h13', 'M3.5 5h.01', 'M3.5 12h.01', 'M3.5 19h.01'],
  settings: ['M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4.5 15H4a2 2 0 1 1 0-4h.2A1.6 1.6 0 0 0 5.3 8.2l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 11 4.5V4a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.3 1z'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],

  // Actions
  print: ['M6 9V3h12v6', 'M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2', 'M6 14h12v7H6z'],
  download: ['M12 3v12', 'M7 11l5 5 5-5', 'M4 20h16'],
  upload: ['M12 20V8', 'M7 12l5-5 5 5', 'M4 4h16'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20.5 20.5 16 16'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  close: ['M18 6 6 18', 'M6 6l12 12'],
  edit: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14', 'M10 11v6', 'M14 11v6'],
  check: ['M20 6 9 17l-5-5'],
  warning: ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'],
  refresh: ['M21 12a9 9 0 1 1-2.6-6.4', 'M21 3v6h-6'],
  restore: ['M3 12a9 9 0 1 0 2.6-6.4', 'M3 3v6h6'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  eye: ['M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12 19 18.5 12 18.5 1.5 12 1.5 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  save: ['M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z', 'M17 21v-8H7v8', 'M7 3v5h8'],

  // Arrows
  arrowLeft: ['M19 12H5', 'M12 19l-7-7 7-7'],
  arrowRight: ['M5 12h14', 'M12 5l7 7-7 7'],
  chevronUp: ['M18 15l-6-6-6 6'],
  chevronDown: ['M6 9l6 6 6-6'],
  chevronLeft: ['M15 18l-6-6 6-6'],
  chevronRight: ['M9 18l6-6-6-6'],
  chevronsLeft: ['M11 17l-5-5 5-5', 'M18 17l-5-5 5-5'],
  chevronsRight: ['M13 17l5-5-5-5', 'M6 17l5-5-5-5'],

  // Point of sale
  cash: ['M2 6h20v12H2z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M5 9h.01', 'M19 15h.01'],
  momo: ['M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z', 'M11 18.5h2'],
  card: ['M2 5h20v14H2z', 'M2 10h20', 'M6 15h4'],
  credit: ['M9 3h6a1 1 0 0 1 1 1v1H8V4a1 1 0 0 1 1-1z', 'M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2', 'M9 12h6', 'M9 16h4'],
  user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  barcode: ['M3 5v14', 'M6.5 5v14', 'M10 5v10', 'M13 5v14', 'M17 5v10', 'M20.5 5v14'],
  inbox: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.4 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.4-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.8 1.1z'],
  offline: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M8.5 12.5 11 15l4.5-5.5'],
  tag: ['M20.6 13.4 12.4 21.6a2 2 0 0 1-2.8 0l-7.2-7.2a2 2 0 0 1-.6-1.4V4a2 2 0 0 1 2-2h9a2 2 0 0 1 1.4.6l6.4 6.4a2 2 0 0 1 0 2.8z', 'M7.5 7.5h.01'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3.5 2'],
  lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4']
};

/**
 * Build an icon element.
 * @param {string} name key from PATHS
 * @param {object} [options]
 * @param {number} [options.size] pixel size (square)
 * @param {number} [options.stroke] stroke width
 * @param {string} [options.className] extra classes
 */
export function icon(name, { size = 18, stroke = 1.75, className = '' } = {}) {
  const paths = PATHS[name];
  const svg = document.createElementNS(NS, 'svg');

  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(stroke));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `icon ${className}`.trim());

  if (!paths) {
    // An unknown name must not crash a screen; draw nothing and say so once.
    console.warn(`Unknown icon: ${name}`);
    return svg;
  }

  for (const d of paths) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/** The icon names available, for tests and tooling. */
export const ICON_NAMES = Object.keys(PATHS);
