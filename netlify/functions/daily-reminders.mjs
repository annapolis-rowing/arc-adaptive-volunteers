// Runs every morning. Emails volunteers about sessions tomorrow and in 3 days
// (their own spots + spots still open), and sends the coordinator a status digest.
// Netlify schedules are in UTC: 12:00 UTC = 7:00 AM Eastern in winter, 8:00 AM in summer.
import { blobStore } from '../lib/store.mjs';
import { makeMailer } from '../lib/mail.mjs';
import { runReminders } from '../lib/jobs.mjs';

export default async () => {
  const mailer = makeMailer();
  try {
    const result = await runReminders(blobStore(), mailer);
    console.log('daily reminders', JSON.stringify(result));
  } finally { mailer.close(); }
};

export const config = { schedule: '0 12 * * *' };
