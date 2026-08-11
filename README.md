# VibeScore AI ✨

A deliberately generic, excessively gradient-heavy, emoji-filled AI startup validator.

## Architecture

The browser never sees the OpenRouter key. `public/app.js` posts the form fields to
`POST /api/analyze` on this server, and `server.js` adds the key, the model, the system
prompt, and the JSON schema before calling OpenRouter.

```
browser  ──POST /api/analyze──▶  server.js  ──Bearer key──▶  openrouter.ai
         ◀──{ model, analysis }──           ◀──────────────
```

## Run it locally

Requires Node 20.18+ (built-in `fetch` and `--env-file-if-exists`). No dependencies to install.

```bash
cp .env.example .env      # then put a real key in OPENROUTER_API_KEY
npm run dev               # loads .env, restarts on file changes
```

`npm run dev` reads `.env`; `npm start` deliberately does not, because Railway supplies
real environment variables and has no `.env` file to read. If you use `npm start` locally,
export the key yourself first.

Then visit `http://localhost:3000`.

Opening `public/index.html` directly from disk no longer works — there is no server to
call, so `/api/analyze` will 404.

## Deploy on Railway

1. Point a Railway service at this repo. It runs `npm start` from `package.json`.
2. Under **Variables**, add `OPENROUTER_API_KEY`. Optionally add `OPENROUTER_MODEL` and
   `APP_URL` (your public Railway URL, used for OpenRouter attribution).
3. Do **not** set `PORT` — Railway injects it, and `server.js` reads it.

The server binds `0.0.0.0`, which Railway requires to route traffic to the container.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `OPENROUTER_API_KEY` | yes | — | Server-side OpenRouter credential |
| `OPENROUTER_MODEL` | no | `deepseek/deepseek-v4-flash` | Model slug |
| `OPENROUTER_REASONING_EFFORT` | no | `none` | `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` |
| `APP_URL` | no | derived from request host | `HTTP-Referer` attribution |
| `PORT` | no | `3000` | Listen port (Railway sets this) |

### Reasoning and provider routing

`effort: "none"` disables reasoning outright. Every other level — including `minimal` —
still computes and **bills** reasoning tokens; `exclude: true` only hides them from the
response. Since this app wants a JSON blob and not deliberation, `none` is both correct
and cheapest.

`minimal` is only honoured by OpenAI (o-series, GPT-5) and Grok models. If you point
`OPENROUTER_MODEL` back at `openai/gpt-5-nano`, set `OPENROUTER_REASONING_EFFORT=minimal`.

The request also sends `provider: { require_parameters: true }`. Several DeepSeek V4 Flash
providers advertise `response_format` but not `structured_outputs`; without this flag
OpenRouter can route to one of them, and the strict schema is silently ignored — you get
prose where the app expects JSON.

If `OPENROUTER_API_KEY` is missing, the static site still serves and `/api/analyze`
returns a 500 that says exactly which variable to set.

## Troubleshooting

### `401` / "User not found."

OpenRouter's wording is misleading — it means **the server's API key was rejected**, not
that anything is wrong with the visitor. The server now logs a redacted shape report at
startup and on every auth failure:

```
🔎 Key shape: length 73 · looks well-formed
🔎 Key shape: length 41 · had surrounding quotes (stripped)
🔎 Key shape: length 40 · CONTAINS INTERNAL WHITESPACE — almost certainly a bad paste
```

Quotes and surrounding whitespace are stripped automatically, since dashboard-style env
editors (Railway included) store values verbatim rather than parsing them like a `.env`.

To test the key on its own, without involving this server at all:

```bash
curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer YOUR_KEY_HERE"
```

A valid key returns its label, usage, and limit. A `401` means the key itself is bad —
revoked, deleted, truncated, or from a different account. No code change will help.

## Security notes

- The key is server-side only. Never move it back into `public/`.
- `/api/analyze` is a fixed-purpose endpoint: the model, prompt, and response schema are
  hardcoded server-side, so it cannot be repurposed as a general LLM proxy. Callers only
  control the four form fields, which are length-capped.
- There is **no rate limiting**. A public deployment can be called in a loop by anyone who
  finds the URL. Keep a spend cap on the OpenRouter key.
- An earlier commit (`742eafe`) contained a live key in `public/app.js`. That key is
  revoked; do not restore it from history.

## Files

- `public/index.html` — the extremely AI-generated landing page and app UI
- `public/styles.css` — imports `styles-1/2/3.css`: gradients, glass cards, fake testimonials, pricing
- `public/app.js` — form handling, `/api/analyze` call, result rendering
- `server.js` — static file server plus the OpenRouter proxy endpoint
