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

const { execSync } = require('child_process');

const target = process.argv[2] === 'electron' ? 'electron' : 'node';

function loadsUnderNode() {
  try {
    // The native binding is loaded lazily on first use, so opening a database is
    // the only reliable way to find out which ABI the build targets.
    const Database = require('better-sqlite3');
    new Database(':memory:').close();
    return true;
  } catch (error) {
    if (/NODE_MODULE_VERSION/.test(error.message)) return false;
    throw error;
  }
}

function run(command) {
  execSync(command, { stdio: 'inherit' });
}

try {
  if (target === 'electron') {
    console.log('Rebuilding better-sqlite3 for Electron…');
    run('npx electron-rebuild -f -w better-sqlite3');
  } else if (loadsUnderNode()) {
    // Already built for this Node — nothing to do.
  } else {
    console.log('better-sqlite3 was built for Electron; rebuilding it for Node so the tests can run…');
    run('npm rebuild better-sqlite3 --build-from-source');
  }
} catch (error) {
  console.error('Could not prepare the native database module:', error.message);
  process.exit(1);
}
