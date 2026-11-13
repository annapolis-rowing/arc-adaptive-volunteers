// HTTP routes for the app. Wired to Netlify in netlify/functions/api.mjs; tests call makeHandler directly.
import crypto from 'node:crypto';
import * as core from './core.mjs';
import * as mail from './mail.mjs';
import * as ath from './athletes.mjs';
import { runReminders } from './jobs.mjs';

const env = (k) => (globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? '').trim();
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

function itemFor(cfg, date, slot) {
  return { dateLabel: core.fmtDate(date), time: core.fmtTime(slot.time), boat: slot.boat, position: slot.position, athlete: slot.athlete, note: slot.note };
}

export function makeHandler({ store, mailer, now = () => new Date() }) {
  const base = (req) => (env('SITE_URL') || env('URL') || new URL(req.url).origin).replace(/\/$/, '');
  const link = (req, v) => mail.linkFor(base(req), v.key);

  async function trySend(cfg, msg) {
    if (!mailer.enabled) return 'Email is not set up yet, so no email was sent.';
    try { await mailer.send(cfg, msg); return null; } catch (e) { console.error('email failed', e); return 'The email could not be sent.'; }
  }

  function isAdmin(req) {
    const want = env('ADMIN_PASSCODE');
    const got = req.headers.get('x-admin-pass') || '';
    if (!want) throw new core.UserError('The coordinator passcode has not been set. Add ADMIN_PASSCODE in Netlify (see README).', 503);
    const a = crypto.createHash('sha256').update(want).digest(), b = crypto.createHash('sha256').update(got).digest();
    if (!crypto.timingSafeEqual(a, b)) throw new core.UserError('Wrong passcode.', 401);
  }

  async function me(key) {
    const v = await core.volunteerByKey(store, key);
    if (!v) throw new core.UserError('We could not find your volunteer profile. Use "Email me my link" to sign in again.', 401);
    return v;
  }

  /* athletes */
  const athLink = (req, a) => mail.athleteLinkFor(base(req), a.key);
  const athItem = (date, time, note = '') => ({ dateLabel: core.fmtDate(date), time: core.fmtTime(time), note });
  async function athMe(key) {
    const a = await ath.athleteByKey(store, key);
    if (!a) throw new core.UserError('We could not find your athlete profile. Use "Email me my link" to sign in again.', 401);
    return a;
  }
  async function athById(id) {
    const a = (await ath.loadAthletes(store)).byId[id];
    if (!a) throw new core.UserError('Pick an athlete from the list.');
    return a;
  }
  async function sendAthleteLinks(req, cfg, list) {
    if (!list.length) return null;
    return trySend(cfg, mail.athleteLinkEmail(cfg, list.map((a) => ({ athlete: a, link: athLink(req, a) }))));
  }

  const routes = {
    /* ---------- volunteers ---------- */
    'GET schedule': async (req, url) => {
      const out = await core.publicSchedule(store, url.searchParams.get('k'), now());
      const cfg = await core.loadConfig(store);
      ath.attachAthletes(cfg, out.schedule, await ath.registrationsFor(store, out.schedule.map((d) => d.date)));
      return out;
    },

    'POST register': async (req, url, body) => {
      const r = await core.register(store, body);
      const cfg = await core.loadConfig(store);
      if (r.existing) {
        const v = await core.linkRequest(store, r.existing.email);
        if (v && !v.throttled) await trySend(cfg, mail.linkEmail(cfg, v, link(req, v)));
        return { existing: true, message: `You're already registered. We emailed your personal link to ${r.existing.email} — open it to continue.` };
      }
      const warn = await trySend(cfg, mail.welcomeEmail(cfg, r.created, link(req, r.created)));
      return { key: r.created.key, emailWarning: warn };
    },

    'POST link': async (req, url, body) => {
      const v = await core.linkRequest(store, body.email);
      const cfg = await core.loadConfig(store);
      if (v && !v.throttled) await trySend(cfg, mail.linkEmail(cfg, v, link(req, v)));
      return { message: `If ${core.normEmail(body.email)} is registered, a sign-in link is on its way. Check your inbox (and spam folder).` };
    },

    'POST profile': async (req, url, body) => {
      const v = await core.updateProfile(store, body.k, body);
      return { me: { name: v.name, email: v.email, phone: v.phone, alerts: v.alerts !== false } };
    },

    'POST claim': async (req, url, body) => {
      const v = await me(body.k);
      const r = await core.claim(store, v.email, body.date, body.slotId, { now: now() });
      const cfg = await core.loadConfig(store);
      const warn = await trySend(cfg, mail.claimEmail(cfg, v, itemFor(cfg, r.date, r.slot), link(req, v)));
      return { ok: true, emailWarning: warn };
    },

    'POST release': async (req, url, body) => {
      const v = await me(body.k);
      const r = await core.release(store, v.email, body.date, body.slotId, { now: now() });
      const cfg = await core.loadConfig(store);
      if (r.late && cfg.coordinatorEmail) await trySend(cfg, mail.lateCancelEmail(cfg, cfg.coordinatorEmail, v, itemFor(cfg, r.date, r.slot), base(req) + '/admin'));
      return { ok: true };
    },

    /* ---------- athletes ---------- */
    'GET athlete/schedule': async (req, url) => ath.athleteSchedule(store, url.searchParams.get('k'), now()),

    'POST athlete/register': async (req, url, body) => {
      const r = await ath.registerAthlete(store, body);
      const cfg = await core.loadConfig(store);
      if (r.existing) {
        const l = await ath.athleteLinkRequest(store, r.existing.email);
        if (!l.throttled) await sendAthleteLinks(req, cfg, l.list);
        return { existing: true, message: `${r.existing.name} is already registered. We emailed the personal link to ${r.existing.email} — open it to continue.` };
      }
      const warn = await trySend(cfg, mail.athleteWelcomeEmail(cfg, r.created, athLink(req, r.created)));
      return { key: r.created.key, emailWarning: warn };
    },

    'POST athlete/link': async (req, url, body) => {
      const l = await ath.athleteLinkRequest(store, body.email);
      const cfg = await core.loadConfig(store);
      if (!l.throttled) await sendAthleteLinks(req, cfg, l.list);
      return { message: `If ${core.normEmail(body.email)} is registered, a sign-in link is on its way. Check your inbox (and spam folder).` };
    },

    'POST athlete/profile': async (req, url, body) => {
      const a = await ath.updateAthleteProfile(store, body.k, body);
      return { me: ath.publicAthlete(a) };
    },

    'POST athlete/join': async (req, url, body) => {
      const a = await athMe(body.k);
      await ath.athleteJoin(store, a.id, body.date, body.time, body.note, { now: now() });
      const cfg = await core.loadConfig(store);
      const warn = await trySend(cfg, mail.athleteJoinedEmail(cfg, a, athItem(body.date, body.time, body.note), athLink(req, a)));
      return { ok: true, emailWarning: warn };
    },

    'POST athlete/note': async (req, url, body) => {
      const a = await athMe(body.k);
      await ath.athleteUpdateNote(store, a.id, body.date, body.time, body.note);
      return { ok: true };
    },

    'POST athlete/leave': async (req, url, body) => {
      const a = await athMe(body.k);
      const r = await ath.athleteLeave(store, a.id, body.date, body.time, { now: now() });
      const cfg = await core.loadConfig(store);
      if (r.late && cfg.coordinatorEmail) await trySend(cfg, mail.athleteLateDropEmail(cfg, cfg.coordinatorEmail, a, athItem(r.date, r.time, r.removed.note), base(req) + '/admin', r.removed.icrew));
      return { ok: true };
    },

    /* ---------- coordinator ---------- */
    'GET admin/overview': async (req) => {
      isAdmin(req);
      const o = await core.adminOverview(store, now());
      const origin = base(req);
      if (!o.settings.siteUrl || o.settings.siteUrl !== origin) await core.mutateConfig(store, (c) => { c.siteUrl = origin; });
      const cfg = await core.loadConfig(store);
      ath.attachAthletes(cfg, o.schedule, await ath.registrationsFor(store, o.schedule.map((d) => d.date), { full: true }));
      const [all, todo] = await Promise.all([ath.loadAthletes(store), ath.icrewTodo(store, now())]);
      const upcoming = {};
      for (const d of o.schedule) for (const s of d.sessions) if (!s.past) for (const a of s.athletes || []) upcoming[a.id] = (upcoming[a.id] || 0) + 1;
      const athletes = Object.values(all.byId).map((a) => ({ id: a.id, name: a.name, email: a.email, phone: a.phone, contactName: a.contactName, key: a.key, created: a.created, upcoming: upcoming[a.id] || 0 }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { ...o, athletes, icrew: todo, email: { enabled: mailer.enabled, from: mailer.from }, base: origin };
    },
    'POST admin/settings': async (req, url, body) => { isAdmin(req); return { settings: await core.saveSettings(store, body) }; },
    'POST admin/slots': async (req, url, body) => {
      isAdmin(req);
      if (Array.isArray(body.slots)) await ath.checkScheduleChange(store, body.slots, now());
      return { slots: await core.saveSlots(store, body.slots, now()) };
    },

    'POST admin/cancel': async (req, url, body) => {
      isAdmin(req);
      await core.setCancelled(store, body.date, body.time, body.reason, body.cancelled !== false);
      let notified = 0, athletesNotified = 0, warn = null;
      if (body.cancelled !== false && body.notify) {
        const cfg = await core.loadConfig(store);
        const people = await core.sessionVolunteers(store, body.date, body.time);
        const athletes = await ath.sessionAthletes(store, body.date, body.time);
        const byVol = {};
        for (const p of people) (byVol[p.volunteer.email] ||= { v: p.volunteer, items: [] }).items.push(itemFor(cfg, body.date, p.slot));
        if ((Object.keys(byVol).length || athletes.length) && !mailer.enabled) warn = 'Email is not set up yet, so nobody was notified.';
        else {
          const vRes = await mail.sendAll(mailer, cfg, Object.values(byVol).map(({ v, items }) => mail.sessionCancelledEmail(cfg, v, items, body.reason, link(req, v))));
          const aRes = await mail.sendAll(mailer, cfg, athletes.map((a) => mail.athleteSessionCancelledEmail(cfg, a, athItem(body.date, body.time), body.reason, athLink(req, a))));
          notified = vRes.sent.length; athletesNotified = aRes.sent.length;
          const failed = vRes.failed.length + aRes.failed.length;
          if (failed) warn = `${failed} email(s) failed to send.`;
        }
      }
      return { ok: true, notified, athletesNotified, emailWarning: warn };
    },

    'POST admin/one-time': async (req, url, body) => {
      isAdmin(req);
      return core.addOneTimeSession(store, body, now());
    },
    'POST admin/one-time-delete': async (req, url, body) => {
      isAdmin(req);
      const athletes = core.isDate(body.date) && core.isTime(body.time) ? await ath.sessionAthletes(store, body.date, body.time) : [];
      await core.deleteOneTimeSession(store, body.date, body.time, athletes.length > 0);
      return { ok: true };
    },

    'POST admin/athlete': async (req, url, body) => {
      isAdmin(req);
      const a = await ath.adminAddAthlete(store, body);
      let warn = null;
      if (body.sendWelcome) { const cfg = await core.loadConfig(store); warn = await trySend(cfg, mail.athleteWelcomeEmail(cfg, a, athLink(req, a))); }
      return { ok: true, emailWarning: warn };
    },
    'POST admin/athlete-update': async (req, url, body) => { isAdmin(req); await ath.adminUpdateAthlete(store, body.id, body); return { ok: true }; },
    'POST admin/athlete-delete': async (req, url, body) => { isAdmin(req); await ath.adminDeleteAthlete(store, body.id, now()); return { ok: true }; },
    'POST admin/athlete-send-link': async (req, url, body) => {
      isAdmin(req);
      const a = await athById(body.id);
      const cfg = await core.loadConfig(store);
      const warn = await trySend(cfg, mail.athleteLinkEmail(cfg, [{ athlete: a, link: athLink(req, a) }]));
      if (warn) throw new core.UserError(warn);
      return { ok: true };
    },
    'POST admin/athlete-join': async (req, url, body) => {
      isAdmin(req);
      const a = await athById(body.id);
      await ath.athleteJoin(store, a.id, body.date, body.time, body.note, { now: now(), bypass: true, by: 'coordinator' });
      let warn = null;
      if (body.notify) { const cfg = await core.loadConfig(store); warn = await trySend(cfg, mail.athleteJoinedEmail(cfg, a, athItem(body.date, body.time, body.note), athLink(req, a), true)); }
      return { ok: true, emailWarning: warn };
    },
    'POST admin/athlete-leave': async (req, url, body) => {
      isAdmin(req);
      const a = await athById(body.id);
      const r = await ath.athleteLeave(store, a.id, body.date, body.time, { now: now(), admin: true });
      let warn = null;
      if (body.notify) { const cfg = await core.loadConfig(store); warn = await trySend(cfg, mail.athleteRemovedEmail(cfg, a, athItem(body.date, body.time, r.removed.note), athLink(req, a))); }
      return { ok: true, wasInIcrew: !!r.removed.icrew, emailWarning: warn };
    },
    'POST admin/icrew-mark': async (req, url, body) => { isAdmin(req); return ath.icrewMark(store, body.items); },
    'GET admin/athlete-export': async (req, url) => {
      isAdmin(req);
      const today = core.todayET(now());
      const from = core.isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : core.addDays(today, -60);
      const to = core.isDate(url.searchParams.get('to')) ? url.searchParams.get('to') : core.addDays(today, 84);
      const csv = await ath.exportAthleteCsv(store, from, to);
      return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="athlete-registrations-${from}-to-${to}.csv"`, 'cache-control': 'no-store' } });
    },

    'POST admin/remove': async (req, url, body) => {
      isAdmin(req);
      const r = await core.release(store, null, body.date, body.slotId, { admin: true, now: now() });
      let warn = null;
      if (body.notify) {
        const [cfg, vols] = await Promise.all([core.loadConfig(store), core.loadVolunteers(store)]);
        const v = vols.byEmail[r.removed.email];
        if (v) warn = await trySend(cfg, mail.releasedByCoordinatorEmail(cfg, v, itemFor(cfg, r.date, r.slot), link(req, v)));
      }
      return { ok: true, emailWarning: warn };
    },

    'POST admin/assign': async (req, url, body) => {
      isAdmin(req);
      const vols = await core.loadVolunteers(store);
      const v = vols.byEmail[core.normEmail(body.email)];
      if (!v) throw new core.UserError('Pick a volunteer from the list.');
      const r = await core.claim(store, v.email, body.date, body.slotId, { now: now(), bypass: true });
      let warn = null;
      if (body.notify) { const cfg = await core.loadConfig(store); warn = await trySend(cfg, mail.claimEmail(cfg, v, itemFor(cfg, r.date, r.slot), link(req, v), true)); }
      return { ok: true, emailWarning: warn };
    },

    'POST admin/volunteer': async (req, url, body) => {
      isAdmin(req);
      const v = await core.adminAddVolunteer(store, body);
      let warn = null;
      if (body.sendWelcome) { const cfg = await core.loadConfig(store); warn = await trySend(cfg, mail.welcomeEmail(cfg, v, link(req, v))); }
      return { ok: true, emailWarning: warn };
    },
    'POST admin/volunteer-delete': async (req, url, body) => { isAdmin(req); await core.adminDeleteVolunteer(store, body.email, now()); return { ok: true }; },
    'POST admin/send-link': async (req, url, body) => {
      isAdmin(req);
      const vols = await core.loadVolunteers(store);
      const v = vols.byEmail[core.normEmail(body.email)];
      if (!v) throw new core.UserError('Volunteer not found.');
      const cfg = await core.loadConfig(store);
      const warn = await trySend(cfg, mail.linkEmail(cfg, v, link(req, v)));
      if (warn) throw new core.UserError(warn);
      return { ok: true };
    },

    'POST admin/blast': async (req, url, body) => {
      isAdmin(req);
      if (!mailer.enabled) throw new core.UserError('Email is not set up yet.');
      const days = Math.max(1, Math.min(28, +body.days || 7));
      const { cfg, open } = await core.openSpots(store, days, now());
      if (!open.length) return { ok: true, sent: 0, message: `No open spots in the next ${days} days. Nothing was sent.` };
      const vols = Object.values((await core.loadVolunteers(store)).byEmail).filter((v) => v.alerts !== false);
      const res = await mail.sendAll(mailer, cfg, vols.map((v) => mail.openSpotsEmail(cfg, v, open, link(req, v))));
      return { ok: true, sent: res.sent.length, failed: res.failed.length, open: open.length };
    },
    'POST admin/run-reminders': async (req) => { isAdmin(req); return runReminders(store, mailer, now()); },
    'POST admin/test-email': async (req, url, body) => {
      isAdmin(req);
      const cfg = await core.loadConfig(store);
      const to = core.normEmail(body.to || cfg.coordinatorEmail);
      if (!to) throw new core.UserError('Enter an email address to send the test to.');
      if (!mailer.enabled) throw new core.UserError('Email is not set up yet. Add GMAIL_USER and GMAIL_APP_PASSWORD in Netlify, then redeploy.');
      await mailer.send(cfg, mail.testEmail(cfg, to));
      return { ok: true, message: `Test email sent to ${to}.` };
    },
    'GET admin/export': async (req, url) => {
      isAdmin(req);
      const today = core.todayET(now());
      const from = core.isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : core.addDays(today, -60);
      const to = core.isDate(url.searchParams.get('to')) ? url.searchParams.get('to') : core.addDays(today, 84);
      const csv = await core.exportCsv(store, from, to);
      return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="volunteer-signups-${from}-to-${to}.csv"`, 'cache-control': 'no-store' } });
    },
  };

  return async function handle(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
    const fn = routes[`${req.method} ${path}`];
    if (!fn) return json({ error: 'Not found' }, 404);
    try {
      let body = {};
      if (req.method === 'POST') { try { body = await req.json(); } catch { body = {}; } }
      const out = await fn(req, url, body);
      return out instanceof Response ? out : json(out);
    } catch (e) {
      if (e instanceof core.UserError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Something went wrong on the server. Please try again.' }, 500);
    }
  };
}
