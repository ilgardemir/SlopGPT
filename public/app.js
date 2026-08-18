// The OpenRouter key and model live on the server. The browser only ever talks to
// our own /api/analyze and /api/followup endpoints.
const ANALYZE_ENDPOINT = '/api/analyze';
const FOLLOWUP_ENDPOINT = '/api/followup';
const MIN_IDEA_LENGTH = 20;

// Mirrors the server's caps. The server enforces them for real; these exist so the page
// can disable itself politely instead of firing a request it knows will be refused.
const MAX_FOLLOWUP_TURNS = 8;
const MAX_QUESTION_LENGTH = 500;
const MIN_QUESTION_LENGTH = 3;

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

// Mirrors MAX_PROSE_LENGTH / MAX_VERDICT_LENGTH / MAX_LIST_ITEM_LENGTH in server.js. Both
// ends have to agree: the browser renders these strings and then posts them back as
// follow-up context, so a tighter cap here would quietly show the founder one roast while
// the model discusses another.
const MAX_PROSE_LENGTH = 1200;
const MAX_VERDICT_LENGTH = 1600;
const MAX_LIST_ITEM_LENGTH = 400;

// The cap is a backstop for a runaway generation, not a routine edit — the prompt's length
// budget is what normally keeps these in range. A bare slice ends mid-word and reads like
// the app broke, so back up to the last word boundary and mark the cut.
function truncateProse(value, limit) {
  const text = String(value ?? '').trim();
  if (text.length <= limit) return text;

  const head = text.slice(0, limit - 1);
  const boundary = head.search(/\s+\S*$/);
  // An unbroken run with no late boundary has nothing sensible to back up to; hard-cut it
  // rather than throwing away most of the text.
  return (boundary > limit * 0.6 ? head.slice(0, boundary) : head).trimEnd() + '…';
}

function safeList(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const clean = value
    .filter((item) => !looksDegenerate(String(item)))
    .map((item) => truncateProse(item, MAX_LIST_ITEM_LENGTH))
    .slice(0, 5);
  return clean.length ? clean : fallback;
}

function normalizeResult(raw = {}) {
  return {
    name: String(raw.name || 'Untitled AI Revolution').slice(0, 90),
    tagline: truncateProse(raw.tagline || 'Transforming the future, one gradient at a time.', 180),
    vibeScore: clampScore(raw.vibeScore),
    slopRisk: clampScore(raw.slopRisk),
    marketNeed: clampScore(raw.marketNeed),
    buildDifficulty: clampScore(raw.buildDifficulty),
    verdict: truncateProse(raw.verdict || 'The neural engine detected both potential and an urgent need for customer interviews.', MAX_VERDICT_LENGTH),
    strongestAngle: truncateProse(raw.strongestAngle || 'A focused workflow for a specific group of users.', MAX_PROSE_LENGTH),
    biggestProblem: truncateProse(raw.biggestProblem || 'The product may be easy to copy and hard to distribute.', MAX_PROSE_LENGTH),
    unfairAdvantages: safeList(raw.unfairAdvantages, ['Focused distribution', 'Workflow-specific data', 'Actually talking to users']),
    features: safeList(raw.features, ['One excellent core workflow', 'Useful exports', 'A dashboard with at least three gradients']),
    nextSteps: safeList(raw.nextSteps, ['Interview five target users', 'Build the smallest useful prototype', 'Measure repeated usage']),
    roast: truncateProse(raw.roast || 'This idea is one animated orb away from a $49 monthly subscription.', MAX_PROSE_LENGTH)
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

// The thread is deliberately memory-only: it belongs to the analysis on screen, and a new
// analysis (or a reload) starts a fresh conversation. `context` is what gets posted back
// to the server with every question, since the server keeps no session of its own.
const followup = { context: null, history: [], baseText: '', busy: false };

function followupSection() {
  return `
    <section class="followup" aria-labelledby="followupHeading">
      <div class="followup-head">
        <span class="followup-kicker">💬 CONVERSATIONAL INTELLIGENCE LAYER</span>
        <h3 id="followupHeading">Interrogate The Neural Engine</h3>
        <p>
          It still has your entire analysis in front of it. Ask what to fix, what to cut,
          or why it said that about your beautiful idea.
        </p>
      </div>

      <div class="followup-thread" id="followupThread" role="log" aria-live="polite" aria-label="Follow-up conversation"></div>

      <form class="followup-form" id="followupForm" novalidate>
        <div class="followup-input">
          <textarea
            id="followupQuestion"
            rows="2"
            maxlength="${MAX_QUESTION_LENGTH}"
            aria-label="Ask a follow-up question about your analysis"
            aria-describedby="followupQuota"
            placeholder="e.g. How do I get my Slop Risk down without rebuilding the whole thing?"
          ></textarea>
          <button type="submit" class="followup-send" id="followupSend">
            <span class="followup-send-label">Ask ✨</span>
          </button>
        </div>
        <p class="followup-meta">
          <span id="followupCount">0 / ${MAX_QUESTION_LENGTH}</span>
          <span id="followupQuota">${MAX_FOLLOWUP_TURNS} free questions remaining</span>
        </p>
        <p class="followup-error" id="followupError" role="alert" hidden></p>
      </form>
    </section>
  `;
}

function renderResult(raw, model, submission) {
  const data = normalizeResult(raw);

  followup.context = { ...submission, analysis: data };
  followup.history = [];
  followup.busy = false;
  followup.baseText = resultToText(data, model);

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

      ${followupSection()}

      <div class="result-actions">
        <button type="button" class="result-action primary" data-action="again">↻ Analyze another idea</button>
        <button type="button" class="result-action" data-action="copy">📋 Copy results</button>
      </div>
    </div>
  `;

  results.hidden = false;
  results.dataset.plain = followup.baseText;
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

function askedCount() {
  return followup.history.filter((entry) => entry.role === 'user').length;
}

// Copy results should hand over the whole session, not just the part that existed before
// the founder started arguing with the model.
function updatePlainText() {
  if (!followup.history.length) {
    results.dataset.plain = followup.baseText;
    return;
  }
  const thread = followup.history.map(
    (entry) => `${entry.role === 'user' ? 'YOU' : 'VIBESCORE AI'}: ${entry.content}`
  );
  results.dataset.plain = `${followup.baseText}\n\n--- FOLLOW-UP QUESTIONS ---\n\n${thread.join('\n\n')}`;
}

// The model is told to write paragraphs, but "a blank line between them" is not something
// it honours reliably, so treat every non-empty line as its own paragraph.
function answerParagraphs(text) {
  return String(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function appendBubble(role, text) {
  const thread = results.querySelector('#followupThread');
  if (!thread) return null;

  const bubble = document.createElement('div');
  bubble.className = `bubble bubble-${role}`;
  const who = role === 'user' ? 'You' : '✨ VibeScore AI';
  bubble.innerHTML =
    `<span class="bubble-who">${escapeHtml(who)}</span>` +
    answerParagraphs(text)
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join('');

  thread.appendChild(bubble);
  bubble.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return bubble;
}

function appendThinkingBubble() {
  const thread = results.querySelector('#followupThread');
  if (!thread) return null;

  const bubble = document.createElement('div');
  bubble.className = 'bubble bubble-ai bubble-thinking';
  bubble.innerHTML =
    '<span class="bubble-who">✨ VibeScore AI</span>' +
    '<p class="loading-dots">Consulting the deeper synergy layers</p>';
  thread.appendChild(bubble);
  bubble.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return bubble;
}

function updateQuestionCount() {
  const input = results.querySelector('#followupQuestion');
  const count = results.querySelector('#followupCount');
  if (input && count) count.textContent = `${input.value.length} / ${MAX_QUESTION_LENGTH}`;
}

function updateFollowupQuota() {
  const quota = results.querySelector('#followupQuota');
  const input = results.querySelector('#followupQuestion');
  if (!quota || !input) return;

  const remaining = MAX_FOLLOWUP_TURNS - askedCount();
  if (remaining > 0) {
    quota.textContent = `${remaining} free question${remaining === 1 ? '' : 's'} remaining`;
    return;
  }

  quota.textContent = `Follow-up allowance exhausted — analyze a new idea to unlock ${MAX_FOLLOWUP_TURNS} more.`;
  input.placeholder = 'The neural engine has said everything it is contractually obliged to say.';
}

// Owns the disabled state of both controls, because it always runs last (from the `finally`
// of a send). Folding the exhausted case in here stops it re-enabling an input that the
// turn cap has just retired.
function setFollowupBusy(busy) {
  followup.busy = busy;
  const send = results.querySelector('#followupSend');
  const input = results.querySelector('#followupQuestion');
  if (!send || !input) return;

  const locked = busy || askedCount() >= MAX_FOLLOWUP_TURNS;
  send.disabled = locked;
  send.setAttribute('aria-busy', String(busy));
  send.querySelector('.followup-send-label').textContent = busy ? 'Thinking' : 'Ask ✨';
  input.disabled = locked;
  if (!locked) input.focus({ preventScroll: true });
}

function showFollowupError(message) {
  const error = results.querySelector('#followupError');
  if (!error) return;
  error.textContent = message;
  error.hidden = false;
}

function clearFollowupError() {
  const error = results.querySelector('#followupError');
  if (!error) return;
  error.hidden = true;
  error.textContent = '';
}

async function sendFollowup() {
  const input = results.querySelector('#followupQuestion');
  if (!input || followup.busy || !followup.context) return;
  if (askedCount() >= MAX_FOLLOWUP_TURNS) return;

  const question = input.value.trim();
  if (question.length < MIN_QUESTION_LENGTH) {
    showFollowupError('✨ Ask an actual question and the neural engine will consider it.');
    input.focus();
    return;
  }

  clearFollowupError();
  input.value = '';
  updateQuestionCount();

  const questionBubble = appendBubble('user', question);
  const thinking = appendThinkingBubble();
  setFollowupBusy(true);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(FOLLOWUP_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...followup.context, history: followup.history, question })
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

    const answer = String(payload.answer || '').trim();
    if (!answer || looksDegenerate(answer)) {
      throw new Error('The model answered with unreadable output. Try asking that again in different words.');
    }

    thinking?.remove();
    appendBubble('ai', answer);
    followup.history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
    updatePlainText();
    updateFollowupQuota();
  } catch (error) {
    // Nothing failed gets into `history`, so the next attempt sends the same clean thread.
    // The question goes back in the box rather than sitting orphaned above an error.
    thinking?.remove();
    questionBubble?.remove();
    input.value = question;
    updateQuestionCount();
    showFollowupError(`⚠️ The follow-up failed: ${describeClientError(error)}`);
  } finally {
    clearTimeout(timeoutId);
    setFollowupBusy(false);
  }
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

// The results card is replaced wholesale on every analysis, so the follow-up controls are
// bound by delegation on the container that survives.
results.addEventListener('submit', (event) => {
  if (event.target.id !== 'followupForm') return;
  event.preventDefault();
  sendFollowup();
});

results.addEventListener('input', (event) => {
  if (event.target.id !== 'followupQuestion') return;
  updateQuestionCount();
  if (event.target.value.trim().length >= MIN_QUESTION_LENGTH) clearFollowupError();
});

results.addEventListener('keydown', (event) => {
  if (event.target.id !== 'followupQuestion') return;
  // Enter sends, Shift+Enter writes a new line — the convention every chat box uses.
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendFollowup();
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

  const submission = {
    idea,
    audience: audienceInput.value.trim(),
    businessModel: businessModelInput.value.trim(),
    brutality: new FormData(form).get('brutality') || 'balanced'
  };

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
      body: JSON.stringify(submission)
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

    renderResult(payload.analysis, payload.model, submission);
  } catch (error) {
    results.hidden = true;
    results.innerHTML = '';
    followup.context = null;
    followup.history = [];
    const message = `⚠️ AI disruption failed: ${describeClientError(error)}`;
    showFormError(message);
    resultsStatus.textContent = message;
    ideaInput.focus({ preventScroll: true });
  } finally {
    clearTimeout(timeoutId);
    setLoading(false);
  }
});
