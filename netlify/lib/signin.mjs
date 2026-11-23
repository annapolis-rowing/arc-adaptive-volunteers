// 6-digit sign-in codes, sent with "Email me my link".
// A saved home-screen app has its own storage, and email links open in the browser,
// so a code typed into the app is the only reliable way to sign the app in.
//
// Blob `signin-codes`: { "<kind>:<email>": { hash, exp, tries } }
//   kind = 'v' (volunteer) or 'a' (athlete). Only a hash of the code is stored.

import { createHash, randomInt } from 'node:crypto';
import { UserError, mutate, normEmail } from './core.mjs';

const TTL_MS = 30 * 60 * 1000;
const MAX_TRIES = 5;
const hash = (id, code) => createHash('sha256').update(id + '|' + code).digest('hex');
const mutateCodes = (store, fn) => mutate(store, 'signin-codes', () => ({}), fn);

/** Make a new code for this email (replacing any earlier one). Returns the code to put in the email. */
export async function issueCode(store, kind, email) {
  const id = kind + ':' + normEmail(email);
  const code = String(randomInt(0, 1e6)).padStart(6, '0');
  await mutateCodes(store, (all) => {
    const now = Date.now();
    for (const [k, v] of Object.entries(all)) if (v.exp < now) delete all[k]; // tidy expired
    all[id] = { hash: hash(id, code), exp: now + TTL_MS, tries: 0 };
  });
  return code;
}

/** Check a code. Succeeds once; wrong codes count toward a limit. */
export async function checkCode(store, kind, email, code) {
  const id = kind + ':' + normEmail(email);
  code = String(code ?? '').replace(/\D/g, '');
  if (code.length !== 6) throw new UserError('Enter the 6-digit code from the email.');
  const result = await mutateCodes(store, (all) => {
    const c = all[id];
    if (!c || c.exp < Date.now()) { delete all[id]; return 'expired'; }
    if (c.hash === hash(id, code)) { delete all[id]; return 'ok'; }
    c.tries += 1;
    if (c.tries >= MAX_TRIES) { delete all[id]; return 'locked'; }
    return 'wrong';
  });
  if (result === 'ok') return true;
  if (result === 'wrong') throw new UserError("That code doesn't match. Check the newest email and try again.");
  if (result === 'locked') throw new UserError('Too many tries. Tap "Send a new code" to get a fresh one.');
  throw new UserError('That code has expired or was already used. Tap "Send a new code".');
}
