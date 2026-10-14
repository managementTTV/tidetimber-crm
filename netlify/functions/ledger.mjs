// ============================================================
//  Deal Ledger backend helper (Netlify Function).
//  The page never talks to Supabase directly any more: every read
//  and write comes through here, using a server-only secret key
//  (SUPABASE_SECRET_KEY, set in Netlify → Environment variables).
//  Once this is live, the public key in the old page/repo is
//  switched off in Supabase, so it opens nothing.
//
//  Honest limit: there is no login, so anyone who opens the site
//  can still use the page. What this adds: no direct database
//  access, one row per write, a size cap, a template whitelist,
//  a same-site check and a per-visitor rate limit.
// ============================================================

import { geocode } from '../lib/geocode.mjs';

const SUPABASE_URL = 'https://jcnicrsdzyrosgldilns.supabase.co';
const SITE_ORIGIN = /^https:\/\/(?:[a-z0-9-]+--)?tidetimber-crm\.netlify\.app$/;
const DEV_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;
const TEMPLATE_KEYS = new Set(['crm-templates']);
const MAX_BODY_BYTES = 200000;
const PAGE = 1000;

export const config = {
  path: ['/api/leads', '/api/leads/*', '/api/settings/*', '/api/geocode'],
  rateLimit: { windowLimit: 180, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

function originOf(url) {
  try { return new URL(url).origin; } catch (e) { return ''; }
}

// Same-site check. A browser on another website can't pass it (it can't set the
// custom header without a CORS preflight we never answer). A script can fake
// these headers, so this stops drive-by use, not a determined person.
export function sameSite(req, isDev) {
  const okOrigin = (o) => SITE_ORIGIN.test(o) || (isDev && DEV_ORIGIN.test(o));
  if (req.headers.get('x-deal-ledger') !== '1') return false;
  const origin = req.headers.get('origin');
  if (origin && !okOrigin(origin)) return false;
  const site = req.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  const ref = req.headers.get('referer');
  return !!ref && okOrigin(originOf(ref));
}

function validId(id) {
  return typeof id === 'string' && id.length >= 1 && id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(id);
}

async function readBody(req) {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return { error: 'Lead is too large' };
  try { return { body: JSON.parse(text) }; } catch (e) { return { error: 'Bad JSON' }; }
}

// Netlify's runtime API first, plain process.env as the fallback (local tests).
const env = (name) => (globalThis.Netlify && globalThis.Netlify.env && globalThis.Netlify.env.get(name)) || process.env[name];

const isNumOrNull = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v));

export default async function handler(req) {
  try {
    return await route(req);
  } catch (e) {
    console.error('ledger helper error', e && e.message);
    return json(500, { error: 'Backend error' });
  }
}

async function route(req) {
  const key = env('SUPABASE_SECRET_KEY');
  const isDev = env('NETLIFY_DEV') === 'true';
  if (!sameSite(req, isDev)) return json(403, { error: 'Not allowed' });
  if (!key) return json(503, { error: 'Backend key is not set up' });

  const db = (path, init = {}) => fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...init,
    headers: { apikey: key, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const fail = async (res) => {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch (e) { /* no body */ }
    console.error('supabase', res.status, detail);
    return json(502, { error: 'Database error (' + res.status + ')' });
  };

  // ---- Map pins from free public address data (never Google) ----
  const url = new URL(req.url);
  if (url.pathname === '/api/geocode') {
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    const q = (url.searchParams.get('q') || '').slice(0, 300);
    return json(200, (q && await geocode(q)) || { lat: null, lng: null, source: null });
  }

  const parts = url.pathname.replace(/^\/api\//, '').split('/');
  const [kind, rawId, ...extra] = parts;
  if (extra.length) return json(404, { error: 'Not found' });
  let id = null;
  if (rawId !== undefined) {
    try { id = decodeURIComponent(rawId); } catch (e) { return json(400, { error: 'Bad id' }); }
    if (!validId(id)) return json(400, { error: 'Bad id' });
  }

  // ---- Leads ----
  if (kind === 'leads' && id === null) {
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    const rows = [];
    for (let offset = 0; ; offset += PAGE) {
      const res = await db(`leads?select=id,data&order=created_at.asc,id.asc&limit=${PAGE}&offset=${offset}`);
      if (!res.ok) return fail(res);
      const page = await res.json();
      rows.push(...page);
      if (page.length < PAGE) break;
    }
    return json(200, rows);
  }

  if (kind === 'leads') {
    const filter = 'leads?id=eq.' + encodeURIComponent(id);
    if (req.method === 'PUT') {
      const { body, error } = await readBody(req);
      if (error) return json(400, { error });
      if (!body || typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) {
        return json(400, { error: 'Missing lead data' });
      }
      if (body.data.id !== undefined && body.data.id !== id) return json(400, { error: 'Lead id mismatch' });
      if (!isNumOrNull(body.lat) || !isNumOrNull(body.lng)) return json(400, { error: 'Bad lat/lng' });
      const res = await db('leads?on_conflict=id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ id, data: body.data, lat: body.lat ?? null, lng: body.lng ?? null }),
      });
      return res.ok ? json(200, { ok: true }) : fail(res);
    }
    if (req.method === 'DELETE') {
      const res = await db(filter, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return res.ok ? json(200, { ok: true }) : fail(res);
    }
    return json(405, { error: 'Method not allowed' });
  }

  // ---- Settings (shared email/SMS templates) ----
  if (kind === 'settings' && id !== null) {
    if (!TEMPLATE_KEYS.has(id)) return json(404, { error: 'Not found' });
    if (req.method === 'GET') {
      const res = await db('settings?select=data&key=eq.' + encodeURIComponent(id));
      if (!res.ok) return fail(res);
      const rows = await res.json();
      return json(200, { data: rows.length ? rows[0].data : null });
    }
    if (req.method === 'PUT') {
      const { body, error } = await readBody(req);
      if (error) return json(400, { error });
      if (!body || typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) {
        return json(400, { error: 'Missing template data' });
      }
      const res = await db('settings?on_conflict=key', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key: id, data: body.data }),
      });
      return res.ok ? json(200, { ok: true }) : fail(res);
    }
    return json(405, { error: 'Method not allowed' });
  }

  return json(404, { error: 'Not found' });
}
