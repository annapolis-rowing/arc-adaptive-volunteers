// The daily reminder run, shared by the scheduled function and the coordinator's "run now" button.
import { planReminders, sentToday, markSent, loadConfig, fmtTime, sessionKey, notifyList } from './core.mjs';
import { reminderEmail, digestEmail, linkFor, sendAll, athleteReminderEmail, athleteLinkFor } from './mail.mjs';
import { planAthleteReminders, athleteTimes, icrewTodo } from './athletes.mjs';

const env = (k) => (globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? '').trim();

export async function siteBase(store) {
  const fromEnv = env('SITE_URL') || env('URL');
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const cfg = await loadConfig(store);
  return (cfg.siteUrl || '').replace(/\/$/, '');
}

export async function runReminders(store, mailer, now = new Date()) {
  const [plan, ath] = await Promise.all([planReminders(store, now), planAthleteReminders(store, now)]);
  const base = await siteBase(store);
  if (!mailer.enabled) return { ok: false, error: 'Email is not set up yet.', planned: plan.messages.length + ath.messages.length };
  const already = await sentToday(store, plan.today);

  const msgs = plan.messages
    .filter((m) => !already.has(m.email))
    .map((m) => ({ key: m.email, ...reminderEmail(plan.cfg, m.volunteer, m.mine, m.open, linkFor(base, m.volunteer.key)) }));

  // Athlete reminders. Keyed by athlete id so a caregiver with two athletes gets one email for each.
  const athKey = (id) => 'athlete:' + id;
  const athMsgs = ath.messages
    .filter((m) => !already.has(athKey(m.athlete.id)))
    .map((m) => ({ key: athKey(m.athlete.id), ...athleteReminderEmail(plan.cfg, m.athlete, m.items, athleteLinkFor(base, m.athlete.key)) }));
  msgs.push(...athMsgs);

  const DIGEST = '__coordinator__';
  if (notifyList(plan.cfg).length && plan.digest.length && !already.has(DIGEST)) {
    for (const d of plan.digest) {
      const raw = athleteTimes(plan.cfg, d.date).find((t) => fmtTime(t) === d.time);
      d.athleteSession = !!raw;
      d.athletes = raw ? ath.bySession[sessionKey(d.date, raw)] || [] : [];
    }
    const todo = await icrewTodo(store, now);
    msgs.push({ key: DIGEST, ...digestEmail(plan.cfg, notifyList(plan.cfg).join(', '), plan.digest, base + '/admin', { add: todo.add.length, remove: todo.remove.length }) });
  }
  const res = await sendAll(mailer, plan.cfg, msgs);
  await markSent(store, plan.today, res.sent);
  const isAth = (k) => k.startsWith('athlete:');
  return {
    ok: true, date: plan.today,
    sessions: plan.digest.length, openSpots: plan.openCount,
    volunteerEmails: res.sent.filter((k) => k !== DIGEST && !isAth(k)).length,
    athleteEmails: res.sent.filter(isAth).length,
    skippedAlreadySent: plan.messages.filter((m) => already.has(m.email)).length + ath.messages.filter((m) => already.has(athKey(m.athlete.id))).length,
    coordinatorDigest: res.sent.includes(DIGEST),
    failed: res.failed,
  };
}
