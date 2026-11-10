// All /api/* requests from the volunteer page and the coordinator page.
import { blobStore } from '../lib/store.mjs';
import { makeMailer } from '../lib/mail.mjs';
import { makeHandler } from '../lib/handler.mjs';

export default async (req) => {
  const mailer = makeMailer();
  try { return await makeHandler({ store: blobStore(), mailer })(req); }
  finally { mailer.close(); }
};

export const config = { path: '/api/*' };
