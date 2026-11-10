// Netlify Blobs adapter exposing the tiny get/set interface core.mjs expects.
import { getStore } from '@netlify/blobs';

export function blobStore() {
  const s = getStore({ name: 'adaptive-volunteers', consistency: 'strong' });
  return {
    async get(key) {
      const r = await s.getWithMetadata(key, { type: 'json' });
      return r ? { data: r.data, etag: r.etag } : null;
    },
    async set(key, data, cond = {}) {
      const r = await s.setJSON(key, data, cond);
      return { modified: r ? r.modified !== false : true };
    },
  };
}
