// Core logic for the ARC Adaptive Rowing volunteer app.
// Storage-agnostic: every function takes a `store` with get/set (see store.mjs)
// so the same code runs on Netlify Blobs and in local tests.
//
// Blobs used:
//   config          program settings + weekly schedule template + cancelled sessions
//   volunteers      { byEmail: { [email]: volunteer } }
//   day/YYYY-MM-DD  { signups: { [slotId]: { email, at } } }
//   sent/YYYY-MM-DD { emails: [...] }  (which reminder emails already went out that day)

import crypto from 'node:crypto';

export const TZ = 'America/New_York';
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const LSO = 'Launch Safety Observer';

export class UserError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

/* ---------------- default data (from the Adaptive sign-up spreadsheet) ---------------- */

const T = (day, time, boat, position, athlete) => ({ day, time, boat, position, athlete, note: athlete ? 'Level 2 bow required' : '' });
const DEFAULT_SLOTS = [
  T(0, '08:00', '2x', 'Bow', 'Ben Danforth'),
  T(1, '07:15', 'Launch', LSO, ''),
  T(1, '07:15', 'Launch', LSO, ''),
  T(1, '08:45', '2x', 'Bow', 'Jessica Woods'),
  T(1, '08:45', '2x', 'Bow', 'Doug Wintermute'),
  T(1, '08:45', 'Launch', LSO, ''),
  T(1, '18:15', '2x', 'Bow', 'Sagan Fylak'),
  T(1, '18:15', '2x', 'Bow', 'Ronda Jones'),
  T(1, '18:15', '2x', 'Bow', 'Ryan Gasser'),
  T(1, '18:15', 'Launch', LSO, ''),
  T(1, '18:15', 'Launch', LSO, ''),
  T(3, '18:15', '2x', 'Bow', 'Sagan Fylak'),
  T(3, '18:15', '2x', 'Bow', 'Ronda Jones'),
  T(3, '18:15', 'Launch', LSO, ''),
  T(3, '18:15', 'Launch', LSO, ''),
  T(4, '07:15', 'Launch', LSO, ''),
  T(4, '07:15', 'Launch', LSO, ''),
  T(4, '08:45', '2x', 'Bow', 'Jessica Woods'),
  T(4, '08:45', '2x', 'Bow', 'Doug Wintermute'),
  T(4, '08:45', 'Launch', LSO, ''),
].map((s, i) => ({ id: 's' + String(i + 1).padStart(2, '0'), ...s }));

export function defaultConfig() {
  return {
    programName: 'ARC Adaptive Rowing',
    coordinatorName: '',
    coordinatorEmail: '',
    weeksAhead: 4,
    seasonStart: '',
    seasonEnd: '',
    siteUrl: '',
    slots: structuredClone(DEFAULT_SLOTS),
    cancelled: {}, // "YYYY-MM-DD|HH:MM" -> { reason, at }
    nextSlotNum: DEFAULT_SLOTS.length + 1,
  };
}

/* ---------------- dates & times ---------------- */

export function todayET(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function nowMinutesET(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const h = +p.find((x) => x.type === 'hour').value, m = +p.find((x) => x.type === 'minute').value;
  return h * 60 + m;
}
export function addDays(date, n) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const dow = (date) => new Date(date + 'T12:00:00Z').getUTCDay();
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T12:00:00Z'));
export const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
export const toMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
export function fmtTime(t) {
  let h = +t.slice(0, 2); const m = t.slice(3, 5); const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12; return `${h}:${m} ${ap}`;
}
export function fmtDate(date, opts = { weekday: 'long', month: 'short', day: 'numeric' }) {
  return new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
}

/* ---------------- small helpers ---------------- */

export const normEmail = (e) => String(e || '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (s, max = 80) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export const newKey = () => crypto.randomBytes(18).toString('base64url');
export function shortName(name) {
  const parts = clean(name).split(' ').filter(Boolean);
  if (parts.length < 2) return parts[0] || 'Volunteer';
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read-modify-write a blob with optimistic locking, retrying on conflict. */
export async function mutate(store, key, init, fn) {
  for (let i = 0; i < 10; i++) {
    const cur = await store.get(key);
    const data = cur ? cur.data : init();
    const result = await fn(data);
    const res = await store.set(key, data, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (res.modified) return result;
    await sleep(40 + Math.random() * 120 * (i + 1));
  }
  throw new UserError('The server is busy. Please try again.', 503);
}

/* ---------------- loaders ---------------- */

export async function loadConfig(store) {
  const cur = await store.get('config');
  return cur ? { ...defaultConfig(), ...cur.data } : defaultConfig();
}
export const mutateConfig = (store, fn) => mutate(store, 'config', defaultConfig, fn);

export async function loadVolunteers(store) {
  const cur = await store.get('volunteers');
  return cur ? cur.data : { byEmail: {} };
}
export const mutateVolunteers = (store, fn) => mutate(store, 'volunteers', () => ({ byEmail: {} }), fn);

export async function volunteerByKey(store, key) {
  if (!key) return null;
  const vols = await loadVolunteers(store);
  return Object.values(vols.byEmail).find((v) => v.key === key) || null;
}

export async function loadDays(store, dates) {
  const out = {};
  await Promise.all(dates.map(async (d) => {
    const cur = await store.get('day/' + d);
    out[d] = cur ? cur.data.signups : {};
  }));
  return out;
}

/* ---------------- schedule ---------------- */

export function windowDates(cfg, today) {
  const n = Math.max(1, Math.min(12, +cfg.weeksAhead || 4)) * 7;
  const dates = [];
  for (let i = 0; i < n; i++) dates.push(addDays(today, i));
  return dates.filter((d) => inSeason(cfg, d));
}
export function inSeason(cfg, date) {
  if (cfg.seasonStart && date < cfg.seasonStart) return false;
  if (cfg.seasonEnd && date > cfg.seasonEnd) return false;
  return true;
}
export function templateForDay(cfg, date) {
  const d = dow(date);
  return cfg.slots.filter((s) => s.day === d).sort((a, b) => toMin(a.time) - toMin(b.time));
}
export const sessionKey = (date, time) => `${date}|${time}`;

/**
 * Build the dated schedule: [{ date, sessions: [{ time, cancelled, slots: [...] }] }]
 * `decorate(slot, signup)` adds per-viewer fields to each slot.
 */
export function buildSchedule(cfg, dates, days, decorate) {
  const out = [];
  for (const date of dates) {
    if (!inSeason(cfg, date)) continue;
    const tpl = templateForDay(cfg, date);
    if (!tpl.length) continue;
    const sessions = [];
    for (const s of tpl) {
      let sess = sessions.find((x) => x.time === s.time);
      if (!sess) {
        const c = cfg.cancelled[sessionKey(date, s.time)];
        sess = { time: s.time, label: fmtTime(s.time), cancelled: c ? c.reason || 'Cancelled' : null, slots: [] };
        sessions.push(sess);
      }
      const su = (days[date] || {})[s.id] || null;
      sess.slots.push(decorate({ slotId: s.id, boat: s.boat, position: s.position, athlete: s.athlete, note: s.note }, su));
    }
    out.push({ date, label: fmtDate(date), sessions });
  }
  return out;
}

function isPast(date, time, now) {
  const today = todayET(now);
  if (date < today) return true;
  return date === today && toMin(time) <= nowMinutesET(now);
}

/* ---------------- public (volunteer) actions ---------------- */

export async function publicSchedule(store, key, now = new Date()) {
  const [cfg, vols] = await Promise.all([loadConfig(store), loadVolunteers(store)]);
  const me = key ? Object.values(vols.byEmail).find((v) => v.key === key) || null : null;
  const today = todayET(now);
  const dates = windowDates(cfg, today);
  const days = await loadDays(store, dates);
  const mine = [];
  const schedule = buildSchedule(cfg, dates, days, (slot, su) => {
    const v = su ? vols.byEmail[su.email] : null;
    const isMine = !!(me && su && su.email === me.email);
    return { ...slot, status: su ? (isMine ? 'mine' : 'taken') : 'open', who: su ? shortName(v ? v.name : su.email) : null };
  });
  for (const day of schedule) {
    for (const sess of day.sessions) {
      sess.past = isPast(day.date, sess.time, now);
      for (const sl of sess.slots) if (sl.status === 'mine') mine.push({ date: day.date, dateLabel: day.label, time: sess.time, timeLabel: sess.label, cancelled: sess.cancelled, past: sess.past, ...sl });
    }
  }
  return {
    program: { name: cfg.programName, coordinatorName: cfg.coordinatorName, coordinatorEmail: cfg.coordinatorEmail, seasonStart: cfg.seasonStart, seasonEnd: cfg.seasonEnd },
    today,
    schedule,
    me: me ? { name: me.name, email: me.email, phone: me.phone, alerts: me.alerts !== false } : null,
    mine,
  };
}

/** Register a new volunteer. If the email already exists, returns { existing } so the caller emails their link instead. */
export async function register(store, { name, email, phone, alerts }) {
  name = clean(name, 60); email = normEmail(email); phone = clean(phone, 30);
  if (name.length < 2) throw new UserError('Please enter your name.');
  if (!EMAIL_RE.test(email)) throw new UserError('Please enter a valid email address.');
  return mutateVolunteers(store, (vols) => {
    const ex = vols.byEmail[email];
    if (ex) return { existing: ex };
    const v = { email, name, phone, alerts: alerts !== false, key: newKey(), created: new Date().toISOString() };
    vols.byEmail[email] = v;
    return { created: v };
  });
}

/** Rate-limited lookup for "email me my link". Returns the volunteer or null. */
export async function linkRequest(store, email) {
  email = normEmail(email);
  if (!EMAIL_RE.test(email)) throw new UserError('Please enter a valid email address.');
  return mutateVolunteers(store, (vols) => {
    const v = vols.byEmail[email];
    if (!v) return null;
    if (v.linkSentAt && Date.now() - Date.parse(v.linkSentAt) < 2 * 60 * 1000) return { ...v, throttled: true };
    v.linkSentAt = new Date().toISOString();
    return { ...v };
  });
}

export async function updateProfile(store, key, { name, phone, alerts }) {
  return mutateVolunteers(store, (vols) => {
    const v = Object.values(vols.byEmail).find((x) => x.key === key);
    if (!v) throw new UserError('We could not find your volunteer profile. Use "Email me my link".', 401);
    if (name !== undefined) { const n = clean(name, 60); if (n.length < 2) throw new UserError('Please enter your name.'); v.name = n; }
    if (phone !== undefined) v.phone = clean(phone, 30);
    if (alerts !== undefined) v.alerts = !!alerts;
    return { ...v };
  });
}

function findTemplateSlot(cfg, date, slotId) {
  if (!isDate(date)) throw new UserError('Invalid date.');
  const s = cfg.slots.find((x) => x.id === slotId);
  if (!s || s.day !== dow(date)) throw new UserError('That spot is not on the schedule.');
  return s;
}

/** Shared claim logic. `bypass` lets the coordinator assign outside the normal window. */
export async function claim(store, email, date, slotId, { now = new Date(), bypass = false } = {}) {
  const cfg = await loadConfig(store);
  const s = findTemplateSlot(cfg, date, slotId);
  if (!bypass) {
    if (!windowDates(cfg, todayET(now)).includes(date)) throw new UserError('That date is not open for sign-up yet.');
  } else if (!inSeason(cfg, date)) throw new UserError('That date is outside the season.');
  if (isPast(date, s.time, now)) throw new UserError('That session has already started.');
  if (cfg.cancelled[sessionKey(date, s.time)]) throw new UserError('That session has been cancelled.');
  const sameSession = new Set(cfg.slots.filter((x) => x.day === s.day && x.time === s.time).map((x) => x.id));
  await mutate(store, 'day/' + date, () => ({ signups: {} }), (day) => {
    const cur = day.signups[slotId];
    if (cur && cur.email === email) throw new UserError("You're already signed up for that spot.");
    if (cur) throw new UserError('Sorry, someone just took that spot.', 409);
    for (const [id, su] of Object.entries(day.signups)) {
      if (su.email === email && sameSession.has(id)) throw new UserError("You're already signed up for another spot in that session.");
    }
    day.signups[slotId] = { email, at: new Date().toISOString() };
  });
  return { slot: s, date };
}

export async function release(store, email, date, slotId, { now = new Date(), admin = false } = {}) {
  const cfg = await loadConfig(store);
  const s = findTemplateSlot(cfg, date, slotId);
  if (!admin && isPast(date, s.time, now)) throw new UserError('That session has already started.');
  const removed = await mutate(store, 'day/' + date, () => ({ signups: {} }), (day) => {
    const cur = day.signups[slotId];
    if (!cur) throw new UserError('That spot is already open.');
    if (!admin && cur.email !== email) throw new UserError('That spot belongs to someone else.', 403);
    delete day.signups[slotId];
    return cur;
  });
  const daysOut = Math.round((Date.parse(date + 'T12:00:00Z') - Date.parse(todayET(now) + 'T12:00:00Z')) / 864e5);
  return { slot: s, date, removed, late: daysOut <= 3 };
}

/* ---------------- coordinator actions ---------------- */

export async function adminOverview(store, now = new Date()) {
  const [cfg, vols] = await Promise.all([loadConfig(store), loadVolunteers(store)]);
  const today = todayET(now);
  const dates = windowDates(cfg, today);
  const days = await loadDays(store, dates);
  const schedule = buildSchedule(cfg, dates, days, (slot, su) => {
    const v = su ? vols.byEmail[su.email] : null;
    return { ...slot, volunteer: su ? { email: su.email, name: v ? v.name : su.email, phone: v ? v.phone : '', at: su.at } : null };
  });
  const upcomingCount = {};
  for (const d of Object.values(days)) for (const su of Object.values(d)) upcomingCount[su.email] = (upcomingCount[su.email] || 0) + 1;
  const volunteers = Object.values(vols.byEmail)
    .map((v) => ({ name: v.name, email: v.email, phone: v.phone, alerts: v.alerts !== false, key: v.key, created: v.created, upcoming: upcomingCount[v.email] || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const day of schedule) for (const sess of day.sessions) sess.past = isPast(day.date, sess.time, now);
  const { slots, ...settings } = cfg;
  return { today, settings, slots, schedule, volunteers };
}

const SETTING_KEYS = ['programName', 'coordinatorName', 'coordinatorEmail', 'weeksAhead', 'seasonStart', 'seasonEnd'];
export async function saveSettings(store, input) {
  const s = {};
  for (const k of SETTING_KEYS) if (input[k] !== undefined) s[k] = input[k];
  if (s.programName !== undefined) { s.programName = clean(s.programName, 60); if (!s.programName) throw new UserError('Program name is required.'); }
  if (s.coordinatorName !== undefined) s.coordinatorName = clean(s.coordinatorName, 60);
  if (s.coordinatorEmail !== undefined) {
    s.coordinatorEmail = normEmail(s.coordinatorEmail);
    if (s.coordinatorEmail && !EMAIL_RE.test(s.coordinatorEmail)) throw new UserError('Coordinator email looks invalid.');
  }
  if (s.weeksAhead !== undefined) { s.weeksAhead = Math.round(+s.weeksAhead); if (!(s.weeksAhead >= 1 && s.weeksAhead <= 12)) throw new UserError('Weeks shown must be 1–12.'); }
  for (const k of ['seasonStart', 'seasonEnd']) if (s[k] !== undefined && s[k] !== '' && !isDate(s[k])) throw new UserError('Season dates must be valid dates.');
  return mutateConfig(store, (cfg) => { Object.assign(cfg, s); const { slots, ...rest } = cfg; return rest; });
}

/** Replace the weekly template. Rows keep their id; new rows get one. Removing a row with future sign-ups is blocked. */
export async function saveSlots(store, rows, now = new Date()) {
  if (!Array.isArray(rows) || rows.length > 200) throw new UserError('Invalid schedule.');
  const cfg = await loadConfig(store);
  const cleanRows = rows.map((r) => {
    const day = +r.day;
    if (!(day >= 0 && day <= 6)) throw new UserError('Every row needs a day.');
    if (!isTime(r.time)) throw new UserError('Every row needs a start time.');
    const position = clean(r.position, 40);
    if (!position) throw new UserError('Every row needs a position.');
    return { id: r.id && cfg.slots.some((x) => x.id === r.id) ? r.id : null, day, time: r.time, boat: clean(r.boat, 20), position, athlete: clean(r.athlete, 50), note: clean(r.note, 120) };
  });
  // Rows that disappeared or moved to a different day/time must not have future sign-ups.
  const today = todayET(now);
  const days = await loadDays(store, Array.from({ length: 84 }, (_, i) => addDays(today, i)));
  const moved = cfg.slots.filter((old) => {
    const nu = cleanRows.find((r) => r.id === old.id);
    return !nu || nu.day !== old.day || nu.time !== old.time;
  });
  const blocked = [];
  for (const old of moved) for (const [d, su] of Object.entries(days)) if (su[old.id] && d >= today) blocked.push(`${fmtDate(d)} ${fmtTime(old.time)} (${old.position}${old.athlete ? ' – ' + old.athlete : ''})`);
  if (blocked.length) throw new UserError('These spots have volunteers signed up, so they can\'t be removed or moved yet. Remove the volunteers first: ' + blocked.slice(0, 6).join('; ') + (blocked.length > 6 ? ` and ${blocked.length - 6} more` : ''));
  return mutateConfig(store, (c) => {
    for (const r of cleanRows) if (!r.id) r.id = 's' + String(c.nextSlotNum++).padStart(2, '0');
    c.slots = cleanRows;
    return c.slots;
  });
}

export async function setCancelled(store, date, time, reason, cancelled) {
  if (!isDate(date) || !isTime(time)) throw new UserError('Invalid session.');
  return mutateConfig(store, (cfg) => {
    const k = sessionKey(date, time);
    if (cancelled) cfg.cancelled[k] = { reason: clean(reason, 100) || 'Cancelled', at: new Date().toISOString() };
    else delete cfg.cancelled[k];
    // tidy old entries
    const cutoff = addDays(todayET(), -30);
    for (const key of Object.keys(cfg.cancelled)) if (key.slice(0, 10) < cutoff) delete cfg.cancelled[key];
  });
}

/** Volunteers signed up for one session (for notices). */
export async function sessionVolunteers(store, date, time) {
  const [cfg, vols, days] = await Promise.all([loadConfig(store), loadVolunteers(store), loadDays(store, [date])]);
  const ids = new Set(templateForDay(cfg, date).filter((s) => s.time === time).map((s) => s.id));
  return Object.entries(days[date]).filter(([id]) => ids.has(id)).map(([id, su]) => ({ slot: cfg.slots.find((s) => s.id === id), volunteer: vols.byEmail[su.email] })).filter((x) => x.volunteer);
}

export async function adminAddVolunteer(store, input) {
  const r = await register(store, input);
  if (r.existing) throw new UserError('A volunteer with that email already exists.');
  return r.created;
}

export async function adminDeleteVolunteer(store, email, now = new Date()) {
  email = normEmail(email);
  const cfg = await loadConfig(store);
  const dates = windowDates({ ...cfg, seasonStart: '', seasonEnd: '' }, todayET(now));
  const days = await loadDays(store, dates);
  for (const [d, su] of Object.entries(days)) if (Object.values(su).some((x) => x.email === email)) throw new UserError('Remove this volunteer from their upcoming spots first.');
  return mutateVolunteers(store, (vols) => { if (!vols.byEmail[email]) throw new UserError('Volunteer not found.'); delete vols.byEmail[email]; });
}

export async function exportCsv(store, from, to) {
  const [cfg, vols] = await Promise.all([loadConfig(store), loadVolunteers(store)]);
  const dates = [];
  for (let d = from; d <= to && dates.length < 400; d = addDays(d, 1)) dates.push(d);
  const days = await loadDays(store, dates);
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Date', 'Day', 'Time', 'Boat', 'Position', 'Athlete', 'Bow level / note', 'Status', 'Volunteer', 'Email', 'Phone'].map(q).join(',')];
  const sched = buildSchedule({ ...cfg, seasonStart: '', seasonEnd: '' }, dates, days, (slot, su) => ({ ...slot, su }));
  for (const day of sched) for (const sess of day.sessions) for (const sl of sess.slots) {
    const v = sl.su ? vols.byEmail[sl.su.email] : null;
    lines.push([day.date, DAY_NAMES[dow(day.date)], fmtTime(sess.time), sl.boat, sl.position, sl.athlete, sl.note,
      sess.cancelled ? 'CANCELLED' : sl.su ? 'FILLED' : 'OPEN', v ? v.name : sl.su?.email, sl.su?.email, v?.phone].map(q).join(','));
  }
  return lines.join('\r\n');
}

/* ---------------- reminders ---------------- */

/**
 * Work out the reminder emails for a run date (does not send).
 * For sessions 1 and 3 days out:
 *   - each signed-up volunteer gets their spots
 *   - each volunteer with alerts on gets the open spots (in sessions they aren't already in)
 *   - the coordinator gets a status digest
 */
export async function planReminders(store, now = new Date()) {
  const [cfg, vols] = await Promise.all([loadConfig(store), loadVolunteers(store)]);
  const today = todayET(now);
  const targets = [{ date: addDays(today, 1), when: 'Tomorrow' }, { date: addDays(today, 3), when: 'In 3 days' }]
    .filter((t) => inSeason(cfg, t.date));
  const days = await loadDays(store, targets.map((t) => t.date));
  const perVol = {}; // email -> { mine: [], open: [] }
  const digest = [];
  const openAll = [];
  for (const t of targets) {
    const sched = buildSchedule(cfg, [t.date], days, (slot, su) => ({ ...slot, su }))[0];
    if (!sched) continue;
    for (const sess of sched.sessions) {
      if (sess.cancelled) { digest.push({ ...t, dateLabel: sched.label, time: sess.label, cancelled: sess.cancelled, slots: [] }); continue; }
      const inSession = new Set(sess.slots.filter((s) => s.su).map((s) => s.su.email));
      const dslots = [];
      for (const sl of sess.slots) {
        const item = { when: t.when, date: t.date, dateLabel: sched.label, time: sess.label, boat: sl.boat, position: sl.position, athlete: sl.athlete, note: sl.note };
        if (sl.su) {
          const v = vols.byEmail[sl.su.email];
          if (v) (perVol[v.email] ||= { mine: [], open: [] }).mine.push(item);
          dslots.push({ ...item, volunteer: v ? `${v.name}${v.phone ? ' · ' + v.phone : ''}` : sl.su.email });
        } else {
          dslots.push({ ...item, volunteer: null });
          openAll.push({ ...item, sessionEmails: inSession });
        }
      }
      digest.push({ ...t, dateLabel: sched.label, time: sess.label, slots: dslots });
    }
  }
  for (const v of Object.values(vols.byEmail)) {
    if (v.alerts === false) continue;
    const open = openAll.filter((o) => !o.sessionEmails.has(v.email)).map(({ sessionEmails, ...o }) => o);
    if (open.length) (perVol[v.email] ||= { mine: [], open: [] }).open = open;
  }
  const messages = Object.entries(perVol).map(([email, m]) => ({ email, volunteer: vols.byEmail[email], ...m }));
  return { cfg, today, targets, messages, digest, openCount: openAll.length };
}

/** Open spots in the next `days` days (for the coordinator's "email open spots now" button). */
export async function openSpots(store, days = 7, now = new Date()) {
  const cfg = await loadConfig(store);
  const today = todayET(now);
  const dates = Array.from({ length: days }, (_, i) => addDays(today, i)).filter((d) => inSeason(cfg, d));
  const signups = await loadDays(store, dates);
  const out = [];
  for (const day of buildSchedule(cfg, dates, signups, (slot, su) => ({ ...slot, su }))) {
    for (const sess of day.sessions) {
      if (sess.cancelled || isPast(day.date, sess.time, now)) continue;
      for (const sl of sess.slots) if (!sl.su) out.push({ date: day.date, dateLabel: day.label, time: sess.label, boat: sl.boat, position: sl.position, athlete: sl.athlete, note: sl.note });
    }
  }
  return { cfg, open: out };
}

export async function sentToday(store, date) {
  const cur = await store.get('sent/' + date);
  return new Set(cur ? cur.data.emails : []);
}
export async function markSent(store, date, emails) {
  if (!emails.length) return;
  await mutate(store, 'sent/' + date, () => ({ emails: [] }), (d) => { d.emails = [...new Set([...d.emails, ...emails])]; });
}
