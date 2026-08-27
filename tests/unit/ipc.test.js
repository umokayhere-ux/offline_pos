'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { CHANNELS, EVENTS } = require('../../src/shared/channels');
const { handlers } = require('../../src/main/ipc');
const { PERMISSIONS } = require('../../src/shared/constants');

test('every whitelisted channel has exactly one handler, and none is undeclared', () => {
  const declared = new Set(CHANNELS);
  const implemented = new Set(Object.keys(handlers));

  const missing = [...declared].filter((c) => !implemented.has(c));
  const extra = [...implemented].filter((c) => !declared.has(c));

  assert.deepEqual(missing, [], 'channels with no handler');
  assert.deepEqual(extra, [], 'handlers for channels the preload will never expose');
  assert.equal(new Set(CHANNELS).size, CHANNELS.length, 'no duplicate channels');
});

test('each handler declares a real permission, or is deliberately public', () => {
  const publicChannels = new Set([
    'auth.state', 'auth.login', 'auth.logout', 'auth.touch',
    'setup.status', 'setup.complete', 'app.info'
  ]);

  for (const [channel, [permission, handler]] of Object.entries(handlers)) {
    assert.equal(typeof handler, 'function', `${channel} must have a function handler`);
    if (permission === null) {
      assert.ok(publicChannels.has(channel), `${channel} is public but is not on the reviewed public list`);
      continue;
    }
    assert.ok(
      permission === 'authenticated' || PERMISSIONS.includes(permission),
      `${channel} declares an unknown permission: ${permission}`
    );
  }
});

test('write operations are never merely "authenticated"', () => {
  const writeVerbs = /\.(create|update|delete|void|disable|import|adjust|recordPayment|writeOff|setPassword|setRolePermissions|restore|createCategory|deleteCategory)$/;
  const allowed = new Set(['auth.changePassword', 'file.saveAs']);

  for (const [channel, [permission]] of Object.entries(handlers)) {
    if (!writeVerbs.test(channel) || allowed.has(channel)) continue;
    assert.ok(
      permission && permission !== 'authenticated',
      `${channel} changes data but only requires "${permission}"`
    );
  }
});

test('the preload exposes only the whitelisted channels', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/preload/preload.js'), 'utf8');
  assert.match(source, /contextBridge\.exposeInMainWorld/);
  assert.doesNotMatch(source, /nodeIntegration/);
  // The bridge must be generated from the list, never hand-written per channel.
  assert.match(source, /for \(const channel of CHANNELS\)/);
  assert.ok(EVENTS.length > 0);
});

test('the main window is created with a locked-down webPreferences block', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/main.js'), 'utf8');
  assert.match(source, /contextIsolation: true/);
  assert.match(source, /nodeIntegration: false/);
  assert.match(source, /webviewTag: false/);
  assert.match(source, /setWindowOpenHandler/);
  assert.match(source, /Content-Security-Policy/);
  assert.doesNotMatch(source, /nodeIntegration: true/);
});

test('the renderer never loads a remote origin', () => {
  const rendererDir = path.join(__dirname, '../../src/renderer');
  if (!fs.existsSync(rendererDir)) return;

  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(html|js|css)$/.test(entry.name)) files.push(full);
    }
  };
  walk(rendererDir);

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const remote = content.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi) || [];
    assert.deepEqual(remote, [], `${path.relative(rendererDir, file)} references a remote asset`);
    assert.doesNotMatch(content, /fonts\.googleapis\.com|cdn\.jsdelivr|cdnjs\.cloudflare|unpkg\.com|bootstrapcdn/i,
      `${path.relative(rendererDir, file)} references a CDN`);
  }
});
