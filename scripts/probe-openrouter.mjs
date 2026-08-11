// Diagnostic probe: finds out WHY /api/analyze is slow.
//
//   npm run probe
//
// Sends the app's real prompt under several configurations and reports how long each
// takes and which provider served it. Each call is a few hundred tokens, so the whole
// run costs well under a cent. Safe to delete once the timeout is understood.

const KEY = (process.env.OPENROUTER_API_KEY || '').trim().replace(/^["']|["']$/g, '');
const MODEL = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash';
const URL = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS) || 70000;

if (!KEY) {
  console.error('OPENROUTER_API_KEY is not set. Put it in .env — this script is run via --env-file-if-exists.');
  process.exit(1);
}

const SCHEMA = {
  name: 'startup_analysis',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      verdict: { type: 'string' },
      vibeScore: { type: 'integer', minimum: 0, maximum: 100 },
      roast: { type: 'string' }
    },
    required: ['name', 'verdict', 'vibeScore', 'roast'],
    additionalProperties: false
  }
};

const messages = [
  { role: 'system', content: 'You are VibeScore AI, a startup strategist. Be concise and useful.' },
  { role: 'user', content: 'REVOLUTIONARY STARTUP VISION:\nAn AI browser extension that scores meeting buzzwords in real time.' }
];

async function probe(label, extra) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();

  try {
    const res = await fetch(URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        'X-Title': 'VibeScore AI probe'
      },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: 700, ...extra })
    });

    const ms = Date.now() - started;
    const text = await res.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      return { label, ms, status: res.status, provider: '-', note: `unparseable: ${text.slice(0, 80)}` };
    }

    if (!res.ok || body.error) {
      return { label, ms, status: res.status, provider: body.provider || '-', note: (body.error?.message || 'error').slice(0, 70) };
    }

    const usage = body.usage || {};
    const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
    const content = body.choices?.[0]?.message?.content || '';
    let valid = 'n/a';
    if (extra.response_format) {
      try {
        JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim());
        valid = 'JSON ok';
      } catch {
        valid = 'NOT JSON';
      }
    }
    return {
      label,
      ms,
      status: res.status,
      provider: body.provider || 'unknown',
      note: `${usage.completion_tokens ?? '?'} tok, ${reasoning} reasoning, ${valid}`
    };
  } catch (error) {
    return {
      label,
      ms: Date.now() - started,
      status: error.name === 'AbortError' ? 'TIMEOUT' : 'ERR',
      provider: '-',
      note: error.name === 'AbortError' ? `aborted at ${TIMEOUT_MS}ms` : String(error.message).slice(0, 70)
    };
  } finally {
    clearTimeout(timer);
  }
}

const structured = { response_format: { type: 'json_schema', json_schema: SCHEMA } };
const strictPool = { require_parameters: true };

// Ordered so the first four isolate each variable independently.
const CONFIGS = [
  ['current app config', { ...structured, reasoning: { effort: 'none' }, provider: { ...strictPool, sort: 'throughput' } }],
  ['no sort (price routing)', { ...structured, reasoning: { effort: 'none' }, provider: strictPool }],
  ['no reasoning field', { ...structured, provider: { ...strictPool, sort: 'throughput' } }],
  ['no structured output', { reasoning: { effort: 'none' }, provider: { ...strictPool, sort: 'throughput' } }],
  ['bare request', {}]
];

const PROVIDERS = ['DeepInfra', 'Baidu', 'Fireworks', 'CoreWeave', 'AtlasCloud', 'Parasail'];

console.log(`Probing ${MODEL} (timeout ${TIMEOUT_MS}ms)\n`);
console.log('CONFIGURATIONS');
console.log('-'.repeat(96));

for (const [label, extra] of CONFIGS) {
  const r = await probe(label, extra);
  console.log(
    `  ${String(r.label).padEnd(26)} ${String(r.ms + 'ms').padStart(8)}  ${String(r.status).padEnd(8)} ${String(r.provider).padEnd(14)} ${r.note}`
  );
}

console.log('\nPER-PROVIDER (current app config, pinned)');
console.log('-'.repeat(96));

for (const name of PROVIDERS) {
  const r = await probe(name, {
    ...structured,
    reasoning: { effort: 'none' },
    provider: { only: [name], allow_fallbacks: false }
  });
  console.log(
    `  ${String(r.label).padEnd(26)} ${String(r.ms + 'ms').padStart(8)}  ${String(r.status).padEnd(8)} ${String(r.provider).padEnd(14)} ${r.note}`
  );
}

console.log('\nRead: if "no structured output" is fast but the others are slow, strict schema');
console.log('decoding is the bottleneck. If one provider is fast, pin it with provider.only.');
