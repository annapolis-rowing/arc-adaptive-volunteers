// Email sending (Gmail or any SMTP server) and the message templates.
//
// Environment variables:
//   GMAIL_USER, GMAIL_APP_PASSWORD   – simplest: a Gmail account + 16-character app password
//   or SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM  – any other SMTP provider
import nodemailer from 'nodemailer';

const env = (k) => (globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? '').trim();

export function makeMailer() {
  const gUser = env('GMAIL_USER'), gPass = env('GMAIL_APP_PASSWORD').replace(/\s+/g, '');
  const host = env('SMTP_HOST');
  let transport = null, fromAddr = '';
  if (gUser && gPass) {
    transport = nodemailer.createTransport({ service: 'gmail', auth: { user: gUser, pass: gPass }, pool: true, maxConnections: 3 });
    fromAddr = gUser;
  } else if (host) {
    transport = nodemailer.createTransport({ host, port: +env('SMTP_PORT') || 587, secure: env('SMTP_PORT') === '465', auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') }, pool: true, maxConnections: 3 });
    fromAddr = env('MAIL_FROM') || env('SMTP_USER');
  }
  return {
    enabled: !!transport,
    from: fromAddr,
    async send(cfg, { to, subject, html, text }) {
      if (!transport) throw new Error('Email is not set up yet (add GMAIL_USER and GMAIL_APP_PASSWORD in Netlify).');
      await transport.sendMail({
        from: { name: cfg.programName || 'Adaptive Rowing', address: fromAddr },
        replyTo: cfg.coordinatorEmail || undefined,
        to, subject, html, text,
      });
    },
    close() { transport?.close?.(); },
  };
}

/** Send many messages a few at a time; returns { sent: [to], failed: [{to, error}] }. */
export async function sendAll(mailer, cfg, msgs, concurrency = 4) {
  const sent = [], failed = [];
  const queue = [...msgs];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const { key, ...m } = queue.shift();
      try { await mailer.send(cfg, m); sent.push(key || m.to); }
      catch (e) { failed.push({ to: m.to, error: String(e.message || e) }); }
    }
  }));
  return { sent, failed };
}

/* ---------------- templates ---------------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NAVY = '#1F3B57', TEAL = '#2E6E73', INK = '#24303c', MUTED = '#65727f', LINE = '#dfe5ea';

function role(it) {
  if (it.athlete) return `${it.boat ? it.boat + ' · ' : ''}${it.position} seat with ${it.athlete}`;
  return it.position;
}
const roleNote = (it) => (it.athlete && it.note ? it.note : '');

function itemRows(items, showWhen = false) {
  return items.map((it) => `
    <tr><td style="padding:10px 12px;border-top:1px solid ${LINE};vertical-align:top;white-space:nowrap;color:${NAVY};font-weight:600">
      ${showWhen && it.when ? `<div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${TEAL}">${esc(it.when)}</div>` : ''}
      ${esc(it.dateLabel)}<br><span style="font-weight:400;color:${INK}">${esc(it.time)}</span></td>
    <td style="padding:10px 12px;border-top:1px solid ${LINE};vertical-align:top;color:${INK}">${esc(role(it))}
      ${roleNote(it) ? `<div style="color:${MUTED};font-size:13px">${esc(roleNote(it))}</div>` : ''}
      ${it.volunteer !== undefined ? `<div style="font-size:13px;margin-top:2px;color:${it.volunteer ? INK : '#9C2A2A'};font-weight:${it.volunteer ? 400 : 600}">${it.volunteer ? esc(it.volunteer) : 'OPEN'}</div>` : ''}
    </td></tr>`).join('');
}
const table = (rows) => `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;border:1px solid ${LINE};border-radius:8px;font-size:15px;margin:8px 0 18px">${rows}</table>`;
const button = (href, label) => `<p style="margin:18px 0"><a href="${esc(href)}" style="display:inline-block;background:${TEAL};color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">${esc(label)}</a></p>`;
const h2 = (t) => `<h2 style="font-size:17px;color:${NAVY};margin:22px 0 4px">${esc(t)}</h2>`;
const p = (t) => `<p style="margin:0 0 12px;line-height:1.5">${t}</p>`;

function layout(cfg, bodyHtml, { link, footerNote, audience = 'Volunteers', manageText = 'Manage your sign-ups and email settings' } = {}) {
  const contact = cfg.coordinatorEmail ? `Questions? Reply to this email${cfg.coordinatorName ? ` or contact ${esc(cfg.coordinatorName)}` : ''}.` : '';
  return `<!doctype html><html><body style="margin:0;background:#f3f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK}">
  <div style="max-width:600px;margin:0 auto;padding:20px 14px">
    <div style="background:${NAVY};color:#fff;border-radius:10px 10px 0 0;padding:16px 20px;font-weight:700;font-size:18px;letter-spacing:.02em">${esc(cfg.programName)} · ${esc(audience)}</div>
    <div style="background:#fff;border-radius:0 0 10px 10px;padding:20px;border:1px solid ${LINE};border-top:0">${bodyHtml}</div>
    <p style="color:${MUTED};font-size:12px;line-height:1.5;margin:14px 4px">${contact}
    ${link ? ` <a href="${esc(link)}" style="color:${MUTED}">${esc(manageText)}</a>.` : ''}
    ${footerNote ? '<br>' + footerNote : ''}</p>
  </div></body></html>`;
}

function textItems(items) {
  return items.map((it) => `- ${it.when ? it.when + ': ' : ''}${it.dateLabel}, ${it.time} — ${role(it)}${roleNote(it) ? ` (${roleNote(it)})` : ''}${it.volunteer !== undefined ? ' — ' + (it.volunteer || 'OPEN') : ''}`).join('\n');
}

export const linkFor = (base, key) => `${base.replace(/\/$/, '')}/?k=${encodeURIComponent(key)}`;

export function welcomeEmail(cfg, v, link) {
  return {
    to: v.email, subject: `Your ${cfg.programName} volunteer link`,
    html: layout(cfg, p(`Hi ${esc(v.name.split(' ')[0])},`) + p(`Thanks for volunteering! This button opens the sign-up page already signed in as you, on any phone or computer. Keep this email so you can come back to it.`) + button(link, 'Open my volunteer page') +
      p(`You'll get a reminder email <b>3 days before</b> and <b>the day before</b> each session you sign up for${v.alerts !== false ? ', plus a heads-up when spots are still open' : ''}.`), { link }),
    text: `Hi ${v.name},\n\nThanks for volunteering! Open your volunteer page here (keep this email):\n${link}\n\nYou'll get reminders 3 days before and the day before each session you sign up for.`,
  };
}

export function claimEmail(cfg, v, item, link, byCoordinator = false) {
  return {
    to: v.email, subject: `You're signed up: ${item.dateLabel}, ${item.time}`,
    html: layout(cfg, p(byCoordinator ? `The coordinator signed you up for this spot:` : `You're signed up. Thank you!`) + table(itemRows([item])) +
      p(`We'll remind you 3 days before and the day before. Need to change it? Use the button below.`) + button(link, 'View or change my sign-ups'), { link }),
    text: `${byCoordinator ? 'The coordinator signed you up for' : "You're signed up for"}:\n${textItems([item])}\n\nView or change: ${link}`,
  };
}

export function releasedByCoordinatorEmail(cfg, v, item, link) {
  return {
    to: v.email, subject: `Change to your sign-up: ${item.dateLabel}, ${item.time}`,
    html: layout(cfg, p(`The coordinator removed you from this spot:`) + table(itemRows([item])) + p(`If this looks wrong, just reply to this email.`) + button(link, 'See my sign-ups'), { link }),
    text: `The coordinator removed you from:\n${textItems([item])}\n\nSee your sign-ups: ${link}`,
  };
}

export function lateCancelEmail(cfg, to, v, item, adminLink) {
  return {
    to, subject: `Heads up: ${v.name} dropped ${item.dateLabel}, ${item.time}`,
    html: layout(cfg, p(`<b>${esc(v.name)}</b>${v.phone ? ` (${esc(v.phone)})` : ''} cancelled a spot that is 3 days away or less. It's open again on the sign-up page.`) + table(itemRows([item])) + button(adminLink, 'Open coordinator page')),
    text: `${v.name} cancelled a spot 3 days away or less:\n${textItems([item])}\n\n${adminLink}`,
  };
}

export function sessionCancelledEmail(cfg, v, items, reason, link) {
  const it = items[0];
  return {
    to: v.email, subject: `Cancelled: ${it.dateLabel}, ${it.time} session`,
    html: layout(cfg, p(`The <b>${esc(it.dateLabel)}, ${esc(it.time)}</b> session has been cancelled${reason ? `: ${esc(reason)}` : ''}. You don't need to come in. Thank you for signing up!`) + table(itemRows(items)) + button(link, 'See other sessions'), { link }),
    text: `The ${it.dateLabel}, ${it.time} session is cancelled${reason ? ': ' + reason : ''}.\n\n${link}`,
  };
}

export function reminderEmail(cfg, v, mine, open, link) {
  const parts = [];
  let subject;
  if (mine.length) {
    const first = mine[0];
    subject = `Reminder: ${first.when === 'Tomorrow' ? 'tomorrow' : first.dateLabel}, ${first.time}${mine.length > 1 ? ` (+${mine.length - 1} more)` : ''}`;
    parts.push(h2(mine.length > 1 ? 'Your upcoming sessions' : 'Your upcoming session') + table(itemRows(mine, true)));
  } else {
    subject = `${open.length} volunteer spot${open.length > 1 ? 's' : ''} still open this week`;
  }
  if (open.length) {
    parts.push(h2('Still open — can you help?') + p(`<span style="color:${MUTED}">These spots are still unfilled.</span>`) + table(itemRows(open.slice(0, 15), true)) + (open.length > 15 ? p(`…and ${open.length - 15} more.`) : ''));
  }
  const greet = p(`Hi ${esc(v.name.split(' ')[0])},`);
  const off = v.alerts !== false ? `You're getting open-spot alerts. You can turn these off from your volunteer page.` : '';
  return {
    to: v.email, subject,
    html: layout(cfg, greet + parts.join('') + button(link, open.length ? 'Sign up or make changes' : 'View or change my sign-ups'), { link, footerNote: esc(off) }),
    text: `Hi ${v.name},\n\n${mine.length ? 'Your upcoming sessions:\n' + textItems(mine) + '\n\n' : ''}${open.length ? 'Still open:\n' + textItems(open) + '\n\n' : ''}${link}`,
  };
}

export function openSpotsEmail(cfg, v, open, link) {
  return {
    to: v.email, subject: `${open.length} volunteer spot${open.length > 1 ? 's' : ''} open in the next week`,
    html: layout(cfg, p(`Hi ${esc(v.name.split(' ')[0])},`) + p(`We still need help with these sessions. Tap below to claim one.`) + table(itemRows(open.slice(0, 25))) + (open.length > 25 ? p(`…and ${open.length - 25} more.`) : '') + button(link, 'Sign up'), { link }),
    text: `We still need help with:\n${textItems(open)}\n\nSign up: ${link}`,
  };
}

function athleteLine(s) {
  if (!s.athleteSession) return '';
  const list = s.athletes || [];
  const names = list.map((a) => esc(a.name) + (a.note ? ` <span style="color:${MUTED}">(“${esc(a.note)}”)</span>` : '') + (a.icrew ? '' : ` <span style="color:#9C2A2A;font-size:12px">not in iCrew yet</span>`));
  return p(`<span style="font-size:14px"><b>Athletes registered:</b> ${list.length ? names.join(', ') : `<span style="color:${MUTED}">none yet</span>`}</span>`);
}

export function digestEmail(cfg, to, digest, adminLink, icrewCounts = null) {
  const blocks = digest.map((s) => s.cancelled
    ? h2(`${s.when}: ${s.dateLabel}, ${s.time}`) + p(`<i>Cancelled — ${esc(s.cancelled)}</i>`)
    : s.erg && !s.slots.length
    ? h2(`${s.when}: ${s.dateLabel}, ${s.time}`) + p(`<span style="color:${MUTED}">Erg · athletes only (no volunteer spots)</span>`) + athleteLine(s)
    : h2(`${s.when}: ${s.dateLabel}, ${s.time}`) + p(`<span style="color:${MUTED}">${s.slots.filter((x) => x.volunteer).length} of ${s.slots.length} volunteer spots filled</span>`) + athleteLine(s) + table(s.slots.map((sl) => `
      <tr><td style="padding:8px 12px;border-top:1px solid ${LINE};color:${INK}">${esc(role(sl))}</td>
      <td style="padding:8px 12px;border-top:1px solid ${LINE};text-align:right;${sl.volunteer ? '' : 'color:#9C2A2A;font-weight:600'}">${sl.volunteer ? esc(sl.volunteer) : 'OPEN'}</td></tr>`).join('')));
  const open = digest.reduce((n, s) => n + (s.cancelled ? 0 : s.slots.filter((x) => !x.volunteer).length), 0);
  const todo = icrewCounts && (icrewCounts.add || icrewCounts.remove)
    ? `<div style="background:#fff6e0;border:1px solid #f0d58a;border-radius:8px;padding:10px 12px;margin:0 0 14px;font-size:14px"><b>iCrew to-do:</b> ${[icrewCounts.add ? `${icrewCounts.add} athlete registration${icrewCounts.add > 1 ? 's' : ''} to add` : '', icrewCounts.remove ? `${icrewCounts.remove} cancellation${icrewCounts.remove > 1 ? 's' : ''} to remove` : ''].filter(Boolean).join(', ')}. See the <b>iCrew to-do</b> tab.</div>`
    : '';
  return {
    to, subject: `Volunteer status: ${open ? open + ' open spot' + (open > 1 ? 's' : '') : 'all filled'} (tomorrow & in 3 days)`,
    html: layout(cfg, p(`Here's where things stand for the sessions tomorrow and in 3 days. Volunteers and athletes signed up for these just got their reminders${open ? ', and volunteers with alerts on were told about the open spots' : ''}.`) + todo + blocks.join('') + button(adminLink, 'Open coordinator page')),
    text: digest.map((s) => `${s.when}: ${s.dateLabel}, ${s.time}\n` + (s.cancelled ? '  CANCELLED' : (s.erg && !s.slots.length ? '  Erg · athletes only\n' : '') + (s.athleteSession ? `  Athletes: ${(s.athletes || []).map((a) => a.name).join(', ') || 'none yet'}\n` : '') + textItems(s.slots))).join('\n\n'),
  };
}

/* ---------------- athlete templates ---------------- */

const A = { audience: 'Athletes', manageText: 'Manage your sessions' };
const first = (n) => esc(String(n || '').split(' ')[0]);
const hello = (a) => p(`Hi ${a.contactName ? first(a.contactName) : first(a.name)},`);
const forWhom = (a) => (a.contactName ? ` for <b>${esc(a.name)}</b>` : '');

function sessionRows(items, showWhen = false) {
  return items.map((it) => `
    <tr><td style="padding:12px 14px;border-top:1px solid ${LINE};vertical-align:top;color:${NAVY};font-weight:600;font-size:16px">
      ${showWhen && it.when ? `<div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${TEAL}">${esc(it.when)}</div>` : ''}
      ${esc(it.dateLabel)} · ${esc(it.time)}
      ${it.note ? `<div style="font-weight:400;color:${MUTED};font-size:14px">Your note: “${esc(it.note)}”</div>` : ''}</td></tr>`).join('');
}
const textSessions = (items) => items.map((it) => `- ${it.when ? it.when + ': ' : ''}${it.dateLabel}, ${it.time}${it.note ? ` (note: ${it.note})` : ''}`).join('\n');

export const athleteLinkFor = (base, key) => `${base.replace(/\/$/, '')}/athletes?k=${encodeURIComponent(key)}`;

export function athleteWelcomeEmail(cfg, a, link) {
  return {
    to: a.email, subject: `Your ${cfg.programName} sign-up link`,
    html: layout(cfg, hello(a) + p(`Welcome! This button opens the rowing sign-up page${forWhom(a)}. It works on any phone or computer, with no password. Keep this email so you can come back to it.`) + button(link, 'Open my sign-up page') +
      p(`We'll email a reminder <b>3 days before</b> and <b>the day before</b> each session.`), { link, ...A }),
    text: `Welcome! Open the rowing sign-up page${a.contactName ? ' for ' + a.name : ''} here (keep this email):\n${link}`,
  };
}

/** One email with a button per athlete (a caregiver may manage more than one). */
export function athleteLinkEmail(cfg, list) {
  const a = list[0].athlete;
  const buttons = list.map(({ athlete, link }) => button(link, list.length > 1 ? `Open ${athlete.name}'s page` : 'Open my sign-up page')).join('');
  return {
    to: a.email, subject: `Your ${cfg.programName} sign-up link`,
    html: layout(cfg, hello(a) + p(`Here's your link to the rowing sign-up page. It signs you in on this device.`) + buttons + p(`<span style="color:${MUTED}">Didn't ask for this? You can ignore it.</span>`), { ...A }),
    text: list.map(({ athlete, link }) => `${athlete.name}: ${link}`).join('\n'),
  };
}

export function athleteJoinedEmail(cfg, a, item, link, byCoordinator = false) {
  return {
    to: a.email, subject: `You're registered: ${item.dateLabel}, ${item.time}`,
    html: layout(cfg, hello(a) + p(byCoordinator ? `The coordinator registered${forWhom(a) || ' you'} for this session:` : `You're registered${forWhom(a)}. See you at practice!`) + table(sessionRows([item])) +
      p(`We'll remind you 3 days before and the day before. Can't make it? Use the button below.`) + button(link, 'See or change my sessions'), { link, ...A }),
    text: `Registered${a.contactName ? ' (' + a.name + ')' : ''}:\n${textSessions([item])}\n\nSee or change: ${link}`,
  };
}

export function athleteReminderEmail(cfg, a, items, link) {
  const it = items[0];
  return {
    to: a.email,
    subject: `Rowing reminder: ${it.when === 'Tomorrow' ? 'tomorrow' : it.dateLabel}, ${it.time}${items.length > 1 ? ` (+${items.length - 1} more)` : ''}`,
    html: layout(cfg, hello(a) + p(`A reminder${forWhom(a)}:`) + table(sessionRows(items, true)) + p(`Can't make it? Please let us know so the coordinator can plan.`) + button(link, "See my sessions / I can't make it"), { link, ...A }),
    text: `Rowing reminder${a.contactName ? ' for ' + a.name : ''}:\n${textSessions(items)}\n\nCan't make it? ${link}`,
  };
}

export function athleteSessionCancelledEmail(cfg, a, item, reason, link) {
  return {
    to: a.email, subject: `Cancelled: ${item.dateLabel}, ${item.time} rowing session`,
    html: layout(cfg, hello(a) + p(`The <b>${esc(item.dateLabel)}, ${esc(item.time)}</b> rowing session has been cancelled${reason ? `: ${esc(reason)}` : ''}. Please don't come in for it.`) + button(link, 'See other sessions'), { link, ...A }),
    text: `The ${item.dateLabel}, ${item.time} session is cancelled${reason ? ': ' + reason : ''}.\n\n${link}`,
  };
}

export function athleteRemovedEmail(cfg, a, item, link) {
  return {
    to: a.email, subject: `Change to your session: ${item.dateLabel}, ${item.time}`,
    html: layout(cfg, hello(a) + p(`The coordinator removed${forWhom(a) || ' you'} from this session:`) + table(sessionRows([item])) + p(`If this looks wrong, just reply to this email.`) + button(link, 'See my sessions'), { link, ...A }),
    text: `The coordinator removed${a.contactName ? ' ' + a.name : ' you'} from:\n${textSessions([item])}\n\n${link}`,
  };
}

export function athleteLateDropEmail(cfg, to, a, item, adminLink, wasInIcrew) {
  return {
    to, subject: `Heads up: athlete ${a.name} can't make ${item.dateLabel}, ${item.time}`,
    html: layout(cfg, p(`<b>${esc(a.name)}</b>${a.phone ? ` (${esc(a.phone)})` : ''} cancelled their registration for a session 3 days away or less. Volunteer spots were <b>not</b> changed.`) + table(sessionRows([item])) +
      (wasInIcrew ? p(`This registration was already in iCrew. It's on your <b>iCrew to-do</b> list to remove.`) : '') + button(adminLink, 'Open coordinator page')),
    text: `${a.name} cancelled ${item.dateLabel}, ${item.time} (3 days away or less). Volunteer spots were not changed.${wasInIcrew ? ' Remove it from iCrew.' : ''}\n\n${adminLink}`,
  };
}

export function testEmail(cfg, to) {
  return {
    to, subject: `Test email from ${cfg.programName} volunteer sign-up`,
    html: layout(cfg, p(`It works! Reminder emails will be sent from this address.`)),
    text: 'It works! Reminder emails will be sent from this address.',
  };
}

export function linkEmail(cfg, v, link) {
  return {
    to: v.email, subject: `Your ${cfg.programName} volunteer link`,
    html: layout(cfg, p(`Hi ${esc(v.name.split(' ')[0])},`) + p(`Here's your personal link to the volunteer sign-up page. It signs you in on this device.`) + button(link, 'Open my volunteer page') + p(`<span style="color:${MUTED}">Didn't ask for this? You can ignore it.</span>`), { link }),
    text: `Your volunteer link: ${link}`,
  };
}
