import { el, mount, clear } from './utils/dom.js';
import { initials, setQuantityPrecision } from './utils/format.js';
import { icon } from './components/icons.js';
import { call, tryCall, onEvent } from './services/api.js';
import { toast } from './components/toast.js';
import { closeTopModal, confirmModal } from './components/modal.js';
import { renderLogin } from './pages/login.js';
import { renderSetup } from './pages/setup.js';

import { dashboardPage } from './pages/dashboard.js';
import { posPage } from './pages/pos.js';
import { productsPage } from './pages/products.js';
import { categoriesPage } from './pages/categories.js';
import { purchasesPage } from './pages/purchases.js';
import { suppliersPage } from './pages/suppliers.js';
import { customersPage } from './pages/customers.js';
import { debtsPage } from './pages/debts.js';
import { expensesPage } from './pages/expenses.js';
import { refundsPage } from './pages/refunds.js';
import { salesPage } from './pages/sales.js';
import { reportsPage } from './pages/reports.js';
import { usersPage } from './pages/users.js';
import { backupPage } from './pages/backup.js';
import { activityPage } from './pages/activity.js';
import { settingsPage } from './pages/settings.js';

/**
 * Application shell: session gate, navigation and page mounting.
 *
 * Pages are plain modules exporting `{ title, subtitle, permission, render(ctx) }`.
 * `render` returns a DOM node; the shell handles the chrome around it.
 */

const ROUTES = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', page: dashboardPage, section: 'Overview' },
  { id: 'pos', label: 'Point of Sale', icon: 'pos', page: posPage, section: 'Overview' },
  { id: 'sales', label: 'Sales', icon: 'sales', page: salesPage, section: 'Trading' },
  { id: 'refunds', label: 'Refunds', icon: 'refunds', page: refundsPage, section: 'Trading' },
  { id: 'debts', label: 'Debts', icon: 'debts', page: debtsPage, section: 'Trading' },
  { id: 'customers', label: 'Customers', icon: 'customers', page: customersPage, section: 'Trading' },
  { id: 'products', label: 'Products', icon: 'products', page: productsPage, section: 'Stock' },
  { id: 'categories', label: 'Categories', icon: 'categories', page: categoriesPage, section: 'Stock' },
  { id: 'purchases', label: 'Purchases', icon: 'purchases', page: purchasesPage, section: 'Stock' },
  { id: 'suppliers', label: 'Suppliers', icon: 'suppliers', page: suppliersPage, section: 'Stock' },
  { id: 'expenses', label: 'Expenses', icon: 'expenses', page: expensesPage, section: 'Money' },
  { id: 'reports', label: 'Reports', icon: 'reports', page: reportsPage, section: 'Money' },
  { id: 'users', label: 'Users', icon: 'users', page: usersPage, section: 'System' },
  { id: 'backup', label: 'Backup', icon: 'backup', page: backupPage, section: 'System' },
  { id: 'activity', label: 'Activity Log', icon: 'activity', page: activityPage, section: 'System' },
  { id: 'settings', label: 'Settings', icon: 'settings', page: settingsPage, section: 'System' }
];

const app = {
  root: document.getElementById('root'),
  user: null,
  shop: null,
  settings: {},
  route: 'dashboard',
  pageNode: null,
  cleanup: null,
  badges: {}
};

function can(permission) {
  if (!app.user) return false;
  if (app.user.role === 'owner') return true;
  if (!permission) return true;
  return Array.isArray(app.user.permissions) && app.user.permissions.includes(permission);
}

function visibleRoutes() {
  return ROUTES.filter((route) => can(route.page.permission));
}

/** The context every page receives. */
function pageContext() {
  return {
    user: app.user,
    shop: app.shop,
    settings: app.settings,
    can,
    navigate,
    refreshShell,
    refreshBadges,
    reloadSettings
  };
}

async function reloadSettings() {
  const [settingsResult, shopResult] = await Promise.all([
    tryCall('settings', 'all', undefined, { silent: true }),
    tryCall('settings', 'shopProfile', undefined, { silent: true })
  ]);
  if (settingsResult.ok) {
    app.settings = settingsResult.data;
    // The shop's quantity precision drives how every screen displays quantities.
    setQuantityPrecision(app.settings['inventory.quantity_precision']);
  }
  if (shopResult.ok) app.shop = shopResult.data;
  return app.settings;
}

async function refreshBadges() {
  const result = await tryCall('dashboard', 'load', undefined, { silent: true });
  if (!result.ok) return;
  app.badges = {
    products: (result.data.stock.lowStock || 0) + (result.data.stock.outOfStock || 0),
    // A sales attendant gets a dashboard scoped to their own day, which carries
    // no shop-wide debt figures.
    debts: (result.data.outstanding && result.data.outstanding.openDebtCount) || 0
  };
  renderSidebarBadges();
}

function renderSidebarBadges() {
  document.querySelectorAll('.nav-item').forEach((item) => {
    const count = app.badges[item.dataset.route];
    const existing = item.querySelector('.badge');
    if (count > 0) {
      if (existing) existing.textContent = String(count);
      else item.appendChild(el('span.badge', String(count)));
    } else if (existing) {
      existing.remove();
    }
  });
}

// ------------------------------- Navigation --------------------------------

function navigate(routeId, params = {}) {
  const route = ROUTES.find((r) => r.id === routeId);
  if (!route) return;
  if (!can(route.page.permission)) {
    toast.warn('You do not have access to that screen.');
    return;
  }

  if (typeof app.cleanup === 'function') {
    try { app.cleanup(); } catch { /* a page teardown must never block navigation */ }
  }
  app.cleanup = null;
  app.route = routeId;

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.route === routeId);
  });

  const titleNode = document.getElementById('page-title');
  const subtitleNode = document.getElementById('page-subtitle');
  if (titleNode) titleNode.textContent = route.page.title || route.label;
  if (subtitleNode) subtitleNode.textContent = route.page.subtitle || '';

  const host = document.getElementById('page-host');
  if (!host) return;
  host.className = route.page.flush ? 'page flush' : 'page';
  mount(host, el('div', { class: route.page.flush ? '' : 'page-inner' }, el('div.loading-block', [el('span.spinner'), 'Loading…'])));

  const context = { ...pageContext(), params, host };
  Promise.resolve()
    .then(() => route.page.render(context))
    .then((result) => {
      if (app.route !== routeId) return;   // the user navigated away while loading
      const node = result && result.node ? result.node : result;
      if (result && typeof result.cleanup === 'function') app.cleanup = result.cleanup;
      // A page may only know its subtitle once it has loaded its data — the
      // dashboard, for instance, says something different to a sales attendant.
      if (result && result.subtitle && subtitleNode) subtitleNode.textContent = result.subtitle;
      mount(host, route.page.flush ? node : el('div.page-inner', node));
    })
    .catch((error) => {
      mount(host, el('div.page-inner', [
        el('div.card', el('div.card-body', [
          el('h2', 'This screen could not be opened'),
          el('p.muted', error.message || String(error)),
          el('button.btn', { type: 'button', onclick: () => navigate(routeId, params) }, 'Try again')
        ]))
      ]));
    });
}

// -------------------------------- Shell ------------------------------------

function refreshShell() {
  const brand = document.getElementById('brand-shop-name');
  if (brand && app.shop) brand.textContent = app.shop.name;
}

function buildSidebar() {
  const nav = el('nav.sidebar-nav');
  let lastSection = null;

  for (const route of visibleRoutes()) {
    if (route.section !== lastSection) {
      nav.appendChild(el('div.nav-section', route.section));
      lastSection = route.section;
    }
    nav.appendChild(el('button.nav-item', {
      type: 'button',
      dataset: { route: route.id },
      class: route.id === app.route ? 'active' : '',
      onclick: () => navigate(route.id)
    }, [icon(route.icon), el('span', route.label)]));
  }

  return el('aside.sidebar', [
    el('div.sidebar-brand', [
      app.shop && app.shop.logoDataUrl
        ? el('img.logo', { src: app.shop.logoDataUrl, alt: '' })
        : el('div.logo', 'iT'),
      el('div', { style: { overflow: 'hidden' } }, [
        el('div.shop-name#brand-shop-name', app.shop ? app.shop.name : 'iTtEk POS'),
        el('div.app-name', 'iTtEk POS')
      ])
    ]),
    nav,
    el('div.sidebar-footer', [
      el('div.user-chip', [
        el('div.avatar', initials(app.user.fullName)),
        el('div', { style: { overflow: 'hidden' } }, [
          el('div.name', app.user.fullName),
          el('div.role', app.user.roleLabel || app.user.role)
        ])
      ]),
      el('button.nav-item', { type: 'button', onclick: signOut }, [icon('logout'), el('span', 'Sign out')])
    ])
  ]);
}

function buildTopbar() {
  const clock = el('span.clock');
  const tick = () => {
    clock.textContent = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Accra', weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date());
  };
  tick();
  setInterval(tick, 30000);

  return el('header.topbar', [
    el('div', [
      el('div.page-title#page-title', 'Dashboard'),
      el('div.subtitle#page-subtitle', '')
    ]),
    el('span.grow'),
    app.settings['app.demo_mode'] ? el('span.badge-pill.brand', 'DEMO MODE') : null,
    el('span.offline-pill', [icon('offline', { size: 14 }), 'Offline ready']),
    clock,
    el('button.btn.sm', { type: 'button', title: 'Quick sale (Ctrl+2)', onclick: () => navigate('pos') },
      [icon('pos', { size: 15 }), 'New sale'])
  ]);
}

function renderShell() {
  mount(app.root, el('div.app-shell', [
    buildSidebar(),
    el('main.main', [buildTopbar(), el('div.page#page-host')])
  ]));

  const landing = can('pos.use') && app.user.role === 'attendant' ? 'pos' : 'dashboard';
  navigate(landing);
  refreshBadges();
}

// ------------------------------- Sessions ----------------------------------

async function signOut() {
  const confirmed = await confirmModal({
    title: 'Sign out',
    message: 'Sign out of iTtEk POS?',
    detail: 'Any cart that has not been completed or held will be lost.',
    confirmLabel: 'Sign out'
  });
  if (!confirmed) return;
  await tryCall('auth', 'logout', undefined, { silent: true });
  app.user = null;
  showLogin();
}

async function showLogin() {
  const info = await tryCall('app', 'info', undefined, { silent: true });
  mount(app.root, renderLogin({
    shopName: info.ok ? info.data.shop : 'iTtEk POS',
    logoDataUrl: info.ok ? info.data.logoDataUrl : '',
    onSignedIn: (state) => startSession(state.user)
  }));
}

async function startSession(user) {
  app.user = user;
  await reloadSettings();
  const info = await tryCall('app', 'info', undefined, { silent: true });
  if (info.ok) app.shop = { ...app.shop, logoDataUrl: info.data.logoDataUrl, version: info.data.version };
  renderShell();
}

async function boot() {
  try {
    const status = await call('setup', 'status');
    if (!status.complete) {
      mount(app.root, renderSetup({
        status,
        onComplete: async (result) => {
          if (result.session && result.session.user) await startSession(result.session.user);
          else await showLogin();
        }
      }));
      return;
    }

    const session = await call('auth', 'state');
    if (session.authenticated) await startSession(session.user);
    else await showLogin();
  } catch (error) {
    mount(app.root, el('div.auth-screen.single', el('div.auth-form-side', el('div.auth-card', [
      el('div.auth-logo', icon('warning', { size: 24 })),
      el('h1', 'iTtEk POS could not start'),
      el('p.sub', error.message || String(error)),
      el('button.btn.primary.block', { type: 'button', onclick: () => window.location.reload() }, 'Retry')
    ]))));
  }
}

// ------------------------------- Shortcuts ---------------------------------

document.addEventListener('keydown', (event) => {
  if (!app.user) return;

  if (event.key === 'Escape') {
    if (closeTopModal()) event.preventDefault();
    return;
  }
  if (event.ctrlKey && ['1', '2', '3', '4'].includes(event.key)) {
    event.preventDefault();
    navigate({ 1: 'dashboard', 2: 'pos', 3: 'products', 4: 'reports' }[event.key]);
  }
});

onEvent('session.expired', () => {
  app.user = null;
  toast.warn('Your session timed out. Please sign in again.');
  showLogin();
});

onEvent('app.notice', (payload) => {
  if (!payload) return;
  const kind = payload.type === 'success' ? 'success' : (payload.type === 'error' ? 'error' : 'info');
  toast[kind](payload.message);
});

onEvent('shortcut', (action) => {
  if (!app.user || typeof action !== 'string') return;
  if (action.startsWith('go:')) navigate(action.slice(3));
  else if (action === 'pos.new') navigate('pos');
});

// Keep the idle timer honest while somebody is actually working.
document.addEventListener('click', () => { if (app.user) call('auth', 'touch').catch(() => {}); });

boot();

export { navigate, can };
