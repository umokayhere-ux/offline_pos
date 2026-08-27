// Display formatting. Pure integer maths — no floating point, no dependencies.
// Values arrive from the main process already in pesewas (money) and milli-units
// (quantity); this module only turns them into text.

export const CURRENCY_SYMBOL = '₵'; // Ghana Cedi

/** 125075 -> "₵1,250.75". Always exactly two decimal places. */
export function money(pesewas, { symbol = true } = {}) {
  const value = Number(pesewas);
  if (!Number.isFinite(value)) return symbol ? `${CURRENCY_SYMBOL}0.00` : '0.00';
  const rounded = Math.round(value);
  const negative = rounded < 0;
  const abs = Math.abs(rounded);
  const major = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const minor = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${symbol ? CURRENCY_SYMBOL : ''}${major}.${minor}`;
}

/** Plain "1250.75" for input fields. */
export function moneyInput(pesewas) {
  return money(pesewas, { symbol: false }).replace(/,/g, '');
}

/** Parse a typed cedi amount into pesewas, or null when it is not a number. */
export function parseMoney(text) {
  const cleaned = String(text ?? '').trim().replace(/,/g, '').replace(CURRENCY_SYMBOL, '').trim();
  if (cleaned === '' || !/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [major, minor = ''] = cleaned.split('.');
  return Number(major) * 100 + Number(minor.padEnd(2, '0'));
}

/** 2500 -> "2.5"; trailing zeros trimmed. */
export function qty(milli) {
  const value = Number(milli);
  if (!Number.isFinite(value)) return '0';
  const negative = value < 0;
  const abs = Math.abs(Math.round(value));
  const whole = Math.floor(abs / 1000);
  const frac = String(abs % 1000).padStart(3, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Fixed-precision quantity for inputs, honouring the shop's setting. */
export function qtyFixed(milli, decimals = 3) {
  const value = Number(milli) / 1000;
  return value.toFixed(Math.max(0, Math.min(3, decimals)));
}

/** Parse a typed quantity into milli-units, or null when invalid. */
export function parseQty(text) {
  const cleaned = String(text ?? '').trim().replace(/,/g, '');
  if (cleaned === '' || !/^\d+(\.\d{1,3})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  return Number(whole) * 1000 + Number(frac.padEnd(3, '0'));
}

const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Accra', day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false
});
const DATE_ONLY = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Accra', day: '2-digit', month: 'short', year: 'numeric'
});
const TIME_ONLY = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Accra', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});

export function dateTime(iso) {
  if (!iso) return '';
  return DATE_TIME.format(new Date(iso));
}

export function date(iso) {
  if (!iso) return '';
  return DATE_ONLY.format(new Date(iso));
}

export function time(iso) {
  if (!iso) return '';
  return TIME_ONLY.format(new Date(iso));
}

/** "today", "yesterday", "3 days ago" — for activity feeds. */
export function relative(iso) {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return date(iso);
}

/** Today's date as YYYY-MM-DD in the shop's timezone, for date inputs. */
export function todayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Accra', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

export function addDays(dayKey, count) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + count);
  return dt.toISOString().slice(0, 10);
}

export function percent(value) {
  const n = Number(value);
  return `${Number.isFinite(n) ? n.toFixed(2) : '0.00'}%`;
}

export function initials(name) {
  return String(name || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((part) => part[0].toUpperCase()).join('') || '?';
}

export const PAYMENT_LABELS = {
  cash: 'Cash', momo: 'Mobile Money', card: 'Card', credit: 'Credit / Debt', mixed: 'Mixed'
};

export function paymentLabel(method) {
  return PAYMENT_LABELS[method] || method || '';
}

export function stockBadge(product) {
  if (product.stock_milli <= 0) return { label: 'Out of stock', tone: 'red' };
  if (product.stock_milli <= product.min_stock_milli) return { label: 'Low stock', tone: 'amber' };
  return { label: 'In stock', tone: 'green' };
}
