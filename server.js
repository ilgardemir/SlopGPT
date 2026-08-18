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

// A follow-up carries the whole analysis and the transcript so far, so it will not fit in
// the 16 KB that a bare idea needs. The rest of these caps bound what the browser can push
// into the prompt: /api/followup is the one endpoint where the client supplies model
// context rather than just a question, so none of it is taken on trust.
const MAX_FOLLOWUP_BODY_BYTES = 64 * 1024;
const MAX_QUESTION_LENGTH = 500;
const MIN_QUESTION_LENGTH = 3;
const MAX_FOLLOWUP_TURNS = 8;
const MAX_HISTORY_ENTRIES = MAX_FOLLOWUP_TURNS * 2;
const MAX_HISTORY_ENTRY_LENGTH = 2000;

// Caps on prose the model wrote. These are deliberately far above the length budget the
// prompt asks for (70-90 words, so roughly 400-550 characters) because they exist to stop
// a runaway generation, not to edit normal output. The earlier 500/600 caps sat *below*
// what the model actually returns — measured roasts ran 460-943 characters — so the
// Founder Reality Check was being cut mid-sentence on most analyses.
const MAX_PROSE_LENGTH = 1200;
const MAX_VERDICT_LENGTH = 1600;
const MAX_LIST_ITEM_LENGTH = 400;

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

// Prose the model wrote, as opposed to input the founder typed. The cap is a backstop
// against a runaway generation, not a routine edit — the prompt's length budget is what
// normally keeps these fields in range. When it does fire, a bare slice ends mid-word and
// reads as if the app broke, so back up to the last word boundary and mark the cut.
function truncateProse(value, limit) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length <= limit) return text;

  const head = text.slice(0, limit - 1);
  const boundary = head.search(/\s+\S*$/);
  // An unbroken run with no late boundary has nothing sensible to back up to; hard-cut it
  // rather than throwing away most of the text.
  return (boundary > limit * 0.6 ? head.slice(0, boundary) : head).trimEnd() + '…';
}

function buildPrompts({ idea, audience, businessModel, brutality }) {
  const systemPrompt = `You are VibeScore AI, an expert startup strategist, product visionary, innovation guru, and brutally honest critic. Analyze the startup idea accurately and constructively. Avoid invented market statistics, guaranteed outcomes, or claims of certainty. Identify whether this is a specific, defensible product or a thin generic one anybody could clone. The feedback tone is ${brutality}.

## ANALYZE THE IDEA THE FOUNDER ACTUALLY SUBMITTED

Judge the business they described, on its own terms. Most submissions are not AI products — a laundromat, a bakery, a consultancy, a board game. That is not a flaw and not an omission.

- Never assume an idea involves AI, machine learning, a platform, an app, or a moat unless the founder's own description says so.
- Never treat the absence of any of those as a weakness. "There is no AI here" is not an observation; it is you analyzing a different idea.
- Only mention AI when the founder's description actually involves it.
- Keep the name, tagline, features and next steps inside the product they described. Do not add technology, channels, or scope they did not ask for.

Write with comically generic startup-marketing language such as unlock, supercharge, revolutionary, empower, next-generation, actionable, seamless, ecosystem, transformative, and future-ready—but keep the actual product analysis useful. That register applies to your WORDING only; it must never add a capability the idea does not have.

## LENGTH BUDGET

Each prose field is rendered whole on a card, so finish every thought inside its budget rather than trailing off. Aim for the middle of each range — the lower bound matters as much as the upper one, and a field that lands well under it is thin, not concise:
- verdict: 70-110 words.
- strongestAngle and biggestProblem: 70-100 words each. Say what the problem or angle actually is, then why it matters.
- roast: 45-80 words. Land the joke and stop.
- every unfairAdvantages, features and nextSteps item: one specific sentence, 12-30 words.

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

slopRisk — how generic and easily cloned this is. HIGH IS BAD. A LOW score is the GOOD outcome: it means the idea is specific and defensible. Never invert this.

Score whatever kind of business this actually is. A thin AI wrapper is the obvious case, but it is an example, not the definition. For a local, physical, or service business, ask how fast the competitor across the street could offer the same thing. An idea never scores badly here merely for containing no AI.
- 0-19: hard-won domain insight, or a position a rival cannot simply copy.
- 20-39: a focused product with a real workflow, process, or relationship behind it.
- 40-59: a decent idea whose core a competitor could rebuild in a month.
- 60-79: an obvious idea with a nice front door — a system prompt over a general model plus a dashboard, or a familiar business with one twist.
- 80-100: interchangeable with a hundred identical launches; nothing a customer would pick over the nearest alternative.

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

// The browser posts the analysis back to us because the server keeps no session state.
// That makes it client-supplied prompt material, so rebuild it field by field from a
// whitelist with the same caps the schema enforces, rather than forwarding whatever
// arrived. Anything unrecognised is dropped instead of reaching the model.
function sanitizeAnalysis(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const score = (value) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const list = (value) =>
    (Array.isArray(value) ? value : [])
      .slice(0, 5)
      .map((item) => truncateProse(item, MAX_LIST_ITEM_LENGTH))
      .filter(Boolean);

  return {
    name: trimmedField(raw.name, 90),
    tagline: truncateProse(raw.tagline, 180),
    vibeScore: score(raw.vibeScore),
    slopRisk: score(raw.slopRisk),
    marketNeed: score(raw.marketNeed),
    buildDifficulty: score(raw.buildDifficulty),
    verdict: truncateProse(raw.verdict, MAX_VERDICT_LENGTH),
    strongestAngle: truncateProse(raw.strongestAngle, MAX_PROSE_LENGTH),
    biggestProblem: truncateProse(raw.biggestProblem, MAX_PROSE_LENGTH),
    unfairAdvantages: list(raw.unfairAdvantages),
    features: list(raw.features),
    nextSteps: list(raw.nextSteps),
    roast: truncateProse(raw.roast, MAX_PROSE_LENGTH)
  };
}

// Same treatment for the transcript: only two roles exist, only the last few turns are
// kept, and each turn is truncated so a long thread cannot grow the prompt without bound.
function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];

  const clean = [];
  for (const entry of raw.slice(-MAX_HISTORY_ENTRIES)) {
    const role = entry?.role === 'assistant' ? 'assistant' : entry?.role === 'user' ? 'user' : null;
    const content = trimmedField(entry?.content, MAX_HISTORY_ENTRY_LENGTH);
    if (role && content) clean.push({ role, content });
  }
  return clean;
}

function buildFollowupMessages({ idea, audience, businessModel, brutality, analysis, history, question }) {
  const bullets = (items) => (items.length ? items.map((item) => `- ${item}`).join('\n') : '- (none returned)');

  const systemPrompt = `You are VibeScore AI, the same expert startup strategist, product visionary, innovation guru and brutally honest critic who produced the analysis below. The founder has now read their results and is asking follow-up questions about them.

Answer the question they actually asked. Use the analysis as shared context you both already have — do not re-run it, do not recite the scores back unless a number is load-bearing for your answer, and never invent market statistics, funding figures, competitor revenue, or claims of certainty. Where it helps, propose specific improvements: what to sharpen, cut, change, or test next, and why it would move the score they care about.

Stay inside the idea they actually submitted. Most ideas are not AI products: never assume this one is, never treat the absence of AI or a platform as a shortcoming, and only mention AI if their own description involves it. Advice must be about the business they described, not one you would rather they had described.

Keep writing in comically generic startup-marketing language such as unlock, supercharge, revolutionary, empower, next-generation, actionable, seamless, ecosystem, transformative, and future-ready — while keeping the actual advice specific and genuinely useful. The feedback tone is ${brutality}.

Reply with two to four short paragraphs of ordinary readable prose. No markdown, no headings, no bullet lists, no JSON, and never emit identifiers, schema keys, camelCase names, or underscore-joined tokens as the content of your answer. Keep it under 220 words.

If the founder asks for something the analysis cannot support — hard market data, a guarantee, or a prediction — say so plainly in one sentence and give them the closest useful thing instead.

## THE SUBMISSION YOU ANALYZED
Idea: ${idea}
Dream customers: ${audience || 'Not specified'}
Revenue magic: ${businessModel || 'Not specified'}

## THE ANALYSIS YOU ALREADY GAVE THEM
Name: ${analysis.name}
Tagline: ${analysis.tagline}

Vibe Score: ${analysis.vibeScore}/100 (higher is better — is this worth their next six months)
Slop Risk: ${analysis.slopRisk}/100 (LOWER is better — how close this is to generic AI-wrapper slop)
Market Need: ${analysis.marketNeed}/100 (higher is better — how badly the audience feels the problem)
Build Difficulty: ${analysis.buildDifficulty}/100 (higher means harder; neither good nor bad on its own)

Verdict: ${analysis.verdict}
Strongest angle: ${analysis.strongestAngle}
Biggest problem: ${analysis.biggestProblem}

Unfair advantages:
${bullets(analysis.unfairAdvantages)}

Must-have features:
${bullets(analysis.features)}

Next steps:
${bullets(analysis.nextSteps)}

Founder reality check: ${analysis.roast}`;

  return [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: question }
  ];
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

// DeepSeek V4 Flash occasionally collapses into degenerate repetition under strict
// grammar-constrained decoding, emitting runs of schema-key-like identifiers
// ("hackType_verticalUVP_noveltyVectorNoveltyClassification_ideaCategory_...") in place
// of prose. It is stochastic — the same prompt usually succeeds on a retry — and it is
// most likely when the founder's own idea contains identifier-like text.
//
// Threshold note: the model legitimately quotes a founder's camelCase back at them when
// they put it in the idea, and those quotes measure 40-60 characters. Observed
// degenerate runs are 200+. 80 separates the two without punishing honest quoting.
const MAX_UNBROKEN_RUN = 80;

function longestUnbrokenRun(text) {
  let longest = 0;
  for (const word of String(text).split(/\s+/)) {
    if (word.length > longest) longest = word.length;
  }
  return longest;
}

// Walks every string the model produced, including array items, since the collapse shows
// up field by field rather than corrupting the whole response.
function findDegenerateField(analysis) {
  if (!analysis || typeof analysis !== 'object') return null;
  for (const [field, value] of Object.entries(analysis)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item !== 'string') continue;
      const run = longestUnbrokenRun(item);
      if (run >= MAX_UNBROKEN_RUN) return { field, run };
    }
  }
  return null;
}

const ANTI_DEGENERATION_NUDGE =
  '\n\nEvery string field must be ordinary readable prose — plain English sentences and ' +
  'normal words separated by spaces. Never emit identifiers, schema keys, camelCase ' +
  'names, or underscore-joined tokens as the content of a field.';

function appUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || `localhost:${port}`;
  return `${proto}://${host}`;
}

// Returns a discriminated result instead of writing to `res`, so the caller can make a
// second attempt when the first one comes back degenerate. Shared by /api/analyze (strict
// JSON schema) and /api/followup (plain prose) — everything below the `messages` and
// `responseFormat` arguments is identical for both.
async function callOpenRouter({ messages, responseFormat, maxTokens, referer, signal }) {
  const upstream = await fetch(OPENROUTER_URL, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': referer,
      'X-Title': APP_TITLE
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      reasoning: REASONING_CONFIG,
      ...(responseFormat ? { response_format: responseFormat } : {}),
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
      max_tokens: maxTokens
    })
  });

  const rawBody = await upstream.text();
  const requestId = upstream.headers.get('x-request-id');

  let payload;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return {
      kind: 'error',
      requestId,
      status: 502,
      message: `OpenRouter returned an unreadable response (HTTP ${upstream.status}): ${rawBody.slice(0, 180) || 'empty body'}`
    };
  }

  if (upstream.status === 401 || upstream.status === 403) {
    // OpenRouter's own wording here ("User not found.") reads like the *end user* is the
    // problem. It is not — it means the server's key was rejected.
    console.error(
      `[auth] OpenRouter rejected the server key (HTTP ${upstream.status}): ${payload?.error?.message || 'no detail'}\n` +
        `[auth] OPENROUTER_API_KEY shape: ${describeKeyShape(RAW_API_KEY)}\n` +
        '[auth] Verify with: curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer $OPENROUTER_API_KEY"'
    );
    return {
      kind: 'error',
      requestId,
      status: 503,
      message: 'The idea validator is offline right now. This is a problem on our side, not yours — try again shortly.'
    };
  }

  if (!upstream.ok || payload?.error) {
    // Relay OpenRouter's own error shape so the browser can render provider detail.
    return { kind: 'relay', requestId, status: upstream.ok ? 502 : upstream.status, payload };
  }

  const choice = payload?.choices?.[0];
  const content = getMessageText(choice?.message);
  if (!content) {
    const completionTokens = payload?.usage?.completion_tokens;
    const tokenDetail = Number.isFinite(completionTokens) ? ` Completion tokens: ${completionTokens}.` : '';
    return {
      kind: 'error',
      requestId,
      status: 502,
      message: `OpenRouter returned no visible answer (finish reason: ${choice?.finish_reason || 'missing'}).${tokenDetail}`
    };
  }

  return { kind: 'ok', requestId, payload, content };
}

async function callModel({ systemPrompt, userPrompt, referer, signal }) {
  const result = await callOpenRouter({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    responseFormat: { type: 'json_schema', json_schema: STARTUP_ANALYSIS_SCHEMA },
    maxTokens: 2200,
    referer,
    signal
  });

  if (result.kind !== 'ok') return result;
  return { ...result, analysis: extractJson(result.content) };
}

// Both endpoints need a POST and a configured key before they can do anything useful.
// Returns false once it has written the response, so the caller can simply bail.
function endpointIsUsable(req, res, endpoint) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendApiError(res, 405, 'This endpoint only accepts POST requests.');
    return false;
  }

  if (!OPENROUTER_API_KEY) {
    // The operator needs the variable name; a visitor needs to know it is not their fault.
    // Keep the actionable detail in the server log, not in the browser.
    console.error(
      `[config] ${endpoint} called with no OPENROUTER_API_KEY set. Add it to the Railway ` +
        'service variables (or a local .env) and restart.'
    );
    sendApiError(res, 503, 'The idea validator is offline right now. This is a problem on our side, not yours — try again shortly.');
    return false;
  }

  return true;
}

async function handleAnalyze(req, res) {
  if (!endpointIsUsable(req, res, '/api/analyze')) return;

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
    const referer = appUrl(req);
    let result = await callModel({ systemPrompt, userPrompt, referer, signal: controller.signal });
    let degenerate = result.kind === 'ok' ? findDegenerateField(result.analysis) : null;

    // The collapse is stochastic, so one retry with an explicit "write prose" instruction
    // recovers the overwhelming majority of these. Better a slower answer than a card
    // full of identifier soup.
    if (degenerate) {
      console.warn(
        `[degenerate] ${degenerate.field} contained a ${degenerate.run}-character unbroken run · ` +
          `provider: ${result.payload?.provider || 'unknown'} · retrying once`
      );
      result = await callModel({
        systemPrompt: systemPrompt + ANTI_DEGENERATION_NUDGE,
        userPrompt,
        referer,
        signal: controller.signal
      });
      degenerate = result.kind === 'ok' ? findDegenerateField(result.analysis) : null;
    }

    if (result.requestId) res.setHeader('x-request-id', result.requestId);

    if (result.kind === 'error') {
      sendApiError(res, result.status, result.message);
      return;
    }

    if (result.kind === 'relay') {
      sendJson(res, result.status, result.payload);
      return;
    }

    if (degenerate) {
      console.error(
        `[degenerate] retry also collapsed (${degenerate.field}, ${degenerate.run} chars) · ` +
          `provider: ${result.payload?.provider || 'unknown'}`
      );
      sendApiError(
        res,
        502,
        'The model returned unreadable output twice in a row. Try again, or reword the idea without code-style identifiers.'
      );
      return;
    }

    const { payload } = result;
    console.log(
      `[upstream] ok in ${Date.now() - startedAt}ms · provider: ${payload.provider || 'unknown'} · ` +
        `model: ${payload.model || OPENROUTER_MODEL} · ` +
        `tokens: ${payload?.usage?.completion_tokens ?? '?'} completion / ` +
        `${payload?.usage?.completion_tokens_details?.reasoning_tokens ?? 0} reasoning`
    );

    sendJson(res, 200, {
      model: payload.model || OPENROUTER_MODEL,
      analysis: result.analysis
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

async function handleFollowup(req, res) {
  if (!endpointIsUsable(req, res, '/api/followup')) return;

  let body;
  try {
    body = await readJsonBody(req, MAX_FOLLOWUP_BODY_BYTES);
  } catch (error) {
    const status = error.status || 400;
    sendApiError(res, status, error.message);
    if (status === 413) res.on('finish', () => req.destroy());
    return;
  }

  const question = trimmedField(body.question, MAX_QUESTION_LENGTH);
  if (question.length < MIN_QUESTION_LENGTH) {
    sendApiError(res, 400, 'Ask an actual question and the neural engine will consider it.');
    return;
  }

  const idea = trimmedField(body.idea, MAX_IDEA_LENGTH);
  if (idea.length < MIN_IDEA_LENGTH) {
    sendApiError(res, 400, 'Run an analysis first — follow-ups need an idea to follow up on.');
    return;
  }

  const analysis = sanitizeAnalysis(body.analysis);
  if (!analysis || !analysis.verdict) {
    sendApiError(res, 400, 'That analysis is missing or malformed. Run the analysis again, then ask.');
    return;
  }

  const history = sanitizeHistory(body.history);
  // Backstop for the client's own cap: the disabled textarea is a courtesy, not a control.
  const askedSoFar = history.filter((entry) => entry.role === 'user').length;
  if (askedSoFar >= MAX_FOLLOWUP_TURNS) {
    sendApiError(
      res,
      429,
      `That is ${MAX_FOLLOWUP_TURNS} follow-ups on one idea — the free tier's neural generosity is exhausted. Run a new analysis to keep going.`
    );
    return;
  }

  const rawBrutality = trimmedField(body.brutality, 20);
  const messages = buildFollowupMessages({
    idea,
    audience: trimmedField(body.audience, MAX_FIELD_LENGTH),
    businessModel: trimmedField(body.businessModel, MAX_FIELD_LENGTH),
    brutality: BRUTALITY_MODES.has(rawBrutality) ? rawBrutality : 'balanced',
    analysis,
    history,
    question
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const referer = appUrl(req);
    const request = { responseFormat: null, maxTokens: 700, referer, signal: controller.signal };

    let result = await callOpenRouter({ ...request, messages });
    let answer = result.kind === 'ok' ? result.content.trim() : '';
    let run = answer ? longestUnbrokenRun(answer) : 0;

    // Same stochastic collapse the analyze path guards against (see findDegenerateField),
    // and the same fix: one retry with an explicit "write prose" instruction.
    if (run >= MAX_UNBROKEN_RUN) {
      console.warn(`[degenerate] follow-up answer contained a ${run}-character unbroken run · retrying once`);
      const [system, ...rest] = messages;
      result = await callOpenRouter({
        ...request,
        messages: [{ role: 'system', content: system.content + ANTI_DEGENERATION_NUDGE }, ...rest]
      });
      answer = result.kind === 'ok' ? result.content.trim() : '';
      run = answer ? longestUnbrokenRun(answer) : 0;
    }

    if (result.requestId) res.setHeader('x-request-id', result.requestId);

    if (result.kind === 'error') {
      sendApiError(res, result.status, result.message);
      return;
    }

    if (result.kind === 'relay') {
      sendJson(res, result.status, result.payload);
      return;
    }

    if (run >= MAX_UNBROKEN_RUN) {
      console.error(`[degenerate] follow-up retry also collapsed (${run} chars)`);
      sendApiError(res, 502, 'The model returned unreadable output twice in a row. Try asking that again in different words.');
      return;
    }

    console.log(
      `[followup] ok in ${Date.now() - startedAt}ms · turn ${askedSoFar + 1}/${MAX_FOLLOWUP_TURNS} · ` +
        `provider: ${result.payload.provider || 'unknown'} · ` +
        `tokens: ${result.payload?.usage?.completion_tokens ?? '?'} completion`
    );

    sendJson(res, 200, { answer, remaining: MAX_FOLLOWUP_TURNS - (askedSoFar + 1) });
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    if (error?.name === 'AbortError') {
      console.error(`[followup] TIMEOUT after ${elapsed}ms · model: ${OPENROUTER_MODEL}`);
      sendApiError(
        res,
        504,
        `The follow-up timed out after ${Math.round(UPSTREAM_TIMEOUT_MS / 1000)} seconds. Ask it again; the model provider may be overloaded.`
      );
      return;
    }
    console.error(`[followup] failed after ${elapsed}ms: ${error instanceof Error ? error.message : error}`);
    sendApiError(res, 502, error instanceof Error ? error.message : 'Unknown upstream error');
  } finally {
    clearTimeout(timeoutId);
  }
}

const server = http.createServer((req, res) => {
  const rawPath = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;

  const apiHandler = rawPath === '/api/analyze' ? handleAnalyze : rawPath === '/api/followup' ? handleFollowup : null;

  if (apiHandler) {
    apiHandler(req, res).catch(() => {
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
