'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { CHANNELS, EVENTS } = require('../../src/shared/channels');
const { UNITS, PAYMENT_METHODS, PAYMENT_METHOD_LABELS, CURRENCY } = require('../../src/shared/constants');

/**
 * The preload runs sandboxed and cannot import project modules, so its channel
 * list and reference data are repeated inline. These tests fail the moment the
 * copies drift apart — which would otherwise show up as a mysteriously missing
 * button in the UI.
 */

const PRELOAD_PATH = path.join(__dirname, '../../src/preload/preload.js');

/** Execute the preload with stub Electron globals and capture what it exposes. */
function loadPreload() {
  const source = fs.readFileSync(PRELOAD_PATH, 'utf8');
  const exposed = {};
  const invoked = [];
  const listened = [];

  const context = {
    require: (name) => {
      if (name !== 'electron') throw new Error(`preload must not require "${name}" — it runs sandboxed`);
      return {
        contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
        ipcRenderer: {
          invoke: (channel, payload) => { invoked.push({ channel, payload }); return Promise.resolve({ ok: true }); },
          on: (event, handler) => listened.push({ event, handler }),
          removeListener: () => {}
        }
      };
    },
    module: { exports: {} },
    console
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: PRELOAD_PATH });

  return { exposed, invoked, listened, source };
}

test('the preload exposes one function per whitelisted channel and nothing else', () => {
  const { exposed } = loadPreload();
  const api = exposed.api;
  assert.ok(api, 'window.api must be exposed');

  const exposedChannels = [];
  for (const [domain, group] of Object.entries(api)) {
    if (domain === 'on') continue;
    for (const action of Object.keys(group)) {
      assert.equal(typeof group[action], 'function', `api.${domain}.${action} must be a function`);
      exposedChannels.push(`${domain}.${action}`);
    }
  }

  assert.deepEqual([...exposedChannels].sort(), [...CHANNELS].sort(),
    'the preload channel list has drifted from src/shared/channels.js');
});

test('each exposed function invokes its own channel', () => {
  const { exposed, invoked } = loadPreload();
  exposed.api.products.list({ search: 'rice' });
  exposed.api.pos.completeSale({ items: [] });
  assert.deepEqual(invoked.map((i) => i.channel), ['products.list', 'pos.completeSale']);
  assert.deepEqual(invoked[0].payload, { search: 'rice' });
});

test('only declared events can be subscribed to', () => {
  const { exposed, listened } = loadPreload();
  for (const event of EVENTS) {
    exposed.api.on(event, () => {});
  }
  assert.deepEqual(listened.map((l) => l.event), EVENTS);
  assert.throws(() => exposed.api.on('anything-else', () => {}), /Unknown event/);
  assert.throws(() => exposed.api.on(EVENTS[0], 'not a function'), /callback function/);
});

test('reference data matches the shared constants', () => {
  const { exposed } = loadPreload();
  // The preload runs in its own VM realm, so compare by value, not by prototype.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(exposed.appConstants.units), [...UNITS]);
  assert.deepEqual(plain(exposed.appConstants.paymentMethods), [...PAYMENT_METHODS]);
  assert.deepEqual(plain(exposed.appConstants.paymentMethodLabels), { ...PAYMENT_METHOD_LABELS });
  assert.equal(exposed.appConstants.currency.symbol, CURRENCY.symbol);
  assert.equal(exposed.appConstants.currency.code, 'GHS');
});

test('the preload never hands the renderer a node capability', () => {
  const { source } = loadPreload();
  assert.doesNotMatch(source, /exposeInMainWorld\(\s*['"](?:require|process|fs|electron)['"]/);
  assert.doesNotMatch(source, /ipcRenderer\s*\}\s*\)/, 'ipcRenderer itself must never be exposed');
  assert.doesNotMatch(source, /require\((?!'electron')/, 'a sandboxed preload can only require electron');
});
