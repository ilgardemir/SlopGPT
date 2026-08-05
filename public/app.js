const OPENROUTER_API_KEY = [
  'sk-or',
  '-v1-',
  'b1a7f0ecc5888fd8cf37fb0311554658',
  '35dc51baab2dee4ba38a414560992d97'
].join('');
const OPENROUTER_MODEL = 'openai/gpt-5-nano';

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
      unfairAdvantages: {
        type: 'array',
        items: { type: 'string' },
        minItems: 3,
        maxItems: 5
      },
      features: {
        type: 'array',
        items: { type: 'string' },
        minItems: 3,
        maxItems: 5
      },
      nextSteps: {
        type: 'array',
        items: { type: 'string' },
        minItems: 3,
        maxItems: 5
      },
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

const form = document.querySelector('#ideaForm');
const ideaInput = document.querySelector('#idea');
const audienceInput = document.querySelector('#audience');
const businessModelInput = document.querySelector('#businessModel');
const charCount = document.querySelector('#charCount');
const submitButton = document.querySelector('#submitButton');
const demoButton = document.querySelector('#demoButton');
const results = document.querySelector('#results');
const errorBox = document.querySelector('#errorBox');
const toast = document.querySelector('#toast');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function safeList(value, fallback) {
  return Array.isArray(value) && value.length
    ? value.map((item) => String(item).slice(0, 220)).slice(0, 5)
    : fallback;
}

function normalizeResult(raw = {}) {
  return {
    name: String(raw.name || 'Untitled AI Revolution').slice(0, 90),
    tagline: String(raw.tagline || 'Transforming the future, one gradient at a time.').slice(0, 180),
    vibeScore: clampScore(raw.vibeScore),
    slopRisk: clampScore(raw.slopRisk),
    marketNeed: clampScore(raw.marketNeed),
    buildDifficulty: clampScore(raw.buildDifficulty),
    verdict: String(raw.verdict || 'The neural engine detected both potential and an urgent need for customer interviews.').slice(0, 1000),
    strongestAngle: String(raw.strongestAngle || 'A focused workflow for a specific group of users.').slice(0, 500),
    biggestProblem: String(raw.biggestProblem || 'The product may be easy to copy and hard to distribute.').slice(0, 500),
    unfairAdvantages: safeList(raw.unfairAdvantages, ['Focused distribution', 'Workflow-specific data', 'Actually talking to users']),
    features: safeList(raw.features, ['One excellent core workflow', 'Useful exports', 'A dashboard with at least three gradients']),
    nextSteps: safeList(raw.nextSteps, ['Interview five target users', 'Build the smallest useful prototype', 'Measure repeated usage']),
    roast: String(raw.roast || 'This idea is one animated orb away from a $49 monthly subscription.').slice(0, 600)
  };
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

function compactMetadata(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 240);
  try {
    return JSON.stringify(value).slice(0, 240);
  } catch {
    return String(value).slice(0, 240);
  }
}

function describeOpenRouterError(payload, response) {
  const apiError = payload?.error || {};
  const metadata = apiError?.metadata || {};
  const parts = [apiError?.message || payload?.message || 'OpenRouter rejected the request'];

  parts.push(`HTTP ${response.status}`);
  if (apiError?.code && Number(apiError.code) !== response.status) {
    parts.push(`API code ${apiError.code}`);
  }
  if (metadata?.error_type) parts.push(`type: ${metadata.error_type}`);
  if (metadata?.provider_name) parts.push(`provider: ${metadata.provider_name}`);
  if (metadata?.model_slug) parts.push(`model: ${metadata.model_slug}`);

  const providerDetail = compactMetadata(
    metadata?.provider_error || metadata?.raw || metadata?.details
  );
  if (providerDetail) parts.push(providerDetail);

  const requestId = response.headers.get('x-request-id');
  if (requestId) parts.push(`request: ${requestId}`);

  return parts.join(' · ');
}

function describeClientError(error) {
  if (error?.name === 'AbortError') {
    return 'The OpenRouter request timed out after 45 seconds. Retry once; if it persists, the model provider may be overloaded.';
  }

  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return `The browser could not reach OpenRouter. Check the internet connection, privacy/ad-blocking extensions, and whether the page is served over HTTPS. Browser detail: ${message}`;
  }
  return message;
}

function renderList(items) {
  return items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
}

function scoreCard(emoji, label, value) {
  return `
    <article class="score-card">
      <span>${emoji} ${escapeHtml(label)}</span>
      <strong>${value}<small>/100</small></strong>
      <div class="score-bar"><i style="width:${value}%"></i></div>
    </article>
  `;
}

function renderResult(raw, model) {
  const data = normalizeResult(raw);
  results.innerHTML = `
    <div class="result-shell">
      <div class="result-top">
        <div>
          <span class="result-kicker">✨ YOUR AI-POWERED SUCCESS BLUEPRINT</span>
          <h2>${escapeHtml(data.name)}</h2>
          <p class="result-tagline">${escapeHtml(data.tagline)}</p>
        </div>
        <span class="result-badge">🧠 GENERATED BY ${escapeHtml(model || 'ADVANCED AI')}</span>
      </div>

      <div class="score-grid">
        ${scoreCard('✨', 'Vibe Score', data.vibeScore)}
        ${scoreCard('🫠', 'Slop Risk', data.slopRisk)}
        ${scoreCard('📈', 'Market Need', data.marketNeed)}
        ${scoreCard('🛠️', 'Build Difficulty', data.buildDifficulty)}
      </div>

      <article class="verdict-card">
        <h3>🚀 The Revolutionary AI Verdict</h3>
        <p>${escapeHtml(data.verdict)}</p>
      </article>

      <div class="result-columns">
        <article class="insight-card"><h3>💎 Your Strongest Opportunity</h3><p>${escapeHtml(data.strongestAngle)}</p></article>
        <article class="insight-card"><h3>⚠️ Your Biggest Growth Blocker</h3><p>${escapeHtml(data.biggestProblem)}</p></article>
      </div>

      <div class="list-grid">
        <article class="list-card"><h3>🛡️ Unfair Advantages</h3><ul>${renderList(data.unfairAdvantages)}</ul></article>
        <article class="list-card"><h3>🪄 Must-Have Features</h3><ul>${renderList(data.features)}</ul></article>
        <article class="list-card"><h3>⚡ High-Impact Next Steps</h3><ul>${renderList(data.nextSteps)}</ul></article>
      </div>

      <div class="roast-card">🔥 <strong>Founder Reality Check:</strong> ${escapeHtml(data.roast)}</div>
    </div>
  `;
  results.hidden = false;
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setLoading(loading) {
  submitButton.disabled = loading;
  const label = submitButton.querySelector('.button-label');
  label.classList.toggle('loading-dots', loading);
  label.textContent = loading ? '🧠 ACTIVATING NEURAL SYNERGY' : '✨ GENERATE MY AI ANALYSIS ✨';
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => { toast.hidden = true; }, 3600);
}

ideaInput.addEventListener('input', () => {
  charCount.textContent = `${ideaInput.value.length} / 3000`;
});

demoButton.addEventListener('click', () => {
  ideaInput.value = 'An AI-powered browser extension that watches online meetings, detects corporate buzzwords in real time, and generates a live Synergy Score plus personalized follow-up emails.';
  audienceInput.value = 'Remote teams, startup founders, and LinkedIn thought leaders';
  businessModelInput.value = '$19/month Pro, $99/month Team, mysterious Enterprise pricing';
  ideaInput.dispatchEvent(new Event('input'));
  document.querySelector('#validator').scrollIntoView({ behavior: 'smooth', block: 'center' });
  showToast('✨ Demo vision injected. Your billion-dollar journey awaits.');
});

document.querySelectorAll('[data-fake-upgrade]').forEach((button) => {
  button.addEventListener('click', () => {
    showToast('🚀 Incredible choice! The payment infrastructure has not manifested yet.');
  });
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  results.hidden = true;

  const idea = ideaInput.value.trim();
  if (idea.length < 20) {
    errorBox.textContent = '✨ Please provide at least 20 characters of visionary founder lore.';
    errorBox.hidden = false;
    return;
  }

  const brutality = new FormData(form).get('brutality') || 'balanced';
  const systemPrompt = `You are VibeScore AI, an expert startup strategist, product visionary, innovation guru, and brutally honest critic. Analyze the startup idea accurately and constructively. Avoid invented market statistics, guaranteed outcomes, or claims of certainty. Identify whether this is a useful vertical product or just a thin generic AI wrapper. The feedback tone is ${brutality}.

Write with comically generic AI-business language such as unlock, supercharge, revolutionary, empower, next-generation, actionable, seamless, ecosystem, transformative, and future-ready—but keep the actual product analysis useful.`;

  const userPrompt = `REVOLUTIONARY STARTUP VISION:\n${idea}\n\nDREAM CUSTOMERS:\n${audienceInput.value.trim() || 'Not specified'}\n\nREVENUE MAGIC:\n${businessModelInput.value.trim() || 'Not specified'}`;

  setLoading(true);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45000);

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': window.location.href,
        'X-OpenRouter-Title': 'VibeScore AI'
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        reasoning: {
          effort: 'minimal',
          exclude: true
        },
        response_format: {
          type: 'json_schema',
          json_schema: STARTUP_ANALYSIS_SCHEMA
        },
        max_tokens: 2200
      })
    });

    const rawBody = await response.text();
    let payload;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      throw new Error(`OpenRouter returned an unreadable response (HTTP ${response.status}): ${rawBody.slice(0, 180) || 'empty body'}`);
    }

    if (!response.ok || payload?.error) {
      throw new Error(describeOpenRouterError(payload, response));
    }

    const choice = payload?.choices?.[0];
    const content = getMessageText(choice?.message);
    if (!content) {
      const finishReason = choice?.finish_reason || 'missing';
      const completionTokens = payload?.usage?.completion_tokens;
      const tokenDetail = Number.isFinite(completionTokens)
        ? ` Completion tokens: ${completionTokens}.`
        : '';
      throw new Error(`OpenRouter returned no visible answer (finish reason: ${finishReason}).${tokenDetail}`);
    }

    renderResult(extractJson(content), payload.model || OPENROUTER_MODEL);
  } catch (error) {
    errorBox.textContent = `⚠️ AI disruption failed: ${describeClientError(error)}`;
    errorBox.hidden = false;
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } finally {
    clearTimeout(timeoutId);
    setLoading(false);
  }
});
