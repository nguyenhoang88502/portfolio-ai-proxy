/**
 * Shared helpers for every serverless function in this proxy.
 *
 * Vercel ignores files under /api whose name starts with "_", so this module is
 * importable from the route handlers without becoming a route itself.
 */

const DEFAULT_ORIGINS = [
  'https://nguyenhoang88502.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

/** ALLOWED_ORIGIN may be a single origin or a comma-separated list. */
export function allowedOrigins() {
  const fromEnv = (process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_ORIGINS;
}

/**
 * Applies CORS headers and handles the preflight.
 * Returns true when the caller should stop (preflight answered or origin refused).
 */
export function applyCors(request, response) {
  const list = allowedOrigins();
  const origin = request.headers.origin;
  // Same-origin and server-to-server calls send no Origin header at all.
  const allow = !origin || list.includes(origin) ? origin || list[0] : null;

  if (allow) response.setHeader('Access-Control-Allow-Origin', allow);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    response.status(200).end();
    return true;
  }
  if (origin && !allow) {
    response.status(403).json({ error: 'Origin not allowed' });
    return true;
  }
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return true;
  }
  return false;
}

/**
 * Which front-end is calling. The portfolio and the ticket book share an origin
 * (both live on nguyenhoang88502.github.io), so the origin alone cannot tell
 * them apart -- the body field decides, with the Referer path as a fallback.
 */
export function resolveApp(request) {
  const fromBody = String(request.body?.app || '').toLowerCase();
  if (fromBody === 'saigon' || fromBody === 'bucketlist') return 'saigon';
  if (fromBody === 'portfolio') return 'portfolio';

  const referer = String(request.headers.referer || '');
  if (referer.includes('/saigon_bucketlist')) return 'saigon';
  return 'portfolio';
}

/** Trim a message list down to something safe to forward. */
export function sanitizeMessages(messages, { maxMessages = 20, maxChars = 4000 } = {}) {
  if (!Array.isArray(messages)) return [];
  return messages
    .slice(-maxMessages)
    .filter((m) => m && typeof m.content === 'string')
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content.slice(0, maxChars),
    }));
}

/** One place that knows how to talk to DeepSeek. */
export async function callDeepSeek({
  system,
  messages,
  maxTokens = 2000,
  temperature = 0.7,
  jsonMode = false,
}) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('missing_api_key');

  const body = {
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    messages: [{ role: 'system', content: system }, ...messages],
    max_tokens: maxTokens,
    temperature,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`deepseek_${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('deepseek_empty_response');
  return text;
}

/**
 * Pull a JSON value out of a model response, tolerating code fences and
 * surrounding prose. Returns null rather than throwing on malformed output.
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  try {
    return JSON.parse(s);
  } catch {
    // fall through to a bracket scan
  }

  const start = s.search(/[[{]/);
  if (start === -1) return null;
  const open = s[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

export function fail(response, status, code, detail) {
  if (detail) console.error(`[proxy] ${code}:`, detail);
  return response.status(status).json({ error: code });
}
