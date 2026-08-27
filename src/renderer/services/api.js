// The renderer's only route to data. Every main-process reply is
// { ok, data } or { ok:false, error } — this module turns a failure into a
// thrown ApiError carrying a message that is already safe to show a user.

import { toast } from '../components/toast.js';

export class ApiError extends Error {
  constructor(error) {
    super(error?.message || 'Something went wrong.');
    this.name = 'ApiError';
    this.code = error?.code || 'UNEXPECTED';
    this.details = error?.details || null;
  }
}

const bridge = window.api;

/** Call a channel and unwrap the reply. Throws ApiError on failure. */
export async function call(domain, action, payload) {
  const group = bridge[domain];
  if (!group || typeof group[action] !== 'function') {
    throw new ApiError({ message: `This action is not available (${domain}.${action}).`, code: 'NO_CHANNEL' });
  }
  const reply = await group[action](payload);
  if (!reply || reply.ok !== true) throw new ApiError(reply && reply.error);
  return reply.data;
}

/**
 * Call and show the error as a toast instead of throwing.
 * Returns { ok, data } so callers can branch without try/catch.
 */
export async function tryCall(domain, action, payload, { silent = false } = {}) {
  try {
    return { ok: true, data: await call(domain, action, payload) };
  } catch (error) {
    if (!silent) toast.error(error.message);
    return { ok: false, error };
  }
}

/** Namespaced helpers so page code reads as api.products.list(...). */
function group(domain) {
  return new Proxy({}, {
    get: (_target, action) => (payload) => call(domain, String(action), payload)
  });
}

export const api = new Proxy({}, { get: (_target, domain) => group(String(domain)) });

export function onEvent(event, callback) {
  return bridge.on(event, callback);
}

export const constants = window.appConstants;
