// The daily reminder run, shared by the scheduled function and the coordinator's "run now" button.
import { planReminders, sentToday, markSent, loadConfig } from './core.mjs';
import { reminderEmail, digestEmail, linkFor, sendAll } from './mail.mjs';

const env = (k) => (globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? '').trim();

export async function siteBase(store) {
  const fromEnv = env('SITE_URL') || env('URL');
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const cfg = await loadConfig(store);
  return (cfg.siteUrl || '').replace(/\/$/, '');
}

export async function runReminders(store, mailer, now = new Date()) {
  const plan = await planReminders(store, now);
  const base = await siteBase(store);
  if (!mailer.enabled) return { ok: false, error: 'Email is not set up yet.', planned: plan.messages.length };
  const already = await sentToday(store, plan.today);
  const msgs = plan.messages
    .filter((m) => !already.has(m.email))
    .map((m) => ({ key: m.email, ...reminderEmail(plan.cfg, m.volunteer, m.mine, m.open, linkFor(base, m.volunteer.key)) }));
  const DIGEST = '__coordinator__';
  if (plan.cfg.coordinatorEmail && plan.digest.length && !already.has(DIGEST)) {
    msgs.push({ key: DIGEST, ...digestEmail(plan.cfg, plan.cfg.coordinatorEmail, plan.digest, base + '/admin') });
  }
  const res = await sendAll(mailer, plan.cfg, msgs);
  await markSent(store, plan.today, res.sent);
  return {
    ok: true, date: plan.today,
    sessions: plan.digest.length, openSpots: plan.openCount,
    volunteerEmails: res.sent.filter((k) => k !== DIGEST).length,
    skippedAlreadySent: plan.messages.filter((m) => already.has(m.email)).length,
    coordinatorDigest: res.sent.includes(DIGEST),
    failed: res.failed,
  };
}
