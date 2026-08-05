const form = document.querySelector('#ideaForm');
const ideaInput = document.querySelector('#idea');
const audienceInput = document.querySelector('#audience');
const businessModelInput = document.querySelector('#businessModel');
const charCount = document.querySelector('#charCount');
const submitButton = document.querySelector('#submitButton');
const previewPanel = document.querySelector('#previewPanel');
const results = document.querySelector('#results');
const errorBox = document.querySelector('#errorBox');
const demoButton = document.querySelector('#demoButton');

const escapeHtml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

ideaInput.addEventListener('input', () => {
  charCount.textContent = `${ideaInput.value.length} / 3000`;
});

demoButton.addEventListener('click', () => {
  ideaInput.value =
    'A tool for Discord communities that turns long arguments into a neutral summary, identifies unresolved questions, suggests action items, and gives the drama a completely unnecessary severity score.';
  audienceInput.value = 'Discord moderators and large online communities';
  businessModelInput.value = 'Freemium bot with a $12/month moderator dashboard';
  charCount.textContent = `${ideaInput.value.length} / 3000`;
  document.querySelector('#validator').scrollIntoView({ behavior: 'smooth' });
  ideaInput.focus();
});

function listMarkup(items, ordered = false) {
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag}>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>`;
}

function scoreCard(label, value) {
  const safeValue = Math.max(0, Math.min(100, Number(value) || 0));
  return `
    <article class="score-card">
      <p>${escapeHtml(label)}</p>
      <div class="score-line">
        <strong>${safeValue}</strong>
        <div class="bar"><i style="width:${safeValue}%"></i></div>
      </div>
    </article>`;
}

function renderResult(data, model) {
  results.innerHTML = `
    <div class="result-hero">
      <div class="result-title">
        <span class="mini">THE ORACLE HAS POSTED</span>
        <h2>${escapeHtml(data.name)}</h2>
        <p>${escapeHtml(data.tagline)}</p>
      </div>
      <div class="big-score" style="--score:${data.vibeScore}">
        <div><strong>${data.vibeScore}</strong><span>VIBE SCORE</span></div>
      </div>
    </div>

    <div class="score-grid">
      ${scoreCard('MARKET NEED', data.marketNeed)}
      ${scoreCard('SLOP RISK', data.slopRisk)}
      ${scoreCard('BUILD DIFFICULTY', data.buildDifficulty)}
    </div>

    <div class="insight-grid">
      <article class="insight-card wide"><h3>⚡ Brutal verdict</h3><p>${escapeHtml(data.verdict)}</p></article>
      <article class="insight-card"><h3>💎 Strongest angle</h3><p>${escapeHtml(data.strongestAngle)}</p></article>
      <article class="insight-card"><h3>🕳️ Biggest problem</h3><p>${escapeHtml(data.biggestProblem)}</p></article>
      <article class="insight-card"><h3>🏰 Possible moats</h3>${listMarkup(data.unfairAdvantages)}</article>
      <article class="insight-card"><h3>🧪 MVP feature dump</h3>${listMarkup(data.features)}</article>
      <article class="insight-card wide"><h3>🚀 Your next three founder rituals</h3>${listMarkup(data.nextSteps, true)}</article>
    </div>

    <div class="roast-card">🔥 “${escapeHtml(data.roast)}”</div>
    <p class="model-note">Generated through OpenRouter using ${escapeHtml(model)}. Scores are subjective, not market research.</p>
  `;
  results.hidden = false;
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setLoading(isLoading) {
  submitButton.disabled = isLoading;
  previewPanel.classList.toggle('loading', isLoading);
  submitButton.querySelector('.button-label').textContent = isLoading
    ? 'CONSULTING THE ORACLE...'
    : 'ANALYZE THE VIBES';
  previewPanel.querySelector('.preview-label').textContent = isLoading
    ? 'SYNTHESIZING FOUNDER AURA'
    : 'AWAITING DISRUPTION';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  results.hidden = true;
  setLoading(true);

  const payload = {
    idea: ideaInput.value,
    audience: audienceInput.value,
    businessModel: businessModelInput.value,
    brutality: new FormData(form).get('brutality')
  };

  try {
    const response = await fetch('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || 'The disruption pipeline experienced a mysterious failure.');
    }

    renderResult(data.result, data.model);
  } catch (error) {
    errorBox.textContent = error instanceof Error ? error.message : 'Something went wrong.';
    errorBox.hidden = false;
  } finally {
    setLoading(false);
  }
});
