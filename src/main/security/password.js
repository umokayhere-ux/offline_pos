'use strict';

const crypto = require('crypto');

/**
 * Password hashing using scrypt from Node's own crypto module — no native
 * dependency, no network, and memory-hard. Salt and parameters are stored with
 * the hash so parameters can be raised later without invalidating old hashes.
 */

const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('Password is required');
  }
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(plain.normalize('NFKC'), salt, PARAMS.keylen, PARAMS);
  return {
    hash: `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${derived.toString('base64')}`,
    salt: salt.toString('base64')
  };
}

function verifyPassword(plain, storedHash, storedSalt) {
  try {
    if (typeof plain !== 'string' || !storedHash || !storedSalt) return false;
    const [scheme, N, r, p, keyB64] = String(storedHash).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(keyB64, 'base64');
    const derived = crypto.scryptSync(
      plain.normalize('NFKC'),
      Buffer.from(storedSalt, 'base64'),
      expected.length,
      { N: Number(N), r: Number(r), p: Number(p) }
    );
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Basic strength policy; the minimum length is configurable per shop. */
function validatePasswordStrength(plain, minLength = 6) {
  const errors = [];
  if (typeof plain !== 'string' || plain.length < minLength) {
    errors.push(`Password must be at least ${minLength} characters long.`);
  }
  if (/^\s|\s$/.test(plain || '')) errors.push('Password cannot start or end with a space.');
  return { valid: errors.length === 0, errors };
}

module.exports = { hashPassword, verifyPassword, validatePasswordStrength };
