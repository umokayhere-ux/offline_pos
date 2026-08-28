'use strict';

/**
 * better-sqlite3 is a native module, so it has to be compiled against the exact
 * ABI of the runtime that loads it — Electron's bundled Node for running the
 * application, and your system Node for running the test suite.
 *
 * This script makes that automatic: it checks whether the current build loads
 * under plain Node and rebuilds only when it does not. Running `npm test`
 * therefore always works, whatever the last build targeted.
 *
 *   node scripts/ensure-abi.js          rebuild for Node if needed (tests)
 *   node scripts/ensure-abi.js electron rebuild for Electron (running the app)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const target = process.argv[2] === 'electron' ? 'electron' : 'node';

/**
 * A build can be unusable in two different ways: compiled for another Node ABI
 * (running the app after testing, or vice versa) or compiled for another
 * platform entirely (after `npm run build:win` cross-packages the module).
 * Both simply mean "rebuild".
 */
const NEEDS_REBUILD = [
  /NODE_MODULE_VERSION/,          // built for a different Node/Electron ABI
  /invalid ELF header/i,          // a Windows or macOS binary on Linux
  /wrong ELF class/i,             // 32/64-bit mismatch
  /not a valid Win32 application/i,
  /mach-o|incompatible architecture/i,
  /was compiled against a different/i,
  /Cannot find module.*better_sqlite3\.node/i
];

function loadsUnderNode() {
  try {
    // The native binding is loaded lazily on first use, so opening a database is
    // the only reliable way to find out what the current build targets.
    const Database = require('better-sqlite3');
    new Database(':memory:').close();
    return true;
  } catch (error) {
    if (NEEDS_REBUILD.some((pattern) => pattern.test(error.message))) return false;
    throw error;
  }
}

function run(command) {
  execSync(command, { stdio: 'inherit' });
}

/** Fail loudly when dependencies are missing, rather than half-working. */
function assertInstalled() {
  const missing = ['electron', '@electron/rebuild']
    .filter((name) => !fs.existsSync(path.join(__dirname, '..', 'node_modules', name)));
  if (missing.length === 0) return;

  console.error(
    `\nDependencies are not fully installed (missing: ${missing.join(', ')}).\n`
    + 'This usually means `npm install` did not finish — a dropped connection is the\n'
    + 'most common cause, since Electron alone is around 100MB.\n\n'
    + 'Run `npm install` again; it resumes from what has already been downloaded.\n'
  );
  process.exit(1);
}

try {
  if (target === 'electron') {
    assertInstalled();
    console.log('Rebuilding better-sqlite3 for Electron…');
    // --no-install: use the electron-rebuild from node_modules and never silently
    // fetch a different package of that name from the registry.
    run('npx --no-install electron-rebuild -f -w better-sqlite3');
  } else if (loadsUnderNode()) {
    // Already built for this Node — nothing to do.
  } else {
    console.log('The database module was built for another runtime or platform; rebuilding it for Node so the tests can run…');
    run('npm rebuild better-sqlite3 --build-from-source');
  }
} catch (error) {
  console.error('Could not prepare the native database module:', error.message);
  process.exit(1);
}
