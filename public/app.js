// The OpenRouter key and model live on the server. The browser only ever talks to
// our own /api/analyze endpoint.
const ANALYZE_ENDPOINT = '/api/analyze';
const MIN_IDEA_LENGTH = 20;

const form = document.querySelector('#ideaForm');
const ideaInput = document.querySelector('#idea');
const audienceInput = document.querySelector('#audience');
const businessModelInput = document.querySelector('#businessModel');
const charCount = document.querySelector('#charCount');
const submitButton = document.querySelector('#submitButton');
const demoButton = document.querySelector('#demoButton');
const results = document.querySelector('#results');
const resultsStatus = document.querySelector('#resultsStatus');
const formError = document.querySelector('#formError');
const toast = document.querySelector('#toast');
const announcement = document.querySelector('#announcement');
const dismissAnnouncement = document.querySelector('#dismissAnnouncement');

// Each score's `higherIsBetter` drives the bar colour. Without it every metric renders
// in the same celebratory purple, and a Slop Risk of 90 looks like an achievement.
const SCORE_META = {
  vibeScore: { emoji: '✨', label: 'Vibe Score', higherIsBetter: true },
  slopRisk: { emoji: '🫠', label: 'Slop Risk', higherIsBetter: false },
  marketNeed: { emoji: '📈', label: 'Market Need', higherIsBetter: true },
  buildDifficulty: { emoji: '🛠️', label: 'Build Difficulty', higherIsBetter: null }
};

const SCORE_HELP = [
  {
    emoji: '✨',
    label: 'Vibe Score',
    direction: 'Higher is better',
    tone: 'good',
    body:
      'The overall verdict: is this worth your next six months? It is not an average of the other three — a beloved idea nobody needs still scores low, and a boring idea with an urgent, paying audience scores high. Under 40 is a hobby project. Over 60 means a specific audience will care.'
  },
  {
    emoji: '🫠',
    label: 'Slop Risk',
    direction: 'Lower is better',
    tone: 'bad',
    body:
      'How close your idea is to generic, low-effort AI-wrapper slop. This one is inverted: a LOW score is the good outcome and means your idea is specific and hard to clone. A HIGH score means it reads as a system prompt over a general model with a dashboard bolted on.'
  },
  {
    emoji: '📈',
    label: 'Market Need',
    direction: 'Higher is better',
    tone: 'good',
    body:
      'How badly the customers you named already feel this problem. Low means you invented the problem. High means people are already paying for a fix, or hacking one together themselves.'
  },
  {
    emoji: '🛠️',
    label: 'Build Difficulty',
    direction: 'Neither good nor bad',
    tone: 'neutral',
    body:
      'The engineering and operational effort to ship something people would pay for. Low is a weekend project; high means custom infrastructure, regulation, or a research problem. This is context, not a grade — high difficulty only hurts when it is not matched by real market need.'
  }
];

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

// Backstop for the same model collapse the server screens for (see findDegenerateField in
// server.js). A list can lose its bad entries and still be useful, so drop them here
// rather than failing the whole render. Measured before truncation, since slicing to 220
// would hide the tail of a longer run.
const MAX_UNBROKEN_RUN = 80;

function looksDegenerate(text) {
  return text.split(/\s+/).some((word) => word.length >= MAX_UNBROKEN_RUN);
}

function safeList(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const clean = value
    .filter((item) => !looksDegenerate(String(item)))
    .map((item) => String(item).slice(0, 220))
    .slice(0, 5);
  return clean.length ? clean : fallback;
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

function compactMetadata(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 240);
  try {
    return JSON.stringify(value).slice(0, 240);
  } catch {
    return String(value).slice(0, 240);
  }
}

function describeAnalyzeError(payload, response) {
  const apiError = payload?.error || {};
  const metadata = apiError?.metadata || {};

  // 5xx responses from our own server are already visitor-safe sentences. Appending
  // "HTTP 503 · provider: …" to them just leaks plumbing at the person reading it.
  const message = apiError?.message || payload?.message || 'The analysis request was rejected';
  if (response.status >= 500) return message;

  const parts = [message, `HTTP ${response.status}`];
  if (apiError?.code && Number(apiError.code) !== response.status) parts.push(`API code ${apiError.code}`);
  if (metadata?.error_type) parts.push(`type: ${metadata.error_type}`);
  if (metadata?.provider_name) parts.push(`provider: ${metadata.provider_name}`);

  const providerDetail = compactMetadata(metadata?.provider_error || metadata?.raw || metadata?.details);
  if (providerDetail) parts.push(providerDetail);

  return parts.join(' · ');
}

function describeClientError(error) {
  if (error?.name === 'AbortError') {
    return 'The request timed out after 60 seconds. Retry once; if it persists, the model provider may be overloaded.';
  }
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return 'Could not reach the VibeScore server. Check your connection and try again.';
  }
  return message;
}

function renderList(items) {
  return items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
}

// A 0-100 number is meaningless without knowing which direction is good. `higherIsBetter`
// maps the value onto a good/warn/bad ramp; `null` means the metric is informational.
function scoreTone(value, higherIsBetter) {
  if (higherIsBetter === null) return 'neutral';
  const goodness = higherIsBetter ? value : 100 - value;
  if (goodness >= 67) return 'good';
  if (goodness >= 34) return 'warn';
  return 'bad';
}

function scoreCard(key, value) {
  const { emoji, label, higherIsBetter } = SCORE_META[key];
  const tone = scoreTone(value, higherIsBetter);
  const hint =
    higherIsBetter === null ? 'Higher means harder' : higherIsBetter ? 'Higher is better' : 'Lower is better';

  return `
    <article class="score-card" data-tone="${tone}">
      <span class="score-label"><span aria-hidden="true">${emoji}</span> ${escapeHtml(label)}</span>
      <strong>${value}<small>/100</small></strong>
      <div
        class="score-bar"
        role="meter"
        aria-valuenow="${value}"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-label="${escapeHtml(label)}: ${value} out of 100. ${hint}."
      ><i style="width:${value}%"></i></div>
      <span class="score-hint">${hint}</span>
    </article>
  `;
}

function scoreHelpPanel() {
  const rows = SCORE_HELP.map(
    (item) => `
      <div class="score-help-row" data-tone="${item.tone}">
        <h4><span aria-hidden="true">${item.emoji}</span> ${escapeHtml(item.label)}
          <em>${escapeHtml(item.direction)}</em>
        </h4>
        <p>${escapeHtml(item.body)}</p>
      </div>`
  ).join('');

  return `
    <details class="score-help">
      <summary>
        <span class="score-help-mark" aria-hidden="true">?</span>
        <span>What do these scores mean?</span>
      </summary>
      <div class="score-help-body">
        ${rows}
        <p class="score-help-note">
          Scores are the model's judgement of the idea itself. The feedback mode you pick
          changes the wording, not the numbers.
        </p>
      </div>
    </details>
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
        ${scoreCard('vibeScore', data.vibeScore)}
        ${scoreCard('slopRisk', data.slopRisk)}
        ${scoreCard('marketNeed', data.marketNeed)}
        ${scoreCard('buildDifficulty', data.buildDifficulty)}
      </div>

      ${scoreHelpPanel()}

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

      <div class="result-actions">
        <button type="button" class="result-action primary" data-action="again">↻ Analyze another idea</button>
        <button type="button" class="result-action" data-action="copy">📋 Copy results</button>
      </div>
    </div>
  `;

  results.hidden = false;
  results.dataset.plain = resultToText(data, model);
  resultsStatus.textContent = `Analysis ready. Vibe Score ${data.vibeScore} out of 100.`;
  results.querySelector('.result-shell').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resultToText(data, model) {
  const lines = [
    `${data.name} — ${data.tagline}`,
    '',
    `Vibe Score:       ${data.vibeScore}/100 (higher is better)`,
    `Slop Risk:        ${data.slopRisk}/100 (lower is better)`,
    `Market Need:      ${data.marketNeed}/100 (higher is better)`,
    `Build Difficulty: ${data.buildDifficulty}/100 (higher means harder)`,
    '',
    `VERDICT: ${data.verdict}`,
    '',
    `STRONGEST OPPORTUNITY: ${data.strongestAngle}`,
    `BIGGEST BLOCKER: ${data.biggestProblem}`,
    '',
    'UNFAIR ADVANTAGES:',
    ...data.unfairAdvantages.map((item) => `  - ${item}`),
    '',
    'MUST-HAVE FEATURES:',
    ...data.features.map((item) => `  - ${item}`),
    '',
    'NEXT STEPS:',
    ...data.nextSteps.map((item) => `  - ${item}`),
    '',
    `REALITY CHECK: ${data.roast}`,
    '',
    `Generated by ${model || 'an AI model'} via VibeScore AI.`
  ];
  return lines.join('\n');
}

// A skeleton keeps the results area occupied for the length of the model call, so the
// page does not look inert while the (off-screen) button spinner is the only feedback.
function renderSkeleton() {
  results.innerHTML = `
    <div class="result-shell skeleton" aria-hidden="true">
      <div class="skeleton-line skeleton-kicker"></div>
      <div class="skeleton-line skeleton-title"></div>
      <div class="skeleton-line skeleton-tagline"></div>
      <div class="score-grid">
        ${'<article class="score-card"><div class="skeleton-line skeleton-label"></div><div class="skeleton-line skeleton-number"></div><div class="skeleton-line skeleton-bar"></div></article>'.repeat(4)}
      </div>
      <div class="skeleton-block"></div>
      <div class="result-columns"><div class="skeleton-block short"></div><div class="skeleton-block short"></div></div>
    </div>
  `;
  results.hidden = false;
}

function setLoading(loading) {
  submitButton.disabled = loading;
  submitButton.setAttribute('aria-busy', String(loading));
  const label = submitButton.querySelector('.button-label');
  label.classList.toggle('loading-dots', loading);
  label.textContent = loading ? '🧠 ACTIVATING NEURAL SYNERGY' : '✨ GENERATE MY AI ANALYSIS ✨';
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => {
    toast.hidden = true;
  }, 3600);
}

function showFormError(message) {
  formError.textContent = message;
  formError.hidden = false;
}

function clearFormError() {
  formError.hidden = true;
  formError.textContent = '';
}

function focusIdea() {
  ideaInput.focus({ preventScroll: true });
  document.querySelector('#validator').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea fallback */
  }
  try {
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(scratch);
    scratch.select();
    const ok = document.execCommand('copy');
    scratch.remove();
    return ok;
  } catch {
    return false;
  }
}

ideaInput.addEventListener('input', () => {
  charCount.textContent = `${ideaInput.value.length} / 3000`;
  if (!formError.hidden && ideaInput.value.trim().length >= MIN_IDEA_LENGTH) clearFormError();
});

if (dismissAnnouncement) {
  dismissAnnouncement.addEventListener('click', () => {
    announcement.remove();
  });
}

demoButton.addEventListener('click', () => {
  ideaInput.value =
    'An AI-powered browser extension that watches online meetings, detects corporate buzzwords in real time, and generates a live Synergy Score plus personalized follow-up emails.';
  audienceInput.value = 'Remote teams, startup founders, and LinkedIn thought leaders';
  businessModelInput.value = '$19/month Pro, $99/month Team, mysterious Enterprise pricing';
  ideaInput.dispatchEvent(new Event('input'));
  clearFormError();
  focusIdea();
  showToast('✨ Demo vision injected. Your billion-dollar journey awaits.');
});

document.querySelectorAll('[data-fake-upgrade]').forEach((button) => {
  button.addEventListener('click', () => {
    showToast('🚀 Incredible choice! The payment infrastructure has not manifested yet.');
  });
});

results.addEventListener('click', async (event) => {
  const button = event.target.closest('.result-action');
  if (!button) return;

  if (button.dataset.action === 'again') {
    focusIdea();
    return;
  }

  if (button.dataset.action === 'copy') {
    const ok = await copyText(results.dataset.plain || '');
    showToast(ok ? '📋 Analysis copied to your clipboard.' : '⚠️ Could not copy — select the text manually.');
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearFormError();

  const idea = ideaInput.value.trim();
  if (idea.length < MIN_IDEA_LENGTH) {
    showFormError(`✨ Please provide at least ${MIN_IDEA_LENGTH} characters of visionary founder lore.`);
    ideaInput.focus();
    return;
  }

  const brutality = new FormData(form).get('brutality') || 'balanced';

  setLoading(true);
  renderSkeleton();
  resultsStatus.textContent = 'Analyzing your idea. This usually takes a few seconds.';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(ANALYZE_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idea,
        audience: audienceInput.value.trim(),
        businessModel: businessModelInput.value.trim(),
        brutality
      })
    });

    const rawBody = await response.text();
    let payload;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      throw new Error(`The server returned an unreadable response (HTTP ${response.status}).`);
    }

    if (!response.ok || payload?.error) {
      throw new Error(describeAnalyzeError(payload, response));
    }

    renderResult(payload.analysis, payload.model);
  } catch (error) {
    results.hidden = true;
    results.innerHTML = '';
    const message = `⚠️ AI disruption failed: ${describeClientError(error)}`;
    showFormError(message);
    resultsStatus.textContent = message;
    ideaInput.focus({ preventScroll: true });
  } finally {
    clearTimeout(timeoutId);
    setLoading(false);
  }
});
