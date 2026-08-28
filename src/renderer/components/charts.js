import { el } from '../utils/dom.js';
import { money } from '../utils/format.js';

/**
 * Charts drawn as inline SVG. No charting library, no CDN — which is what lets
 * the dashboard render with the network unplugged.
 *
 * Every chart takes values already in pesewas and renders them without further
 * arithmetic beyond scaling to pixels.
 */

/* One hue. Series are told apart by lightness, not by different colours, so a
   chart never introduces a second brand colour into the interface. */
const PALETTE = ['#1d4ed8', '#7ea6f7', '#172554', '#bcd2fb', '#3b7bec', '#5b93f5', '#0f1f4b', '#dbe6fe'];

function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.appendChild(child);
  return node;
}

function svgText(content, attrs) {
  const node = svg('text', attrs);
  node.textContent = content;
  return node;
}

function niceMax(value) {
  if (value <= 0) return 100;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

/**
 * Grouped bar chart over days.
 * @param {Array} data rows from reports.dailySeries
 * @param {Array} series [{ key, label, colour }]
 */
export function barChart(data, series, { height = 220, formatValue = money } = {}) {
  if (!data || data.length === 0) return el('div.empty-state', 'No activity in this period yet.');

  const width = Math.max(360, data.length * (series.length * 12 + 26));
  const padding = { top: 14, right: 12, bottom: 30, left: 66 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const maxValue = niceMax(Math.max(1, ...data.flatMap((row) => series.map((s) => Math.max(0, row[s.key] || 0)))));
  const slot = plotWidth / data.length;
  const barWidth = Math.max(4, Math.min(20, (slot - 8) / series.length));

  const children = [];

  // Horizontal grid with cedi labels.
  for (let i = 0; i <= 4; i += 1) {
    const value = (maxValue / 4) * i;
    const y = padding.top + plotHeight - (value / maxValue) * plotHeight;
    children.push(svg('line', {
      x1: padding.left, x2: width - padding.right, y1: y, y2: y,
      stroke: '#e6eaf0', 'stroke-width': 1
    }));
    children.push(svgText(formatValue(value), {
      x: padding.left - 8, y: y + 4, 'text-anchor': 'end',
      'font-size': 10, fill: '#98a2b3'
    }));
  }

  data.forEach((row, index) => {
    series.forEach((s, seriesIndex) => {
      const value = Math.max(0, row[s.key] || 0);
      const barHeight = (value / maxValue) * plotHeight;
      const x = padding.left + index * slot + (slot - barWidth * series.length) / 2 + seriesIndex * barWidth;
      const rect = svg('rect', {
        x,
        y: padding.top + plotHeight - barHeight,
        width: Math.max(2, barWidth - 2),
        height: Math.max(0, barHeight),
        fill: s.colour || PALETTE[seriesIndex % PALETTE.length],
        rx: 2
      });
      const title = svg('title');
      title.textContent = `${row.day} — ${s.label}: ${formatValue(value)}`;
      rect.appendChild(title);
      children.push(rect);
    });

    const label = String(row.day || '').slice(5);
    if (data.length <= 16 || index % Math.ceil(data.length / 12) === 0) {
      children.push(svgText(label, {
        x: padding.left + index * slot + slot / 2, y: height - 10,
        'text-anchor': 'middle', 'font-size': 10, fill: '#667085'
      }));
    }
  });

  const chart = svg('svg', {
    class: 'chart', viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'xMidYMid meet', role: 'img'
  }, children);

  return el('div', [
    el('div', { style: { overflowX: 'auto' } }, chart),
    el('div.chart-legend', series.map((s, i) => el('span.key', [
      el('span.swatch', { style: { background: s.colour || PALETTE[i % PALETTE.length] } }),
      s.label
    ])))
  ]);
}

/** Line chart for a profit trend. */
export function lineChart(data, series, { height = 240, formatValue = money } = {}) {
  if (!data || data.length < 2) return el('div.empty-state', 'Not enough data to draw a trend yet.');

  // Cap the drawing width so a 30-day series still scales to a readable height
  // inside a half-width card rather than collapsing to a thin strip.
  const width = Math.min(680, Math.max(360, data.length * 26));
  const padding = { top: 14, right: 14, bottom: 28, left: 66 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const values = data.flatMap((row) => series.map((s) => row[s.key] || 0));
  const maxValue = niceMax(Math.max(1, ...values));
  const minValue = Math.min(0, ...values);
  const span = maxValue - minValue || 1;

  const xFor = (i) => padding.left + (i / (data.length - 1)) * plotWidth;
  const yFor = (v) => padding.top + plotHeight - ((v - minValue) / span) * plotHeight;

  const children = [];
  for (let i = 0; i <= 4; i += 1) {
    const value = minValue + (span / 4) * i;
    const y = yFor(value);
    children.push(svg('line', { x1: padding.left, x2: width - padding.right, y1: y, y2: y, stroke: '#e6eaf0' }));
    children.push(svgText(formatValue(value), { x: padding.left - 8, y: y + 4, 'text-anchor': 'end', 'font-size': 10, fill: '#98a2b3' }));
  }

  series.forEach((s, seriesIndex) => {
    const colour = s.colour || PALETTE[seriesIndex % PALETTE.length];
    const points = data.map((row, i) => `${xFor(i)},${yFor(row[s.key] || 0)}`).join(' ');
    children.push(svg('polyline', { points, fill: 'none', stroke: colour, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }));
    data.forEach((row, i) => {
      const dot = svg('circle', { cx: xFor(i), cy: yFor(row[s.key] || 0), r: 3, fill: colour });
      const title = svg('title');
      title.textContent = `${row.day} — ${s.label}: ${formatValue(row[s.key] || 0)}`;
      dot.appendChild(title);
      children.push(dot);
    });
  });

  data.forEach((row, i) => {
    if (data.length <= 16 || i % Math.ceil(data.length / 10) === 0) {
      children.push(svgText(String(row.day).slice(5), {
        x: xFor(i), y: height - 8, 'text-anchor': 'middle', 'font-size': 10, fill: '#667085'
      }));
    }
  });

  return el('div', [
    el('div', { style: { overflowX: 'auto' } },
      svg('svg', {
        class: 'chart', viewBox: `0 0 ${width} ${height}`,
        preserveAspectRatio: 'xMidYMid meet', style: `max-width:${width}px`
      }, children)),
    el('div.chart-legend', series.map((s, i) => el('span.key', [
      el('span.swatch', { style: { background: s.colour || PALETTE[i % PALETTE.length] } }), s.label
    ])))
  ]);
}

/** Donut chart for a categorical split (payment methods, expense categories). */
export function donutChart(slices, { size = 180, formatValue = money } = {}) {
  const data = (slices || []).filter((s) => Number(s.value) > 0);
  if (data.length === 0) return el('div.empty-state', 'Nothing recorded in this period.');

  const total = data.reduce((sum, s) => sum + Number(s.value), 0);
  const radius = size / 2;
  const inner = radius * 0.62;
  const children = [];
  let angle = -Math.PI / 2;

  data.forEach((slice, index) => {
    const portion = Number(slice.value) / total;
    const end = angle + portion * Math.PI * 2;
    const colour = slice.colour || PALETTE[index % PALETTE.length];

    if (portion >= 0.9999) {
      children.push(svg('circle', { cx: radius, cy: radius, r: (radius + inner) / 2, fill: 'none', stroke: colour, 'stroke-width': radius - inner }));
    } else {
      const large = portion > 0.5 ? 1 : 0;
      const path = [
        `M ${radius + radius * Math.cos(angle)} ${radius + radius * Math.sin(angle)}`,
        `A ${radius} ${radius} 0 ${large} 1 ${radius + radius * Math.cos(end)} ${radius + radius * Math.sin(end)}`,
        `L ${radius + inner * Math.cos(end)} ${radius + inner * Math.sin(end)}`,
        `A ${inner} ${inner} 0 ${large} 0 ${radius + inner * Math.cos(angle)} ${radius + inner * Math.sin(angle)}`,
        'Z'
      ].join(' ');
      const wedge = svg('path', { d: path, fill: colour });
      const title = svg('title');
      title.textContent = `${slice.label}: ${formatValue(slice.value)} (${(portion * 100).toFixed(1)}%)`;
      wedge.appendChild(title);
      children.push(wedge);
    }
    angle = end;
  });

  children.push(svgText(formatValue(total), {
    x: radius, y: radius + 2, 'text-anchor': 'middle', 'font-size': 14, 'font-weight': 700, fill: '#101828'
  }));
  children.push(svgText('total', { x: radius, y: radius + 17, 'text-anchor': 'middle', 'font-size': 10, fill: '#98a2b3' }));

  return el('div.row.gap-16', { style: { alignItems: 'center', flexWrap: 'wrap' } }, [
    svg('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}` }, children),
    el('div.chart-legend', { style: { flexDirection: 'column', gap: '7px' } },
      data.map((slice, index) => el('span.key', [
        el('span.swatch', { style: { background: slice.colour || PALETTE[index % PALETTE.length] } }),
        el('span', `${slice.label} — `),
        el('strong', formatValue(slice.value))
      ])))
  ]);
}

/** Horizontal ranked bars (top products). */
export function rankedBars(items, { formatValue = money } = {}) {
  if (!items || items.length === 0) return el('div.empty-state', 'No sales in this period yet.');
  const max = Math.max(...items.map((i) => Number(i.value) || 0), 1);

  return el('div.bar-list', items.map((item, index) => el('div.bar-row', [
    el('div.bar-head', [
      el('span', `${index + 1}. ${item.label}`),
      el('strong.money', formatValue(item.value))
    ]),
    el('div.bar-track', [
      el('div.bar-fill', {
        style: {
          width: `${Math.max(2, (Number(item.value) / max) * 100)}%`,
          background: PALETTE[index % PALETTE.length]
        }
      })
    ]),
    item.hint ? el('div.text-sm.muted', item.hint) : null
  ])));
}

export { PALETTE };
