// Worker entry: serves POST /api/waitlist; every other path is a static asset.
// wrangler.jsonc routes only /api/* here first (run_worker_first), so pages skip this code.

interface KV { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void>; }
interface RateLimiter { limit(opts: { key: string }): Promise<{ success: boolean }>; }
export interface Env { ASSETS: { fetch(req: Request): Promise<Response> }; WAITLIST: KV; WAITLIST_LIMITER: RateLimiter; }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELDS = ['email', 'fsm', 'source', 'page', 'company'] as const;
type Fields = Partial<Record<(typeof FIELDS)[number], string>>;
type Result = { ok: true } | { ok: false; error: 'invalid_email' | 'rate_limited' | 'bad_request' | 'server_error' };

const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

async function readFields(req: Request): Promise<Fields | null> {
  const type = req.headers.get('content-type') ?? '';
  try {
    let raw: Record<string, unknown>;
    if (type.includes('application/json')) raw = (await req.json()) as Record<string, unknown>;
    else if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) raw = Object.fromEntries(await req.formData());
    else return null;
    if (!raw || typeof raw !== 'object') return null;
    const out: Fields = {};
    for (const k of FIELDS) out[k] = clip(raw[k], k === 'email' ? 254 : 200);
    return out;
  } catch { return null; }
}

export async function handleWaitlist(req: Request, env: Env): Promise<{ status: number; body: Result }> {
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await env.WAITLIST_LIMITER.limit({ key: ip });
  if (!success) return { status: 429, body: { ok: false, error: 'rate_limited' } };

  const f = await readFields(req);
  if (!f) return { status: 400, body: { ok: false, error: 'bad_request' } };
  // Honeypot: real visitors never see the "company" field. Answer as if it worked so bots learn nothing.
  if (f.company) return { status: 200, body: { ok: true } };
  const email = (f.email ?? '').toLowerCase();
  if (!EMAIL_RE.test(email)) return { status: 400, body: { ok: false, error: 'invalid_email' } };

  const key = `email:${email}`;
  try {
    if (!(await env.WAITLIST.get(key))) {
      const cf = (req as Request & { cf?: { country?: string } }).cf;
      await env.WAITLIST.put(key, JSON.stringify({ email, fsm: f.fsm, source: f.source, page: f.page, country: cf?.country ?? '', at: new Date().toISOString() }));
    }
  } catch { return { status: 500, body: { ok: false, error: 'server_error' } }; }
  return { status: 200, body: { ok: true } };
}

const page = (title: string, msg: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head>` +
  `<body style="font-family:system-ui,sans-serif;background:#08090c;color:#e8eaed;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1><p>${msg}</p><p><a style="color:#9ab4ff" href="/">Back to TradeTill</a></p></body></html>`;

function htmlResult(r: { status: number; body: Result }): Response {
  const [title, msg] = r.body.ok
    ? ["You're on the list.", "We'll email you as early access opens."]
    : r.body.error === 'invalid_email' ? ['Check your email', 'That email address does not look right. Go back and try again.']
    : r.body.error === 'rate_limited' ? ['Too many tries', 'Please wait a minute and try again.']
    : ['Something went wrong', 'Please go back and try again.'];
  return new Response(page(title, msg), { status: r.status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname !== '/api/waitlist') {
      if (pathname.startsWith('/api/')) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
      return env.ASSETS.fetch(req);
    }
    if (req.method !== 'POST') return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405, headers: { allow: 'POST' } });
    const r = await handleWaitlist(req, env);
    // The JS form path posts JSON and reads JSON; a no-JS form post gets a readable page instead.
    if ((req.headers.get('content-type') ?? '').includes('application/json')) {
      return Response.json(r.body, { status: r.status, headers: { 'cache-control': 'no-store' } });
    }
    return htmlResult(r);
  },
};
