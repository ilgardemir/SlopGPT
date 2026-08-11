import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');
const port = Number(process.env.PORT) || 3000;

// Railway (and most dashboard-style env editors) store variable values verbatim, so a
// pasted `"sk-or-v1-..."` keeps its quotes and a stray newline survives. Either produces
// a malformed Authorization header and an opaque 401 "User not found." from OpenRouter.
function sanitizeKey(raw) {
  if (typeof raw !== 'string') return '';
  let key = raw.trim();
  if (key.length >= 2) {
    const first = key[0];
    const last = key[key.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      key = key.slice(1, -1).trim();
    }
  }
  return key;
}

// Reports the shape of the configured key without ever logging the secret itself.
function describeKeyShape(raw) {
  if (typeof raw !== 'string' || !raw) return 'not set';
  const clean = sanitizeKey(raw);
  const notes = [];
  if (raw !== raw.trim()) notes.push('had surrounding whitespace (stripped)');
  if (clean !== raw.trim()) notes.push('had surrounding quotes (stripped)');
  if (/\s/.test(clean)) notes.push('CONTAINS INTERNAL WHITESPACE — almost certainly a bad paste');
  if (!clean.startsWith('sk-or-')) notes.push(`unexpected prefix "${clean.slice(0, 6)}" — OpenRouter keys start with sk-or-`);
  return `length ${clean.length}${notes.length ? ' · ' + notes.join(' · ') : ' · looks well-formed'}`;
}

const RAW_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_API_KEY = sanitizeKey(RAW_API_KEY);
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const APP_TITLE = 'VibeScore AI';

// OpenRouter's unified reasoning effort levels. "none" disables reasoning outright;
// every other level still computes (and bills) reasoning tokens.
// "minimal" is only honoured by OpenAI (o-series/GPT-5) and Grok models — DeepSeek is
// not in that set, so it defaults to "none" here.
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const rawEffort = (process.env.OPENROUTER_REASONING_EFFORT || 'none').trim().toLowerCase();
const REASONING_EFFORT = REASONING_EFFORTS.has(rawEffort) ? rawEffort : 'none';

// With effort "none" there is no reasoning trace to suppress, so `exclude` is pointless.
const REASONING_CONFIG =
  REASONING_EFFORT === 'none'
    ? { effort: 'none' }
    : { effort: REASONING_EFFORT, exclude: true };

const MAX_BODY_BYTES = 16 * 1024;
const UPSTREAM_TIMEOUT_MS = 45000;
const MAX_IDEA_LENGTH = 3000;
const MAX_FIELD_LENGTH = 500;
const MIN_IDEA_LENGTH = 20;
const BRUTALITY_MODES = new Set(['supportive', 'balanced', 'savage']);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

const STARTUP_ANALYSIS_SCHEMA = {
  name: 'startup_analysis',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      tagline: { type: 'string' },
      vibeScore: { type: 'integer', minimum: 0, maximum: 100 },
      slopRisk: { type: 'integer', minimum: 0, maximum: 100 },
      marketNeed: { type: 'integer', minimum: 0, maximum: 100 },
      buildDifficulty: { type: 'integer', minimum: 0, maximum: 100 },
      verdict: { type: 'string' },
      strongestAngle: { type: 'string' },
      biggestProblem: { type: 'string' },
      unfairAdvantages: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 5 },
      features: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 5 },
      nextSteps: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 5 },
      roast: { type: 'string' }
    },
    required: [
      'name',
      'tagline',
      'vibeScore',
      'slopRisk',
      'marketNeed',
      'buildDifficulty',
      'verdict',
      'strongestAngle',
      'biggestProblem',
      'unfairAdvantages',
      'features',
      'nextSteps',
      'roast'
    ],
    additionalProperties: false
  }
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function sendApiError(res, status, message, extra = {}) {
  sendJson(res, status, { error: { message, code: status, ...extra } });
}

function sendFile(res, filePath) {
  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
      'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=300',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    });

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let rejected = false;

    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        rejected = true;
        // Stop buffering but keep draining, so the 413 response still reaches the client.
        chunks = [];
        req.resume();
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (rejected) return;
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Request body was not valid JSON'), { status: 400 }));
      }
    });

    req.on('error', reject);
  });
}

function trimmedField(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function buildPrompts({ idea, audience, businessModel, brutality }) {
  const systemPrompt = `You are VibeScore AI, an expert startup strategist, product visionary, innovation guru, and brutally honest critic. Analyze the startup idea accurately and constructively. Avoid invented market statistics, guaranteed outcomes, or claims of certainty. Identify whether this is a useful vertical product or just a thin generic AI wrapper. The feedback tone is ${brutality}.

Write with comically generic AI-business language such as unlock, supercharge, revolutionary, empower, next-generation, actionable, seamless, ecosystem, transformative, and future-ready—but keep the actual product analysis useful.`;

  const userPrompt = `REVOLUTIONARY STARTUP VISION:\n${idea}\n\nDREAM CUSTOMERS:\n${audience || 'Not specified'}\n\nREVENUE MAGIC:\n${businessModel || 'Not specified'}`;

  return { systemPrompt, userPrompt };
}

function getMessageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part) => (typeof part === 'string' ? part : part?.text || part?.content || ''))
      .join('')
      .trim();
  }
  return '';
}

function extractJson(text) {
  const cleaned = String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error('The model responded, but its output was not valid JSON. Retry the request.');
  }
}

function appUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || `localhost:${port}`;
  return `${proto}://${host}`;
}

async function handleAnalyze(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendApiError(res, 405, 'This endpoint only accepts POST requests.');
    return;
  }

  if (!OPENROUTER_API_KEY) {
    sendApiError(
      res,
      500,
      'The server is missing its OPENROUTER_API_KEY environment variable. Set it in the Railway service variables (or a local .env) and restart.'
    );
    return;
  }

  let body;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (error) {
    const status = error.status || 400;
    sendApiError(res, status, error.message);
    if (status === 413) res.on('finish', () => req.destroy());
    return;
  }

  const idea = trimmedField(body.idea, MAX_IDEA_LENGTH);
  if (idea.length < MIN_IDEA_LENGTH) {
    sendApiError(res, 400, `Provide at least ${MIN_IDEA_LENGTH} characters of visionary founder lore.`);
    return;
  }

  const rawBrutality = trimmedField(body.brutality, 20);
  const { systemPrompt, userPrompt } = buildPrompts({
    idea,
    audience: trimmedField(body.audience, MAX_FIELD_LENGTH),
    businessModel: trimmedField(body.businessModel, MAX_FIELD_LENGTH),
    brutality: BRUTALITY_MODES.has(rawBrutality) ? rawBrutality : 'balanced'
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': appUrl(req),
        'X-Title': APP_TITLE
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        reasoning: REASONING_CONFIG,
        response_format: { type: 'json_schema', json_schema: STARTUP_ANALYSIS_SCHEMA },
        // Several DeepSeek V4 Flash providers expose `response_format` but NOT
        // `structured_outputs`. Without this, OpenRouter may route to one of them and the
        // strict schema is silently ignored, producing free-form prose instead of JSON.
        provider: { require_parameters: true },
        max_tokens: 2200
      })
    });

    const rawBody = await upstream.text();
    let payload;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      sendApiError(
        res,
        502,
        `OpenRouter returned an unreadable response (HTTP ${upstream.status}): ${rawBody.slice(0, 180) || 'empty body'}`
      );
      return;
    }

    const requestId = upstream.headers.get('x-request-id');
    if (requestId) res.setHeader('x-request-id', requestId);

    if (upstream.status === 401 || upstream.status === 403) {
      // OpenRouter's own wording here ("User not found.") reads like the *end user* is the
      // problem. It is not — it means the server's key was rejected.
      const upstreamMessage = payload?.error?.message || 'no detail';
      console.error(
        `[auth] OpenRouter rejected the server key (HTTP ${upstream.status}): ${upstreamMessage}\n` +
          `[auth] OPENROUTER_API_KEY shape: ${describeKeyShape(RAW_API_KEY)}\n` +
          '[auth] Verify with: curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer $OPENROUTER_API_KEY"'
      );
      sendApiError(
        res,
        502,
        `This server's OpenRouter key was rejected (upstream said: "${upstreamMessage}"). This is a server configuration problem, not something you did. Check that OPENROUTER_API_KEY is set to a current, un-revoked key with no surrounding quotes or whitespace.`
      );
      return;
    }

    if (!upstream.ok || payload?.error) {
      // Relay OpenRouter's own error shape so the browser can render provider detail.
      sendJson(res, upstream.ok ? 502 : upstream.status, payload);
      return;
    }

    const choice = payload?.choices?.[0];
    const content = getMessageText(choice?.message);
    if (!content) {
      const finishReason = choice?.finish_reason || 'missing';
      const completionTokens = payload?.usage?.completion_tokens;
      const tokenDetail = Number.isFinite(completionTokens) ? ` Completion tokens: ${completionTokens}.` : '';
      sendApiError(res, 502, `OpenRouter returned no visible answer (finish reason: ${finishReason}).${tokenDetail}`);
      return;
    }

    sendJson(res, 200, {
      model: payload.model || OPENROUTER_MODEL,
      analysis: extractJson(content)
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      sendApiError(
        res,
        504,
        'The OpenRouter request timed out after 45 seconds. Retry once; if it persists, the model provider may be overloaded.'
      );
      return;
    }
    sendApiError(res, 502, error instanceof Error ? error.message : 'Unknown upstream error');
  } finally {
    clearTimeout(timeoutId);
  }
}

const server = http.createServer((req, res) => {
  const rawPath = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;

  if (rawPath === '/api/analyze') {
    handleAnalyze(req, res).catch(() => {
      if (!res.headersSent) sendApiError(res, 500, 'Unexpected server error');
      else res.destroy();
    });
    return;
  }

  const requestedPath = rawPath === '/' ? '/index.html' : rawPath;
  const filePath = path.join(publicDir, path.normalize(requestedPath));

  if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  sendFile(res, filePath);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`✨ VibeScore AI is disrupting http://localhost:${port}`);
  console.log(
    OPENROUTER_API_KEY
      ? `🔑 OpenRouter key loaded · model: ${OPENROUTER_MODEL} · reasoning effort: ${REASONING_EFFORT}`
      : '⚠️  OPENROUTER_API_KEY is not set — /api/analyze will return a 500 until you set it.'
  );
  if (OPENROUTER_API_KEY) {
    console.log(`🔎 Key shape: ${describeKeyShape(RAW_API_KEY)}`);
  }
  if (rawEffort !== REASONING_EFFORT) {
    console.log(`⚠️  Ignored unknown OPENROUTER_REASONING_EFFORT="${rawEffort}" — fell back to "none".`);
  }
});
