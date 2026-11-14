// Supabase through its REST API (PostgREST) with the service role key. No client package.
import { config } from './config.js';

async function rest(path, { method = 'GET', body, prefer, query } = {}) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const res = await fetch(`${config.supabaseUrl}/rest/v1/${path}${qs}`, {
    method,
    headers: {
      apikey: config.supabaseKey,
      authorization: `Bearer ${config.supabaseKey}`,
      'content-type': 'application/json',
      ...(prefer ? { prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`supabase ${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export const db = {
  select: (table, query) => rest(table, { query }),
  insert: (table, rows) => rest(table, { method: 'POST', body: rows, prefer: 'return=representation' }),
  // Inserts new rows and leaves rows already held (by the unique key) untouched; returns only the new ones.
  insertNew: (table, rows, onConflict) =>
    rest(table, {
      method: 'POST',
      body: rows,
      query: { on_conflict: onConflict },
      prefer: 'resolution=ignore-duplicates,return=representation',
    }),
  update: (table, query, patch) => rest(table, { method: 'PATCH', body: patch, query, prefer: 'return=representation' }),
};
