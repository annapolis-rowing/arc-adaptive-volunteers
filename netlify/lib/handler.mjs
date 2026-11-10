// HTTP routes for the app. Wired to Netlify in netlify/functions/api.mjs; tests call makeHandler directly.
import crypto from 'node:crypto';
import * as core from './core.mjs';
import * as mail from './mail.mjs';
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

  const routes = {
    /* ---------- volunteers ---------- */
    'GET schedule': async (req, url) => core.publicSchedule(store, url.searchParams.get('k'), now()),

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

    /* ---------- coordinator ---------- */
    'GET admin/overview': async (req) => {
      isAdmin(req);
      const o = await core.adminOverview(store, now());
      const origin = base(req);
      if (!o.settings.siteUrl || o.settings.siteUrl !== origin) await core.mutateConfig(store, (c) => { c.siteUrl = origin; });
      return { ...o, email: { enabled: mailer.enabled, from: mailer.from }, base: origin };
    },
    'POST admin/settings': async (req, url, body) => { isAdmin(req); return { settings: await core.saveSettings(store, body) }; },
    'POST admin/slots': async (req, url, body) => { isAdmin(req); return { slots: await core.saveSlots(store, body.slots, now()) }; },

    'POST admin/cancel': async (req, url, body) => {
      isAdmin(req);
      await core.setCancelled(store, body.date, body.time, body.reason, body.cancelled !== false);
      let notified = 0, warn = null;
      if (body.cancelled !== false && body.notify) {
        const cfg = await core.loadConfig(store);
        const people = await core.sessionVolunteers(store, body.date, body.time);
        const byVol = {};
        for (const p of people) (byVol[p.volunteer.email] ||= { v: p.volunteer, items: [] }).items.push(itemFor(cfg, body.date, p.slot));
        if (Object.keys(byVol).length && !mailer.enabled) warn = 'Email is not set up yet, so volunteers were not notified.';
        else {
          const res = await mail.sendAll(mailer, cfg, Object.values(byVol).map(({ v, items }) => mail.sessionCancelledEmail(cfg, v, items, body.reason, link(req, v))));
          notified = res.sent.length; if (res.failed.length) warn = `${res.failed.length} email(s) failed to send.`;
        }
      }
      return { ok: true, notified, emailWarning: warn };
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
