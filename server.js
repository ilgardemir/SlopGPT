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
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 45000;
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

Write with comically generic AI-business language such as unlock, supercharge, revolutionary, empower, next-generation, actionable, seamless, ecosystem, transformative, and future-ready—but keep the actual product analysis useful.

## SCORING RUBRIC — applies to the four integer scores only

The feedback tone above controls the WORDING of verdict, strongestAngle, biggestProblem and roast. It must not move a single number. The same idea scores identically in supportive, balanced and savage mode.

Judge the idea itself, not how it is written. Buzzword density, typos, and founder enthusiasm change nothing.

Anchor each score to the band descriptions below rather than to a gut feeling, and use the whole range. Most real ideas land between 25 and 75; clustering every score in the 70s is a failure.

marketNeed — how badly the named audience already feels this problem. HIGH IS GOOD.
- 0-19: nobody has this problem; the founder invented it.
- 20-39: a mild annoyance people currently tolerate for free.
- 40-59: a real recurring irritation, but there is an accepted workaround.
- 60-79: people already pay for something here, or hack together their own fix.
- 80-100: an urgent, expensive, budgeted problem people are actively shopping for.

buildDifficulty — the engineering and operational effort to ship something people would actually pay for. HIGH MEANS HARDER. This is neither good nor bad on its own.
- 0-19: a weekend CRUD app, or one API call behind a form.
- 20-39: a few weeks for one competent developer; no novel technology.
- 40-59: months of work, real integrations, or non-trivial data plumbing.
- 60-79: custom infrastructure, regulatory work, hardware, or a large seeded dataset.
- 80-100: an open research problem, or partnerships and licences that gate any launch.

slopRisk — how close this is to indistinguishable, low-effort, generic AI-wrapper slop. HIGH IS BAD. A LOW score is the GOOD outcome: it means the idea is specific and defensible. Never invert this.
- 0-19: hard-won domain insight; genuinely difficult to clone.
- 20-39: a focused vertical product with a real workflow behind it.
- 40-59: a decent idea whose core loop a competitor could rebuild in a month.
- 60-79: mostly a system prompt over a general model, plus a dashboard.
- 80-100: interchangeable with a hundred identical launches; a wrapper with a landing page.

vibeScore — the overall verdict: is this worth a real person's next six months? HIGH IS GOOD. It is NOT the average of the other three. Strong marketNeed and low slopRisk raise it the most. High buildDifficulty lowers it only when it is not matched by real market need. A beloved idea nobody needs still scores low; a boring idea with an urgent, paying audience scores high.
- 0-19: do not build this.
- 20-39: a hobby project; do not quit anything for it.
- 40-59: plausible, but the wedge is not sharp yet.
- 60-79: worth building; a specific audience will care.
- 80-100: rare — urgent need, defensible angle, and an obvious first customer.

Score marketNeed, buildDifficulty and slopRisk independently, then set vibeScore last so it is consistent with the other three. If the idea is too vague to judge, score marketNeed and vibeScore low rather than guessing generously.`;

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
    // The operator needs the variable name; a visitor needs to know it is not their fault.
    // Keep the actionable detail in the server log, not in the browser.
    console.error(
      '[config] /api/analyze called with no OPENROUTER_API_KEY set. Add it to the Railway ' +
        'service variables (or a local .env) and restart.'
    );
    sendApiError(res, 503, 'The idea validator is offline right now. This is a problem on our side, not yours — try again shortly.');
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
  const startedAt = Date.now();

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
        provider: {
          // Several DeepSeek V4 Flash providers expose `response_format` but NOT
          // `structured_outputs`. Without this, OpenRouter may route to one of them and
          // the strict schema is silently ignored, producing prose instead of JSON.
          require_parameters: true,
          // Default routing is price-weighted (inverse square of price), which favours the
          // cheapest provider rather than a fast one and can land on a degraded endpoint.
          // This is an interactive request with a human waiting, so sort by throughput.
          sort: 'throughput'
        },
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
      sendApiError(res, 503, 'The idea validator is offline right now. This is a problem on our side, not yours — try again shortly.');
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

    console.log(
      `[upstream] ok in ${Date.now() - startedAt}ms · provider: ${payload.provider || 'unknown'} · ` +
        `model: ${payload.model || OPENROUTER_MODEL} · ` +
        `tokens: ${payload?.usage?.completion_tokens ?? '?'} completion / ` +
        `${payload?.usage?.completion_tokens_details?.reasoning_tokens ?? 0} reasoning`
    );

    sendJson(res, 200, {
      model: payload.model || OPENROUTER_MODEL,
      analysis: extractJson(content)
    });
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    if (error?.name === 'AbortError') {
      console.error(
        `[upstream] TIMEOUT after ${elapsed}ms · model: ${OPENROUTER_MODEL} · ` +
          `reasoning effort: ${REASONING_EFFORT} · sort: throughput · require_parameters: true\n` +
          '[upstream] Run `npm run probe` with the same key to see which provider is slow.'
      );
      sendApiError(
        res,
        504,
        `The request timed out after ${Math.round(UPSTREAM_TIMEOUT_MS / 1000)} seconds. Retry once; if it persists, the model provider may be overloaded.`
      );
      return;
    }
    console.error(`[upstream] failed after ${elapsed}ms: ${error instanceof Error ? error.message : error}`);
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
      : '⚠️  OPENROUTER_API_KEY is not set — /api/analyze will return a 503 until you set it.'
  );
  if (OPENROUTER_API_KEY) {
    console.log(`🔎 Key shape: ${describeKeyShape(RAW_API_KEY)}`);
  }
  if (rawEffort !== REASONING_EFFORT) {
    console.log(`⚠️  Ignored unknown OPENROUTER_REASONING_EFFORT="${rawEffort}" — fell back to "none".`);
  }
});
