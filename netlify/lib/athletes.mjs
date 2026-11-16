// Athlete registration for sessions. Kept separate from volunteer spots on purpose:
// an athlete registering (or not) never opens, closes or changes volunteer spots.
// It only shows up as information for volunteers and the coordinator.
//
// Blobs used:
//   athletes        { byId: { [id]: athlete } }
//   ath/YYYY-MM-DD  { regs:  { [HH:MM]: { [athleteId]: { at, note, by, icrew } } },
//                     drops: { [HH:MM]: { [athleteId]: { at, by } } } }
//                   `icrew` = coordinator has entered the registration in iCrew.
//                   `drops` only holds cancellations that were already in iCrew,
//                   so the coordinator knows to take them back out.

import {
  UserError, mutate, loadConfig, todayET, nowMinutesET, addDays, dow, isDate, isTime, toMin,
  fmtTime, fmtDate, normEmail, newKey, shortName, windowDates, inSeason, sessionKey, slotsForDate,
} from './core.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (s, max = 80) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanNote = (s) => String(s ?? '').replace(/[ \t]+/g, ' ').trim().slice(0, 300);

export const isLaunchSlot = (s) => /launch/i.test(s.boat || '') || /launch|safety/i.test(s.position || '');

/* ---------------- athletes ---------------- */

export async function loadAthletes(store) {
  const cur = await store.get('athletes');
  return cur ? cur.data : { byId: {}, nextNum: 1 };
}
const mutateAthletes = (store, fn) => mutate(store, 'athletes', () => ({ byId: {}, nextNum: 1 }), fn);

export async function athleteByKey(store, key) {
  if (!key) return null;
  const a = await loadAthletes(store);
  return Object.values(a.byId).find((x) => x.key === key) || null;
}

export const publicAthlete = (a) => ({ name: a.name, email: a.email, phone: a.phone, contactName: a.contactName });

/**
 * Register an athlete. Email may be shared (a parent or caregiver can register more than one athlete),
 * so an athlete is the same person only if both name and email match.
 */
export async function registerAthlete(store, { name, email, phone, contactName }) {
  name = clean(name, 60); email = normEmail(email); phone = clean(phone, 30); contactName = clean(contactName, 60);
  if (name.length < 2) throw new UserError("Please enter the athlete's name.");
  if (!EMAIL_RE.test(email)) throw new UserError('Please enter a valid email address.');
  return mutateAthletes(store, (all) => {
    all.nextNum ||= 1;
    const ex = Object.values(all.byId).find((a) => a.email === email && a.name.toLowerCase() === name.toLowerCase());
    if (ex) return { existing: ex };
    const id = 'a' + String(all.nextNum++).padStart(3, '0');
    const a = { id, name, email, phone, contactName, key: newKey(), created: new Date().toISOString() };
    all.byId[id] = a;
    return { created: a };
  });
}

/** Rate-limited "email me my link". Returns every athlete on that email (caregivers may have several). */
export async function athleteLinkRequest(store, email) {
  email = normEmail(email);
  if (!EMAIL_RE.test(email)) throw new UserError('Please enter a valid email address.');
  return mutateAthletes(store, (all) => {
    const list = Object.values(all.byId).filter((a) => a.email === email);
    if (!list.length) return { list: [], throttled: false };
    const recent = list.some((a) => a.linkSentAt && Date.now() - Date.parse(a.linkSentAt) < 2 * 60 * 1000);
    if (recent) return { list: [], throttled: true };
    const at = new Date().toISOString();
    for (const a of list) a.linkSentAt = at;
    return { list: list.map((a) => ({ ...a })), throttled: false };
  });
}

export async function updateAthleteProfile(store, key, { name, phone, contactName }) {
  return mutateAthletes(store, (all) => {
    const a = Object.values(all.byId).find((x) => x.key === key);
    if (!a) throw new UserError('We could not find your athlete profile. Use "Email me my link".', 401);
    if (name !== undefined) { const n = clean(name, 60); if (n.length < 2) throw new UserError("Please enter the athlete's name."); a.name = n; }
    if (phone !== undefined) a.phone = clean(phone, 30);
    if (contactName !== undefined) a.contactName = clean(contactName, 60);
    return { ...a };
  });
}

export async function adminAddAthlete(store, input) {
  const r = await registerAthlete(store, input);
  if (r.existing) throw new UserError('That athlete is already on the list.');
  return r.created;
}

export async function adminUpdateAthlete(store, id, input) {
  return mutateAthletes(store, (all) => {
    const a = all.byId[id];
    if (!a) throw new UserError('Athlete not found.');
    if (input.name !== undefined) { const n = clean(input.name, 60); if (n.length < 2) throw new UserError('Name is required.'); a.name = n; }
    if (input.email !== undefined) { const e = normEmail(input.email); if (!EMAIL_RE.test(e)) throw new UserError('Please enter a valid email address.'); a.email = e; }
    if (input.phone !== undefined) a.phone = clean(input.phone, 30);
    if (input.contactName !== undefined) a.contactName = clean(input.contactName, 60);
    return { ...a };
  });
}

export async function adminDeleteAthlete(store, id, now = new Date()) {
  const today = todayET(now);
  const days = await loadAthDays(store, Array.from({ length: 84 }, (_, i) => addDays(today, i)));
  for (const d of Object.values(days)) for (const regs of Object.values(d.regs)) if (regs[id]) throw new UserError('Remove this athlete from their upcoming sessions first.');
  return mutateAthletes(store, (all) => { if (!all.byId[id]) throw new UserError('Athlete not found.'); delete all.byId[id]; });
}

/* ---------------- sessions athletes can register for ---------------- */

/** Times on a date that have at least one rowing (non-launch) spot. Launch-only sessions aren't athlete sessions. */
export function athleteTimes(cfg, date) {
  const times = new Set(slotsForDate(cfg, date).filter((s) => !isLaunchSlot(s)).map((s) => s.time));
  return [...times].sort((a, b) => toMin(a) - toMin(b));
}

/** The athletes named on the weekly schedule for a session (who usually rows then). */
function usualAthletes(cfg, date, time) {
  return [...new Set(slotsForDate(cfg, date).filter((s) => s.time === time && s.athlete).map((s) => s.athlete))];
}

export async function loadAthDays(store, dates) {
  const out = {};
  await Promise.all(dates.map(async (d) => {
    const cur = await store.get('ath/' + d);
    out[d] = cur ? { regs: cur.data.regs || {}, drops: cur.data.drops || {} } : { regs: {}, drops: {} };
  }));
  return out;
}
const mutateAthDay = (store, date, fn) => mutate(store, 'ath/' + date, () => ({ regs: {}, drops: {} }), (d) => { d.regs ||= {}; d.drops ||= {}; return fn(d); });

function isPast(date, time, now) {
  const today = todayET(now);
  if (date < today) return true;
  return date === today && toMin(time) <= nowMinutesET(now);
}

function checkSession(cfg, date, time, now, bypass) {
  if (!isDate(date) || !isTime(time)) throw new UserError('Invalid session.');
  if (!athleteTimes(cfg, date).includes(time)) throw new UserError('That session is not on the schedule.');
  if (!bypass) {
    if (!windowDates(cfg, todayET(now)).includes(date)) throw new UserError('That date is not open for sign-up yet.');
  } else if (!inSeason(cfg, date)) throw new UserError('That date is outside the season.');
  if (isPast(date, time, now)) throw new UserError('That session has already started.');
  if (cfg.cancelled[sessionKey(date, time)]) throw new UserError('That session has been cancelled.');
}

/* ---------------- athlete actions ---------------- */

export async function athleteSchedule(store, key, now = new Date()) {
  const [cfg, all] = await Promise.all([loadConfig(store), loadAthletes(store)]);
  const me = key ? Object.values(all.byId).find((a) => a.key === key) || null : null;
  const today = todayET(now);
  const dates = windowDates(cfg, today);
  const days = await loadAthDays(store, dates);
  const schedule = [], mine = [];
  for (const date of dates) {
    const times = athleteTimes(cfg, date);
    if (!times.length) continue;
    const sessions = times.map((time) => {
      const c = cfg.cancelled[sessionKey(date, time)];
      const reg = me ? (days[date].regs[time] || {})[me.id] : null;
      const atTime = slotsForDate(cfg, date).filter((x) => x.time === time);
      const s = { time, label: fmtTime(time), erg: atTime.some((x) => x.erg) && atTime.every((x) => x.erg || isLaunchSlot(x)), oneTime: !atTime.some((x) => !x.extra), cancelled: c ? c.reason || 'Cancelled' : null, past: isPast(date, time, now), registered: !!reg, note: reg ? reg.note || '' : '' };
      if (me) s.usual = usualAthletes(cfg, date, time).some((n) => n.toLowerCase() === me.name.toLowerCase());
      if (reg) mine.push({ date, dateLabel: fmtDate(date), ...s });
      return s;
    });
    schedule.push({ date, label: fmtDate(date), sessions });
  }
  return {
    program: { name: cfg.programName, coordinatorName: cfg.coordinatorName, coordinatorEmail: cfg.coordinatorEmail, seasonStart: cfg.seasonStart },
    today, schedule, mine,
    me: me ? publicAthlete(me) : null,
  };
}

export async function athleteJoin(store, athleteId, date, time, note, { now = new Date(), bypass = false, by = 'athlete' } = {}) {
  const cfg = await loadConfig(store);
  checkSession(cfg, date, time, now, bypass);
  await mutateAthDay(store, date, (d) => {
    const regs = (d.regs[time] ||= {});
    if (regs[athleteId]) throw new UserError("You're already registered for that session.");
    // Re-registering after a cancellation that's still waiting to come out of iCrew: it's still in iCrew, so nothing to do there.
    const pendingDrop = d.drops[time]?.[athleteId];
    if (pendingDrop) delete d.drops[time][athleteId];
    regs[athleteId] = { at: new Date().toISOString(), note: cleanNote(note), by, icrew: !!pendingDrop };
  });
  return { date, time };
}

export async function athleteUpdateNote(store, athleteId, date, time, note) {
  if (!isDate(date) || !isTime(time)) throw new UserError('Invalid session.');
  await mutateAthDay(store, date, (d) => {
    const r = d.regs[time]?.[athleteId];
    if (!r) throw new UserError("You're not registered for that session.");
    r.note = cleanNote(note);
  });
}

export async function athleteLeave(store, athleteId, date, time, { now = new Date(), admin = false } = {}) {
  if (!isDate(date) || !isTime(time)) throw new UserError('Invalid session.');
  if (!admin && isPast(date, time, now)) throw new UserError('That session has already started.');
  const removed = await mutateAthDay(store, date, (d) => {
    const r = d.regs[time]?.[athleteId];
    if (!r) throw new UserError("You're not registered for that session.");
    delete d.regs[time][athleteId];
    if (r.icrew) (d.drops[time] ||= {})[athleteId] = { at: new Date().toISOString(), by: admin ? 'coordinator' : 'athlete' };
    return r;
  });
  const daysOut = Math.round((Date.parse(date + 'T12:00:00Z') - Date.parse(todayET(now) + 'T12:00:00Z')) / 864e5);
  return { date, time, removed, late: daysOut <= 3 };
}

/* ---------------- coordinator: iCrew bookkeeping ---------------- */

/** Mark a registration as entered in iCrew (kind 'add'), or a cancellation as removed from iCrew (kind 'remove'). */
export async function icrewMark(store, items) {
  if (!Array.isArray(items) || !items.length || items.length > 500) throw new UserError('Nothing to update.');
  const byDate = {};
  for (const it of items) {
    if (!isDate(it.date) || !isTime(it.time) || typeof it.id !== 'string') throw new UserError('Invalid item.');
    (byDate[it.date] ||= []).push(it);
  }
  let changed = 0;
  for (const [date, list] of Object.entries(byDate)) {
    changed += await mutateAthDay(store, date, (d) => {
      let n = 0;
      for (const it of list) {
        if (it.kind === 'add') {
          const r = d.regs[it.time]?.[it.id];
          if (r && r.icrew !== (it.done !== false)) { r.icrew = it.done !== false; n++; }
        } else if (it.kind === 'remove') {
          if (d.drops[it.time]?.[it.id]) { delete d.drops[it.time][it.id]; n++; }
        }
      }
      return n;
    });
  }
  return { changed };
}

/** Everything the coordinator still needs to do in iCrew, from 14 days back through the sign-up window. */
export async function icrewTodo(store, now = new Date()) {
  const [cfg, all] = await Promise.all([loadConfig(store), loadAthletes(store)]);
  const today = todayET(now);
  const end = windowDates({ ...cfg, seasonStart: '', seasonEnd: '' }, today).slice(-1)[0] || today;
  const dates = [];
  for (let d = addDays(today, -14); d <= end; d = addDays(d, 1)) dates.push(d);
  const days = await loadAthDays(store, dates);
  const add = [], remove = [];
  const nm = (id) => all.byId[id]?.name || '(deleted athlete)';
  for (const date of dates) {
    const { regs, drops } = days[date];
    for (const [time, m] of Object.entries(regs)) for (const [id, r] of Object.entries(m)) {
      if (!r.icrew) add.push({ kind: 'add', date, time, id, name: nm(id), dateLabel: fmtDate(date), timeLabel: fmtTime(time), at: r.at, note: r.note || '', cancelled: !!cfg.cancelled[sessionKey(date, time)], past: date < today });
    }
    for (const [time, m] of Object.entries(drops)) for (const [id, r] of Object.entries(m)) {
      remove.push({ kind: 'remove', date, time, id, name: nm(id), dateLabel: fmtDate(date), timeLabel: fmtTime(time), at: r.at, by: r.by, past: date < today });
    }
  }
  const sorter = (a, b) => a.date.localeCompare(b.date) || toMin(a.time) - toMin(b.time) || a.name.localeCompare(b.name);
  return { add: add.sort(sorter), remove: remove.sort(sorter) };
}

/* ---------------- attaching athletes to the volunteer / coordinator schedules ---------------- */

/** Who's registered for each session, keyed "date|time". `full` adds contact info and iCrew status for the coordinator. */
export async function registrationsFor(store, dates, { full = false } = {}) {
  const [all, days] = await Promise.all([loadAthletes(store), loadAthDays(store, dates)]);
  const out = {};
  for (const date of dates) {
    for (const [time, m] of Object.entries(days[date].regs)) {
      const list = Object.entries(m).map(([id, r]) => {
        const a = all.byId[id];
        const name = a ? a.name : '(deleted athlete)';
        return full
          ? { id, name, email: a?.email || '', phone: a?.phone || '', contactName: a?.contactName || '', note: r.note || '', icrew: !!r.icrew, by: r.by, at: r.at }
          : { name: shortName(name) };
      }).sort((x, y) => x.name.localeCompare(y.name));
      if (list.length) out[sessionKey(date, time)] = list;
    }
    if (full) for (const [time, m] of Object.entries(days[date].drops)) {
      const k = sessionKey(date, time);
      const ids = Object.keys(m);
      if (ids.length) out[k + '|drops'] = ids.map((id) => ({ id, name: all.byId[id]?.name || '(deleted athlete)' }));
    }
  }
  return out;
}

/** Adds `athletes` (and for the coordinator `athleteDrops`, `athleteSession`) to each session of a built schedule. */
export function attachAthletes(cfg, schedule, regs) {
  for (const day of schedule) {
    const times = new Set(athleteTimes(cfg, day.date));
    for (const sess of day.sessions) {
      const k = sessionKey(day.date, sess.time);
      sess.athleteSession = times.has(sess.time);
      sess.athletes = regs[k] || [];
      if (regs[k + '|drops']) sess.athleteDrops = regs[k + '|drops'];
    }
  }
  return schedule;
}

/** Athletes registered for one session (for cancellation notices). */
export async function sessionAthletes(store, date, time) {
  const [all, days] = await Promise.all([loadAthletes(store), loadAthDays(store, [date])]);
  return Object.keys(days[date].regs[time] || {}).map((id) => all.byId[id]).filter(Boolean);
}

/** Block weekly-schedule edits that would orphan upcoming athlete registrations. */
export async function checkScheduleChange(store, newRows, now = new Date()) {
  const cfg = await loadConfig(store);
  const extraKeys = new Set((cfg.extras || []).filter((x) => !isLaunchSlot(x)).map((x) => `${x.date}|${x.time}`));
  const today = todayET(now);
  const dates = Array.from({ length: 84 }, (_, i) => addDays(today, i));
  const days = await loadAthDays(store, dates);
  const keep = new Set(newRows.filter((r) => !isLaunchSlot(r)).map((r) => `${+r.day}|${r.time}`));
  const blocked = [];
  for (const date of dates) for (const [time, m] of Object.entries(days[date].regs)) {
    const n = Object.keys(m).length;
    if (n && !keep.has(`${dow(date)}|${time}`) && !extraKeys.has(`${date}|${time}`)) blocked.push(`${fmtDate(date)} ${fmtTime(time)} (${n} athlete${n > 1 ? 's' : ''})`);
  }
  if (blocked.length) throw new UserError("These sessions have athletes registered, so they can't be removed or moved yet. Remove the athletes first: " + blocked.slice(0, 6).join('; ') + (blocked.length > 6 ? ` and ${blocked.length - 6} more` : ''));
}

/* ---------------- reminders & export ---------------- */

/** Athlete reminders for sessions tomorrow and in 3 days. Returns [{ athlete, items }] plus per-session lists for the digest. */
export async function planAthleteReminders(store, now = new Date()) {
  const [cfg, all] = await Promise.all([loadConfig(store), loadAthletes(store)]);
  const today = todayET(now);
  const targets = [{ date: addDays(today, 1), when: 'Tomorrow' }, { date: addDays(today, 3), when: 'In 3 days' }].filter((t) => inSeason(cfg, t.date));
  const days = await loadAthDays(store, targets.map((t) => t.date));
  const per = {}, bySession = {};
  for (const t of targets) {
    for (const [time, m] of Object.entries(days[t.date].regs)) {
      const cancelled = !!cfg.cancelled[sessionKey(t.date, time)];
      for (const [id, r] of Object.entries(m)) {
        const a = all.byId[id]; if (!a) continue;
        (bySession[sessionKey(t.date, time)] ||= []).push({ name: a.name, note: r.note || '', icrew: !!r.icrew });
        if (!cancelled) (per[id] ||= { athlete: a, items: [] }).items.push({ when: t.when, date: t.date, dateLabel: fmtDate(t.date), time: fmtTime(time), note: r.note || '' });
      }
    }
  }
  return { messages: Object.values(per), bySession };
}

export async function exportAthleteCsv(store, from, to) {
  const [cfg, all] = await Promise.all([loadConfig(store), loadAthletes(store)]);
  const dates = [];
  for (let d = from; d <= to && dates.length < 400; d = addDays(d, 1)) dates.push(d);
  const days = await loadAthDays(store, dates);
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Date', 'Day', 'Time', 'Athlete', 'Email', 'Phone', 'Contact person', 'Note for coach', 'Registered', 'In iCrew', 'Session status'].map(q).join(',')];
  for (const date of dates) {
    const times = Object.keys(days[date].regs).sort((a, b) => toMin(a) - toMin(b));
    for (const time of times) for (const [id, r] of Object.entries(days[date].regs[time])) {
      const a = all.byId[id];
      lines.push([date, fmtDate(date, { weekday: 'long' }), fmtTime(time), a?.name || '(deleted)', a?.email, a?.phone, a?.contactName, r.note, r.at?.slice(0, 16).replace('T', ' '), r.icrew ? 'Yes' : 'No',
        cfg.cancelled[sessionKey(date, time)] ? 'CANCELLED' : ''].map(q).join(','));
    }
  }
  return lines.join('\r\n');
}
